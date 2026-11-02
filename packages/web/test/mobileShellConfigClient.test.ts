import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_UI_BRIDGE_SCHEMA_VERSION,
  type MobileShellBridge,
  type MobileShellConfig,
  type PlatformSecureStore,
} from "@zcode/shared";
import {
  MOBILE_SHELL_DEVELOPMENT_CONFIG_REVISION_KEY,
  MobileShellBridgeError,
  createDevelopmentMobileShellBridgeInfo,
  createMobileShellConfigClient,
  openMobileShellBackend,
  readMobileShellBridgeInfo,
  resolveMobileShellRuntimeMode,
} from "../src/mobile-shell/mobileShellConfigClient.js";

function createMemorySecureStore(initial: Record<string, string> = {}): PlatformSecureStore {
  const state = new Map(Object.entries(initial));
  return {
    async get(key) {
      return state.get(key) ?? null;
    },
    async set(key, value) {
      state.set(key, value);
    },
    async remove(key) {
      state.delete(key);
    },
  };
}

function createNativeBridge(initialConfig: MobileShellConfig | null = null) {
  let config = initialConfig;
  let revision = initialConfig?.configRevision ?? 0;
  const calls: Array<{
    type: "save" | "clear" | "openRemote";
    payload?: Record<string, unknown>;
    backendId?: string;
    expectedConfigRevision?: number;
  }> = [];
  const bridge: MobileShellBridge = {
    readConfig: () => JSON.stringify({ schemaVersion: 1, ok: true, config }),
    saveConfig: (inputJson) => {
      const write = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push({ type: "save", payload: write });
      revision += 1;
      config = {
        schemaVersion: 1,
        gatewayUrl: String(write.gatewayUrl),
        namespace: String(write.namespace),
        credential: String(write.credential),
        ...(typeof write.backendId === "string" ? { backendId: write.backendId } : {}),
        configRevision: revision,
      };
      return JSON.stringify({ schemaVersion: 1, ok: true, config });
    },
    clearConfig: () => {
      calls.push({ type: "clear" });
      config = null;
      revision += 1;
      return JSON.stringify({ schemaVersion: 1, ok: true });
    },
    openRemote: (backendId, expectedConfigRevision) => {
      calls.push({ type: "openRemote", backendId, expectedConfigRevision });
      return JSON.stringify(
        expectedConfigRevision === revision
          ? { schemaVersion: 1, ok: true }
          : {
              schemaVersion: 1,
              ok: false,
              error: { code: "config-revision-stale", message: "revision changed" },
            },
      );
    },
    getBridgeInfo: () =>
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        info: {
          schemaVersion: 1,
          bridgeVersion: 1,
          appVersion: "3.15.1",
          allowsInsecureGatewayTransport: false,
        },
      }),
    getDiagnostics: () =>
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        diagnostics: { schemaVersion: 1, configRevision: revision },
      }),
  };
  return { bridge, calls, getRevision: () => revision };
}

const CONFIG: MobileShellConfig = {
  schemaVersion: 1,
  gatewayUrl: "https://gateway.example.com",
  namespace: "zody",
  credential: "zgd_test",
  backendId: "backend-a",
  configRevision: 4,
};

describe("Shell runtime mode", () => {
  it("native bridge 优先；生产缺少 bridge 时不可用；开发模式允许降级", () => {
    const { bridge } = createNativeBridge();
    expect(resolveMobileShellRuntimeMode({ bridge, isProduction: true })).toBe("native");
    expect(resolveMobileShellRuntimeMode({ bridge: undefined, isProduction: true })).toBe(
      "unavailable",
    );
    expect(resolveMobileShellRuntimeMode({ bridge: undefined, isProduction: false })).toBe(
      "development",
    );
  });

  it("native 模式缺少 bridge 时立即 fail closed", () => {
    expect(() =>
      createMobileShellConfigClient({ mode: "native", allowInsecureTransport: false }),
    ).toThrowError(MobileShellBridgeError);
  });

  it("bridge info 严格校验版本字段", () => {
    const { bridge } = createNativeBridge();
    expect(readMobileShellBridgeInfo(bridge)).toEqual({
      schemaVersion: 1,
      bridgeVersion: 1,
      appVersion: "3.15.1",
      allowsInsecureGatewayTransport: false,
    });
    expect(createDevelopmentMobileShellBridgeInfo().allowsInsecureGatewayTransport).toBe(true);
  });
});

