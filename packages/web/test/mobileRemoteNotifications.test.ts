import { describe, expect, it, vi } from "vitest";
import {
  createMobileNotificationPlatform,
  disableGatewayNotificationSubscription,
  syncGatewayNotificationSubscription,
} from "../src/mobile-remote/mobileRemoteNotifications.js";

describe("native notification capability", () => {
  it("keeps ordinary web unsupported and validates cold click data", async () => {
    expect(createMobileNotificationPlatform({})).toBeUndefined();
    const native = {
      notificationGetPendingClick: () => JSON.stringify({ backendId: "b", notificationId: "n" }),
      notificationSyncSubscription: () => '{"status":"ready"}',
      notificationAcknowledgeClick: vi.fn(),
      notificationGetStatus: () => '{"status":"ready"}',
      notificationRequestPermission: vi.fn(),
      notificationShow: vi.fn(),
    };
    const capability = createMobileNotificationPlatform({ ZcodeMobileBridge: native })!;
    expect(await capability.getPendingClick()).toEqual({ backendId: "b", notificationId: "n" });
    native.notificationGetPendingClick = () => '{"backendId":"b","notificationId":""}';
    expect(await capability.getPendingClick()).toBeNull();
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
