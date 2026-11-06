import { describe, expect, it, vi } from "vitest";
import {
  checkMobileRemoteRelease,
  resolveMobileRemoteReleaseRequestUrl,
} from "../src/mobile-remote/mobileRemoteReleaseCheck.js";

const context = {
  gatewayUrl: "https://gateway.example.invalid",
  backendId: "backend-1",
  credential: "zgd_secret",
  bridgeCapabilities: {
    schemaVersion: 1 as const,
    bridgeVersion: 1,
    appVersion: "1.2.3",
    capabilities: ["session-context"],
  },
};

const manifest = {
  schemaVersion: 1,
  releaseId: "0123456789abcdef01234567",
  desktopVersion: "0.1.0",
  supportedBridgeVersions: [1],
  entry: "/assets/remote/index.html",
  assetDigest: "a".repeat(64),
};

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Remote 启动期 release manifest 校验", () => {
  it("生产构建从 Remote 固定 origin 读取，不把凭证放进 URL 或请求头", async () => {
    const fetcher = vi.fn(async () => jsonResponse(manifest));

    const result = await checkMobileRemoteRelease({
      context,
      isProduction: true,
      origin: "https://remote.zody.local",
      fetcher,
    });

    expect(result).toEqual({ kind: "compatible", manifest });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://remote.zody.local/mobile-ui/release");
    expect(url).not.toContain("zgd_");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.cache).toBe("no-store");
  });

  it("开发构建直接走 Gateway proxy 路径，凭证只在 Authorization 头", async () => {
    const fetcher = vi.fn(async () => jsonResponse(manifest));

    await checkMobileRemoteRelease({
      context,
      isProduction: false,
      fetcher,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gateway.example.invalid/api/proxy/backend-1/mobile-ui/release");
    expect(url).not.toContain("zgd_");
    expect(init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer zgd_secret",
    });
  });

  it("manifest 不支持当前 bridgeVersion 时只要求升级 APK", async () => {
    const result = await checkMobileRemoteRelease({
      context: {
        ...context,
        bridgeCapabilities: { ...context.bridgeCapabilities, bridgeVersion: 2 },
      },
      isProduction: true,
      origin: "https://remote.zody.local",
      fetcher: async () => jsonResponse(manifest),
    });

    expect(result).toEqual({
      kind: "upgrade-required",
      bridgeVersion: 2,
      supportedBridgeVersions: [1],
    });
  });

  it.each([
    ["HTTP 错误", async () => new Response("nope", { status: 503 }), "http-error"],
    [
      "非法 manifest",
      async () => jsonResponse({ ...manifest, supportedBridgeVersions: [0] }),
      "invalid-manifest",
    ],
    ["非 JSON", async () => new Response("nope", { status: 200 }), "invalid-manifest"],
    [
      "网络失败",
      async () => {
        throw new Error("offline");
      },
      "network-error",
    ],
  ] as const)("%s 返回 unavailable，不启动业务 Channel", async (_label, fetcher, reason) => {
    const result = await checkMobileRemoteRelease({
      context,
      isProduction: true,
      origin: "https://remote.zody.local",
      fetcher: fetcher as typeof fetch,
    });
    expect(result).toEqual({ kind: "unavailable", reason });
  });

  it("缺少 Remote origin 时 fail closed", () => {
    expect(
      resolveMobileRemoteReleaseRequestUrl({
        context,
        isProduction: true,
        origin: "",
      }),
    ).toBeUndefined();
    expect(
      resolveMobileRemoteReleaseRequestUrl({
        context,
        isProduction: false,
      }),
    ).toBe("https://gateway.example.invalid/api/proxy/backend-1/mobile-ui/release");
  });
});
