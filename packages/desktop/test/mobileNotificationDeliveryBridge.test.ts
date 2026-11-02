import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMobileNotificationDeliveryBridge } from "../src/host/mobileNotificationDeliveryBridge.js";
import {
  createMobileNotificationService,
  type IMobileNotificationService,
} from "@zody/services/mobile-notifications/node";

function claimFixture(notificationId = "n") {
  return {
    notification: {
      notificationId,
      target: { backendId: "b" },
      kind: "completed",
      occurredAt: 10,
    },
    leaseId: "lease",
    fencingToken: 7,
  };
}

describe("Host notification outbox transport", () => {
  it("keeps business state in the service and settles only matching receipts", async () => {
    const claim = {
      notification: {
        notificationId: "n",
        target: { backendId: "b" },
        kind: "completed",
        occurredAt: 10,
      },
      leaseId: "lease",
      fencingToken: 7,
    };
    const service = {
      claimOutbox: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
      acknowledgeOutbox: vi.fn().mockResolvedValue(true),
      failOutbox: vi.fn().mockResolvedValue(true),
      onFeedChanged: () => ({ dispose() {} }),
    };
    const sent: any[] = [];
    const bridge = createMobileNotificationDeliveryBridge({
      service: service as any,
      send: (message) => sent.push(message),
      now: () => 20,
    });
    bridge.accept({ type: "mobile-notification-context", enabled: true, backendId: "b" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].event.clickUrl).toContain("notificationId=n");
    bridge.accept({
      type: "mobile-notification-result",
      requestId: "other",
      receipt: { status: "accepted" },
    });
    expect(service.acknowledgeOutbox).not.toHaveBeenCalled();
    bridge.accept({
      type: "mobile-notification-result",
      requestId: sent[0].requestId,
      receipt: { status: "accepted" },
    });
    await vi.waitFor(() =>
      expect(service.acknowledgeOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ notificationId: "n", fencingToken: 7 }),
      ),
    );
    bridge.dispose();
  });

  it("permission 通知的 envelope 携带脱敏按钮；其他 kind 不带（第二批 E4）", async () => {
    const permissionClaim = {
      notification: {
        notificationId: "n-perm",
        target: { backendId: "b" },
        kind: "permission",
        occurredAt: 10,
        actions: [
          { optionId: "opt-once", optionKind: "allowOnce" },
          { optionId: "opt-deny", optionKind: "deny" },
        ],
      },
      leaseId: "lease-1",
      fencingToken: 1,
    };
    const completedClaim = {
      notification: {
        notificationId: "n-done",
        target: { backendId: "b" },
        kind: "completed",
        occurredAt: 10,
        actions: [{ optionId: "opt-x", optionKind: "deny" }],
      },
      leaseId: "lease-2",
      fencingToken: 2,
    };
    const service = {
      claimOutbox: vi
        .fn()
        .mockResolvedValueOnce(permissionClaim)
        .mockResolvedValueOnce(completedClaim)
        .mockResolvedValue(null),
      acknowledgeOutbox: vi.fn().mockResolvedValue(true),
      failOutbox: vi.fn().mockResolvedValue(true),
      onFeedChanged: () => ({ dispose() {} }),
    };
    const sent: any[] = [];
    const bridge = createMobileNotificationDeliveryBridge({
      service: service as any,
      send: (message) => sent.push(message),
      now: () => 20,
    });
    bridge.accept({ type: "mobile-notification-context", enabled: true, backendId: "b" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // drain 串行等回执：先结算第一条，第二条 claim 才会发生。
    bridge.accept({
      type: "mobile-notification-result",
      requestId: sent[0].requestId,
      receipt: { status: "accepted" },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const permissionPayload = JSON.parse(sent[0].event.body);
    expect(permissionPayload.actions).toEqual([
      { optionId: "opt-once", optionKind: "allowOnce" },
      { optionId: "opt-deny", optionKind: "deny" },
    ]);
    // envelope 仍不含 label/命令/路径：按钮文案由 Android 本地渲染。
    expect(JSON.stringify(permissionPayload)).not.toContain("label");

    const completedPayload = JSON.parse(sent[1].event.body);
    expect(completedPayload.actions).toBeUndefined();
    bridge.dispose();
  });

  it("maps filtered/terminal/retryable receipts onto failOutbox retryability (MN11)", async () => {
    const cases = [
      { status: "filtered", retryable: false },
      { status: "terminal", retryable: false },
      { status: "retryable", retryable: true },
    ] as const;
    for (const { status, retryable } of cases) {
      const service = {
        claimOutbox: vi
          .fn()
          .mockResolvedValueOnce(claimFixture())
          .mockResolvedValue(null),
        acknowledgeOutbox: vi.fn().mockResolvedValue(true),
        failOutbox: vi.fn().mockResolvedValue(true),
        onFeedChanged: () => ({ dispose() {} }),
      };
      const sent: any[] = [];
      const bridge = createMobileNotificationDeliveryBridge({
        service: service as any,
        send: (message) => sent.push(message),
        now: () => 20,
      });
      bridge.accept({ type: "mobile-notification-context", enabled: true, backendId: "b" });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      bridge.accept({
        type: "mobile-notification-result",
        requestId: sent[0].requestId,
        receipt: { status },
      });
      await vi.waitFor(() => expect(service.failOutbox).toHaveBeenCalledTimes(1));
      expect(service.failOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ notificationId: "n", leaseId: "lease", fencingToken: 7, retryable }),
      );
      // 非 accepted 回执绝不确认成功。
      expect(service.acknowledgeOutbox).not.toHaveBeenCalled();
      bridge.dispose();
    }
  });

  it("marks delivery failed after 8 consecutive failures and stops claiming the notification (MN11)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mobile-notification-retry-"));
    let clock = 1_000;
    let idSequence = 0;
    const service = await createMobileNotificationService({
      databasePath: join(directory, "feed.sqlite"),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
      dataVersionPollMs: 600_000,
    });
    const context = { type: "mobile-notification-context" as const, enabled: true, backendId: "b" };
    const sent: any[] = [];
    let bridge: ReturnType<typeof createMobileNotificationDeliveryBridge> | undefined;
    bridge = createMobileNotificationDeliveryBridge({
      service,
      send(message) {
        sent.push(message);
        // Gateway 每次都返回 retryable 失败，模拟持续投递失败。
        bridge?.accept({
          type: "mobile-notification-result",
          requestId: message.requestId,
          receipt: { status: "retryable", code: "push-failed" },
        });
      },
      now: () => clock,
    });
    try {
      await service.record({
        target: {
          backendId: "b",
          workspaceKey: "/work/retry",
          workspacePath: "/work/retry",
          taskId: "task-retry",
          sessionId: "session-retry",
        },
        sourceEventId: "evt-retry",
        sourceKind: "turn.completed",
        occurredAt: 1_000,
        kind: "completed",
        title: "Retry me",
      });
      bridge.accept(context);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      // 指数退避最长 128s；每次越过退避窗口后重新唤醒 drain，共 8 次尝试。
      for (let attempt = 2; attempt <= 8; attempt += 1) {
        clock += 10 * 60 * 1000;
        bridge.accept(context);
        await vi.waitFor(() => expect(sent).toHaveLength(attempt));
      }
      const feed = await service.listFeedForPrincipal({
        principal: { backendId: "b", deviceSubject: "d", clientInstanceId: "c" },
      });
      expect(feed.items[0]).toMatchObject({ notificationId: "notification-1", deliveryState: "failed" });
      clock += 10 * 60 * 1000;
      bridge.accept(context);
      await vi.waitFor(() =>
        expect(sent.length).toBe(8),
      );
      expect(
        await service.claimOutbox({ workerId: "manual", backendId: "b", now: clock, leaseMs: 60_000 }),
      ).toBeNull();
    } finally {
      bridge.dispose();
      service.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a lost ACK as retryable and resends the same notificationId with a fresh requestId (MN11)", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "mobile-notification-lost-ack-"));
    let clock = 1_000;
    let idSequence = 0;
    const service: IMobileNotificationService = await createMobileNotificationService({
      databasePath: join(directory, "feed.sqlite"),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
      dataVersionPollMs: 600_000,
    });
    const sent: any[] = [];
    const bridge = createMobileNotificationDeliveryBridge({
      service,
      // 首次 publish 后不回 result（丢 ACK），第二次 publish 正常确认。
      send(message) {
        sent.push(message);
        if (sent.length > 1) {
          bridge.accept({
            type: "mobile-notification-result",
            requestId: message.requestId,
            receipt: { status: "accepted" },
          });
        }
      },
      now: () => clock,
    });
    try {
      await service.record({
        target: {
          backendId: "backend-lost",
          workspaceKey: "/work/lost",
          workspacePath: "/work/lost",
          taskId: "task-lost",
          sessionId: "session-lost",
        },
        sourceEventId: "evt-lost-ack",
        sourceKind: "turn.completed",
        occurredAt: 1_000,
        kind: "completed",
        title: "Lost ack",
      });
      bridge.accept({
        type: "mobile-notification-context",
        enabled: true,
        backendId: "backend-lost",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);
      // 20s transport timeout：按 retryable 落账，通知保持可重发。
      await vi.advanceTimersByTimeAsync(20_000);
      const afterTimeout = await service.listFeedForPrincipal({
        principal: { backendId: "backend-lost", deviceSubject: "d", clientInstanceId: "c" },
      });
      expect(afterTimeout.items[0]).toMatchObject({
        notificationId: "notification-1",
        deliveryState: "submitted",
      });
      // 越过退避窗口后 retry timer 唤醒重发：同 notificationId、不同 requestId。
      clock = 60_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toHaveLength(2);
      const firstPayload = JSON.parse(sent[0].event.body);
      const secondPayload = JSON.parse(sent[1].event.body);
      expect(secondPayload.notificationId).toBe(firstPayload.notificationId);
      expect(sent[1].requestId).not.toBe(sent[0].requestId);
      await vi.waitFor(async () =>
        expect(
          (
            await service.listFeedForPrincipal({
              principal: { backendId: "backend-lost", deviceSubject: "d", clientInstanceId: "c" },
            })
          ).items[0],
        ).toMatchObject({ deliveryState: "accepted" }),
      );
    } finally {
      bridge.dispose();
      service.dispose();
      rmSync(directory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
