// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fetchMobileUiReleaseObservation,
  readMobileUiReleaseMetaReleaseId,
} from "../src/mobile-remote/mobileUiReleaseDto.js";

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

describe("发布 DTO 适配", () => {
  it("200 且 schema 合法时返回严格校验后的 manifest", async () => {
    const fetcher = vi.fn(async () => jsonResponse(manifest));

    const result = await fetchMobileUiReleaseObservation({
      context,
      isProduction: true,
      origin: "https://remote.zody.local",
      fetcher,
    });

    expect(result).toEqual({ kind: "observed", manifest });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://remote.zody.local/mobile-ui/release");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.cache).toBe("no-store");
  });

  it("开发构建凭证只出现在 Authorization 头，不写 URL", async () => {
    const fetcher = vi.fn(async () => jsonResponse(manifest));

    await fetchMobileUiReleaseObservation({ context, isProduction: false, fetcher });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gateway.example.invalid/api/proxy/backend-1/mobile-ui/release");
    expect(url).not.toContain("zgd_");
    expect(init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer zgd_secret",
    });
  });

  it.each([
    [401, "login-invalid"],
    [403, "login-invalid"],
    [429, "rate-limited"],
    [500, "server-error"],
    [503, "server-error"],
    [404, "http-error"],
  ])("HTTP %i 映射为 %s，且不产生待刷新目标", async (status, reason) => {
    const fetcher = vi.fn(async () => new Response("", { status }));

    await expect(
      fetchMobileUiReleaseObservation({
        context,
        isProduction: true,
        origin: "https://remote.zody.local",
        fetcher,
      }),
    ).resolves.toEqual({ kind: "failed", reason, status });
  });

  it("网络异常保留为 network-error", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      fetchMobileUiReleaseObservation({
        context,
        isProduction: true,
        origin: "https://remote.zody.local",
        fetcher,
      }),
    ).resolves.toEqual({ kind: "failed", reason: "network-error" });
  });

  it.each([
    ["非 JSON", () => new Response("not-json", { status: 200 })],
    ["schema 不匹配", () => jsonResponse({ ...manifest, releaseId: "BAD" })],
    ["额外字段", () => jsonResponse({ ...manifest, extra: true })],
  ])("%s 映射为 invalid-manifest", async (_label, response) => {
    const fetcher = vi.fn(async () => response());

    await expect(
      fetchMobileUiReleaseObservation({
        context,
        isProduction: true,
        origin: "https://remote.zody.local",
        fetcher,
      }),
    ).resolves.toEqual({ kind: "failed", reason: "invalid-manifest" });
  });
});

describe("读取当前 HTML release meta", () => {
  function withMeta(content: string | undefined): Document {
    const document = new DOMParser().parseFromString(
      content === undefined
        ? "<html><head></head><body></body></html>"
        : `<html><head><meta name="zody-mobile-ui-release" content="${content}" /></head><body></body></html>`,
      "text/html",
    );
    return document;
  }

  it("只接受 M1 的 24 位小写十六进制 releaseId", () => {
    expect(readMobileUiReleaseMetaReleaseId(withMeta("0123456789abcdef01234567"))).toBe(
      "0123456789abcdef01234567",
    );
  });

  it.each([
    ["缺少 meta", undefined],
    ["空内容", ""],
    ["大写", "0123456789ABCDEF01234567"],
    ["过短", "0123456789abcdef0123456"],
    ["非十六进制", "zzzzzzzzzzzzzzzzzzzzzzzz"],
  ])("%s 返回 undefined，由控制器只诊断不刷新", (_label, content) => {
    expect(readMobileUiReleaseMetaReleaseId(withMeta(content))).toBeUndefined();
  });
});
