import { describe, expect, it, vi } from "vitest";
import {
  createMobileNotificationPlatform,
  disableGatewayNotificationSubscription,
  syncGatewayNotificationSubscription,
} from "../src/mobile-remote/mobileRemoteNotifications.js";

function success(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, ok: true, ...extra });
}

function failure(code: string): string {
  return JSON.stringify({ schemaVersion: 1, ok: false, error: { code } });
}

describe("native notification capability", () => {
  it("keeps ordinary web unsupported and validates cold click data", async () => {
    expect(createMobileNotificationPlatform({}, { sessionId: "session-1" })).toBeUndefined();
    const native = {
      notificationGetPendingClick: vi.fn((_sessionId: string) =>
        success({ click: { backendId: "b", notificationId: "n" } }),
      ),
      notificationSyncSubscription: vi.fn((_sessionId: string, _config: string) =>
        success({ status: { status: "ready" } }),
      ),
      notificationAcknowledgeClick: vi.fn(() => success()),
      notificationGetStatus: vi.fn((_sessionId: string) =>
        success({ status: { status: "ready" } }),
      ),
      notificationRequestPermission: vi.fn(() => success()),
      notificationShow: vi.fn(() => success({ shown: true })),
      notificationSetActiveTarget: vi.fn(() => success()),
    };
    const capability = createMobileNotificationPlatform(
      { ZodyRemoteBridge: native },
      { sessionId: "session-1" },
    )!;
    expect(await capability.getPendingClick()).toEqual({ backendId: "b", notificationId: "n" });
    expect(native.notificationGetPendingClick).toHaveBeenCalledWith("session-1");
    await capability.setActiveTarget?.("target");
    expect(native.notificationSetActiveTarget).toHaveBeenCalledWith("session-1", "target");
    native.notificationGetPendingClick.mockReturnValue(
      success({ click: { backendId: "b", notificationId: "" } }),
    );
    expect(await capability.getPendingClick()).toBeNull();
  });

  it("所有原生通知调用都携带当前 sessionId", async () => {
    const native = {
      notificationGetPendingClick: vi.fn(() => success({ click: null })),
      notificationSyncSubscription: vi.fn(() => success({ status: { status: "ready" } })),
      notificationAcknowledgeClick: vi.fn(() => success()),
      notificationGetStatus: vi.fn(() => success({ status: { status: "ready" } })),
      notificationRequestPermission: vi.fn(() => success()),
      notificationShow: vi.fn(() => success({ shown: true })),
      notificationGetPendingAction: vi.fn(() => success({ action: null })),
      notificationAcknowledgeAction: vi.fn(() => success()),
      notificationCancel: vi.fn(() => success()),
    };
    const capability = createMobileNotificationPlatform(
      { ZodyRemoteBridge: native },
      { sessionId: "session-1" },
    )!;

    await capability.syncSubscription({
      enabled: true,
      backendId: "b",
      ntfyUrl: "https://gateway.example.invalid",
      topic: "push-b",
      authToken: "token",
    });
    await capability.getStatus();
    await capability.acknowledgeClick("n");
    await capability.requestPermission();
    await capability.show({ title: "t", body: "b" });
    await capability.getPendingAction?.();
    await capability.acknowledgeAction?.("n");
    await capability.cancel?.("n");

    expect(native.notificationSyncSubscription).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
    );
    expect(native.notificationGetStatus).toHaveBeenCalledWith("session-1");
    expect(native.notificationAcknowledgeClick).toHaveBeenCalledWith("session-1", "n");
    expect(native.notificationRequestPermission).toHaveBeenCalledWith("session-1");
    expect(native.notificationShow).toHaveBeenCalledWith("session-1", expect.any(String));
    expect(native.notificationGetPendingAction).toHaveBeenCalledWith("session-1");
    expect(native.notificationAcknowledgeAction).toHaveBeenCalledWith("session-1", "n");
    expect(native.notificationCancel).toHaveBeenCalledWith("session-1", "n");
  });

  it("forwards permission changes and only exposes transport capabilities the shell implements", () => {
    let permissionListener: ((granted: boolean) => void) | undefined;
    const dispose = vi.fn();
    const native = {
      notificationGetPendingClick: vi.fn(() => success({ click: null })),
      notificationSyncSubscription: vi.fn(() => success({ status: { status: "ready" } })),
      notificationAcknowledgeClick: vi.fn(() => success()),
      notificationGetStatus: vi.fn(() => success({ status: { status: "ready" } })),
      notificationRequestPermission: vi.fn(() => success()),
      notificationShow: vi.fn(() => success({ shown: true })),
    };
    const capability = createMobileNotificationPlatform(
      { ZodyRemoteBridge: native },
      {
        sessionId: "session-1",
        subscribePermission: (listener) => {
          permissionListener = listener;
          return dispose;
        },
      },
    )!;

    const statusListener = vi.fn();
    expect(capability.onStatusChanged).toBeDefined();
    const unsubscribe = capability.onStatusChanged!(statusListener);
    permissionListener?.(true);
    expect(statusListener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();

    // 旧壳没有 action/cancel 方法时，页面必须保持能力缺失（快速路径提示升级），不能假装成功。
    expect(capability.getPendingAction).toBeUndefined();
    expect(capability.acknowledgeAction).toBeUndefined();
    expect(capability.cancel).toBeUndefined();
  });

  it("parses only fully-formed pending actions from the native slot", async () => {
    const native = {
      notificationGetPendingClick: vi.fn(() => success({ click: null })),
      notificationSyncSubscription: vi.fn(() => success({ status: { status: "ready" } })),
      notificationAcknowledgeClick: vi.fn(() => success()),
      notificationGetStatus: vi.fn(() => success({ status: { status: "ready" } })),
      notificationRequestPermission: vi.fn(() => success()),
      notificationGetPendingAction: vi.fn(() =>
        success({
          action: {
            backendId: "b",
            notificationId: "n",
            optionId: "opt",
            optionKind: "escalate",
          },
        }),
      ),
      notificationAcknowledgeAction: vi.fn(() => success()),
    };
    const capability = createMobileNotificationPlatform(
      { ZodyRemoteBridge: native },
      { sessionId: "session-1" },
    )!;

    expect(await capability.getPendingAction?.()).toBeNull();
  });

  it("supports statusRaw and degrades failure envelopes to an explicit error", async () => {
    const native = {
      notificationGetPendingClick: vi.fn(() => success({ click: null })),
      notificationSyncSubscription: vi.fn(() => success({ statusRaw: '{"status":"disabled"}' })),
      notificationAcknowledgeClick: vi.fn(() => failure("stale-session")),
      notificationGetStatus: vi.fn(() => failure("stale-session")),
      notificationRequestPermission: vi.fn(() => success()),
      notificationSetActiveTarget: vi.fn(() => success()),
    };
    const capability = createMobileNotificationPlatform(
      { ZodyRemoteBridge: native },
      { sessionId: "session-1" },
    )!;

    await expect(
      capability.syncSubscription({
        enabled: false,
        backendId: "b",
        ntfyUrl: "https://gateway.example.invalid",
        topic: "push-b",
        authToken: "",
      }),
    ).resolves.toEqual({ status: "disabled" });
    await expect(capability.getStatus()).resolves.toEqual({ status: "error" });
    await expect(capability.acknowledgeClick("n")).rejects.toMatchObject({
      code: "stale-session",
    });
  });

  it("syncs a scoped Gateway root alias without exporting ntfy credentials", async () => {
    const syncSubscription = vi.fn().mockResolvedValue({ status: "ready" });
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          version: 1,
          enabled: true,
          transportBasePath: "",
          topic: "push-b",
          authMode: "bearer",
        },
      }),
    });
    await syncGatewayNotificationSubscription({
      gatewayUrl: "https://gateway.example.invalid",
      backendId: "b",
      credential: "test-device",
      platform: { syncSubscription } as any,
      fetcher,
    });
    expect(syncSubscription).toHaveBeenCalledWith({
      enabled: true,
      backendId: "b",
      ntfyUrl: "https://gateway.example.invalid",
      topic: "push-b",
      authToken: "test-device",
    });
    expect(fetcher.mock.calls[0][0]).toContain("/api/notifications/subscription/b");
  });
  it("disables only the active selected backend after terminal credential failure", async () => {
    const syncSubscription = vi.fn().mockResolvedValue({ status: "ready" });
    await disableGatewayNotificationSubscription({
      gatewayUrl: "wss://gateway.example.invalid/",
      backendId: "backend-b",
      platform: { syncSubscription } as any,
    });
    expect(syncSubscription).toHaveBeenCalledOnce();
    expect(syncSubscription).toHaveBeenCalledWith({
      enabled: false,
      backendId: "backend-b",
      ntfyUrl: "https://gateway.example.invalid",
      topic: "push-backend-b",
      authToken: "",
    });
  });
  it.each([401, 403, 404])("cleans only the requested backend on Gateway %s", async (status) => {
    const syncSubscription = vi.fn().mockResolvedValue({ status: "ready" });
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status });
    await syncGatewayNotificationSubscription({
      gatewayUrl: "https://gateway.example.invalid",
      backendId: "backend-a",
      credential: "test-device",
      platform: { syncSubscription } as any,
      fetcher,
    });
    expect(syncSubscription).toHaveBeenCalledWith({
      enabled: false,
      backendId: "backend-a",
      ntfyUrl: "https://gateway.example.invalid",
      topic: "push-backend-a",
      authToken: "",
    });
  });
  it.each([200, 401])(
    "does not mutate a new backend subscription after a stale %s response",
    async (status) => {
      let release!: (response: unknown) => void;
      let current = true;
      const syncSubscription = vi.fn();
      const request = syncGatewayNotificationSubscription({
        gatewayUrl: "https://gateway.example.invalid",
        backendId: "old-backend",
        credential: "test-device",
        platform: { syncSubscription } as any,
        isCurrent: () => current,
        fetcher: vi.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        ) as any,
      });
      current = false;
      release({
        ok: status === 200,
        status,
        json: async () => ({
          success: true,
          data: {
            version: 1,
            enabled: true,
            transportBasePath: "",
            topic: "push-old-backend",
            authMode: "bearer",
          },
        }),
      });
      await request;
      expect(syncSubscription).not.toHaveBeenCalled();
    },
  );
});