describe("native Shell config client", () => {
  it("读取持久配置与 configRevision", async () => {
    const { bridge } = createNativeBridge(CONFIG);
    const client = createMobileShellConfigClient({
      mode: "native",
      bridge,
      allowInsecureTransport: false,
    });

    expect(await client.read()).toEqual(CONFIG);
    expect(await client.load()).toEqual({
      gatewayUrl: CONFIG.gatewayUrl,
      namespace: CONFIG.namespace,
      credential: CONFIG.credential,
      backendId: CONFIG.backendId,
    });
  });

  it("保存草稿时发送不含 configRevision 的写格式，并采用原生返回的新 revision", async () => {
    const { bridge, calls } = createNativeBridge();
    const client = createMobileShellConfigClient({
      mode: "native",
      bridge,
      allowInsecureTransport: false,
    });

    const saved = await client.save({
      gatewayUrl: "https://gateway.example.com/",
      namespace: "zody",
      credential: "zgd_test",
      backendId: "backend-a",
    });

    expect(saved).toEqual({
      schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
      gatewayUrl: "https://gateway.example.com",
      namespace: "zody",
      credential: "zgd_test",
      backendId: "backend-a",
      configRevision: 1,
    });
    expect(calls[0]?.type).toBe("save");
    expect(calls[0]?.payload).not.toHaveProperty("configRevision");
  });

  it("openRemote 使用最新 revision；revision 过期返回 stale 且由原生拒绝导航", async () => {
    const { bridge, calls } = createNativeBridge(CONFIG);
    const client = createMobileShellConfigClient({
      mode: "native",
      bridge,
      allowInsecureTransport: false,
    });

    await expect(openMobileShellBackend(client, "backend-a")).resolves.toEqual({
      kind: "opened",
    });
    expect(calls.at(-1)).toEqual({
      type: "openRemote",
      backendId: "backend-a",
      expectedConfigRevision: 4,
    });

    await expect(client.openRemote("backend-a", 3)).resolves.toMatchObject({
      kind: "stale",
    });
  });

  it("backend 在读取后被替换时不导航，按 stale 处理", async () => {
    const { bridge, calls } = createNativeBridge({ ...CONFIG, backendId: "backend-b" });
    const client = createMobileShellConfigClient({
      mode: "native",
      bridge,
      allowInsecureTransport: false,
    });

    await expect(openMobileShellBackend(client, "backend-a")).resolves.toMatchObject({
      kind: "stale",
    });
    expect(calls.some((call) => call.type === "openRemote")).toBe(false);
  });

  it("损坏 JSON 或失败 envelope 映射为稳定错误码", async () => {
    const broken: MobileShellBridge = {
      ...createNativeBridge().bridge,
      readConfig: () => "{not-json",
    };
    const client = createMobileShellConfigClient({
      mode: "native",
      bridge: broken,
      allowInsecureTransport: false,
    });
    await expect(client.read()).rejects.toMatchObject({ code: "config-invalid" });

    const rejected: MobileShellBridge = {
      ...createNativeBridge().bridge,
      readConfig: () =>
        JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "config-invalid" } }),
    };
    const rejectedClient = createMobileShellConfigClient({
      mode: "native",
      bridge: rejected,
      allowInsecureTransport: false,
    });
    await expect(rejectedClient.read()).rejects.toMatchObject({ code: "config-invalid" });
  });
});

describe("development Shell config client", () => {
  it("递增开发期 configRevision，并把 openRemote 降级为带 URL 参数的 Remote 导航", async () => {
    const secureStore = createMemorySecureStore();
    const navigate = vi.fn();
    const client = createMobileShellConfigClient({
      mode: "development",
      allowInsecureTransport: true,
      secureStore,
      navigate,
    });

    const first = await client.save({
      gatewayUrl: "http://localhost:3200/",
      namespace: "zody",
      credential: "zgd_test",
    });
    expect(first.configRevision).toBe(1);
    const second = await client.save({
      gatewayUrl: first.gatewayUrl,
      namespace: first.namespace,
      credential: first.credential,
      backendId: "backend-a",
    });
    expect(second.configRevision).toBe(2);
    await expect(secureStore.get(MOBILE_SHELL_DEVELOPMENT_CONFIG_REVISION_KEY)).resolves.toBe("2");

    await expect(client.openRemote("backend-a", 1)).resolves.toMatchObject({ kind: "stale" });
    expect(navigate).not.toHaveBeenCalled();

    await expect(client.openRemote("backend-a", 2)).resolves.toEqual({ kind: "opened" });
    expect(navigate).toHaveBeenCalledOnce();
    const url = new URL(navigate.mock.calls[0]![0]);
    expect(url.pathname.endsWith("/mobile.html")).toBe(true);
    expect(url.searchParams.get("gateway")).toBe("http://localhost:3200");
    expect(url.searchParams.get("credential")).toBe("zgd_test");
    expect(url.searchParams.get("backend")).toBe("backend-a");
  });

  it("清除配置也递增 revision，并回到未配置状态", async () => {
    const secureStore = createMemorySecureStore();
    const client = createMobileShellConfigClient({
      mode: "development",
      allowInsecureTransport: true,
      secureStore,
      navigate: () => {},
    });

    await client.save({
      gatewayUrl: "https://gateway.example.com",
      namespace: "zody",
      credential: "zgd_test",
      backendId: "backend-a",
    });
    await client.clear();

    expect(await client.read()).toBeNull();
    expect(await secureStore.get(MOBILE_SHELL_DEVELOPMENT_CONFIG_REVISION_KEY)).toBe("2");
  });
});
