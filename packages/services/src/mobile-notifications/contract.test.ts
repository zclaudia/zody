import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMobileNotificationService } from "./adapters/service.js";
import { bindMobileNotificationReader } from "./app/reader.js";
import type { IMobileNotificationService } from "./internal/serviceContract.js";

describe("mobile notification service", () => {
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

  it("persists and returns permission action buttons, dropping corrupt actions safely (E4)", async () => {
    await service.record({
      target,
      sourceEventId: "interaction:perm-1",
      sourceKind: "interaction.pending",
      interactionId: "perm-1",
      occurredAt: clock,
      kind: "permission",
      title: "task",
      actions: [
        { optionId: "opt-once", optionKind: "allowOnce" },
        { optionId: "opt-deny", optionKind: "deny" },
      ],
    });
    const sameServicePage = await service.listFeedForPrincipal({
      principal: { backendId: "backend-a", deviceSubject: "device-a", clientInstanceId: "instance-a" },
      limit: 10,
    });
    expect(sameServicePage.items[0]?.actions).toEqual([
      { optionId: "opt-once", optionKind: "allowOnce" },
      { optionId: "opt-deny", optionKind: "deny" },
    ]);
    // 同库重开：actions 跨进程持久化（SQLite 列迁移后仍可读）。
    service.dispose();
    // 重开沿用注入时钟：默认 now()=Date.now() 会让 prune 把 occurredAt=100 的行清掉。
    service = await createMobileNotificationService({
      databasePath: databasePath(),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
    });
    const page = await service.listFeedForPrincipal({
      principal: { backendId: "backend-a", deviceSubject: "device-a", clientInstanceId: "instance-a" },
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.actions).toEqual([
      { optionId: "opt-once", optionKind: "allowOnce" },
      { optionId: "opt-deny", optionKind: "deny" },
    ]);

    // 损坏的 actions JSON 不让 feed 读取失败：记录保留、按钮退化为无。
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(databasePath());
    db.exec("UPDATE mobile_notification SET actions = '{corrupt'");
    db.close();
    service.dispose();
    // 重开沿用注入时钟：默认 now()=Date.now() 会让 prune 把 occurredAt=100 的行清掉。
    service = await createMobileNotificationService({
      databasePath: databasePath(),
      createId: () => `notification-${++idSequence}`,
      now: () => clock,
    });
    const recovered = await service.listFeedForPrincipal({
      principal: { backendId: "backend-a", deviceSubject: "device-a", clientInstanceId: "instance-a" },
      limit: 10,
    });
    expect(recovered.items).toHaveLength(1);
    expect(recovered.items[0]?.actions).toBeUndefined();
    expect(recovered.items[0]?.kind).toBe("permission");
  });

  it("binds reader identity at attachment scope and exposes no fact or outbox commands", async () => {
    await service.record({
      target,
      sourceEventId: "evt-1",
      sourceKind: "turn.completed",
      occurredAt: 100,
      kind: "completed",
      title: "Completed",
    });
    const reader = bindMobileNotificationReader(service, {
      backendId: "backend-a",
      deviceSubject: "device-a",
      clientInstanceId: "phone-a",
    });
    expect(await reader.listFeed({})).toMatchObject({
      items: [{ notificationId: "notification-1", read: false }],
    });
    expect("record" in reader).toBe(false);
    expect("claimOutbox" in reader).toBe(false);
    const forged = reader as unknown as { listFeed(input: object): Promise<unknown> };
    expect(
      await forged.listFeed({
        principal: { backendId: "backend-b", deviceSubject: "attacker", clientInstanceId: "other" },
      }),
    ).toMatchObject({ items: [{ notificationId: "notification-1" }] });
    expect(await reader.getNotification({ notificationId: "notification-1" })).toMatchObject({
      notificationId: "notification-1",
    });
    expect(
      await bindMobileNotificationReader(service, {
        backendId: "backend-b",
        deviceSubject: "device-a",
        clientInstanceId: "phone-a",
      }).getNotification({ notificationId: "notification-1" }),
    ).toBeNull();
  });

  it("rejects malformed pagination input at the reader boundary", async () => {
    const reader = bindMobileNotificationReader(service, {
      backendId: "backend-a",
      deviceSubject: "device-a",
      clientInstanceId: "phone-a",
    });
    expect(() => reader.listFeed({ limit: Number.NaN })).toThrow(/limit/);
    expect(() =>
      reader.listFeed({ before: { occurredAt: Number.NaN, notificationId: "x" } }),
    ).toThrow(/cursor/);
  });
});
