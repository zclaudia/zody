import { describe, expect, it, vi } from "vitest";
import { MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE } from "@zody/shared";
import {
  createDevelopmentMobileRemoteSecureStore,
  createMobileRemoteSecureStore,
  createUnavailableMobileRemoteSecureStore,
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

describe("mobile remote secure store (T4.2)", () => {
  it("release builds fail closed and never localStorage", async () => {
    const store = createUnavailableMobileRemoteSecureStore();

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
    expect(storage.setItem).toHaveBeenCalledWith("zody-mobile-remote:config", "value");
    expect(await store.get("config")).toBe("value");
    await store.remove("config");
    expect(await store.get("config")).toBeNull();
  });

  it("uses the Vite dev branch during tests (jsdom default)", async () => {
    // vitest 的 import.meta.env.PROD 为 false，默认入口应能降级到 localStorage。
    const storage = createStorage();
    const store = createMobileRemoteSecureStore({ storage });

    await store.set("config", "dev-value");
    expect(await store.get("config")).toBe("dev-value");
  });

  it("treats a throwing browser get as unconfigured", async () => {
    const storage = createStorage();
    storage.getItem.mockImplementation(() => {
      throw new Error("private mode");
    });
    const browserStore = createDevelopmentMobileRemoteSecureStore({ storage });
    expect(await browserStore.get("config")).toBeNull();
  });
});