it("hashes the same canonical view target as the Host without conflating identity", async () => {
  const { createHash } = await import("node:crypto");
  const { mobileNotificationTargetKey } =
    await import("../src/mobile-remote/mobileRemoteNotifications.js");
  const key = await mobileNotificationTargetKey("b", "identity-a", "task");
  expect(key).toBe(
    createHash("sha256")
      .update(JSON.stringify(["b", "identity-a", "task"]))
      .digest("hex"),
  );
  expect(await mobileNotificationTargetKey("b", "identity-b", "task")).not.toBe(key);
});

it("reports a diagnostic push as submitted only for an accepted receipt", async () => {
  const { sendGatewayTestNotification } =
    await import("../src/mobile-remote/mobileRemoteNotifications.js");
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { status: "filtered" } }),
  });
  const config = {
    gatewayUrl: "https://gateway.example.invalid",
    backendId: "backend-a",
    credential: "device-test",
    fetcher,
  };
  await expect(sendGatewayTestNotification(config)).rejects.toThrow("not-accepted");
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { status: "accepted" } }),
  });
  await expect(sendGatewayTestNotification(config)).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toContain("/test/backend-a");
});

import { parseMobileNotificationAction } from "../src/mobile-remote/mobileRemoteNotifications.js";

describe("parseMobileNotificationAction (E4)", () => {
  it("accepts only fully-formed action clicks with a known optionKind", () => {
    expect(
      parseMobileNotificationAction({
        backendId: "b",
        notificationId: "n",
        optionId: "opt",
        optionKind: "allowAlways",
      }),
    ).toEqual({ backendId: "b", notificationId: "n", optionId: "opt", optionKind: "allowAlways" });
    expect(
      parseMobileNotificationAction({ backendId: "b", notificationId: "n", optionId: "opt" }),
    ).toBeNull();
    expect(
      parseMobileNotificationAction({
        backendId: "b",
        notificationId: "n",
        optionId: "opt",
        optionKind: "escalate",
      }),
    ).toBeNull();
    expect(parseMobileNotificationAction(null)).toBeNull();
  });
});
