import { describe, expect, it, vi } from "vitest";
import { MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE } from "@zcode/shared";
import {
  createDevelopmentMobileRemoteSecureStore,
  createMobileRemoteSecureStore,
  createNativeMobileRemoteSecureStore,
  resolveMobileRemoteNativeBridge,
} from "../src/mobile-remote/mobileRemoteSecureStore.js";

function createStorage(initial: Record<string, string> = {}) {
  const state = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => state.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      state.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      state.delete(key);
    }),
    state,
  };
}

function createNativeBridge() {
  const state = new Map<string, string>();
  return {
    native: {
      get: vi.fn((key: string) => state.get(key) ?? null),
      set: vi.fn((key: string, value: string) => {
        state.set(key, value);
      }),
      remove: vi.fn((key: string) => {
        state.delete(key);
      }),
    },
    state,
  };
}

describe("mobile remote secure store (T4.2)", () => {
  it("production implementation uses the native bridge and never localStorage", async () => {
    const { native } = createNativeBridge();
    const storage = createStorage();
    // 生产实现不接收 storage；直接验证它只依赖 native bridge。
    const store = createNativeMobileRemoteSecureStore({ secureStore: native });

    expect(await store.get("config")).toBeNull();
    await store.set("config", "value");
    expect(await store.get("config")).toBe("value");
    await store.remove("config");
    expect(await store.get("config")).toBeNull();
    expect(native.get).toHaveBeenCalledWith("config");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("refuses to save credentials in release builds without a native bridge", async () => {
    const store = createNativeMobileRemoteSecureStore();

    expect(await store.get("config")).toBeNull();
    await expect(store.set("config", "zgd_secret")).rejects.toThrow(
      MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE,
    );
    await expect(store.remove("config")).rejects.toThrow(
      MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE,
    );
  });

  it("development implementation falls back to namespaced localStorage", async () => {
    const storage = createStorage();
    const store = createDevelopmentMobileRemoteSecureStore({ storage });

    await store.set("config", "value");
    expect(storage.setItem).toHaveBeenCalledWith("zcode-mobile-remote:config", "value");
    expect(await store.get("config")).toBe("value");
    await store.remove("config");
    expect(await store.get("config")).toBeNull();
  });

  it("development implementation prefers the native bridge when present", async () => {
    const { native } = createNativeBridge();
    const storage = createStorage();
    const store = createDevelopmentMobileRemoteSecureStore({
      bridge: { secureStore: native },
      storage,
    });

    await store.set("config", "native");
    expect(native.set).toHaveBeenCalledWith("config", "native");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("uses the Vite dev branch during tests (jsdom default) without a bridge", async () => {
    // vitest 的 import.meta.env.PROD 为 false，默认入口应能降级到 localStorage。
    const storage = createStorage();
    const store = createMobileRemoteSecureStore({ storage });

    await store.set("config", "dev-value");
    expect(await store.get("config")).toBe("dev-value");
  });

  it("treats a throwing native/browser get as unconfigured", async () => {
    const nativeStore = createNativeMobileRemoteSecureStore({
      secureStore: {
        get: () => {
          throw new Error("keystore unavailable");
        },
        set: () => {},
        remove: () => {},
      },
    });
    expect(await nativeStore.get("config")).toBeNull();

    const storage = createStorage();
    storage.getItem.mockImplementation(() => {
      throw new Error("private mode");
    });
    const browserStore = createDevelopmentMobileRemoteSecureStore({ storage });
    expect(await browserStore.get("config")).toBeNull();
  });

  it("normalizes the Kotlin flat @JavascriptInterface shape", async () => {
    // Android 的 @JavascriptInterface 只能暴露平铺方法（T6.2）；
    // resolveMobileRemoteNativeBridge 负责归一化成 secureStore.get/set/remove。
    const state = new Map<string, string>();
    const target = {
      ZcodeMobileBridge: {
        secureStoreGet: (key: string) => state.get(key) ?? null,
        secureStoreSet: (key: string, value: string) => {
          state.set(key, value);
        },
        secureStoreRemove: (key: string) => {
          state.delete(key);
        },
      },
    };

    const bridge = resolveMobileRemoteNativeBridge(target);
    expect(bridge?.secureStore).toBeDefined();

    const store = createNativeMobileRemoteSecureStore(bridge);
    await store.set("config", "zgd_native");
    expect(await store.get("config")).toBe("zgd_native");
    await store.remove("config");
    expect(await store.get("config")).toBeNull();
  });

  it("detects only complete native bridge shapes", () => {
    expect(resolveMobileRemoteNativeBridge({})).toBeUndefined();
    expect(
      resolveMobileRemoteNativeBridge({ ZcodeMobileBridge: { secureStore: {} } }),
    ).toBeUndefined();
    expect(
      resolveMobileRemoteNativeBridge({
        ZcodeMobileBridge: {
          secureStore: { get: () => null, set: () => {}, remove: () => {} },
        },
      }),
    ).toBeDefined();
    // 平铺形状缺一个方法时同样视为没有桥，release 构建会拒绝保存凭证。
    expect(
      resolveMobileRemoteNativeBridge({
        ZcodeMobileBridge: {
          secureStoreGet: () => null,
          secureStoreSet: () => {},
        },
      }),
    ).toBeUndefined();
  });
});
