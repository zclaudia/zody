import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayClient } from "@zclaudia/gateway-client";
import { createMobileUiAssetProvider } from "../src/main/remote-access/mobileUiAssetProvider.js";
import { createRemoteGatewayBackend } from "../src/main/remote-access/remoteGatewayBackend.js";
import type { RemoteGatewayBackend } from "../src/main/remote-access/remoteGatewayBackendTypes.js";
import { resolveMobileWebRootDir } from "../scripts/mobile-web-assets.mjs";

/**
 * M1-T5：真实 Gateway `/api/proxy/<backendId>` 集成验证。
 *
 * 只复用本地 `.env.gateway.local` 已签发的 backend/device 凭证（`ZCODE_GATEWAY_ENV_FILE` 指定文件），
 * 不在测试里调用管理 API 新签凭证、不重启/改写 gateway、不打印任何凭证。
 * 环境或真实制品缺失时整个 suite 跳过并在名称里写明原因，不伪造通过。
 *
 * 覆盖：
 * - T2 provider 经 T3 `RemoteGatewayBackend.mobileUiHandler` 注册到真实 SDK `serveHttp`；
 * - Gateway 传给 SDK 的 path 契约：`/api/proxy/<backendId>/mobile-ui/release` → handler 收到
 *   `/mobile-ui/release`（zclaudia-gateway `src/server.ts` 的 `req.params[0]`）；
 * - release / index / 内容哈希资源的真实状态、缓存头、CSP 与字节摘要；
 * - 拒绝路径与 POST；
 * - 同一 backend 上 `zcode-remote` 业务 channel 仍可打开。
 */

const ENV_FILE_CANDIDATES = [
  process.env.ZCODE_GATEWAY_ENV_FILE?.trim(),
  resolve(import.meta.dirname, "../../../.env.gateway.local"),
  resolve(process.cwd(), ".env.gateway.local"),
  resolve(process.cwd(), "../../.env.gateway.local"),
].filter((candidate): candidate is string => Boolean(candidate));

async function readGatewayEnv(): Promise<Record<string, string>> {
  for (const candidate of ENV_FILE_CANDIDATES) {
    try {
      return parseEnv(await readFile(candidate, "utf8"));
    } catch {
      // 继续尝试下一个候选路径；环境未配置时 suite 会整体跳过。
    }
  }
  return {};
}

const fileEnv = await readGatewayEnv();
const readEnv = (name: string) => process.env[name]?.trim() || fileEnv[name]?.trim() || "";

const gatewayUrl = readEnv("ZCODE_GATEWAY_IT_URL").replace(/\/+$/u, "");
const backendCredential = readEnv("ZCODE_GATEWAY_BACKEND_CREDENTIAL");
const deviceCredential = readEnv("ZCODE_GATEWAY_DEVICE_CREDENTIAL");
// 与既有 T3 集成测试一致：凭证实际 namespace 由 ZCODE_GATEWAY_IT_NAMESPACE 指定。
// 本机 `.env.gateway.local` 里的 ZCODE_GATEWAY_NAMESPACE 可能滞后于已签发凭证，
// 直接用它会让 peer_hello 因 namespace 不匹配返回 UNAUTHORIZED。
const namespace = readEnv("ZCODE_GATEWAY_IT_NAMESPACE") || "zcode";

const desktopPackageRoot = resolve(import.meta.dirname, "..");
const rootDir = resolveMobileWebRootDir({ isPackaged: false, desktopPackageRoot });
const artifactReady =
  existsSync(join(rootDir, "release.json")) && existsSync(join(rootDir, "index.html"));

const missingEnv = !gatewayUrl
  ? "未设置 ZCODE_GATEWAY_IT_URL"
  : !backendCredential
    ? "未设置 ZCODE_GATEWAY_BACKEND_CREDENTIAL"
    : !deviceCredential
      ? "未设置 ZCODE_GATEWAY_DEVICE_CREDENTIAL"
      : undefined;
const skipReason =
  missingEnv ?? (artifactReady ? undefined : `未找到 ${rootDir}；先运行 pnpm build:mobile-web`);

const describeIntegration = skipReason ? describe.skip : describe;
const suiteName = skipReason
  ? `真实 Gateway 移动 UI 代理（M1-T5 跳过：${skipReason}）`
  : "真实 Gateway 移动 UI 代理（M1-T5）";

interface Harness {
  backend: RemoteGatewayBackend;
  backendId: string;
  observedPaths: string[];
  businessChannelKinds: Array<string | undefined>;
}

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.backend.dispose();
    harness = undefined;
  }
});

