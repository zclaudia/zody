import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMobileNotificationService } from "./service.js";
import type { IMobileNotificationService } from "../internal/serviceContract.js";

describe("mobile notification service retention and leases", () => {
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

  it("persists read markers and lease fencing across service recreation", async () => {
    await service.record({
      target,
      sourceEventId: "restart-event",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Done",
    });
    const principal = {
      backendId: "backend-a",
      deviceSubject: "device-a",
      clientInstanceId: "phone-a",
    };
    await service.markReadForPrincipal({ principal, notificationId: "notification-1" });
    const firstClaim = await service.claimOutbox({
      workerId: "host-old",
      backendId: "backend-a",
      now: 100,
      leaseMs: 10,
    });
    service.dispose();
    clock = 105;
    service = await createMobileNotificationService({
      databasePath: databasePath(),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
    });
    expect((await service.listFeedForPrincipal({ principal })).items[0]?.read).toBe(true);
    expect(
      await service.claimOutbox({
        workerId: "host-new",
        backendId: "backend-a",
        now: clock,
        leaseMs: 10,
      }),
    ).toBeNull();
    clock = 111;
    const reclaimed = await service.claimOutbox({
      workerId: "host-new",
      backendId: "backend-a",
      now: clock,
      leaseMs: 10,
    });
    expect(reclaimed?.fencingToken).toBe((firstClaim?.fencingToken ?? 0) + 1);
  });

  it("applies retry backoff and prunes feed rows after retention", async () => {
    await service.record({
      target,
      sourceEventId: "retry-event",
      sourceKind: "turn.failed",
      occurredAt: 100,
      kind: "failed",
      title: "Retry",
    });
    const claim = await service.claimOutbox({
      workerId: "host",
      backendId: "backend-a",
      now: 100,
      leaseMs: 10,
    });
    await service.failOutbox({
      notificationId: claim!.notification.notificationId,
      leaseId: claim!.leaseId,
      fencingToken: claim!.fencingToken,
      failedAt: 100,
      retryable: true,
    });
    expect(
      await service.claimOutbox({
        workerId: "host",
        backendId: "backend-a",
        now: 1_099,
        leaseMs: 10,
      }),
    ).toBeNull();
    expect(
      await service.claimOutbox({
        workerId: "host",
        backendId: "backend-a",
        now: 1_100,
        leaseMs: 10,
      }),
    ).not.toBeNull();
    clock = 100 + 31 * 24 * 60 * 60 * 1000;
    await service.record({
      target,
      sourceEventId: "new-event",
      sourceKind: "turn.completed",
      occurredAt: clock,
      kind: "completed",
      title: "Fresh",
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
      ).items.map((item) => item.sourceEventId),
    ).toEqual(["new-event"]);
  });

  it("prunes retained rows when the feed is read after a quiet period", async () => {
    await service.record({
      target,
      sourceEventId: "quiet-old",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Old",
    });
    clock = 100 + 31 * 24 * 60 * 60 * 1000;
    await service.record({
      target,
      sourceEventId: "quiet-fresh",
      sourceKind: "turn.completed",
      occurredAt: clock,
      kind: "completed",
      title: "Fresh",
    });

    const feed = await service.listFeedForPrincipal({
      principal: { backendId: "backend-a", deviceSubject: "device-a", clientInstanceId: "phone-a" },
    });
    expect(feed.items.map((item) => item.sourceEventId)).toEqual(["quiet-fresh"]);
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

  it("prunes retained rows when a click reference is read after a quiet period", async () => {
    await service.record({
      target,
      sourceEventId: "click-old",
      sourceKind: "turn.failed",
      occurredAt: 100,
      kind: "failed",
      title: "Old",
    });
    clock = 100 + 31 * 24 * 60 * 60 * 1000;

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
    ).toEqual([]);
  });
});
