import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMobileNotificationService } from "./service.js";
import type { IMobileNotificationService } from "../internal/serviceContract.js";

describe("mobile notification service read state (MN04)", () => {
  let directory: string;
  let service: IMobileNotificationService;
  let idSequence = 0;
  let clock = 100;
  const databasePath = () => join(directory, "notifications.sqlite");
  const target = {
    backendId: "backend-a",
    workspaceKey: "identity-a",
    workspacePath: "/repo",
    workspaceIdentity: "identity-a",
    taskId: "task-a",
    sessionId: "session-a",
  };
  const principal = {
    backendId: "backend-a",
    deviceSubject: "device-a",
    clientInstanceId: "phone-a",
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mobile-notifications-read-"));
    idSequence = 0;
    clock = 100;
    service = await createMobileNotificationService({
      databasePath: databasePath(),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
    });
  });

  afterEach(async () => {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("markAllRead 使用旧 cursor 后，occurredAt 更大的新事件仍为 unread", async () => {
    const first = await service.record({
      target,
      sourceEventId: "evt-first",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "First",
    });
    await service.markAllReadForPrincipal({
      principal,
      through: { occurredAt: first.occurredAt, notificationId: first.notificationId },
    });
    const newer = await service.record({
      target,
      sourceEventId: "evt-newer",
      sourceKind: "turn.completed",
      occurredAt: 200,
      kind: "completed",
      title: "Newer",
    });
    const page = await service.listFeedForPrincipal({ principal });
    expect(page.items).toEqual([
      expect.objectContaining({ notificationId: newer.notificationId, read: false }),
      expect.objectContaining({ notificationId: first.notificationId, read: true }),
    ]);
    expect(page.unreadCount).toBe(1);
  });

  it("acknowledge 后重建 service（新实例同 DB）不再 claim 同一 notificationId", async () => {
    await service.record({
      target,
      sourceEventId: "evt-acked",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Acked",
    });
    const claim = await service.claimOutbox({
      workerId: "worker-old",
      backendId: "backend-a",
      now: 100,
      leaseMs: 60_000,
    });
    expect(claim).not.toBeNull();
    expect(
      await service.acknowledgeOutbox({
        notificationId: claim!.notification.notificationId,
        leaseId: claim!.leaseId,
        fencingToken: claim!.fencingToken,
        acceptedAt: 100,
      }),
    ).toBe(true);
    service.dispose();
    clock = 200;
    service = await createMobileNotificationService({
      databasePath: databasePath(),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
    });
    // 换新实例、新 worker 与更长 lease 也不得重复投递已 accepted 的通知。
    expect(
      await service.claimOutbox({
        workerId: "worker-restarted",
        backendId: "backend-a",
        now: clock,
        leaseMs: 60_000,
      }),
    ).toBeNull();
    expect(
      (await service.listFeedForPrincipal({ principal })).items[0],
    ).toMatchObject({ notificationId: "notification-1", deliveryState: "accepted" });
  });
});
