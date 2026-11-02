// @vitest-environment jsdom

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformSecureStore } from "@zcode/shared";
import { saveMobileRemoteSettingsDraft } from "../src/mobile-remote/mobileRemoteSettingsDraft.js";

/**
 * 手机首次使用流程（T4.2）：设置页 → 选电脑页 → 可建连配置。
 *
 * 用真实 UI 组件渲染到手机入口自己的 React 根（`#root`），只注入 fake discovery，
 * 验证配置确实写入 secure store，且 clientInstanceId 按 backendId 持久化。
 */

function createMemorySecureStore(): PlatformSecureStore & { state: Map<string, string> } {
  const state = new Map<string, string>();
  return {
    state,
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

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 812 });
});

describe("mobile remote setup flow (375px)", () => {
  it("goes from settings to backend selection and persists the chosen config", async () => {
    const { MobileRemoteConfigStore } =
      await import("../src/mobile-remote/mobileRemoteConfigStore.js");
    const { resolveMobileRemoteConnection } =
      await import("../src/mobile-remote/mobileRemoteSetup.js");
    const secureStore = createMemorySecureStore();
    const store = new MobileRemoteConfigStore(secureStore, { allowInsecureTransport: true });
    const createBackendDiscovery = vi.fn(
      (options: {
        onUpdate(snapshot: {
          loading: boolean;
          backends: Array<{
            backendId: string;
            name: string;
            online: boolean;
            supported: boolean;
            lastSeenAt: number | null;
          }>;
        }): void;
      }) => {
        options.onUpdate({
          loading: false,
          backends: [
            {
              backendId: "backend-1",
              name: "Studio Mac",
              online: true,
              supported: true,
              lastSeenAt: 1,
            },
          ],
        });
        return () => {};
      },
    );

    const resolved = resolveMobileRemoteConnection(null, {
      store,
      allowUrlConfig: false,
      allowInsecureTransport: true,
      createBackendDiscovery,
    });

    fireEvent.change(await screen.findByLabelText("Gateway address"), {
      target: { value: "http://localhost:3200/" },
    });
    fireEvent.change(screen.getByLabelText("Device credential"), {
      target: { value: "zgd_test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(createBackendDiscovery).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByText("Studio Mac"));
    fireEvent.click(screen.getByText("Connect to this desktop"));

    await expect(resolved).resolves.toEqual({
      gatewayUrl: "http://localhost:3200",
      namespace: "zody",
      credential: "zgd_test",
      backendId: "backend-1",
    });
    expect((await store.load())?.backendId).toBe("backend-1");
  });

  it("returns to settings from the backend picker and keeps the saved scope", async () => {
    const { MobileRemoteConfigStore } =
      await import("../src/mobile-remote/mobileRemoteConfigStore.js");
    const { resolveMobileRemoteConnection } =
      await import("../src/mobile-remote/mobileRemoteSetup.js");
    const secureStore = createMemorySecureStore();
    const store = new MobileRemoteConfigStore(secureStore, { allowInsecureTransport: true });
    await store.save({
      gatewayUrl: "https://gateway.example.com",
      namespace: "zcode",
      credential: "zgd_saved",
    });

    const createBackendDiscovery = vi.fn(
      (options: {
        onUpdate(snapshot: { loading: boolean; backends: Array<Record<string, unknown>> }): void;
      }) => {
        options.onUpdate({ loading: false, backends: [] });
        return () => {};
      },
    );

    const resolved = resolveMobileRemoteConnection(null, {
      store,
      allowUrlConfig: false,
      allowInsecureTransport: true,
      createBackendDiscovery,
    });

    const back = await screen.findByText("Back to settings");
    fireEvent.click(back);
    // 返回设置页后已有凭证显示为「已保存」，直接继续即可重新进入选电脑页。
    expect(
      await screen.findByPlaceholderText("Credential saved; leave empty to keep it"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(createBackendDiscovery).toHaveBeenCalledTimes(2));
    expect((await store.load())?.credential).toBe("zgd_saved");
    expect(resolved).toBeInstanceOf(Promise);
  });
});

/**
 * 首次配置与已连接会话内浮层共用的草稿校验/保存 helper（spec §4.1）。
 * 这里锁定抽取前的 scopeChanged/backendId 保留语义，防止两条写入路径分叉。
 */
describe("shared mobile remote settings draft save helper", () => {
  const savedConfig = {
    gatewayUrl: "https://gateway.example.com",
    namespace: "zody",
    credential: "zgd_saved",
    backendId: "backend-1",
  };

  function createSaveStore() {
    return { save: vi.fn(async () => {}) };
  }

  it("keeps the selected backend when the draft does not change the connection scope", async () => {
    const store = createSaveStore();
    const result = await saveMobileRemoteSettingsDraft({
      store,
      initial: savedConfig,
      draft: {
        // 尾部斜杠经归一化后与原配置相同，不算作用域变化。
        gatewayUrl: "https://gateway.example.com/",
        namespace: "zody",
        credential: "",
      },
      allowInsecureTransport: true,
    });

    expect(result.scopeChanged).toBe(false);
    expect(result.config).toEqual(savedConfig);
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.save).toHaveBeenCalledWith(savedConfig);
  });

  it.each([
    ["gateway", { gatewayUrl: "https://gateway-2.example.com", namespace: "zody", credential: "" }],
    ["namespace", { gatewayUrl: "https://gateway.example.com", namespace: "team", credential: "" }],
    [
      "credential",
      { gatewayUrl: "https://gateway.example.com", namespace: "zody", credential: "zgd_new" },
    ],
  ])("changing the %s drops the old backend and reports scope change", async (_label, draft) => {
    const store = createSaveStore();
    const result = await saveMobileRemoteSettingsDraft({
      store,
      initial: savedConfig,
      draft,
      allowInsecureTransport: true,
    });

    expect(result.scopeChanged).toBe(true);
    expect(result.config).not.toHaveProperty("backendId");
    expect(store.save).toHaveBeenCalledWith(result.config);
  });

  it("rejects an invalid draft without writing to the store", async () => {
    const store = createSaveStore();

    await expect(
      saveMobileRemoteSettingsDraft({
        store,
        initial: savedConfig,
        draft: { gatewayUrl: "ftp://gateway.example.com", namespace: "zody", credential: "" },
        allowInsecureTransport: true,
      }),
    ).rejects.toThrow();
    expect(store.save).not.toHaveBeenCalled();
  });
});
