import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTelemetryRuntimeOwner } from "@zody/contracts/telemetry";
import {
  createModelTelemetry,
  parseOtlpHeaders,
  prepareModelTelemetryEnv,
  resolveOtlpMetricEndpoint,
  resolveOtlpTraceEndpoint,
  shutdownPreparedModelTelemetry,
} from "../src/bootstrap.js";
import { NoopAgentExecutionTelemetry } from "../src/agent-trace-runtime.js";

afterEach(async () => {
  await shutdownPreparedModelTelemetry();
});

describe("Telemetry V4 bootstrap", () => {
  it("显式注入的进程 Owner 优先，Session 关闭只 abandon + flush", async () => {
    const execution = new NoopAgentExecutionTelemetry();
    const flush = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {});
    const abandon = vi.spyOn(execution, "abandonSession");
    const owner: AgentTelemetryRuntimeOwner = {
      abandonSession: abandon,
      agentExecution: execution,
      enabled: true,
      flush,
      modelExecution: execution,
      shutdown,
      updateIdentity() {},
    };

    const telemetry = createModelTelemetry({ owner, sessionId: "session-1" });
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.agentExecution).toBe(execution);
    await telemetry.shutdown();
    expect(abandon).toHaveBeenCalledWith("session-1");
    expect(flush).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("disabled 路径不需要 endpoint，也提供安全 Noop Port", async () => {
    const telemetry = createModelTelemetry();
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.agentExecution.captureCausation()).toBeUndefined();
    await telemetry.shutdown();
  });

  it("遵循 OTLP traces/metrics/common endpoint 与 percent-encoded header 规则", () => {
    expect(
      resolveOtlpTraceEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/v1/traces",
      }),
    ).toBe("https://arms.example/v1/traces");
    expect(
      resolveOtlpTraceEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example/otlp/",
      }),
    ).toBe("https://arms.example/otlp/v1/traces");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example/v1/metrics",
      }),
    ).toBe("https://arms.example/v1/metrics");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example/otlp/",
      }),
    ).toBe("https://arms.example/otlp/v1/metrics");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/apm/trace/opentelemetry",
      }),
    ).toBe("https://arms.example/apm/trace/opentelemetry");
    expect(parseOtlpHeaders("x-a=one%2Ctwo,x-b=hello%20world")).toEqual({
      "x-a": "one,two",
      "x-b": "hello world",
    });
  });

  it("uses the new default service name and preserves an explicit OTEL override", async () => {
    const exporter = await import("../src/otlp-exporter.js");
    const create = vi.spyOn(exporter, "createOwnedAgentTelemetryRuntime");
    const home = await mkdtemp(join(tmpdir(), "r46-service-name-"));
    const base = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:1/v1/traces", ZODY_HOME: home };
    try {
      await prepareModelTelemetryEnv(base, {});
      expect(create.mock.calls.at(-1)?.[0].resource.serviceName).toBe("zody-cli-agent");
      await shutdownPreparedModelTelemetry();
      await prepareModelTelemetryEnv({ ...base, OTEL_SERVICE_NAME: "custom-service" }, {});
      expect(create.mock.calls.at(-1)?.[0].resource.serviceName).toBe("custom-service");
    } finally { create.mockRestore(); }
  });

  it("Standalone 异步生成并复用随机 installation id", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-telemetry-"));
    const env = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:1/v1/traces",
      ZODY_HOME: home,
    };
    const [first, second] = await Promise.all([
      prepareModelTelemetryEnv(env, {
        cliVersion: "0.16.1",
        productVersion: "3.6.1",
      }),
      prepareModelTelemetryEnv(env, {
        cliVersion: "0.16.1",
        productVersion: "3.6.1",
      }),
    ]);

    expect(first.ZODY_TELEMETRY_DEVICE_MID).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second.ZODY_TELEMETRY_DEVICE_MID).toBe(first.ZODY_TELEMETRY_DEVICE_MID);
    const state = JSON.parse(await readFile(join(home, "v2", "telemetry-state.json"), "utf8")) as {
      deviceMid: string;
    };
    expect(state.deviceMid).toBe(first.ZODY_TELEMETRY_DEVICE_MID);
  });
});

describe("R30 build commit environment key", () => {
  it.each([
    { name: "only new", env: { ZODY_BUILD_COMMIT_ID: "abcdef1" }, expected: "abcdef1" },
    { name: "only old", env: { ZCODE_BUILD_COMMIT_ID: "1234567" }, expected: undefined },
    {
      name: "both",
      env: { ZODY_BUILD_COMMIT_ID: "abcdef1", ZCODE_BUILD_COMMIT_ID: "1234567" },
      expected: "abcdef1",
    },
    { name: "neither", env: {}, expected: undefined },
  ])("builds the telemetry resource with $name", async ({ env, expected }) => {
    const exporter = await import("../src/otlp-exporter.js");
    const create = vi.spyOn(exporter, "createOwnedAgentTelemetryRuntime").mockReturnValue({
      shutdown: async () => {},
    } as never);
    try {
      await prepareModelTelemetryEnv({
        ...env,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://example.invalid/v1/traces",
        ZCODE_TELEMETRY_DEVICE_MID: "01234567-89ab-4cde-8fab-0123456789ab",
        ZODY_TELEMETRY_DEVICE_MID: "01234567-89ab-4cde-8fab-0123456789ab",
      });
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]?.[0].resource.buildCommitId).toBe(expected);
    } finally {
      await shutdownPreparedModelTelemetry();
      create.mockRestore();
    }
  });
});
