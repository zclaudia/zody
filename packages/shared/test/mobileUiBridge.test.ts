import { describe, expect, it } from "vitest";
import {
  MOBILE_BRIDGE_ERROR_CODES,
  MOBILE_UI_BRIDGE_SCHEMA_VERSION,
  MOBILE_UI_BRIDGE_V1_CAPABILITIES,
  MOBILE_UI_BRIDGE_VERSION,
  MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY,
  MOBILE_UI_SHELL_BRIDGE_GLOBAL_KEY,
  mobileBridgeFailureSchema,
  mobileBridgeCapabilitiesSchema,
  mobileSessionContextReadResultSchema,
  mobileSessionContextSchema,
  mobileShellBridgeInfoSchema,
  mobileShellConfigReadResultSchema,
  mobileShellConfigSaveResultSchema,
  mobileShellConfigSchema,
  mobileShellConfigWriteSchema,
  mobileShellOperationResultSchema,
  parseMobileBridgeJson,
  parseMobileSessionContext,
  parseMobileShellConfig,
  parseMobileShellConfigWrite,
  resolveMobileRemoteBridge,
  resolveMobileShellBridge,
  type MobileSessionContext,
  type MobileShellBridge,
  type MobileShellConfig,
} from "../src/mobile-ui-bridge.js";
import * as sharedIndex from "../src/index.js";

const CONFIG: MobileShellConfig = {
  schemaVersion: 1,
  gatewayUrl: "https://gateway.example.com",
  namespace: "zody",
  credential: "zgd_test",
  backendId: "backend-a",
  configRevision: 3,
};

const CONTEXT: MobileSessionContext = {
  schemaVersion: 1,
  sessionId: "session-1",
  gatewayUrl: "https://gateway.example.com",
  namespace: "zody",
  backendId: "backend-a",
  credential: "zgd_test",
  clientInstanceId: "client-instance-a",
  appVersion: "3.15.1",
  bridgeCapabilities: {
    schemaVersion: 1,
    bridgeVersion: 1,
    appVersion: "3.15.1",
    capabilities: [...MOBILE_UI_BRIDGE_V1_CAPABILITIES],
  },
};

const release = { allowInsecureTransport: false };
const development = { allowInsecureTransport: true };

describe("mobile-ui-bridge 契约常量", () => {
  it("与 spec 第 7 节保持一致，且经 shared 根入口公开", () => {
    expect(MOBILE_UI_BRIDGE_SCHEMA_VERSION).toBe(1);
    expect(MOBILE_UI_BRIDGE_VERSION).toBe(1);
    expect(MOBILE_UI_SHELL_BRIDGE_GLOBAL_KEY).toBe("ZodyShellBridge");
    expect(MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY).toBe("ZodyRemoteBridge");
    expect(MOBILE_UI_BRIDGE_V1_CAPABILITIES).toEqual([
      "session-context",
      "file-save",
      "file-open",
      "notifications",
      "lifecycle",
    ]);
    expect(sharedIndex.parseMobileShellConfig).toBe(parseMobileShellConfig);
    expect(sharedIndex.parseMobileSessionContext).toBe(parseMobileSessionContext);
    expect(sharedIndex.resolveMobileShellBridge).toBe(resolveMobileShellBridge);
  });

  it("稳定错误码集合不随实现漂移", () => {
    expect(MOBILE_BRIDGE_ERROR_CODES).toEqual([
      "native-bridge-unavailable",
      "invalid-argument",
      "config-unavailable",
      "config-invalid",
      "config-revision-stale",
      "config-write-failed",
      "backend-not-found",
      "backend-remote-control-unsupported",
      "backend-ui-unsupported",
      "open-remote-failed",
      "session-context-invalid",
      "stale-session",
      "bridge-version-unsupported",
      "unsupported-capability",
    ]);
  });
});

