import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginUiPageManager, type ManagedPluginPage } from "./pluginUiPageManager.js";
const make = (key: string, task = key) => {
  let running = true,
    busy = false;
  return {
    key,
    task,
    visible: false,
    busy: () => busy,
    running: () => running,
    suspend: vi.fn(() => {
      running = false;
    }),
    destroy: vi.fn(),
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
};
const pool = () =>
  new PluginUiPageManager<ManagedPluginPage>(
    (run, ms) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    },
    () => {},
  );
afterEach(() => vi.useRealTimers());
describe("MCP App page ownership", () => {
  // I20（2026-10-24 决策）：离屏/收起不是销毁信号，旧语义是连续离屏 5 分钟后 suspend。
  it("keeps an offscreen page executing past five minutes and reuses the same owner on return", async () => {
    vi.useFakeTimers();
    const owner = pool();
    const page = make("page");
    await owner.add(page);
    await owner.reserve(page);
    owner.visibility(page, false);
    vi.advanceTimersByTime(15 * 60_000);
    expect(page.suspend).not.toHaveBeenCalled();
    owner.visibility(page, true);
    vi.advanceTimersByTime(600_000);
    expect(page.suspend).not.toHaveBeenCalled();
    expect(owner.get("page")).toBe(page);
  });
  // I20：后台结果 settle（页面工具调用/采样结束）不等于页面可回收，旧语义会立即 suspend。
  it("keeps an unanchored page when its background result settles after the offscreen deadline", async () => {
    vi.useFakeTimers();
    const owner = pool();
    const page = make("page");
    await owner.add(page);
    await owner.reserve(page);
    page.setBusy(true);
    owner.visibility(page, false);
    // 离屏定时器在页面忙时到点只移除定时器，不回收；随后结果 settle 仍不得销毁页面。
    vi.advanceTimersByTime(5 * 60_000);
    expect(page.suspend).not.toHaveBeenCalled();
    page.setBusy(false);
    owner.settled(page);
    expect(page.suspend).not.toHaveBeenCalled();
    expect(owner.get("page")).toBe(page);
  });
  // I20：30 task 是硬上限，超限拒绝新页面；不得销毁无锚点的后台任务（旧语义 LRU 淘汰 first）。
  it("rejects the thirty-first task without destroying a background page", async () => {
    const owner = pool();
    const first = make("first");
    await owner.add(first);
    await owner.reserve(first);
    for (let n = 1; n < 30; n++) {
      const page = make(String(n));
      await owner.add(page);
      await owner.reserve(page);
    }
    await expect(owner.add(make("overflow"))).rejects.toThrow("capacity");
    expect(first.destroy).not.toHaveBeenCalled();
    expect(first.suspend).not.toHaveBeenCalled();
    expect(owner.get("first")).toBe(first);
  });
  it("rejects overflow when all 64 pages are visible or busy", async () => {
    const owner = pool();
    for (let n = 0; n < 64; n++) {
      const p = make(String(n), "task");
      p.visible = true;
      await owner.add(p);
      await owner.reserve(p);
    }
    const next = make("next", "task");
    next.suspend();
    await owner.add(next);
    await expect(owner.reserve(next)).rejects.toThrow("capacity");
  });
  it("does not allow stale visibility cleanup to mutate a replacement", async () => {
    const owner = pool();
    const a = make("same");
    await owner.add(a);
    owner.removeTask(a.task);
    const b = make("same");
    await owner.add(b);
    owner.visibility(b, true);
    owner.visibility(a, false);
    expect(b.visible).toBe(true);
  });
  it("serializes concurrent capacity reservations without exceeding 64", async () => {
    const owner = pool();
    const pages = Array.from({ length: 65 }, (_, i) => make(String(i), "task"));
    for (const page of pages) {
      page.visible = true;
      await owner.add(page);
    }
    const results = await Promise.allSettled(pages.map((page) => owner.reserve(page)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(64);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("does not evict an instance when the Agent reports a newly admitted approval", async () => {
    const owner = pool();
    const first = { ...make("first"), suspend: vi.fn(async () => false) };
    await owner.add(first);
    for (let n = 1; n < 30; n++) {
      const page = make(String(n));
      page.visible = true;
      await owner.add(page);
    }
    await expect(owner.add(make("overflow"))).rejects.toThrow("capacity");
    expect(first.destroy).not.toHaveBeenCalled();
    expect(owner.get("first")).toBe(first);
  });
  it("cancels queued admission when its task is removed", async () => {
    const owner = pool();
    const page = make("late");
    const pending = owner.add(page);
    owner.removeTask(page.task);
    await expect(pending).rejects.toThrow("removed");
    expect(owner.get(page.key)).toBeUndefined();
  });
  it("does not reserve or revive a page removed while its admission was pending", async () => {
    const owner = pool();
    const page = make("late", "task");
    const pendingAdd = owner.add(page);
    const pendingReserve = owner.reserve(page);
    owner.removeTask(page.task);
    await expect(pendingAdd).rejects.toThrow("removed");
    await expect(pendingReserve).rejects.toThrow("removed");
    expect(owner.get(page.key)).toBeUndefined();
  });
  // I20：64 allocated 同样是硬上限；不得 suspend 无锚点的活页面来腾槽位。
  it("rejects a sixty-fifth allocation without recycling a live background page", async () => {
    const owner = pool();
    const pages = Array.from({ length: 64 }, (_, i) => make(String(i), "task"));
    for (const page of pages) {
      await owner.add(page);
      await owner.reserve(page);
    }
    const next = make("next");
    await owner.add(next);
    await expect(owner.reserve(next)).rejects.toThrow("capacity");
    for (const page of pages) expect(page.suspend).not.toHaveBeenCalled();
  });
  // I20：卡片与后台结果共享同一逻辑页面；并发准入只允许一个 owner，30 task 超限时拒绝新任务而不销毁现有页面。
  it("admits one owner when the card and background result race at task capacity", async () => {
    const owner = pool();
    const background = make("shared");
    await owner.add(background);
    await owner.reserve(background);
    for (let n = 1; n < 30; n++) await owner.add(make(String(n)));
    const card = make("shared");
    const [duplicate, overflow] = await Promise.allSettled([
      owner.add(card),
      owner.add(make("overflow")),
    ]);
    expect(duplicate.status).toBe("rejected");
    expect(overflow.status).toBe("rejected");
    expect(owner.get("shared")).toBe(background);
    expect(background.suspend).not.toHaveBeenCalled();
    expect(background.destroy).not.toHaveBeenCalled();
  });
});
