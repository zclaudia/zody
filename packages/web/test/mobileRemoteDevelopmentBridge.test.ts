import { describe, expect, it, vi } from "vitest";
import { MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY } from "@zody/shared";
import { installDevelopmentMobileRemoteBridge } from "../src/mobile-remote/mobileRemoteDevelopmentBridge.js";
import {
  MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX,
  type MobileRemoteDevelopmentStorage,
} from "../src/mobile-remote/mobileRemoteDevelopmentHandoff.js";

function createStorage(initial: Record<string, string> = {}): MobileRemoteDevelopmentStorage {
  const state = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return state.get(key) ?? null;
    },
    setItem(key, value) {
      state.set(key, value);
    },
    removeItem(key) {
      state.delete(key);
    },
  };
}

const CONTEXT = {
  schemaVersion: 1,
  sessionId: "session-dev-1",
  gatewayUrl: "http://localhost:3200",
  namespace: "zody",
  backendId: "backend-a",
  credential: "zgd_test",
  clientInstanceId: "client-instance-1",
  appVersion: "1.2.3",
  bridgeCapabilities: {
    schemaVersion: 1,
    bridgeVersion: 1,
    appVersion: "1.2.3",
    capabilities: ["session-context", "insecure-gateway-transport"],
  },
};

function handoffStorage(context: unknown = CONTEXT) {
  return createStorage({
    [`${MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX}remote-handoff`]: JSON.stringify(context),
  });
}

function parseEnvelope(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("development Remote bridge handoff (M2-T2)", () => {
  it("does not install a bridge without a handoff", () => {
    const target: Record<string, unknown> = {};
    expect(
      installDevelopmentMobileRemoteBridge({ target, storage: createStorage() }),
    ).toBeUndefined();
    expect(target[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]).toBeUndefined();
  });

  it("simulates getSessionContext, bridgeCapabilities and markRemoteReady", () => {
    const target: Record<string, unknown> = {};
    const bridge = installDevelopmentMobileRemoteBridge({
      target,
      storage: handoffStorage(),
    });
    expect(bridge).toBeDefined();
    expect(target[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]).toBe(bridge);

    const contextEnvelope = parseEnvelope(bridge!.getSessionContext());
    expect(contextEnvelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      context: {
        sessionId: "session-dev-1",
        backendId: "backend-a",
        clientInstanceId: "client-instance-1",
        bridgeCapabilities: {
          bridgeVersion: 1,
          capabilities: ["session-context", "insecure-gateway-transport"],
        },
      },
    });
    expect(parseEnvelope(bridge!.markRemoteReady!("session-dev-1"))).toEqual({
      schemaVersion: 1,
      ok: true,
    });
    expect(parseEnvelope(bridge!.markRemoteReady!("stale-session"))).toMatchObject({
      ok: false,
      error: { code: "stale-session" },
    });
  });

  it("fails closed for a corrupt handoff instead of trusting page storage", () => {
    const target: Record<string, unknown> = {};
    const bridge = installDevelopmentMobileRemoteBridge({
      target,
      storage: handoffStorage({ schemaVersion: 1, sessionId: "" }),
    });
    expect(parseEnvelope(bridge!.getSessionContext())).toMatchObject({
      ok: false,
      error: { code: "session-context-invalid" },
    });
  });

  it("returnShell validates the session, clears the handoff and navigates to Shell", () => {
    const target: Record<string, unknown> = {};
    const storage = handoffStorage();
    const navigate = vi.fn();
    const bridge = installDevelopmentMobileRemoteBridge({
      target,
      storage,
      navigate,
    })!;

    bridge.returnShell("settings", "stale-session");
    expect(navigate).not.toHaveBeenCalled();
    expect(
      storage.getItem(`${MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX}remote-handoff`),
    ).not.toBeNull();

    bridge.returnShell("settings", "session-dev-1");
    expect(navigate).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("mobile-shell.html"));
    expect(storage.getItem(`${MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX}remote-handoff`)).toBeNull();
    expect(target[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]).toBeUndefined();
  });

  it("never overrides a bridge already injected by the native shell", () => {
    const nativeBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
    };
    const target: Record<string, unknown> = {
      [MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]: nativeBridge,
    };
    expect(
      installDevelopmentMobileRemoteBridge({
        target,
        storage: handoffStorage(),
      }),
    ).toBeUndefined();
    expect(target[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]).toBe(nativeBridge);
  });
});
