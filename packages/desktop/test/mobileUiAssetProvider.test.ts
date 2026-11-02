import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpHandler, HttpServeResponse } from "@zclaudia/gateway-backend";
import {
  createMobileUiAssetProvider,
  type MobileUiAssetProviderOptions,
  type MobileUiSecurityContext,
} from "../src/main/remote-access/mobileUiAssetProvider.js";

const RELEASE_JSON = JSON.stringify({
  schemaVersion: 1,
  releaseId: "0123456789abcdef01234567",
  desktopVersion: "0.1.0",
  supportedBridgeVersions: [1],
  entry: "/assets/remote/index.html",
  assetDigest: "a".repeat(64),
});

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

const FILES: Record<string, string> = {
  "release.json": RELEASE_JSON,
  "index.html": INDEX_HTML,
  "assets/index-abcdef12.js": "console.log('remote');",
  "assets/index-abcdef12.css": ".root{display:block}",
  "assets/chunk-helper.js": "export const chunk = 1;",
  "fonts/inter-abcdef12.woff2": "font-bytes",
  "favicon.ico": "icon",
  "pdf/cmaps/Adobe-Japan1-UCS2.bcmap": "cmap",
  "notes.txt": "supporting text",
};

let rootDir: string;
let outsideDir: string;
let handler: HttpHandler;

function request(
  path: string,
  method = "GET",
  body: Uint8Array = new Uint8Array(0),
): Promise<HttpServeResponse> {
  return handler({ method, path, headers: {}, body });
}

function header(response: HttpServeResponse, name: string): string | undefined {
  return response.headers?.[name];
}

