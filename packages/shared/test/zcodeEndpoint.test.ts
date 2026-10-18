import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  buildRuntimeZCodeApiUrl,
  normalizeZCodeEndpointOrigin,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZCodeEndpointOrigin,
  rewriteZCodeEndpointUrl,
} from "../src/zcodeEndpoint.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("zcodeEndpoint", () => {
  it("defaults to the scoped origin in every env without env base url", () => {
    expect(resolveZCodeEndpointOrigin({ env: "test" })).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
    expect(resolveZCodeEndpointOrigin({ env: "production" })).toBe(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  });

  it("uses ZCODE_BASE_URL style env base as the default endpoint", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        envBaseOrigin: "https://zcode.z.ai/api/v1",
      }),
    ).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
    expect(
      resolveZCodeEndpointOrigin({
        env: "production",
        envBaseOrigin: "https://zcode.z.ai/api/v1",
      }),
    ).toBe(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  });

  it("keeps the non-production settings override above env base url", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        envBaseOrigin: "https://zcode.z.ai",
        overrideOrigin: "http://localhost:3030/api/v1",
      }),
    ).toBe("http://localhost:3030");
  });

  it("uses a non-production override after normalizing to origin", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        overrideOrigin: "https://zcode.z.ai/api/v1/ignored?x=1",
      }),
    ).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
  });

  it("ignores overrides in production", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "production",
        envBaseOrigin: "https://zcode.z.ai",
        overrideOrigin: "https://zcode.z.ai",
      }),
    ).toBe(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  });

  it("builds runtime API urls from the selected environment", () => {
    expect(buildRuntimeZCodeApiUrl({ ZCODE_ENV: "test" }, "/api/v1/client/scenes")).toBe(
      "https://zcode.z.ai/api/v1/client/scenes",
    );
    expect(
      buildRuntimeZCodeApiUrl({ ZCODE_ENV: "test", ZCODE_BASE_URL: "http://localhost:3030/x" }, "/health"),
    ).toBe("http://localhost:3030/health");
    expect(resolveRuntimeZCodeEndpointOrigin({ ZCODE_ENV: "production" })).toBe(
      DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    );
  });

  it("rewrites only the default ZCode origin", () => {
    expect(
      rewriteZCodeEndpointUrl("https://zcode.z.ai/api/v1/event/report?x=1", "http://localhost:3030"),
    ).toBe("http://localhost:3030/api/v1/event/report?x=1");
    expect(
      rewriteZCodeEndpointUrl("https://example.com/api/v1/event/report", "http://localhost:3030"),
    ).toBe("https://example.com/api/v1/event/report");
    expect(
      rewriteZCodeEndpointUrl("https://zcode.z.ai/api/v1/event/report", "https://zcode.z.ai"),
    ).toBe("https://zcode.z.ai/api/v1/event/report");
  });

  it("rejects non-http endpoint origins", () => {
    expect(() => normalizeZCodeEndpointOrigin("file:///tmp/zcode")).toThrow(/http or https/);
  });

  it("persists optional endpoint override in app settings", () => {
    expect(
      appSettingsSchema.parse({ zcodeEndpointOrigin: "https://zcode.z.ai/path" })
        .zcodeEndpointOrigin,
    ).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
    expect(
      appSettingsPatchSchema.parse({ zcodeEndpointOrigin: "http://localhost:3030/foo" })
        .zcodeEndpointOrigin,
    ).toBe("http://localhost:3030");
  });
});
