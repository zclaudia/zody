import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteBridge, MobileSessionContext } from "@zcode/shared";
import type {
  MobileUiReleaseController,
  MobileUiReleaseControllerOptions,
} from "../src/mobile-remote/mobileUiReleaseController.js";
import {
  beginMobileRemoteFileOperation,
  hasActiveMobileRemoteFileOperation,
} from "../src/mobile-remote/mobileRemoteFileBridge.js";
import { createMobileRemoteReleaseRuntime } from "../src/mobile-remote/mobileUiReleaseRuntime.js";
import {
  createMobileUiRefreshGuardRegistry,
  type MobileUiRefreshGuardRegistry,
} from "../src/mobile-remote/mobileUiRefreshGuards.js";

const uiState = vi.hoisted(() => ({
  installed: undefined as unknown,
  installCalls: 0,
  uninstallCalls: 0,
}));

vi.mock("@zcode/ui", () => ({
  installMobileRemoteRefreshGuardRegistry: (registry: unknown) => {
    uiState.installed = registry;
    uiState.installCalls += 1;
    return () => {
      if (uiState.installed === registry) uiState.installed = undefined;
      uiState.uninstallCalls += 1;
    };
  },
}));

const releaseId = "0123456789abcdef01234567";
const manifest = {
  schemaVersion: 1 as const,
  releaseId,
  desktopVersion: "0.1.0",
  supportedBridgeVersions: [1],
  entry: "/assets/remote/index.html",
  assetDigest: "a".repeat(64),
};

const session = {
  sessionId: "session-1",
  gatewayUrl: "https://gateway.test",
  namespace: "zcode",
  backendId: "backend-1",
  credential: "zgd_test",
  clientInstanceId: "client-1",
  appVersion: "1.0.0",
  bridgeCapabilities: {
    schemaVersion: 1,
    bridgeVersion: 1,
    appVersion: "1.0.0",
    capabilities: ["session-context"],
  },
} as unknown as MobileSessionContext;

function createFakeController(
  options: MobileUiReleaseControllerOptions,
): MobileUiReleaseController & {
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  checkNow: ReturnType<typeof vi.fn>;
  notifyBusinessReconnect: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn();
  const dispose = vi.fn();
  const checkNow = vi.fn(() => Promise.resolve());
  const notifyBusinessReconnect = vi.fn();
  return {
    guards: options.guards!,
    start,
    dispose,
    checkNow,
    notifyBusinessReconnect,
    requestSafeReload: vi.fn(async () => ({
      kind: "not-ready" as const,
      status: { kind: "idle" as const },
    })),
    getStatus: () => ({ kind: "idle" as const }),
    subscribe: () => () => {},
  };
}

function createHarness(
  overrides: {
    bridge?: MobileRemoteBridge;
    guards?: MobileUiRefreshGuardRegistry;
    isProduction?: boolean;
    fetcher?: typeof fetch;
    reload?: () => void;
  } = {},
) {
  let controllerOptions: MobileUiReleaseControllerOptions | undefined;
  let controller: ReturnType<typeof createFakeController> | undefined;
  const runtime = createMobileRemoteReleaseRuntime({
    session,
    ...(overrides.bridge ? { bridge: overrides.bridge } : {}),
    isProduction: overrides.isProduction ?? false,
    ...(overrides.fetcher ? { fetcher: overrides.fetcher } : {}),
    ...(overrides.reload ? { reload: overrides.reload } : {}),
    ...(overrides.guards ? { guards: overrides.guards } : {}),
    createController(options) {
      controllerOptions = options;
      controller = createFakeController(options);
      return controller;
    },
  });
  return {
    runtime,
    get options() {
      return controllerOptions!;
    },
    get controller() {
      return controller!;
    },
  };
}

afterEach(() => {
  uiState.installed = undefined;
  uiState.installCalls = 0;
  uiState.uninstallCalls = 0;
  vi.unstubAllGlobals();
});

describe("mobile release controller installation boundary", () => {
  it("only the mobile Remote bootstrap installs the controller", () => {
    const ordinaryWebEntry = readFileSync(
      resolve(process.cwd(), "packages/web/src/main.tsx"),
      "utf8",
    );
    expect(ordinaryWebEntry).not.toContain("mobileUiReleaseRuntime");
    expect(ordinaryWebEntry).not.toContain("bootstrapGatewayWebRemoteControl");

    const mobileBootstrap = readFileSync(
      resolve(process.cwd(), "packages/web/src/mobile-remote/bootstrap.tsx"),
      "utf8",
    );
    expect(mobileBootstrap).toContain("createMobileRemoteReleaseRuntime");
    expect(mobileBootstrap).toContain("releaseRuntime.start()");
    expect(mobileBootstrap).toContain("releaseRuntime.notifyBusinessReconnect()");
    expect(mobileBootstrap).toContain("releaseRuntime.dispose()");
  });
});

