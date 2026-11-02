import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpHandler, HttpServeResponse } from "@zclaudia/gateway-backend";
import { createMobileUiAssetProvider } from "../src/main/remote-access/mobileUiAssetProvider.js";
import { resolveMobileWebRootDir } from "../scripts/mobile-web-assets.mjs";

/**
 * M1-T5 focused 集成测试：用 M1-T4 的真实根路径解析读取当前 `dist-mobile-remote`。
 *
 * 与 T2 的临时目录单测不同，这里必须读到真实的 `release.json` / `index.html` / 内容哈希资源，
 * 从而验证 Main 装配使用的 rootDir 与真实构建产物形状一致。制品是 gitignored 生成物：
 * 未构建时整个 suite 跳过并在名称里写明原因，不伪造通过。
 *
 * Gateway 路径契约（与 zclaudia-gateway `src/server.ts` 的 `/api/proxy/:backendId/*` 对应）：
 * gateway 只把 `req.params[0]`（例如 `mobile-ui/release`）放进 `http_request.path`，SDK handler
 * 收到的是带前导 `/` 的相对路径。provider 因此必须拒绝完整 `/api/proxy/...` 前缀，避免误当资源。
 */

const desktopPackageRoot = resolve(import.meta.dirname, "..");
const rootDir = resolveMobileWebRootDir({ isPackaged: false, desktopPackageRoot });
const releasePath = join(rootDir, "release.json");
const entryPath = join(rootDir, "index.html");
const artifactReady = existsSync(releasePath) && existsSync(entryPath);
const skipReason = `未找到 ${rootDir}；先运行 pnpm build:mobile-web`;

const GENERIC_GATEWAY_ORIGIN = "https://gateway.example.com";
const GENERIC_GATEWAY_WS_ORIGIN = "wss://gateway.example.com";

function createHandler(): HttpHandler {
  return createMobileUiAssetProvider({
    rootDir,
    resolveSecurityContext: () => ({
      gatewayHttpOrigin: GENERIC_GATEWAY_ORIGIN,
      gatewayWsOrigin: GENERIC_GATEWAY_WS_ORIGIN,
    }),
  });
}

function request(handler: HttpHandler, path: string, method = "GET"): Promise<HttpServeResponse> {
  return Promise.resolve(handler({ method, path, headers: {}, body: new Uint8Array(0) }));
}

function header(response: HttpServeResponse, name: string): string | undefined {
  const match = Object.entries(response.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function findContentHashedAsset(): Promise<string> {
  const assetsDir = join(rootDir, "assets");
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const hashed = entries.find(
    (entry) => entry.isFile() && /[.-][A-Za-z0-9_-]{8,64}\.[A-Za-z0-9]+$/u.test(entry.name),
  );
  if (!hashed) {
    throw new Error(`真实制品缺少内容哈希资源：${assetsDir}`);
  }
  return `assets/${hashed.name}`;
}

const describeArtifact = artifactReady ? describe : describe.skip;
const suiteName = artifactReady
  ? "真实移动 UI 制品经桌面 provider 读取（M1-T5）"
  : `真实移动 UI 制品经桌面 provider 读取（跳过：${skipReason}）`;

describeArtifact(suiteName, () => {
  it("release 与入口 HTML 来自同一次构建且 releaseId 一致", async () => {
    const handler = createHandler();
    const releaseBytes = await readFile(releasePath);
    const release = JSON.parse(releaseBytes.toString("utf8")) as {
      releaseId: string;
      entry: string;
      supportedBridgeVersions: number[];
    };
    expect(release.releaseId).toMatch(/^[0-9a-f]{24}$/u);
    expect(release.entry).toBe("/assets/remote/index.html");
    expect(release.supportedBridgeVersions).toContain(1);

    const releaseResponse = await request(handler, "/mobile-ui/release");
    expect(releaseResponse.status).toBe(200);
    expect(header(releaseResponse, "Cache-Control")).toBe("no-store");
    expect(header(releaseResponse, "Content-Type")).toBe("application/json; charset=utf-8");
    expect(Buffer.from(releaseResponse.body as Uint8Array).equals(releaseBytes)).toBe(true);

    const entryBytes = await readFile(entryPath);
    const entryResponse = await request(handler, "/assets/remote/index.html");
    expect(entryResponse.status).toBe(200);
    expect(header(entryResponse, "Cache-Control")).toBe("no-store");
    expect(header(entryResponse, "Content-Type")).toBe("text/html; charset=utf-8");
    expect(Buffer.from(entryResponse.body as Uint8Array).equals(entryBytes)).toBe(true);
    expect(entryBytes.toString("utf8")).toContain(
      `<meta name="zody-mobile-ui-release" content="${release.releaseId}" />`,
    );
  });

  it("读取真实内容哈希资源并返回 immutable 与精确字节", async () => {
    const handler = createHandler();
    const relativeAsset = await findContentHashedAsset();
    const bytes = await readFile(join(rootDir, relativeAsset));

    const response = await request(handler, `/assets/remote/${relativeAsset}`);
    expect(response.status).toBe(200);
    expect(header(response, "Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(header(response, "Content-Length")).toBe(String(bytes.byteLength));
    expect(sha256(response.body as Uint8Array)).toBe(sha256(bytes));

    const head = await request(handler, `/assets/remote/${relativeAsset}`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
    expect(header(head, "Content-Length")).toBe(String(bytes.byteLength));
  });

  it("CSP 只包含当前 Gateway 的纯 HTTP/WS origin", async () => {
    const handler = createHandler();
    const response = await request(handler, "/assets/remote/index.html");
    const csp = header(response, "Content-Security-Policy") ?? "";

    expect(csp).toContain(
      `connect-src 'self' ${GENERIC_GATEWAY_ORIGIN} ${GENERIC_GATEWAY_WS_ORIGIN}`,
    );
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src *");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    for (const leaked of ["Bearer", "password", "token=", "userinfo"]) {
      expect(csp).not.toContain(leaked);
    }
  });

  it("拒绝完整 /api/proxy 前缀、逃逸与未允许路径", async () => {
    const handler = createHandler();
    for (const path of [
      // Gateway 不会把这些前缀传给 SDK；若误传，provider 必须拒绝而不是当资源读取。
      "/api/proxy/backend-1/mobile-ui/release",
      "/api/proxy/backend-1/assets/remote/index.html",
      "/api/mobile-ui/release",
      "/mobile-ui/release/extra",
      "/assets/remote/../release.json",
      "/assets/remote/assets/../../release.json",
      "/assets/remote/release.json",
    ]) {
      const response = await request(handler, path);
      expect(response.status, path).toBe(404);
      expect(response.body, path).toBeUndefined();
      expect(header(response, "Cache-Control"), path).toBe("no-store");
    }
  });

  it("只允许 GET/HEAD", async () => {
    const handler = createHandler();
    const response = await request(handler, "/mobile-ui/release", "POST");
    expect(response.status).toBe(405);
    expect(header(response, "Allow")).toBe("GET, HEAD");
    expect(header(response, "Cache-Control")).toBe("no-store");
  });
});
