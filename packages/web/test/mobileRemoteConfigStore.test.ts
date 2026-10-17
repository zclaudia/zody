import { describe, expect, it } from "vitest";
import {
  MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE,
  type PlatformSecureStore,
} from "@zcode/shared";
import {
  MobileRemoteConfigStore,
  parseMobileRemoteGatewayConfig,
  validateMobileRemoteGatewayConfig,
} from "../src/mobile-remote/mobileRemoteConfigStore.js";

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

const development = { allowInsecureTransport: true };
const release = { allowInsecureTransport: false };

describe("mobile remote config store (T4.2)", () => {
  it("normalizes the gateway URL and defaults the namespace", async () => {
    const secureStore = createMemorySecureStore();
    const store = new MobileRemoteConfigStore(secureStore, development);
    await store.save({
      gatewayUrl: " HTTP://Localhost:3200/ ",
      namespace: " ",
      credential: " zgd_abc ",
      backendId: "backend-1",
    });

    expect(await store.load()).toEqual({
      gatewayUrl: "http://localhost:3200",
      namespace: "zcode",
      credential: "zgd_abc",
      backendId: "backend-1",
    });
  });

  it("requires https and a zgd_ credential in release builds", () => {
    expect(
      parseMobileRemoteGatewayConfig(
        {
          gatewayUrl: "http://gateway.example.com",
          credential: "zgd_abc",
        },
        release,
      ),
    ).toBeUndefined();
    expect(() =>
      validateMobileRemoteGatewayConfig(
        { gatewayUrl: "https://gateway.example.com", credential: "zgb_abc" },
        release,
      ),
    ).toThrow("zgd_");
    expect(
      validateMobileRemoteGatewayConfig(
        { gatewayUrl: "https://gateway.example.com", credential: "zgd_abc" },
        release,
      ),
    ).toMatchObject({ gatewayUrl: "https://gateway.example.com", namespace: "zcode" });
  });

  it("treats corrupt or invalid stored values as unconfigured", async () => {
    const corrupt = new MobileRemoteConfigStore(
      createMemorySecureStore({ config: "{not-json" }),
      development,
    );
    expect(await corrupt.load()).toBeNull();

    const invalid = new MobileRemoteConfigStore(
      createMemorySecureStore({
        config: JSON.stringify({ gatewayUrl: "ftp://gateway", credential: "zgd_x" }),
      }),
      development,
    );
    expect(await invalid.load()).toBeNull();
  });

  it("refuses writes when the platform has no secure store", async () => {
    const store = new MobileRemoteConfigStore(undefined, development);
    expect(await store.load()).toBeNull();
    await expect(
      store.save({
        gatewayUrl: "https://gateway.example.com",
        namespace: "zcode",
        credential: "zgd_abc",
      }),
    ).rejects.toThrow(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
  });

  it("persists one clientInstanceId per backend", async () => {
    const store = new MobileRemoteConfigStore(createMemorySecureStore(), development);
    const first = await store.getClientInstanceId("backend-a");
    const again = await store.getClientInstanceId("backend-a");
    const other = await store.getClientInstanceId("backend-b");

    expect(first).toBeTruthy();
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });
});