async function waitFor<T>(
  predicate: () => T | undefined | false | Promise<T | undefined | false>,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value as T;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}`);
}

async function startBackend(): Promise<Harness> {
  const observedPaths: string[] = [];
  const businessChannelKinds: Array<string | undefined> = [];
  const provider = createMobileUiAssetProvider({
    rootDir,
    resolveSecurityContext: () => ({
      gatewayHttpOrigin: new URL(gatewayUrl).origin,
      gatewayWsOrigin: new URL(gatewayUrl).origin.replace(/^http/u, "ws"),
    }),
  });
  const backend = createRemoteGatewayBackend({
    loadConfig: async () => ({
      enabled: true,
      gatewayUrl,
      namespace,
      credential: backendCredential,
    }),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    allowInsecureTransport: true,
    // 记录真实 SDK 收到的 path，验证 Gateway 已剥离 /api/proxy/<backendId> 前缀。
    mobileUiHandler: async (request) => {
      observedPaths.push(request.path);
      return provider(request);
    },
  });
  backend.setChannelHandler((channel) => {
    businessChannelKinds.push(channel.kind);
    channel.close();
  });

  await backend.reloadConfig();
  const status = await waitFor(() => {
    const current = backend.getStatus();
    return current.state === "online" ? current : undefined;
  }, "桌面 backend 连接本地 Gateway");

  harness = { backend, backendId: status.backendId, observedPaths, businessChannelKinds };
  return harness;
}

function proxyRequest(backendId: string, path: string, method = "GET"): Promise<Response> {
  return fetch(`${gatewayUrl}/api/proxy/${encodeURIComponent(backendId)}${path}`, {
    method,
    headers: { authorization: `Bearer ${deviceCredential}` },
    signal: AbortSignal.timeout(20_000),
  });
}

async function findContentHashedAsset(): Promise<string> {
  const entries = await readdir(join(rootDir, "assets"), { withFileTypes: true });
  const hashed = entries.find(
    (entry) => entry.isFile() && /[.-][A-Za-z0-9_-]{8,64}\.[A-Za-z0-9]+$/u.test(entry.name),
  );
  if (!hashed) {
    throw new Error("真实制品缺少内容哈希资源");
  }
  return `assets/${hashed.name}`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describeIntegration(suiteName, () => {
  it("经真实 /api/proxy 读取 release/index/hash，并确认 SDK 收到剥离前缀的 path", async () => {
    const current = await startBackend();
    const releaseBytes = await readFile(join(rootDir, "release.json"));
    const release = JSON.parse(releaseBytes.toString("utf8")) as { releaseId: string };

    const releaseResponse = await proxyRequest(current.backendId, "/mobile-ui/release");
    expect(releaseResponse.status).toBe(200);
    expect(releaseResponse.headers.get("cache-control")).toBe("no-store");
    expect(releaseResponse.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(Buffer.from(await releaseResponse.arrayBuffer()).equals(releaseBytes)).toBe(true);

    const entryBytes = await readFile(join(rootDir, "index.html"));
    const entryResponse = await proxyRequest(current.backendId, "/assets/remote/index.html");
    expect(entryResponse.status).toBe(200);
    expect(entryResponse.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await entryResponse.arrayBuffer()).equals(entryBytes)).toBe(true);
    // 真实 Gateway 的 PROXY_RESPONSE_HEADER_ALLOWLIST 不含 CSP / X-Frame-Options /
    // X-Content-Type-Options / Referrer-Policy。provider 本身仍按 spec 第 5 节设置这些头
    // （见 provider 单测与真实制品测试），但经 `/api/proxy` 不会到达客户端；
    // M2 必须在 Android 原生代理或入口 HTML meta 层补足，不能在这里放宽 provider。
    expect(entryResponse.headers.get("content-security-policy")).toBeNull();
    expect(entryResponse.headers.get("x-frame-options")).toBeNull();

    const relativeAsset = await findContentHashedAsset();
    const assetBytes = await readFile(join(rootDir, relativeAsset));
    const assetResponse = await proxyRequest(current.backendId, `/assets/remote/${relativeAsset}`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(sha256(new Uint8Array(await assetResponse.arrayBuffer()))).toBe(sha256(assetBytes));

    // Gateway 实际传给 SDK 的 path 必须已去掉 /api/proxy/<backendId> 前缀。
    expect(current.observedPaths).toContain("/mobile-ui/release");
    expect(current.observedPaths).toContain("/assets/remote/index.html");
    expect(current.observedPaths.every((path) => !path.startsWith("/api/proxy/"))).toBe(true);
    expect(release.releaseId).toMatch(/^[0-9a-f]{24}$/u);
  }, 60_000);

  it("拒绝非 UI 路径与方法，且不影响同一 backend 的 zcode-remote channel", async () => {
    const current = await startBackend();

    for (const path of ["/api/anything", "/mobile-ui/release/extra"]) {
      const response = await proxyRequest(current.backendId, path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
    const postResponse = await proxyRequest(current.backendId, "/mobile-ui/release", "POST");
    expect(postResponse.status).toBe(405);
    // 同上：Gateway 的响应头 allowlist 不包含 Allow，方法限制仍由 provider 保证。
    expect(postResponse.headers.get("allow")).toBeNull();

    // 业务 Channel 仍走既有 `zcode-remote` kind，与 UI 的 `http` kind 分离。
    const client = new GatewayClient({
      url: gatewayUrl,
      credential: deviceCredential,
      namespace,
      reconnect: false,
    });
    try {
      await client.connect();
      const channel = await client.openChannel(current.backendId, "zcode-remote");
      await waitFor(
        () => current.businessChannelKinds.includes("zcode-remote"),
        "桌面 backend 收到 zcode-remote channel",
      );
      channel.close();
    } finally {
      client.close();
    }
  }, 60_000);
});
