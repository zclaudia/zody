import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMobileNotificationService } from "./service.js";
import type { IMobileNotificationService } from "../internal/serviceContract.js";

function countRows(databasePath: string, table: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    return Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    );
  } finally {
    db.close();
  }
}

describe("mobile notification service concurrency (MN05)", () => {
  let directory: string;
  let hostA: IMobileNotificationService;
  let hostB: IMobileNotificationService;
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
    directory = await mkdtemp(join(tmpdir(), "mobile-notifications-concurrency-"));
    idSequence = 0;
    clock = 100;
    const createOptions = () => ({
      databasePath: databasePath(),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
    });
    hostA = await createMobileNotificationService(createOptions());
    hostB = await createMobileNotificationService(createOptions());
  });

  afterEach(async () => {
    hostA.dispose();
    hostB.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("两个 Host 并发 record 同一稳定 envelope 只产生一条 feed 行与一条 outbox 行", async () => {
    const envelope = {
      target,
      sourceEventId: "evt-concurrent",
      sourceKind: "turn.completed" as const,
      turnId: "turn-1",
      occurredAt: 100,
      kind: "completed" as const,
      title: "Concurrent completion",
    };
    const [fromA, fromB] = await Promise.all([hostA.record(envelope), hostB.record(envelope)]);
    // 逻辑键 {backendId, workspaceKey, sessionId, sourceEventId} 去重：两个 Host 解析到同一行。
    expect(fromA.notificationId).toBe(fromB.notificationId);
    expect(
      (await hostA.listFeedForPrincipal({ principal })).items.map(
        (item) => item.sourceEventId,
      ),
    ).toEqual(["evt-concurrent"]);
    // 独立连接核对物理行数：feed 与 outbox 各只有一条。
    expect(countRows(databasePath(), "mobile_notification")).toBe(1);
    expect(countRows(databasePath(), "mobile_notification_outbox")).toBe(1);
  });

  it("两个 Host 并发 claimOutbox 只有其中一方拿到同一通知", async () => {
    await hostA.record({
      target,
      sourceEventId: "evt-claim-race",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Claim race",
    });
    const [claimA, claimB] = await Promise.all([
      hostA.claimOutbox({ workerId: "host-a", backendId: "backend-a", now: 100, leaseMs: 50 }),
      hostB.claimOutbox({ workerId: "host-b", backendId: "backend-a", now: 100, leaseMs: 50 }),
    ]);
    const claims = [claimA, claimB].filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      notification: { notificationId: "notification-1" },
      attempt: 1,
    });
    // 拿到 lease 的一方可以正常确认。
    expect(
      await hostA.acknowledgeOutbox({
        notificationId: claims[0]!.notification.notificationId,
        leaseId: claims[0]!.leaseId,
        fencingToken: claims[0]!.fencingToken,
        acceptedAt: 100,
      }),
    ).toBe(true);
  });

  it("lease 被接管后旧 leaseId 的 acknowledgeOutbox 与 failOutbox 都被 fencing 拒绝", async () => {
    await hostA.record({
      target,
      sourceEventId: "evt-fencing",
      sourceKind: "turn.failed",
      occurredAt: 100,
      kind: "failed",
      title: "Fencing",
    });
    const oldClaim = await hostA.claimOutbox({
      workerId: "host-a",
      backendId: "backend-a",
      now: 100,
      leaseMs: 5,
    });
    expect(oldClaim).not.toBeNull();
    // lease 过期后另一 Host 接管，fencing token 递增。
    const takeover = await hostB.claimOutbox({
      workerId: "host-b",
      backendId: "backend-a",
      now: 200,
      leaseMs: 60,
    });
    expect(takeover).not.toBeNull();
    expect(takeover!.fencingToken).toBeGreaterThan(oldClaim!.fencingToken);
    expect(
      await hostA.acknowledgeOutbox({
        notificationId: oldClaim!.notification.notificationId,
        leaseId: oldClaim!.leaseId,
        fencingToken: oldClaim!.fencingToken,
        acceptedAt: 200,
      }),
    ).toBe(false);
    expect(
      await hostA.failOutbox({
        notificationId: oldClaim!.notification.notificationId,
        leaseId: oldClaim!.leaseId,
        fencingToken: oldClaim!.fencingToken,
        failedAt: 200,
        retryable: true,
      }),
    ).toBe(false);
    // 新 lease 持有者仍可正常结算，旧账本未被污染。
    expect(
      await hostB.failOutbox({
        notificationId: takeover!.notification.notificationId,
        leaseId: takeover!.leaseId,
        fencingToken: takeover!.fencingToken,
        failedAt: 200,
        retryable: true,
      }),
    ).toBe(true);
  });
});