describe("MobileShellConfig schema", () => {
  it("接受完整配置并保留 configRevision", () => {
    expect(mobileShellConfigSchema.parse(CONFIG)).toEqual(CONFIG);
  });

  it.each(["schemaVersion", "gatewayUrl", "namespace", "credential", "configRevision"])(
    "缺少字段 %s 时拒绝",
    (field) => {
      const candidate: Record<string, unknown> = { ...CONFIG };
      delete candidate[field];
      expect(mobileShellConfigSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it("backendId 可省略，用于「尚未选择电脑」", () => {
    const { backendId: _backendId, ...withoutBackendId } = CONFIG;
    expect(mobileShellConfigSchema.safeParse(withoutBackendId).success).toBe(true);
  });

  it("拒绝额外字段，配置字段不得由页面自行扩展", () => {
    expect(mobileShellConfigSchema.safeParse({ ...CONFIG, extra: true }).success).toBe(false);
  });

  it("configRevision 必须是非负安全整数", () => {
    for (const configRevision of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(mobileShellConfigSchema.safeParse({ ...CONFIG, configRevision }).success).toBe(false);
    }
    expect(mobileShellConfigSchema.safeParse({ ...CONFIG, configRevision: 0 }).success).toBe(true);
  });

  it("release 拒绝 http，开发模式允许 http 并归一化地址", () => {
    expect(
      parseMobileShellConfig(
        { ...CONFIG, gatewayUrl: "http://localhost:3200/", namespace: " " },
        release,
      ),
    ).toBeUndefined();
    expect(
      parseMobileShellConfig(
        { ...CONFIG, gatewayUrl: "http://localhost:3200/", namespace: " " },
        development,
      ),
    ).toEqual({
      ...CONFIG,
      gatewayUrl: "http://localhost:3200",
      namespace: "zody",
    });
  });

  it("凭证必须是 zgd_ 前缀，backendId 为空时视为未选择", () => {
    expect(parseMobileShellConfig({ ...CONFIG, credential: "zgb_x" }, release)).toBeUndefined();
    expect(parseMobileShellConfig({ ...CONFIG, backendId: "" }, release)).toEqual({
      schemaVersion: 1,
      gatewayUrl: "https://gateway.example.com",
      namespace: "zody",
      credential: "zgd_test",
      configRevision: 3,
    });
  });
});

describe("MobileShellConfigWrite schema", () => {
  it("写入草稿不携带 configRevision，由原生配置 store 递增", () => {
    expect(
      parseMobileShellConfigWrite(
        {
          gatewayUrl: "https://gateway.example.com/",
          namespace: "zody",
          credential: "zgd_test",
          backendId: "backend-a",
        },
        release,
      ),
    ).toEqual({
      gatewayUrl: "https://gateway.example.com",
      namespace: "zody",
      credential: "zgd_test",
      backendId: "backend-a",
    });
    expect(
      mobileShellConfigWriteSchema.safeParse({ ...CONFIG, configRevision: 1 }).success,
    ).toBe(false);
  });
});

describe("MobileSessionContext schema", () => {
  it("接受完整上下文，并要求按 backend 持久化的 clientInstanceId", () => {
    expect(mobileSessionContextSchema.parse(CONTEXT)).toEqual(CONTEXT);
    const { clientInstanceId: _removed, ...withoutClientInstanceId } = CONTEXT;
    expect(mobileSessionContextSchema.safeParse(withoutClientInstanceId).success).toBe(false);
  });

  it("拒绝额外字段，但保留 additive capability 扩展", () => {
    expect(mobileSessionContextSchema.safeParse({ ...CONTEXT, extra: true }).success).toBe(false);
    expect(
      mobileSessionContextSchema.safeParse({
        ...CONTEXT,
        bridgeCapabilities: {
          ...CONTEXT.bridgeCapabilities,
          capabilities: ["session-context", "future-capability"],
        },
      }).success,
    ).toBe(true);
  });

  it("解析时禁止 release 明文 gateway", () => {
    expect(parseMobileSessionContext(CONTEXT, release)?.gatewayUrl).toBe(
      "https://gateway.example.com",
    );
    expect(
      parseMobileSessionContext(
        { ...CONTEXT, gatewayUrl: "http://localhost:3200" },
        release,
      ),
    ).toBeUndefined();
    expect(
      parseMobileSessionContext(
        { ...CONTEXT, gatewayUrl: "http://localhost:3200" },
        development,
      )?.gatewayUrl,
    ).toBe("http://localhost:3200");
  });

  it("bridge capabilities 去重且版本为正整数", () => {
    expect(
      mobileBridgeCapabilitiesSchema.safeParse({
        schemaVersion: 1,
        bridgeVersion: 0,
        appVersion: "3.15.1",
        capabilities: ["session-context"],
      }).success,
    ).toBe(false);
    expect(
      mobileBridgeCapabilitiesSchema.safeParse({
        schemaVersion: 1,
        bridgeVersion: 1,
        appVersion: "3.15.1",
        capabilities: ["session-context", "session-context"],
      }).success,
    ).toBe(false);
  });
});

describe("bridge JSON 结果 envelope", () => {
  it("按 ok 区分成功与稳定错误码", () => {
    expect(
      mobileShellConfigReadResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        config: CONFIG,
      }),
    ).toEqual({ schemaVersion: 1, ok: true, config: CONFIG });
    expect(
      mobileShellConfigReadResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        config: null,
      }),
    ).toEqual({ schemaVersion: 1, ok: true, config: null });
    expect(
      mobileBridgeFailureSchema.parse({
        schemaVersion: 1,
        ok: false,
        error: { code: "config-revision-stale", message: "config changed" },
      }),
    ).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "config-revision-stale", message: "config changed" },
    });
  });

  it("拒绝未知错误码和缺失 envelope 版本", () => {
    expect(
      mobileBridgeFailureSchema.safeParse({
        schemaVersion: 1,
        ok: false,
        error: { code: "made-up" },
      }).success,
    ).toBe(false);
    expect(
      mobileBridgeFailureSchema.safeParse({
        ok: false,
        error: { code: "config-invalid" },
      }).success,
    ).toBe(false);
  });

  it("配置保存、操作、bridge info 与 session context envelope 均严格校验", () => {
    expect(
      mobileShellConfigSaveResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        config: CONFIG,
      }).config,
    ).toEqual(CONFIG);
    expect(mobileShellOperationResultSchema.parse({ schemaVersion: 1, ok: true })).toEqual({
      schemaVersion: 1,
      ok: true,
    });
    expect(
      mobileShellBridgeInfoSchema.parse({
        schemaVersion: 1,
        bridgeVersion: 1,
        appVersion: "3.15.1",
        allowsInsecureGatewayTransport: false,
      }).bridgeVersion,
    ).toBe(1);
    expect(
      mobileSessionContextReadResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        context: CONTEXT,
      }).context,
    ).toEqual(CONTEXT);
  });

  it("parseMobileBridgeJson 对损坏 JSON 或 schema 不匹配抛出可诊断错误", () => {
    expect(
      parseMobileBridgeJson(
        JSON.stringify({ schemaVersion: 1, ok: true }),
        mobileShellOperationResultSchema,
      ),
    ).toEqual({ schemaVersion: 1, ok: true });
    expect(() => parseMobileBridgeJson("{not-json", mobileShellOperationResultSchema)).toThrow(
      /mobile bridge JSON/i,
    );
    expect(() => parseMobileBridgeJson("{}", mobileShellOperationResultSchema)).toThrow(
      /mobile bridge JSON/i,
    );
  });
});

