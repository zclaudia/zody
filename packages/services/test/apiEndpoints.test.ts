import { afterEach, describe, expect, it, vi } from "vitest";

const TEST_ZCODE_ORIGIN = "https://scenes.example.test";

describe("ZCode API endpoints", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("通过统一 ApiClient 注册并请求 client scenes", async () => {
    // fork（F3.1）：endpoint 常量在模块加载时解析，测试必须显式配置后再导入，
    // 避免依赖已删除的官方默认端点。
    vi.stubEnv("ZCODE_ENV", "test");
    vi.stubEnv("ZCODE_BASE_URL", TEST_ZCODE_ORIGIN);
    vi.resetModules();
    const { ZCODE_CLIENT_SCENES_URL } = await import("../src/providers/api/apiEndpoints.js");
    const { createNodeApiClient } = await import("../src/providers/api/nodeApiClient.js");

    const requests: Array<{ headers: Headers; method: string; url: string }> = [];
    const client = createNodeApiClient({
      fetchImpl: async (input, init) => {
        requests.push({
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          url: String(input),
        });
        return new Response('{"code":0,"msg":"","data":[]}', { status: 200 });
      },
      resolveZCodeEndpointOrigin: () => TEST_ZCODE_ORIGIN,
    });

    await client.request(ZCODE_CLIENT_SCENES_URL, { method: "GET" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: `${TEST_ZCODE_ORIGIN}/api/v1/client/scenes`,
    });
    expect(requests[0]?.headers.get("X-ZCode-App-Version")).toBeTruthy();
    expect(requests[0]?.headers.get("X-Platform")).toBe(`${process.platform}-${process.arch}`);
    expect(requests[0]?.headers.get("x-request-id")).toBeTruthy();
  });

  it("fork（F3.1）：未配置端点时不生成相对 URL", async () => {
    vi.stubEnv("ZCODE_ENV", "production");
    vi.stubEnv("ZCODE_BASE_URL", "");
    vi.stubEnv("ZCODE_ENDPOINT_ORIGIN", "");
    vi.stubEnv("ZCODE_PRODUCTION_BASE_URL", "");
    vi.stubEnv("ZCODE_TEST_BASE_URL", "");
    vi.resetModules();
    const { ZCODE_CLIENT_SCENES_URL } = await import("../src/providers/api/apiEndpoints.js");

    expect(ZCODE_CLIENT_SCENES_URL).toBe("");
  });
});
