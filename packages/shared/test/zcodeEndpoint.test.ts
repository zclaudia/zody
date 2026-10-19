import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  buildRuntimeZCodeApiUrl,
  normalizeZCodeEndpointOrigin,
  resolveRuntimeZCodeEndpointOrigin,
  resolveRuntimeZCodeEnv,
  resolveZCodeEndpointOrigin,
  rewriteZCodeEndpointUrl,
} from "../src/zcodeEndpoint.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("zcodeEndpoint", () => {
  it("fork（F3.1）：默认端点为空表示未配置，测试端点使用保留占位域名", () => {
    // 默认端点不再指向官方地址；空字符串是唯一「未配置」语义。
    expect(DEFAULT_ZCODE_ENDPOINT_ORIGIN).toBe("");
    // 测试环境不再复用官方地址；example.invalid 是 RFC 2606 保留域名，不会被解析到真实服务。
    expect(TEST_ZCODE_ENDPOINT_ORIGIN).toBe("https://example.invalid");
  });

  it("keeps production unconfigured unless an explicit env base url is provided", () => {
    expect(resolveZCodeEndpointOrigin({ env: "production" })).toBe(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
    expect(resolveRuntimeZCodeEndpointOrigin({ ZCODE_ENV: "production" })).toBe("");
  });

  it("falls back to the test placeholder in non-production without env base url", () => {
    expect(resolveZCodeEndpointOrigin({ env: "test" })).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
    expect(resolveRuntimeZCodeEndpointOrigin({ ZCODE_ENV: "test" })).toBe(
      TEST_ZCODE_ENDPOINT_ORIGIN,
    );
  });

  it("uses explicit ZCODE_BASE_URL style env base in both environments", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        envBaseOrigin: "https://zcode.example.test/api/v1",
      }),
    ).toBe("https://zcode.example.test");
    expect(
      resolveZCodeEndpointOrigin({
        env: "production",
        envBaseOrigin: "https://zcode.example.test/api/v1",
      }),
    ).toBe("https://zcode.example.test");
  });

  it("resolves the runtime env selection without implying an endpoint", () => {
    // 生产默认只表示「环境选择」，不再意味着官方地址；端点仍需显式配置。
    expect(resolveRuntimeZCodeEnv({})).toBe("production");
    expect(resolveRuntimeZCodeEnv({ ZCODE_ENV: "test" })).toBe("test");
    expect(resolveRuntimeZCodeEndpointOrigin({})).toBe("");
  });

  it("keeps the non-production settings override above env base url", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        envBaseOrigin: "https://zcode.example.test",
        overrideOrigin: "http://localhost:3030/api/v1",
      }),
    ).toBe("http://localhost:3030");
  });

  it("uses a non-production override after normalizing to origin", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        overrideOrigin: `${TEST_ZCODE_ENDPOINT_ORIGIN}/api/v1/ignored?x=1`,
      }),
    ).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
  });

  it("ignores overrides in production", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "production",
        envBaseOrigin: "https://zcode.example.test",
        overrideOrigin: "https://override.example.test",
      }),
    ).toBe("https://zcode.example.test");
  });

  it("builds runtime API urls from the selected environment", () => {
    expect(buildRuntimeZCodeApiUrl({ ZCODE_ENV: "test" }, "/api/v1/client/scenes")).toBe(
      `${TEST_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/scenes`,
    );
    expect(
      buildRuntimeZCodeApiUrl(
        { ZCODE_ENV: "test", ZCODE_BASE_URL: "http://localhost:3030/x" },
        "/health",
      ),
    ).toBe("http://localhost:3030/health");
    // 未配置端点时不拼接相对路径（相对 URL 会被 Node fetch 当成非法地址）。
    expect(buildRuntimeZCodeApiUrl({ ZCODE_ENV: "production" }, "/api/v1/client/scenes")).toBe("");
    expect(
      buildRuntimeZCodeApiUrl(
        { ZCODE_ENV: "production", ZCODE_BASE_URL: "https://zcode.example.test/x" },
        "/health",
      ),
    ).toBe("https://zcode.example.test/health");
  });

  it("does not rewrite requests when the default source origin is unconfigured", () => {
    // fork（F3.1）：DEFAULT 为空后不再存在「官方默认 origin → 活动 origin」的隐式改写，
    // 调用方必须直接用当前 endpoint 构造 URL。
    expect(
      rewriteZCodeEndpointUrl(
        "https://zcode.example.test/api/v1/event/report?x=1",
        "http://localhost:3030",
      ),
    ).toBe("https://zcode.example.test/api/v1/event/report?x=1");
  });

  it("rewrites only the explicitly configured source origin", () => {
    expect(
      rewriteZCodeEndpointUrl(
        "https://zcode.example.test/api/v1/event/report?x=1",
        "http://localhost:3030",
        { sourceOrigin: "https://zcode.example.test" },
      ),
    ).toBe("http://localhost:3030/api/v1/event/report?x=1");
    expect(
      rewriteZCodeEndpointUrl(
        "https://other.example.test/api/v1/event/report",
        "http://localhost:3030",
        { sourceOrigin: "https://zcode.example.test" },
      ),
    ).toBe("https://other.example.test/api/v1/event/report");
    // 目标端点为「未配置」时保持原地址，不产生相对 URL。
    expect(
      rewriteZCodeEndpointUrl("https://zcode.example.test/api/v1/event/report", "", {
        sourceOrigin: "https://zcode.example.test",
      }),
    ).toBe("https://zcode.example.test/api/v1/event/report");
  });

  it("rejects empty and non-http endpoint origins", () => {
    expect(() => normalizeZCodeEndpointOrigin("   ")).toThrow(/empty/);
    expect(() => normalizeZCodeEndpointOrigin("file:///tmp/zcode")).toThrow(/http or https/);
    expect(normalizeZCodeEndpointOrigin("https://zcode.example.test/path?x=1")).toBe(
      "https://zcode.example.test",
    );
  });

  it("persists optional endpoint override in app settings", () => {
    expect(
      appSettingsSchema.parse({ zcodeEndpointOrigin: "https://zcode.example.test/path" })
        .zcodeEndpointOrigin,
    ).toBe("https://zcode.example.test");
    expect(
      appSettingsPatchSchema.parse({ zcodeEndpointOrigin: "http://localhost:3030/foo" })
        .zcodeEndpointOrigin,
    ).toBe("http://localhost:3030");
  });
});