function createHandler(
  options: Partial<Omit<MobileUiAssetProviderOptions, "rootDir">> = {},
): HttpHandler {
  return createMobileUiAssetProvider({
    rootDir,
    resolveSecurityContext: () => ({
      gatewayHttpOrigin: "https://gateway.example.com/base/path",
      gatewayWsOrigin: "wss://gateway.example.com",
    }),
    ...options,
  });
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "zody-mobile-ui-provider-"));
  outsideDir = await mkdtemp(join(tmpdir(), "zody-mobile-ui-provider-outside-"));
  await writeFile(join(outsideDir, "secret-abcdef12.js"), "outside secret");

  for (const [relativePath, content] of Object.entries(FILES)) {
    const absolutePath = join(rootDir, ...relativePath.split("/"));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  handler = createHandler();
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("mobile UI release and entry", () => {
  it("serves release.json as no-store JSON", async () => {
    const response = await request("/mobile-ui/release");
    expect(response.status).toBe(200);
    expect(header(response, "Cache-Control")).toBe("no-store");
    expect(header(response, "Content-Type")).toBe("application/json; charset=utf-8");
    expect(Buffer.from(response.body as Uint8Array).toString("utf8")).toBe(RELEASE_JSON);
    expect(header(response, "Content-Length")).toBe(String(Buffer.byteLength(RELEASE_JSON)));
  });

  it("serves HEAD with the same metadata and an empty body", async () => {
    const response = await request("/mobile-ui/release", "HEAD");
    expect(response.status).toBe(200);
    expect(response.body).toBeUndefined();
    expect(header(response, "Content-Length")).toBe(String(Buffer.byteLength(RELEASE_JSON)));
    expect(header(response, "Cache-Control")).toBe("no-store");
  });

  it("ignores a query string without changing the cache policy", async () => {
    const response = await request("/mobile-ui/release?cacheBust=1");
    expect(response.status).toBe(200);
    expect(header(response, "Cache-Control")).toBe("no-store");
  });

  it("serves the entry HTML as no-store text/html", async () => {
    const response = await request("/assets/remote/index.html");
    expect(response.status).toBe(200);
    expect(header(response, "Cache-Control")).toBe("no-store");
    expect(header(response, "Content-Type")).toBe("text/html; charset=utf-8");
    expect(Buffer.from(response.body as Uint8Array).toString("utf8")).toBe(INDEX_HTML);
  });

  it("does not expose the manifest through the asset prefix", async () => {
    const response = await request("/assets/remote/release.json");
    expect(response.status).toBe(404);
    expect(response.body).toBeUndefined();
  });
});

describe("mobile UI asset caching", () => {
  it.each([
    ["/assets/remote/assets/index-abcdef12.js", "text/javascript; charset=utf-8"],
    ["/assets/remote/assets/index-abcdef12.css", "text/css; charset=utf-8"],
  ])("marks content-hashed %s immutable", async (path, contentType) => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(header(response, "Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(header(response, "Content-Type")).toBe(contentType);
  });

  it("marks non-hashed and root-level assets no-cache", async () => {
    for (const path of [
      "/assets/remote/assets/chunk-helper.js",
      "/assets/remote/fonts/inter-abcdef12.woff2",
      "/assets/remote/favicon.ico",
      "/assets/remote/pdf/cmaps/Adobe-Japan1-UCS2.bcmap",
      "/assets/remote/notes.txt",
    ]) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
      expect(header(response, "Cache-Control"), path).toBe("no-cache");
    }
  });

  it("returns 404 for an old content hash without backfilling the current file", async () => {
    const response = await request("/assets/remote/assets/index-99999999.js");
    expect(response.status).toBe(404);
    expect(response.body).toBeUndefined();
    expect(header(response, "Cache-Control")).toBe("no-store");
  });

  it("allows HEAD for hashed assets without a body", async () => {
    const response = await request("/assets/remote/assets/index-abcdef12.js", "HEAD");
    expect(response.status).toBe(200);
    expect(response.body).toBeUndefined();
    expect(header(response, "Content-Length")).toBe(
      String(Buffer.byteLength(FILES["assets/index-abcdef12.js"] ?? "")),
    );
  });
});

describe("mobile UI method and path rejection", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects %s with 405 and no-store",
    async (method) => {
      const response = await request("/mobile-ui/release", method);
      expect(response.status).toBe(405);
      expect(header(response, "Allow")).toBe("GET, HEAD");
      expect(header(response, "Cache-Control")).toBe("no-store");
      expect(response.body).toBeUndefined();
    },
  );

  it("rejects a GET/HEAD request carrying a body", async () => {
    const response = await request("/mobile-ui/release", "HEAD", new Uint8Array([1]));
    expect(response.status).toBe(400);
    expect(header(response, "Cache-Control")).toBe("no-store");
  });

  it.each([
    "/api/anything",
    "/assets/remote/",
    "/assets/remote/assets/",
    "/assets/remote/index.html/",
    "/mobile-ui/release/",
    "/mobile-ui/release/extra",
    "/assets/remote/../release.json",
    "/assets/remote/assets/../../release.json",
    "//mobile-ui/release",
    "/assets/remote//index.html",
  ])("rejects non-allowlisted path %s", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(header(response, "Cache-Control")).toBe("no-store");
  });

  it.each([
    "/assets/remote/assets/..%2Frelease.json",
    "/assets/remote/assets/index%2Fabcdef12.js",
    "/assets/remote/assets/..%5Csecret-abcdef12.js",
    "/assets/remote/assets/index-abcdef12.js%00.png",
    "/assets/remote/assets/%2e%2e%2fsecret-abcdef12.js",
    "/assets/remote/assets/%252e%252e%252fsecret-abcdef12.js",
    "/assets/remote/assets/..\\secret-abcdef12.js",
    "/assets/remote/assets/%E0%A4%A.js",
  ])("rejects traversal or repeated decoding in %s", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.body).toBeUndefined();
  });

  it("rejects dotfiles and non-allowlisted extensions even when the file exists", async () => {
    await writeFile(join(rootDir, ".env"), "SECRET=1");
    await writeFile(join(rootDir, "tool.exe"), "binary");
    for (const path of ["/assets/remote/.env", "/assets/remote/tool.exe"]) {
      const response = await request(path);
      expect(response.status, path).toBe(404);
    }
  });
});

