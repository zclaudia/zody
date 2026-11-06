import { describe, expect, it } from "vitest";
import {
  ZODY_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  ZODY_REMOTE_HTTP_PROXY_ENV_KEY,
  ZODY_REMOTE_NO_PROXY_ENV_KEY,
  ZODY_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  buildZodyToolEnvPassthroughEnv,
  getCapturedZodyCuaBrokerCredentials,
  isCuaDevModeRequested,
  isZodyCuaInternalFeatureEnabled,
  readZodyAgentTelemetryEnv,
  readZodyToolEnvPassthroughEnv,
  resetCapturedZodyCuaBrokerCredentialsForTest,
  sanitizeZodyRuntimeEnv,
  getCapturedZodyAgentTelemetryEnv,
  resetCapturedZodyAgentTelemetryEnvForTest,
} from "../src/runtimeEnv.js";

describe("runtimeEnv", () => {
  it("enables internal CUA by default while honoring explicit false values", () => {
    expect(isZodyCuaInternalFeatureEnabled({})).toBe(true);
    expect(isZodyCuaInternalFeatureEnabled({ ZODY_CUA_PRODUCT_HELPER: "0" })).toBe(false);
    expect(isZodyCuaInternalFeatureEnabled({ ZODY_CUA_PRODUCT_HELPER: "false" })).toBe(false);
    expect(isZodyCuaInternalFeatureEnabled({ ZODY_CUA_PRODUCT_HELPER: "1" })).toBe(true);
    expect(isZodyCuaInternalFeatureEnabled({ ZODY_CUA_PRODUCT_HELPER: " TRUE " })).toBe(true);
    expect(isZodyCuaInternalFeatureEnabled({ ZODY_CUA_PRODUCT_HELPER: "on" })).toBe(true);
  });

  it("ZODY_CUA_DEV_MODE is the one-knob dev bundle and implies the internal feature flag", () => {
    // isCuaDevModeRequested: only explicit truthy values (case-insensitive, trimmed).
    expect(isCuaDevModeRequested({})).toBe(false);
    expect(isCuaDevModeRequested({ ZODY_CUA_DEV_MODE: "0" })).toBe(false);
    expect(isCuaDevModeRequested({ ZODY_CUA_DEV_MODE: "false" })).toBe(false);
    expect(isCuaDevModeRequested({ ZODY_CUA_DEV_MODE: "1" })).toBe(true);
    expect(isCuaDevModeRequested({ ZODY_CUA_DEV_MODE: " ON " })).toBe(true);
    expect(isCuaDevModeRequested({ ZODY_CUA_DEV_MODE: "true" })).toBe(true);

    // DEV_MODE implies the internal feature flag without needing ZODY_CUA_PRODUCT_HELPER,
    // collapsing the historical multi-var dev incantation to one knob.
    expect(isZodyCuaInternalFeatureEnabled({ ZODY_CUA_DEV_MODE: "1" })).toBe(true);
    expect(isZodyCuaInternalFeatureEnabled({ ZODY_CUA_PRODUCT_HELPER: "1" })).toBe(true);
    expect(isZodyCuaInternalFeatureEnabled({})).toBe(true);
  });

  it("sanitizes runtime env while sealing user network env for tools", () => {
    const sourceEnv = {
      HTTP_PROXY: "http://proxy.example:8080",
      NODE_ENV: "development",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      PATH: "/usr/bin:/bin",
      npm_config_proxy: "http://npm-proxy.example:8080",
    };

    const sanitized = sanitizeZodyRuntimeEnv(sourceEnv);
    const passthroughEnv = buildZodyToolEnvPassthroughEnv(sourceEnv);
    const captured = readZodyToolEnvPassthroughEnv(passthroughEnv);

    expect(sanitized).toEqual({ PATH: "/usr/bin:/bin" });
    expect(passthroughEnv[ZODY_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeDefined();
    expect(captured).toEqual({
      HTTP_PROXY: "http://proxy.example:8080",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      npm_config_proxy: "http://npm-proxy.example:8080",
    });
  });

  it("drops the legacy sealed envelope while the new envelope still restores network values", () => {
    const source = {
      ZCODE_TOOL_ENV_PASSTHROUGH_JSON: JSON.stringify({ HTTP_PROXY: "http://old.invalid" }),
      ZODY_TOOL_ENV_PASSTHROUGH_JSON: JSON.stringify({ HTTP_PROXY: "http://new.invalid" }),
    };
    expect(sanitizeZodyRuntimeEnv(source)).not.toHaveProperty("ZCODE_TOOL_ENV_PASSTHROUGH_JSON");
    expect(readZodyToolEnvPassthroughEnv(source)).toEqual({ HTTP_PROXY: "http://new.invalid" });
  });

  it("ignores invalid passthrough JSON and non-network keys", () => {
    const captured = readZodyToolEnvPassthroughEnv({
      [ZODY_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
        HTTP_PROXY: "http://proxy.example:8080",
        NODE_ENV: "production",
        PATH: "/tmp/bin",
      }),
    });

    expect(captured).toEqual({
      HTTP_PROXY: "http://proxy.example:8080",
    });
    expect(
      readZodyToolEnvPassthroughEnv({
        [ZODY_TOOL_ENV_PASSTHROUGH_ENV_KEY]: "not-json",
      }),
    ).toEqual({});
  });

  it("strips the CUA broker socket/authority/refresh marker from child env and tool passthrough", () => {
    // Confused-deputy 防护：broker bearer 凭据只该定向注入目标 zcode-cua server，绝不能随全局 env
    // 泄漏给其它 MCP / Bash / tool 子进程，也不能经 tool-env-passthrough 恢复。
    const sourceEnv = {
      PATH: "/usr/bin:/bin",
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/zcode-cua-me/broker-abc.sock",
      ZODY_CUA_PERMISSION_BROKER_SOCKET: "/tmp/zcode-cua-me/broker-abc.sock",
      ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER:
        "/tmp/zcode-cua-me/broker-abc.sock.permission-refresh.json",
      ZODY_CUA_PERMISSION_BROKER_REFRESH_MARKER:
        "/tmp/zcode-cua-me/broker-abc.sock.permission-refresh.json",
    };
    const sanitized = sanitizeZodyRuntimeEnv(sourceEnv);
    expect(sanitized).toEqual({ PATH: "/usr/bin:/bin" });

    const captured = readZodyToolEnvPassthroughEnv(buildZodyToolEnvPassthroughEnv(sourceEnv));
    expect(captured).not.toHaveProperty("ZODY_CUA_PERMISSION_BROKER_SOCKET");
    expect(captured).not.toHaveProperty("ZCODE_CUA_PERMISSION_BROKER_SOCKET");
    expect(captured).not.toHaveProperty("ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER");
    expect(captured).not.toHaveProperty("ZODY_CUA_PERMISSION_BROKER_REFRESH_MARKER");
  });

  it("strips desktop-to-remote network handoff values after stdio bootstrap", () => {
    const sourceEnv = {
      PATH: "/usr/bin:/bin",
      [ZODY_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
      [ZODY_REMOTE_HTTP_PROXY_ENV_KEY]: "http://172.21.240.1:7890",
      [ZODY_REMOTE_NO_PROXY_ENV_KEY]: "localhost,127.0.0.1",
    };

    expect(sanitizeZodyRuntimeEnv(sourceEnv)).toEqual({ PATH: "/usr/bin:/bin" });
    expect(readZodyToolEnvPassthroughEnv(buildZodyToolEnvPassthroughEnv(sourceEnv))).toEqual({});
  });

  it("captures broker credentials as one atomic pair and clears stale state on partial rotation", () => {
    resetCapturedZodyCuaBrokerCredentialsForTest();
    try {
      sanitizeZodyRuntimeEnv({
        ZODY_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-a.sock",
        ZODY_CUA_PLUGIN_AUTHORITY: "authority-a",
      });
      expect(getCapturedZodyCuaBrokerCredentials()).toEqual({
        socket: "/tmp/broker-a.sock",
        pluginAuthority: "authority-a",
      });

      sanitizeZodyRuntimeEnv({
        ZODY_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-b.sock",
      });
      expect(getCapturedZodyCuaBrokerCredentials()).toEqual({
        socket: undefined,
        pluginAuthority: undefined,
      });

      sanitizeZodyRuntimeEnv({
        ZODY_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-b.sock",
        ZODY_CUA_PLUGIN_AUTHORITY: "authority-b",
      });
      expect(getCapturedZodyCuaBrokerCredentials()).toEqual({
        socket: "/tmp/broker-b.sock",
        pluginAuthority: "authority-b",
      });
    } finally {
      resetCapturedZodyCuaBrokerCredentialsForTest();
    }
  });

  it("captures Agent OTLP config privately and never passes auth or identity through to tools", () => {
    resetCapturedZodyAgentTelemetryEnvForTest();
    const sourceEnv = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example.com/v1/metrics",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=metric-secret",
      PATH: "/usr/bin:/bin",
      ZODY_TELEMETRY_USER_SUBJECT_ID: "opaque-user",
    };
    expect(sanitizeZodyRuntimeEnv(sourceEnv)).toEqual({ PATH: "/usr/bin:/bin" });
    expect(getCapturedZodyAgentTelemetryEnv()).toMatchObject({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example.com/v1/metrics",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=metric-secret",
      ZODY_TELEMETRY_USER_SUBJECT_ID: "opaque-user",
    });
    const toolEnv = readZodyToolEnvPassthroughEnv(buildZodyToolEnvPassthroughEnv(sourceEnv));
    expect(toolEnv).not.toHaveProperty("OTEL_EXPORTER_OTLP_TRACES_HEADERS");
    expect(toolEnv).not.toHaveProperty("OTEL_EXPORTER_OTLP_METRICS_HEADERS");
    expect(toolEnv).not.toHaveProperty("ZCODE_TELEMETRY_USER_SUBJECT_ID");
    expect(toolEnv).not.toHaveProperty("ZODY_TELEMETRY_USER_SUBJECT_ID");
  });

  it("extracts only the allowlisted Agent telemetry env", () => {
    expect(
      readZodyAgentTelemetryEnv({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: " https://arms.example.com/v1/traces ",
        OTEL_UNKNOWN_SECRET: "must-not-pass",
        PATH: "/bin",
        ZODY_MODEL_TELEMETRY_ENABLED: "1",
        ZODY_TELEMETRY_RUNTIME_DISTRIBUTION: " packaged ",
      }),
    ).toEqual({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      ZODY_MODEL_TELEMETRY_ENABLED: "1",
      ZODY_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
    });
  });
});

describe("R30 telemetry capture and sensitive-key isolation", () => {
  it.each([
    {
      name: "only new",
      env: { ZODY_TELEMETRY_RUNTIME_SURFACE: "cli" },
      expected: { ZODY_TELEMETRY_RUNTIME_SURFACE: "cli" },
    },
    { name: "only old", env: { ZCODE_TELEMETRY_RUNTIME_SURFACE: "legacy" }, expected: {} },
    {
      name: "both",
      env: { ZODY_TELEMETRY_RUNTIME_SURFACE: "cli", ZCODE_TELEMETRY_RUNTIME_SURFACE: "legacy" },
      expected: { ZODY_TELEMETRY_RUNTIME_SURFACE: "cli" },
    },
    { name: "neither", env: {}, expected: {} },
  ])("captures only active telemetry config with $name", ({ env, expected }) => {
    expect(readZodyAgentTelemetryEnv(env)).toEqual(expected);
  });

  it("strips both legacy and renamed broker credentials from runtime and tool passthrough", () => {
    const env = {
      ZCODE_CUA_PERMISSION_BROKER_TOKEN: "synthetic-old-token",
      ZODY_CUA_PERMISSION_BROKER_TOKEN: "synthetic-new-token",
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/synthetic/old.sock",
      ZODY_CUA_PERMISSION_BROKER_SOCKET: "/synthetic/new.sock",
    };
    const sanitized = sanitizeZodyRuntimeEnv(env);
    const passthrough = readZodyToolEnvPassthroughEnv(buildZodyToolEnvPassthroughEnv(env));
    for (const key of Object.keys(env)) {
      expect(sanitized).not.toHaveProperty(key);
      expect(passthrough).not.toHaveProperty(key);
    }
  });
});
