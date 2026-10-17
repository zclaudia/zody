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
  });
});
