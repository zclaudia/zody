import { describe, expect, it, vi } from "vitest";
import { createMobileNotificationClickQueue } from "../src/mobile-remote/mobileNotificationClickQueue.js";

describe("native click owner", () => {
  it("routes the newest click received during an unfinished navigation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = vi.fn(async (click: { notificationId: string }) => {
      if (click.notificationId === "first") await blocked;
    });
    const queue = createMobileNotificationClickQueue({
      readPending: async () => null,
      open,
      onError: vi.fn(),
    });
    const first = queue.enqueue({ backendId: "b", notificationId: "first" });
    void queue.enqueue({ backendId: "b", notificationId: "second" });
    void queue.enqueue({ backendId: "b", notificationId: "latest" });
    release();
    await first;
    expect(open.mock.calls.map(([click]) => click.notificationId)).toEqual(["first", "latest"]);
  });
  it("does not retry an unavailable persisted click in a loop, and disposal stops queued work", async () => {
    const click = { backendId: "b", notificationId: "expired" };
    const onError = vi.fn();
    const queue = createMobileNotificationClickQueue({
      readPending: async () => click,
      open: async () => {
        throw new Error("expired");
      },
      onError,
    });
    await queue.enqueue();
    expect(onError).toHaveBeenCalledOnce();
    queue.dispose();
    await queue.enqueue(click);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not carry a queued notification click into a replaced credential session", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = vi.fn(async (click: { notificationId: string }) => {
      if (click.notificationId === "current") await blocked;
    });
    const queue = createMobileNotificationClickQueue({
      readPending: async () => null,
      open,
      onError: vi.fn(),
    });

    const current = queue.enqueue({
      backendId: "backend-a",
      notificationId: "current",
    });
    void queue.enqueue({
      backendId: "backend-a",
      notificationId: "old-credential-pending",
    });
    queue.dispose();
    release();
    await current;

    expect(open.mock.calls.map(([click]) => click.notificationId)).toEqual(["current"]);
  });

  it("opens a repeated click intent only once per queue lifetime", async () => {
    const click = { backendId: "b", notificationId: "same" };
    const open = vi.fn(async () => {});
    const onError = vi.fn();
    const queue = createMobileNotificationClickQueue({
      readPending: async () => null,
      open,
      onError,
    });

    await queue.enqueue(click);
    await queue.enqueue({ ...click });
    await queue.enqueue({ ...click });

    expect(open).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not reopen an already opened click when the durable slot is re-read", async () => {
    // Controller 在 Remote ready 时派发队列事件，页面同时读取原生 durable 槽；
    // 两条路径携带同一 notificationId，只能执行一次。
    const click = { backendId: "b", notificationId: "cold-start" };
    const open = vi.fn(async () => {});
    const queue = createMobileNotificationClickQueue({
      readPending: async () => click,
      open,
      onError: vi.fn(),
    });

    await queue.enqueue();
    await queue.retryPending();

    expect(open).toHaveBeenCalledOnce();
  });

  it("still retries the same click after a failed attempt", async () => {
    const click = { backendId: "b", notificationId: "retryable" };
    let attempts = 0;
    const open = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    });
    const onError = vi.fn();
    const queue = createMobileNotificationClickQueue({
      readPending: async () => null,
      open,
      onError,
    });

    await queue.enqueue(click);
    await queue.enqueue(click);

    expect(open).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps a different notification click after the previous one completed", async () => {
    const open = vi.fn(async () => {});
    const queue = createMobileNotificationClickQueue({
      readPending: async () => null,
      open,
      onError: vi.fn(),
    });

    await queue.enqueue({ backendId: "b", notificationId: "first" });
    await queue.enqueue({ backendId: "b", notificationId: "second" });

    expect(open.mock.calls.map(([click]) => click.notificationId)).toEqual(["first", "second"]);
  });

  it("re-reads a durable click queued during recovery after the first open becomes stale", async () => {
    const click = { backendId: "b", notificationId: "resume-click" };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const open = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await blocked;
        throw new Error("stale-notification");
      }
    });
    const onError = vi.fn();
    const queue = createMobileNotificationClickQueue({
      readPending: async () => click,
      open,
      onError,
    });

    const originalClick = queue.enqueue(click);
    const recoveryReplay = queue.retryPending();
    release();
    await Promise.all([originalClick, recoveryReplay]);

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith(click);
    expect(onError).toHaveBeenCalledOnce();
  });
});

import { createMobileNotificationActionQueue } from "../src/mobile-remote/mobileNotificationClickQueue.js";
import type { MobileNotificationActionClick } from "@zcode/shared";

describe("mobile notification action queue (E4)", () => {
  it("serializes action intents and re-reads the durable native slot once", async () => {
    const readPending = vi.fn(async () => null);
    const opened: MobileNotificationActionClick[] = [];
    let failFirst = true;
    const queue = createMobileNotificationActionQueue({
      readPending,
      open: async (action) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("bridge-not-ready");
        }
        opened.push(action);
      },
      onError: vi.fn(),
    });
    const action: MobileNotificationActionClick = {
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
      optionKind: "allowOnce",
    };
    await queue.enqueue(action).catch(() => {});
    expect(opened).toEqual([]);
    await queue.enqueue(action);
    expect(opened).toEqual([action]);
    // 显式 intent 不读原生槽；只有 retryPending（连接恢复后）才重读持久槽。
    expect(readPending).not.toHaveBeenCalled();
    await queue.retryPending();
    expect(readPending).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([action]);
    queue.dispose();
  });

  it("submits the same option intent only once even when click and action paths overlap", async () => {
    // 点击卡片和按钮动作可能是两条 intent，但同一 (backendId, notificationId, optionId, optionKind)
    // 只能提交一次；否则快速双击或 durable 槽重读会重复执行权限决策。
    const action: MobileNotificationActionClick = {
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
      optionKind: "allowOnce",
    };
    const opened: MobileNotificationActionClick[] = [];
    const queue = createMobileNotificationActionQueue({
      readPending: async () => action,
      open: async (pending) => {
        opened.push(pending);
      },
      onError: vi.fn(),
    });

    await queue.enqueue(action);
    await queue.enqueue({ ...action });
    await queue.retryPending();

    expect(opened).toEqual([action]);
  });

  it("does not conflate different options for the same notification", async () => {
    const opened: string[] = [];
    const queue = createMobileNotificationActionQueue({
      readPending: async () => null,
      open: async (action) => {
        opened.push(action.optionId);
      },
      onError: vi.fn(),
    });
    const base: MobileNotificationActionClick = {
      backendId: "b",
      notificationId: "n",
      optionId: "allow",
      optionKind: "allowOnce",
    };

    await queue.enqueue(base);
    await queue.enqueue({ ...base, optionId: "deny", optionKind: "deny" });

    expect(opened).toEqual(["allow", "deny"]);
  });
});
