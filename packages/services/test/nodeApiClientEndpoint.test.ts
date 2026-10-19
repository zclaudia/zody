import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";
import { buildZCodeSourceHeaders } from "../src/providers/sourceHeaders.js";

const TEST_ZCODE_ORIGIN = "https://zcode.endpoint.test";

describe("NodeApiClient endpoint rewriting", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setDataBaseDir(null);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fork（F3.1）：默认端点为空后不再隐式改写请求地址", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "http://localhost:3030",
    });

    await client.request(`${TEST_ZCODE_ORIGIN}/api/v1/event/report?x=1`);
    await client.request("https://example.com/static/config.json");
    await client.request("https://feedback.example.invalid/api/v1/tickets");
    await client.request("https://api.z.ai/v1/models");

    // 调用方必须直接使用当前 endpoint 构造 URL；默认源已不存在，不再有改写来源。
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      `${TEST_ZCODE_ORIGIN}/api/v1/event/report?x=1`,
      "https://example.com/static/config.json",
      "https://feedback.example.invalid/api/v1/tickets",
      "https://api.z.ai/v1/models",
    ]);
  });

  it("只给当前 zcode endpoint 请求统一补来源 headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => TEST_ZCODE_ORIGIN,
    });

    await client.request(`${TEST_ZCODE_ORIGIN}/api/v1/client/configs`);
    await client.request("https://api.z.ai/v1/models");

    const zcodeHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(zcodeHeaders.get("User-Agent")).toMatch(/^ZCode\//);
    // F2.10：来源标识（HTTP-Referer/X-Title）默认不发，设备标识（X-Device-Mid）停发。
    expect(zcodeHeaders.get("X-Title")).toBeNull();
    expect(zcodeHeaders.get("X-Device-Mid")).toBeNull();
    expect(zcodeHeaders.get("X-OpenRouter-Title")).toBeNull();
    expect(zcodeHeaders.get("X-OpenRouter-Categories")).toBeNull();
    expect(zcodeHeaders.get("HTTP-Referer")).toBeNull();
    expect(zcodeHeaders.get("X-App-Version")).toBeNull();
    expect(zcodeHeaders.get("X-ZCode-App-Version")).toBeTruthy();
    expect(zcodeHeaders.get("X-Platform")).toBe(`${process.platform}-${process.arch}`);
    expect(zcodeHeaders.get("X-Release-Channel")).toBeTruthy();
    expect(zcodeHeaders.get("X-Client-Language")).toBeTruthy();
    expect(zcodeHeaders.get("X-Client-Timezone")).toBeTruthy();
    expect(zcodeHeaders.get("X-Os-Category")).toBeTruthy();
    expect(zcodeHeaders.get("X-Os-Version")).toBeTruthy();
    expect(zcodeHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const externalHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(externalHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(externalHeaders.get("User-Agent")).toBeNull();
  });

  it("保留调用方显式传入的 zcode endpoint headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => TEST_ZCODE_ORIGIN,
    });

    await client.request(`${TEST_ZCODE_ORIGIN}/api/v1/oauth/token`, {
      headers: {
        "User-Agent": "CustomAgent/1.0",
        "X-Custom-Client-Ref": "caller-ref",
        "X-Title": "Custom Title",
        Authorization: "Bearer token",
      },
    });

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("User-Agent")).toBe("CustomAgent/1.0");
    expect(headers.get("X-Title")).toBe("Custom Title");
    expect(headers.get("X-Custom-Client-Ref")).toBe("caller-ref");
    expect(headers.get("X-OpenRouter-Title")).toBeNull();
    expect(headers.get("X-OpenRouter-Categories")).toBeNull();
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("X-Device-Mid")).toBeNull();
    expect(headers.get("HTTP-Referer")).toBeNull();
    expect(headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("telemetry-state.json 存在 deviceMid 时也不注入 X-Device-Mid", async () => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-device-mid-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    const configDir = join(dataBaseDir, ".zcoder", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "device-mid-1" }),
      "utf-8",
    );

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => TEST_ZCODE_ORIGIN,
    });

    await client.request(`${TEST_ZCODE_ORIGIN}/api/v1/client/configs`);

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    // F2.10：设备标识停发，来源头构造不再读取 telemetry-state.json。
    expect(headers.get("X-Device-Mid")).toBeNull();
  });

  it("统一来源 headers 支持可控的客户端上下文字段", () => {
    const headers = buildZCodeSourceHeaders({
      appVersion: "2.14.0",
      arch: "arm64",
      clientLanguage: "zh-CN",
      clientTimezone: "Asia/Shanghai",
      osVersion: "Darwin 25.0.0",
      platform: "darwin",
      releaseChannel: "production",
    });
    expect(headers).toMatchObject({
      "X-Platform": "darwin-arm64",
      "X-Release-Channel": "production",
      "X-Client-Language": "zh-CN",
      "X-Client-Timezone": "Asia/Shanghai",
      "X-Os-Category": "macos",
      "X-Os-Version": "Darwin 25.0.0",
      "X-ZCode-App-Version": "2.14.0",
    });
    expect(headers).not.toHaveProperty("X-Device-Mid");
    expect(headers).not.toHaveProperty("HTTP-Referer");
    expect(headers).not.toHaveProperty("X-Title");
  });
});
