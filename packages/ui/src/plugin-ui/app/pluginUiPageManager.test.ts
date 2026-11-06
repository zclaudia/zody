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
  // F18（§12.1，2026-11-07 修订，上游 a60ba6a7）：未声明保留的页面沿用默认隐藏即停——
  // 离屏 5 分钟触发回收；回收是 tryRecycle 语义（Agent 可拒绝），页面 owner 记录保留给重建。
  it("suspends an offscreen default page after five minutes and keeps a visible page alive", async () => {
    vi.useFakeTimers();
    const owner = pool();
    const page = make("page");
    await owner.add(page);
    await owner.reserve(page);
    owner.visibility(page, false);
    vi.advanceTimersByTime(15 * 60_000);
    expect(page.suspend).toHaveBeenCalledTimes(1);
    owner.visibility(page, true);
    vi.advanceTimersByTime(600_000);
    expect(page.suspend).toHaveBeenCalledTimes(1);
    expect(owner.get("page")).toBe(page);
  });
  // F18（§12.1）：settled 且不可见且非忙即停；忙时到点只清定时器，随后 settle 也不得回收。
  it("suspends an idle unanchored page when its result settles but not while busy", async () => {
    vi.useFakeTimers();
    const owner = pool();
    const page = make("page");
    await owner.add(page);
    await owner.reserve(page);
    page.setBusy(true);
    owner.visibility(page, false);
    vi.advanceTimersByTime(5 * 60_000);
    expect(page.suspend).not.toHaveBeenCalled();
    page.setBusy(false);
    owner.settled(page);
    expect(page.suspend).toHaveBeenCalledTimes(1);
    expect(owner.get("page")).toBe(page);
  });
  // F18（§12.1）：30 task 上限不变，但超限时按上游路径回收「不可见且非忙」的空闲任务腾位。
  it("evicts an idle background task to admit the thirty-first task", async () => {
    const owner = pool();
    const first = make("first");
    await owner.add(first);
    await owner.reserve(first);
    for (let n = 1; n < 30; n++) {
      const page = make(String(n));
      await owner.add(page);
      await owner.reserve(page);
    }
    const overflow = make("overflow");
    await owner.add(overflow);
    expect(first.suspend).toHaveBeenCalled();
    expect(first.destroy).toHaveBeenCalled();
    expect(owner.get("first")).toBeUndefined();
    expect(owner.get("overflow")).toBe(overflow);
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
  // F18（§12.1）：64 allocated 上限不变，但超限按上游路径回收空闲隐藏页腾位。
  it("recycles an idle hidden allocation to admit the sixty-fifth", async () => {
    const owner = pool();
    const pages = Array.from({ length: 64 }, (_, i) => make(String(i), "task"));
    for (const page of pages) {
      await owner.add(page);
      await owner.reserve(page);
    }
    const next = make("next");
    await owner.add(next);
    await expect(owner.reserve(next)).resolves.toBeUndefined();
    expect(pages[0]!.suspend).toHaveBeenCalled();
    expect(owner.get("next")).toBe(next);
  });
  // F18（§12.1）：卡片与后台结果共享同一逻辑页面键，重复 owner 仍拒绝；
  // 超限的新任务经淘汰空闲后台任务腾位接纳。
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
    expect(overflow.status).toBe("fulfilled");
    // "shared" 任务被淘汰腾位；后台页走 tryRecycle 销毁。
    expect(background.suspend).toHaveBeenCalled();
    expect(background.destroy).toHaveBeenCalled();
    expect(owner.get("shared")).toBeUndefined();
    expect(owner.get("overflow")).toBeDefined();
  });
});