describe("mobile UI filesystem safety", () => {
  it("rejects a symbolic link to a file outside the artifact root", async () => {
    await symlink(
      join(outsideDir, "secret-abcdef12.js"),
      join(rootDir, "assets", "link-abcdef12.js"),
    );
    const response = await request("/assets/remote/assets/link-abcdef12.js");
    expect(response.status).toBe(404);
    expect(response.body).toBeUndefined();
  });

  it("rejects a file below a symlinked directory that escapes the root", async () => {
    await symlink(outsideDir, join(rootDir, "assets", "linked"));
    const response = await request("/assets/remote/assets/linked/secret-abcdef12.js");
    expect(response.status).toBe(404);
  });

  it("returns 413 when an asset exceeds the configured response limit", async () => {
    handler = createHandler({ maxResponseBytes: 8 });
    const response = await request("/assets/remote/assets/index-abcdef12.js");
    expect(response.status).toBe(413);
    expect(header(response, "Cache-Control")).toBe("no-store");
    expect(response.body).toBeUndefined();
  });

  it("returns 404 when the artifact root is missing", async () => {
    handler = createHandler();
    await rm(rootDir, { recursive: true, force: true });
    const response = await request("/mobile-ui/release");
    expect(response.status).toBe(404);
    expect(header(response, "Cache-Control")).toBe("no-store");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "maps an unreadable file to 403 without leaking the absolute path",
    async () => {
      const file = join(rootDir, "assets", "locked-abcdef12.js");
      await writeFile(file, "locked");
      await chmod(file, 0o000);
      const response = await request("/assets/remote/assets/locked-abcdef12.js");
      expect(response.status).toBe(403);
      expect(header(response, "Cache-Control")).toBe("no-store");
      expect(response.body).toBeUndefined();
      await chmod(file, 0o644);
    },
  );
});

describe("mobile UI security headers", () => {
  it("sets strict CSP and does not emit cookies or hop-by-hop headers", async () => {
    const response = await request("/assets/remote/index.html");
    const csp = header(response, "Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src *");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain(
      "connect-src 'self' https://gateway.example.com wss://gateway.example.com",
    );
    expect(header(response, "X-Frame-Options")).toBe("DENY");
    expect(header(response, "X-Content-Type-Options")).toBe("nosniff");

    const headerNames = Object.keys(response.headers ?? {}).map((name) => name.toLowerCase());
    for (const forbidden of [
      "set-cookie",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(headerNames).not.toContain(forbidden);
    }
  });

  it("strips userinfo, path, query and credentials from CSP origins", async () => {
    handler = createHandler({
      resolveSecurityContext: () =>
        ({
          gatewayHttpOrigin: "https://user:password@gateway.example.com/prefix?token=secret",
        }) satisfies MobileUiSecurityContext,
      logger: undefined,
    });
    const response = await request("/assets/remote/index.html");
    const csp = header(response, "Content-Security-Policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    for (const leaked of ["user", "password", "token", "secret", "prefix", "?token"]) {
      expect(csp).not.toContain(leaked);
    }
  });

  it("falls back to same-origin connect-src when the resolver fails", async () => {
    handler = createHandler({
      resolveSecurityContext: () => {
        throw new Error("https://user:password@gateway.example.com/?token=secret");
      },
    });
    const response = await request("/assets/remote/index.html");
    expect(response.status).toBe(200);
    const csp = header(response, "Content-Security-Policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("password");
    expect(csp).not.toContain("secret");
  });

  it("reads the security context for every request", async () => {
    let origin = "https://first.example.com";
    handler = createHandler({
      resolveSecurityContext: () => ({ gatewayHttpOrigin: origin }),
    });
    expect(header(await request("/assets/remote/index.html"), "Content-Security-Policy")).toContain(
      "https://first.example.com",
    );
    origin = "https://second.example.com";
    expect(header(await request("/assets/remote/index.html"), "Content-Security-Policy")).toContain(
      "https://second.example.com",
    );
  });
});