describe("bridge 发现", () => {
  function createShellBridge(): MobileShellBridge {
    return {
      readConfig: () => JSON.stringify({ schemaVersion: 1, ok: true, config: null }),
      saveConfig: () => JSON.stringify({ schemaVersion: 1, ok: true, config: CONFIG }),
      clearConfig: () => JSON.stringify({ schemaVersion: 1, ok: true }),
      openRemote: () => JSON.stringify({ schemaVersion: 1, ok: true }),
      getBridgeInfo: () =>
        JSON.stringify({
          schemaVersion: 1,
          bridgeVersion: 1,
          appVersion: "3.15.1",
          allowsInsecureGatewayTransport: false,
        }),
      getDiagnostics: () =>
        JSON.stringify({
          schemaVersion: 1,
          ok: true,
          diagnostics: { schemaVersion: 1, configRevision: 3 },
        }),
    };
  }

  it("只接受方法齐全的 ZodyShellBridge / ZodyRemoteBridge", () => {
    const shellBridge = createShellBridge();
    expect(
      resolveMobileShellBridge({ [MOBILE_UI_SHELL_BRIDGE_GLOBAL_KEY]: shellBridge }),
    ).toBe(shellBridge);
    expect(
      resolveMobileShellBridge({ [MOBILE_UI_SHELL_BRIDGE_GLOBAL_KEY]: { readConfig: () => "{}" } }),
    ).toBeUndefined();
    expect(resolveMobileShellBridge({})).toBeUndefined();

    const remoteBridge = {
      getSessionContext: () => JSON.stringify({ schemaVersion: 1, ok: true, context: CONTEXT }),
      returnShell: () => {},
    };
    expect(
      resolveMobileRemoteBridge({ [MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]: remoteBridge }),
    ).toBe(remoteBridge);
    expect(
      resolveMobileRemoteBridge({ [MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]: { returnShell: () => {} } }),
    ).toBeUndefined();
  });
});