describe("createMobileRemoteReleaseRuntime", () => {
  it("installs one controller/registry and starts only once with an immediate check", () => {
    const harness = createHarness();
    expect(uiState.installCalls).toBe(1);
    expect(uiState.installed).toBe(harness.runtime.guards);

    harness.runtime.start();
    harness.runtime.start();
    expect(harness.controller.start).toHaveBeenCalledOnce();
    expect(harness.controller.checkNow).toHaveBeenCalledOnce();
    expect(harness.controller.checkNow).toHaveBeenCalledWith("visible");
  });

  it("does not notify business reconnect before start, and forwards after start", () => {
    const harness = createHarness();
    harness.runtime.notifyBusinessReconnect();
    expect(harness.controller.notifyBusinessReconnect).not.toHaveBeenCalled();

    harness.runtime.start();
    harness.runtime.notifyBusinessReconnect();
    expect(harness.controller.notifyBusinessReconnect).toHaveBeenCalledOnce();
  });

  it("disposes controller, clears guards and uninstalls the UI registry idempotently", () => {
    const guards = createMobileUiRefreshGuardRegistry();
    const harness = createHarness({ guards });
    const release = guards.register({ id: "draft", getBlockReason: () => "composer-draft" });
    expect(guards.evaluate().allowed).toBe(false);

    harness.runtime.dispose();
    harness.runtime.dispose();
    expect(harness.controller.dispose).toHaveBeenCalledOnce();
    expect(uiState.uninstallCalls).toBe(1);
    expect(uiState.installed).toBeUndefined();
    expect(guards.evaluate().allowed).toBe(true);
    release();
  });

  it("registers the file operation guard from the file bridge tracker", () => {
    const guards = createMobileUiRefreshGuardRegistry();
    createHarness({ guards });
    expect(guards.evaluate().allowed).toBe(true);

    const release = beginMobileRemoteFileOperation();
    expect(hasActiveMobileRemoteFileOperation()).toBe(true);
    expect(guards.evaluate().reasons).toEqual(["file-operation"]);

    release();
    expect(hasActiveMobileRemoteFileOperation()).toBe(false);
    expect(guards.evaluate().allowed).toBe(true);
  });
});

describe("prepareReload adapter", () => {
  it("parses shared ready/native-busy/stale-session envelopes", async () => {
    const ready: MobileRemoteBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
      prepareReload: () => JSON.stringify({ schemaVersion: 1, ok: true, status: "ready" }),
    };
    const busy: MobileRemoteBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
      prepareReload: () =>
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: { code: "native-busy" },
        }),
    };
    const stale: MobileRemoteBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
      prepareReload: () =>
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: { code: "stale-session" },
        }),
    };

    expect(await createHarness({ bridge: ready }).options.prepareReload("s", "r")).toEqual({
      kind: "ready",
    });
    expect(await createHarness({ bridge: busy }).options.prepareReload("s", "r")).toEqual({
      kind: "native-busy",
    });
    expect(await createHarness({ bridge: stale }).options.prepareReload("s", "r")).toEqual({
      kind: "stale-session",
    });
  });

  it("treats a missing method, thrown bridge call and unknown payload as unsupported", async () => {
    const withoutMethod: MobileRemoteBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
    };
    const throwing: MobileRemoteBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
      prepareReload: () => {
        throw new Error("native failure");
      },
    };
    const unknown: MobileRemoteBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
      prepareReload: () => JSON.stringify({ ok: true }),
    };

    expect(await createHarness({ bridge: withoutMethod }).options.prepareReload("s", "r")).toEqual({
      kind: "unsupported",
    });
    expect(await createHarness({ bridge: throwing }).options.prepareReload("s", "r")).toEqual({
      kind: "unsupported",
    });
    expect(await createHarness({ bridge: unknown }).options.prepareReload("s", "r")).toEqual({
      kind: "unsupported",
    });
  });
});

describe("fetch/reload adapters", () => {
  it("uses the shared release DTO for polling", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const harness = createHarness({ fetcher });

    await expect(harness.options.fetchRelease()).resolves.toEqual({
      kind: "observed",
      manifest,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      "/api/proxy/backend-1/mobile-ui/release",
    );
  });

  it("defaults reload to window.location.reload()", () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    const harness = createHarness();
    harness.options.reload({ releaseId, manifest });
    expect(reload).toHaveBeenCalledOnce();
  });
});
