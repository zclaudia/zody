import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_REMOTE_INSECURE_GATEWAY_TRANSPORT_CAPABILITY,
  MobileRemoteSessionContextError,
  isMobileRemoteSessionBackend,
  readMobileRemoteSessionContext,
  resolveMobileRemoteAllowInsecureTransport,
} from "../src/mobile-remote/mobileRemoteSessionContext.js";

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    gatewayUrl: "https://gateway.example.invalid",
    namespace: "zody",
    backendId: "backend-1",
    credential: "zgd_test",
    clientInstanceId: "client-instance-1",
    appVersion: "1.2.3",
    bridgeCapabilities: {
      schemaVersion: 1,
      bridgeVersion: 1,
      appVersion: "1.2.3",
      capabilities: ["session-context", "file-save", "file-open", "notifications", "lifecycle"],
    },
    ...overrides,
  };
}

function createBridge(result: unknown) {
  return {
    getSessionContext: vi.fn(() => JSON.stringify(result)),
    returnShell: vi.fn(),
  };
}

describe("Remote 只读 session context", () => {
  it("严格解析 ZodyRemoteBridge.getSessionContext 并返回只读会话", () => {
    const bridge = createBridge({ schemaVersion: 1, ok: true, context: createContext() });

    const session = readMobileRemoteSessionContext({
      bridge,
      isProduction: true,
    });

    expect(bridge.getSessionContext).toHaveBeenCalledOnce();
    expect(session.context).toMatchObject({
      sessionId: "session-1",
      gatewayUrl: "https://gateway.example.invalid",
      backendId: "backend-1",
      credential: "zgd_test",
      clientInstanceId: "client-instance-1",
      appVersion: "1.2.3",
    });
    expect(session.allowInsecureTransport).toBe(false);
  });

  it("缺少 bridge 时 fail closed，不使用 URL/localStorage 降级", () => {
    expect(() =>
      readMobileRemoteSessionContext({ target: {}, isProduction: true }),
    ).toThrowError(
      expect.objectContaining({
        name: "MobileRemoteSessionContextError",
        code: "native-bridge-unavailable",
      }),
    );
  });

  it("JSON 损坏或 schema 不匹配时 fail closed", () => {
    expect(() =>
      readMobileRemoteSessionContext({
        bridge: { getSessionContext: () => "{not-json", returnShell: vi.fn() },
        isProduction: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "session-context-invalid" }));

    expect(() =>
      readMobileRemoteSessionContext({
        bridge: createBridge({
          schemaVersion: 1,
          ok: true,
          context: createContext({ credential: "not-a-device-credential" }),
        }),
        isProduction: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "session-context-invalid" }));
  });

  it("保留原生稳定错误码（stale-session 等）", () => {
    const bridge = createBridge({
      schemaVersion: 1,
      ok: false,
      error: { code: "stale-session" },
    });

    expect(() =>
      readMobileRemoteSessionContext({ bridge, isProduction: true }),
    ).toThrowError(expect.objectContaining({ code: "stale-session" }));
  });

  it("bridgeVersion 与当前页面不兼容时要求升级 APK", () => {
    const bridge = createBridge({
      schemaVersion: 1,
      ok: true,
      context: createContext({
        bridgeCapabilities: {
          schemaVersion: 1,
          bridgeVersion: 2,
          appVersion: "1.2.3",
          capabilities: ["session-context"],
        },
      }),
    });

    expect(() =>
      readMobileRemoteSessionContext({ bridge, isProduction: true }),
    ).toThrowError(expect.objectContaining({ code: "bridge-version-unsupported" }));
  });

  it("缺少 session-context 能力时 fail closed", () => {
    const bridge = createBridge({
      schemaVersion: 1,
      ok: true,
      context: createContext({
        bridgeCapabilities: {
          schemaVersion: 1,
          bridgeVersion: 1,
          appVersion: "1.2.3",
          capabilities: ["file-save"],
        },
      }),
    });

    expect(() =>
      readMobileRemoteSessionContext({ bridge, isProduction: true }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-capability" }));
  });

  it("Release 构建拒绝 HTTP Gateway；Debug capability 是唯一放宽来源", () => {
    const httpContext = createContext({ gatewayUrl: "http://gateway.example.invalid" });
    const releaseBridge = createBridge({ schemaVersion: 1, ok: true, context: httpContext });
    expect(() =>
      readMobileRemoteSessionContext({ bridge: releaseBridge, isProduction: true }),
    ).toThrowError(expect.objectContaining({ code: "session-context-invalid" }));

    const debugBridge = createBridge({
      schemaVersion: 1,
      ok: true,
      context: createContext({
        gatewayUrl: "http://gateway.example.invalid",
        bridgeCapabilities: {
          schemaVersion: 1,
          bridgeVersion: 1,
          appVersion: "1.2.3",
          capabilities: ["session-context", MOBILE_REMOTE_INSECURE_GATEWAY_TRANSPORT_CAPABILITY],
        },
      }),
    });
    expect(
      readMobileRemoteSessionContext({ bridge: debugBridge, isProduction: true })
        .allowInsecureTransport,
    ).toBe(true);
  });

  it("只在生产构建或 Debug capability 下允许 HTTP", () => {
    expect(
      resolveMobileRemoteAllowInsecureTransport({ capabilities: [], isProduction: false }),
    ).toBe(true);
    expect(
      resolveMobileRemoteAllowInsecureTransport({ capabilities: [], isProduction: true }),
    ).toBe(false);
    expect(
      resolveMobileRemoteAllowInsecureTransport({
        capabilities: [MOBILE_REMOTE_INSECURE_GATEWAY_TRANSPORT_CAPABILITY],
        isProduction: true,
      }),
    ).toBe(true);
  });

  it("backend 不匹配可以 fail closed", () => {
    expect(isMobileRemoteSessionBackend({ backendId: "backend-1" }, "backend-1")).toBe(true);
    expect(isMobileRemoteSessionBackend({ backendId: "backend-1" }, "backend-2")).toBe(false);
  });

  it("错误对象不携带凭证", () => {
    try {
      readMobileRemoteSessionContext({
        bridge: { getSessionContext: () => "{not-json", returnShell: vi.fn() },
        isProduction: true,
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MobileRemoteSessionContextError);
      expect(JSON.stringify(error)).not.toContain("zgd_");
    }
  });
});
