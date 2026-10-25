import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMobileNotificationService } from "./service.js";
import type { IMobileNotificationService } from "../internal/serviceContract.js";

describe("mobile notification service adapter", () => {
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

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mobile-notifications-"));
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

  it("records a raw source event once and atomically creates its outbox item", async () => {
    const input = {
      target,
      sourceEventId: "evt-1",
      sourceKind: "turn.completed" as const,
      turnId: "turn-1",
      occurredAt: 100,
      kind: "completed" as const,
      title: "Task completed",
    };
    expect(await service.record(input)).toMatchObject({
      notificationId: "notification-1",
      read: false,
      deliveryState: "recorded",
    });
    expect(await service.record(input)).toMatchObject({ notificationId: "notification-1" });
    expect(
      (
        await service.listFeedForPrincipal({
          principal: {
            backendId: "backend-a",
            deviceSubject: "device-a",
            clientInstanceId: "phone-a",
          },
        })
      ).items,
    ).toHaveLength(1);
    const claimed = await service.claimOutbox({
      workerId: "worker-a",
      backendId: "backend-a",
      now: 100,
      leaseMs: 10,
    });
    expect(claimed).toMatchObject({
      notification: { notificationId: "notification-1" },
      fencingToken: 1,
      attempt: 1,
    });
  });

  it("isolates read state by authenticated installation and does not merge task read", async () => {
    await service.record({
      target,
      sourceEventId: "evt-1",
      sourceKind: "turn.failed",
      occurredAt: 100,
      kind: "failed",
      title: "Failed",
    });
    await service.markReadForPrincipal({
      principal: { backendId: "backend-a", deviceSubject: "device-a", clientInstanceId: "phone-a" },
      notificationId: "notification-1",
    });
    expect(
      (
        await service.listFeedForPrincipal({
          principal: {
            backendId: "backend-a",
            deviceSubject: "device-a",
            clientInstanceId: "phone-a",
          },
        })
      ).items[0]?.read,
    ).toBe(true);
    expect(
      (
        await service.listFeedForPrincipal({
          principal: {
            backendId: "backend-b",
            deviceSubject: "device-a",
            clientInstanceId: "phone-a",
          },
        })
      ).items,
    ).toHaveLength(0);
    expect(
      (
        await service.listFeedForPrincipal({
          principal: {
            backendId: "backend-a",
            deviceSubject: "device-b",
            clientInstanceId: "phone-a",
          },
        })
      ).unreadCount,
    ).toBe(1);
  });

  it("notifies another Host service instance when a shared SQLite feed changes", async () => {
    const hostB = await createMobileNotificationService({
      databasePath: databasePath(),
      createId: () => "notification-from-host-b",
      now: () => clock,
      dataVersionPollMs: 5,
    });
    try {
      const eventReceived = new Promise<void>((resolve) => {
        const disposable = service.onFeedChanged(() => {
          disposable.dispose();
          resolve();
        });
      });
      await hostB.record({
        target,
        sourceEventId: "host-b-event",
        sourceKind: "turn.completed",
        occurredAt: 100,
        kind: "completed",
        title: "From another Host",
      });
      await eventReceived;
      expect(
        (
          await service.listFeedForPrincipal({
            principal: {
              backendId: "backend-a",
              deviceSubject: "device-a",
              clientInstanceId: "phone-a",
            },
          })
        ).items,
      ).toMatchObject([{ sourceEventId: "host-b-event" }]);
    } finally {
      hostB.dispose();
    }
  });

  it("resolves a pending interaction without allowing a replay to reopen it", async () => {
    const input = {
      target,
      sourceEventId: "interaction:ask-1",
      sourceKind: "interaction.pending" as const,
      interactionId: "ask-1",
      occurredAt: 100,
      kind: "question" as const,
      title: "Needs an answer",
    };
    await service.record(input);
    await service.resolveInteraction({
      backendId: "backend-a",
      workspaceKey: target.workspaceKey,
      sessionId: target.sessionId,
      interactionId: "ask-1",
    });
    await service.record(input);
    expect(
      (
        await service.listFeedForPrincipal({
          principal: {
            backendId: "backend-a",
            deviceSubject: "device-a",
            clientInstanceId: "phone-a",
          },
        })
      ).items[0]?.resolved,
    ).toBe(true);
  });

  it("resolve 后迟到 record（同 interaction sourceEventId、不同 occurredAt）不新增记录或 outbox 行", async () => {
    const input = {
      target,
      sourceEventId: "interaction:late-1",
      sourceKind: "interaction.pending" as const,
      interactionId: "late-1",
      occurredAt: 100,
      kind: "question" as const,
      title: "Late replay",
    };
    await service.record(input);
    await service.resolveInteraction({
      backendId: "backend-a",
      workspaceKey: target.workspaceKey,
      sessionId: target.sessionId,
      interactionId: "late-1",
    });
    const replay = await service.record({ ...input, occurredAt: 500 });
    // 迟到重放解析到既有唯一键行，不产生第二条 feed 记录，也不覆盖原始 occurredAt。
    expect(replay.notificationId).toBe("notification-1");
    const feed = await service.listFeedForPrincipal({
      principal: {
        backendId: "backend-a",
        deviceSubject: "device-a",
        clientInstanceId: "phone-a",
      },
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      notificationId: "notification-1",
      resolved: true,
      occurredAt: 100,
    });
    // 已 resolve 的交互不再进入推送，且迟到 record 没有插入第二条 outbox 行。
    expect(
      await service.claimOutbox({
        workerId: "worker",
        backendId: "backend-a",
        now: 500,
        leaseMs: 10,
      }),
    ).toBeNull();
    const db = new DatabaseSync(databasePath());
    try {
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM mobile_notification_outbox")
            .get() as { count: number }
        ).count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("fences stale outbox acknowledgements after another host reclaims the lease", async () => {
    await service.record({
      target,
      sourceEventId: "evt-1",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Completed",
    });
    const oldClaim = await service.claimOutbox({
      workerId: "host-a",
      backendId: "backend-a",
      now: 100,
      leaseMs: 5,
    });
    const newClaim = await service.claimOutbox({
      workerId: "host-b",
      backendId: "backend-a",
      now: 106,
      leaseMs: 20,
    });
    expect(oldClaim).not.toBeNull();
    expect(newClaim?.fencingToken).toBeGreaterThan(oldClaim?.fencingToken ?? 0);
    expect(
      await service.acknowledgeOutbox({
        notificationId: "notification-1",
        leaseId: oldClaim!.leaseId,
        fencingToken: oldClaim!.fencingToken,
        acceptedAt: 107,
      }),
    ).toBe(false);
    expect(
      await service.acknowledgeOutbox({
        notificationId: "notification-1",
        leaseId: newClaim!.leaseId,
        fencingToken: newClaim!.fencingToken,
        acceptedAt: 107,
      }),
    ).toBe(true);
  });

  it("claims only the active backend outbox", async () => {
    await service.record({
      target,
      sourceEventId: "evt-a",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "A",
    });
    await service.record({
      target: { ...target, backendId: "backend-b" },
      sourceEventId: "evt-b",
      sourceKind: "turn.failed",
      occurredAt: 100,
      kind: "failed",
      title: "B",
    });
    expect(
      await service.claimOutbox({
        workerId: "worker",
        backendId: "backend-b",
        now: 100,
        leaseMs: 10,
      }),
    ).toMatchObject({
      notification: { target: { backendId: "backend-b" }, notificationId: "notification-2" },
    });
  });

  it("keeps recovery rows in the feed without adding them to push outbox", async () => {
    await service.record({
      target,
      sourceEventId: "recovered-event",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Recovered",
      recovered: true,
    });
    expect(
      (
        await service.listFeedForPrincipal({
          principal: {
            backendId: "backend-a",
            deviceSubject: "device-a",
            clientInstanceId: "phone-a",
          },
        })
      ).items,
    ).toMatchObject([{ recovered: true }]);
    expect(
      await service.claimOutbox({
        workerId: "worker",
        backendId: "backend-a",
        now: 100,
        leaseMs: 10,
      }),
    ).toBeNull();
  });

  it("does not resolve expired push click references", async () => {
    await service.record({
      target,
      sourceEventId: "evt-old",
      sourceKind: "turn.failed",
      occurredAt: 100,
      kind: "failed",
      title: "Old",
    });
    clock = 100 + 24 * 60 * 60 * 1000;
    expect(
      await service.getNotificationForPrincipal({
        principal: {
          backendId: "backend-a",
          deviceSubject: "device-a",
          clientInstanceId: "phone-a",
        },
        notificationId: "notification-1",
      }),
    ).toBeNull();
  });
});
