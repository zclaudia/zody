import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMobileNotificationService } from "./service.js";
import type { IMobileNotificationService } from "../internal/serviceContract.js";
import type { MobileNotification } from "../contract.js";

describe("mobile notification service TTL, ordering and pagination (MN10)", () => {
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
    directory = await mkdtemp(join(tmpdir(), "mobile-notifications-ttl-"));
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

  it("permission/question 1 小时 TTL：过期后点击引用与投递均跳过，未过期未 resolved 可投递，resolved 不投递", async () => {
    const recordInteraction = async (sourceEventId: string, interactionId: string) =>
      service.record({
        target,
        sourceEventId,
        sourceKind: "interaction.pending",
        interactionId,
        occurredAt: 100,
        kind: "permission",
        title: "Needs approval",
      });
    const pending = await recordInteraction("interaction:pending-1", "pending-1");
    const resolved = await recordInteraction("interaction:resolved-1", "resolved-1");
    await service.resolveInteraction({
      backendId: "backend-a",
      workspaceKey: target.workspaceKey,
      sessionId: target.sessionId,
      interactionId: "resolved-1",
    });

    // 未过期且未 resolved：可 claim。
    const claimed = await service.claimOutbox({
      workerId: "worker",
      backendId: "backend-a",
      now: 100,
      leaseMs: 10,
    });
    expect(claimed?.notification.notificationId).toBe(pending.notificationId);
    expect(
      await service.acknowledgeOutbox({
        notificationId: pending.notificationId,
        leaseId: claimed!.leaseId,
        fencingToken: claimed!.fencingToken,
        acceptedAt: 100,
      }),
    ).toBe(true);
    // resolved 的交互即使未过期也不进入推送。
    expect(
      await service.claimOutbox({
        workerId: "worker",
        backendId: "backend-a",
        now: 100,
        leaseMs: 10,
      }),
    ).toBeNull();

    clock = 100 + 60 * 60 * 1000;
    // 交互 1 小时 TTL 到期：点击引用解析为 null。
    expect(
      await service.getNotificationForPrincipal({
        principal,
        notificationId: resolved.notificationId,
      }),
    ).toBeNull();
    // 过期交互不再投递：写入新 pending 后只 claim 到未过期的一条。
    const fresh = await service.record({
      target,
      sourceEventId: "interaction:fresh-1",
      sourceKind: "interaction.pending",
      interactionId: "fresh-1",
      occurredAt: clock,
      kind: "question",
      title: "Fresh question",
    });
    const lateClaim = await service.claimOutbox({
      workerId: "worker",
      backendId: "backend-a",
      now: clock,
      leaseMs: 10,
    });
    expect(lateClaim?.notification.notificationId).toBe(fresh.notificationId);
  });

  it("out-of-order record 晚到但 occurredAt 更旧的事件按 occurredAt 排序", async () => {
    await service.record({
      target,
      sourceEventId: "evt-newer",
      sourceKind: "turn.completed",
      occurredAt: 300,
      kind: "completed",
      title: "Newer",
    });
    await service.record({
      target,
      sourceEventId: "evt-older",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Older",
    });
    await service.record({
      target,
      sourceEventId: "evt-middle",
      sourceKind: "turn.failed",
      occurredAt: 200,
      kind: "failed",
      title: "Middle",
    });
    expect(
      (await service.listFeedForPrincipal({ principal })).items.map(
        (item) => item.sourceEventId,
      ),
    ).toEqual(["evt-newer", "evt-middle", "evt-older"]);
  });

  it("写入超过 1000 条后按 ROW_NUMBER 裁剪最旧记录", async () => {
    for (let index = 0; index < 1_001; index += 1) {
      await service.record({
        target,
        sourceEventId: `evt-${index}`,
        sourceKind: "turn.completed",
        occurredAt: 1_000 + index,
        kind: "completed",
        title: `Event ${index}`,
      });
    }
    const collected: MobileNotification[] = [];
    let before: { occurredAt: number; notificationId: string } | undefined;
    for (;;) {
      const page = await service.listFeedForPrincipal({ principal, ...(before ? { before } : {}) });
      collected.push(...page.items);
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(collected).toHaveLength(1_000);
    // 最旧的 evt-0 被裁剪，其余 1000 条按时间倒序保留。
    expect(collected[0]).toMatchObject({ sourceEventId: "evt-1000" });
    expect(collected.at(-1)).toMatchObject({ sourceEventId: "evt-1" });
    expect(collected.some((item) => item.sourceEventId === "evt-0")).toBe(false);
  });

  it("三页分页（含相同 occurredAt 的 notificationId tie-break）无重复无遗漏且 nextCursor 正确", async () => {
    // 三组事件：时间各不相同，且每组内 3 条共享 occurredAt，页大小 4 会切断 tie 组。
    const created: MobileNotification[] = [];
    for (let group = 0; group < 3; group += 1) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        created.push(
          await service.record({
            target,
            sourceEventId: `evt-g${group}-r${repeat}`,
            sourceKind: "turn.completed",
            occurredAt: 100 + group * 10,
            kind: "completed",
            title: `g${group}r${repeat}`,
          }),
        );
      }
    }
    const expected = [...created].sort(
      (left, right) =>
        right.occurredAt - left.occurredAt ||
        (right.notificationId < left.notificationId ? -1 : right.notificationId > left.notificationId ? 1 : 0),
    );
    const pages: MobileNotification[][] = [];
    const cursors: ({ occurredAt: number; notificationId: string } | undefined)[] = [];
    let before: { occurredAt: number; notificationId: string } | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await service.listFeedForPrincipal({
        principal,
        limit: 4,
        ...(before ? { before } : {}),
      });
      pages.push(result.items);
      cursors.push(result.nextCursor);
      before = result.nextCursor;
    }
    expect(cursors[2]).toBeUndefined();
    const items = pages.flat();
    expect(items.map((item) => item.notificationId)).toEqual(
      expected.map((item) => item.notificationId),
    );
    expect(new Set(items.map((item) => item.notificationId)).size).toBe(items.length);
    // 每页 nextCursor 指向该页最后一项，作为下一页的排他游标。
    expect(cursors[0]).toEqual({
      occurredAt: pages[0]?.at(-1)?.occurredAt,
      notificationId: pages[0]?.at(-1)?.notificationId,
    });
    expect(cursors[1]).toEqual({
      occurredAt: pages[1]?.at(-1)?.occurredAt,
      notificationId: pages[1]?.at(-1)?.notificationId,
    });
  });
});
