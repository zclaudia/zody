import { describe, expect, it, vi } from "vitest";
import { PluginUiBackgroundRetention } from "./pluginUiBackgroundRetention.js";

// F18（上游 a60ba6a7 pluginUiBackgroundRetention）：窗口级保留策略反例集。
// 契约见 docs/plugin-ui-background-execution.md §12：上限 4 页/闲置 30 分钟、
// 最小化暂停计时、busy 不回收、claim/finish 预占、Agent 拒绝后不零延时重试。
interface FakePage {
  key: string;
  visible: boolean;
  busy: () => boolean;
  running: () => boolean;
  suspend: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
}

function createHarness() {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const timer = (run: () => void, ms: number) => {
    const entry = { at: now + ms, run };
    timers.push(entry);
    return () => {
      const index = timers.indexOf(entry);
      if (index >= 0) timers.splice(index, 1);
    };
  };
  const retention = new PluginUiBackgroundRetention<FakePage>(timer, () => now);
  const pages: FakePage[] = [];
  const page = (key: string, over: Partial<Pick<FakePage, "visible">> = {}) => {
    const state = { running: true, busy: false };
    const fake: FakePage = {
      key,
      visible: true,
      ...over,
      busy: () => state.busy,
      running: () => state.running,
      // suspend 即回收：成功后页面停止运行（模拟真实页面 teardown）。
      suspend: vi.fn(async () => {
        state.running = false;
        return true;
      }),
    };
    pages.push(fake);
    return fake;
  };
  const advance = (ms: number) => {
    now += ms;
    for (const entry of [...timers].sort((a, b) => a.at - b.at)) {
      const index = timers.indexOf(entry);
      if (index >= 0 && entry.at <= now) {
        timers.splice(index, 1);
        entry.run();
      }
    }
  };
  // changed() 的评估循环在微任务里；用真实宏任务冲刷保证所有 await 完成。
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { retention, page, pages, advance, flush, now: () => now };
}

describe("PluginUiBackgroundRetention", () => {
  it("keeps declared pages while four or fewer are in the background", async () => {
    const h = createHarness();
    const four = [h.page("a"), h.page("b"), h.page("c"), h.page("d")];
    for (const page of four) {
      h.retention.register(page);
      h.retention.activity(page);
    }
    for (const page of four) page.visible = false;
    h.advance(31 * 60_000);
    h.retention.changed();
    await h.flush();
    for (const page of four) expect(page.suspend).not.toHaveBeenCalled();
  });

  it("recycles only the oldest idle page beyond four background pages", async () => {
    const h = createHarness();
    const oldest = h.page("oldest");
    h.retention.register(oldest);
    h.retention.activity(oldest);
    oldest.visible = false;
    // 其余四页是刚活跃的新后台页。
    const fresh = [h.page("n1"), h.page("n2"), h.page("n3"), h.page("n4")];
    for (const page of fresh) {
      h.retention.register(page);
      h.retention.activity(page);
      page.visible = false;
    }
    h.advance(31 * 60_000);
    h.retention.changed();
    await h.flush();
    expect(oldest.suspend).toHaveBeenCalledTimes(1);
    for (const page of fresh) expect(page.suspend).not.toHaveBeenCalled();
  });

  it("never recycles a page visible in a visible window even when idle", async () => {
    const h = createHarness();
    const five = [h.page("v1"), h.page("h1"), h.page("h2"), h.page("h3"), h.page("h4")];
    for (const page of five) {
      h.retention.register(page);
      h.retention.activity(page);
    }
    // 窗口可见时，可见页不算后台页：后台只有 4 个，回收永不触发。
    five[1]!.visible = false;
    five[2]!.visible = false;
    five[3]!.visible = false;
    five[4]!.visible = false;
    h.advance(31 * 60_000);
    h.retention.changed();
    await h.flush();
    for (const page of five) expect(page.suspend).not.toHaveBeenCalled();
  });

  it("keeps busy pages out of recycling and falls through to the next candidate", async () => {
    const h = createHarness();
    const oldest = h.page("busy-oldest");
    const next = h.page("idle-next");
    h.retention.register(oldest);
    h.retention.activity(oldest);
    oldest.visible = false;
    h.retention.register(next);
    h.retention.activity(next);
    next.visible = false;
    for (const key of ["n1", "n2", "n3"]) {
      const page = h.page(key);
      h.retention.register(page);
      h.retention.activity(page);
      page.visible = false;
    }
    oldest.busy = () => true;
    h.advance(31 * 60_000);
    h.retention.changed();
    await h.flush();
    expect(oldest.suspend).not.toHaveBeenCalled();
    expect(next.suspend).toHaveBeenCalledTimes(1);
  });

  it("pauses idle counting while the window is visible and restarts it on minimize", async () => {
    const h = createHarness();
    const five = Array.from({ length: 5 }, (_, index) => h.page(`p${index}`));
    for (const page of five) {
      h.retention.register(page);
      h.retention.activity(page);
    }
    h.retention.setWindowVisible(true);
    // 最小化：可见页闲置从最小化时刻起算。
    h.retention.setWindowVisible(false);
    h.advance(29 * 60_000);
    h.retention.changed();
    await h.flush();
    for (const page of five) expect(page.suspend).not.toHaveBeenCalled();
    h.advance(2 * 60_000);
    h.retention.changed();
    await h.flush();
    // 最旧的 p0（activity 顺序最早）被回收，其余保留。
    expect(five[0]!.suspend).toHaveBeenCalledTimes(1);
    for (const page of five.slice(1)) expect(page.suspend).not.toHaveBeenCalled();
  });

  it("claims recycle slots atomically and releases them on finish", async () => {
    const h = createHarness();
    const page = h.page("a");
    h.retention.register(page);
    expect(h.retention.claim(page)).toBe(false);
    page.visible = false;
    for (const key of ["n1", "n2", "n3", "n4"]) {
      const other = h.page(key);
      h.retention.register(other);
      h.retention.activity(other);
      other.visible = false;
    }
    // 先冲刷注册触发的评估（此时闲置为 0，不会回收），再推进到闲置到期。
    await h.flush();
    h.advance(31 * 60_000);
    expect(h.retention.claim(page)).toBe(true);
    // 预占中的页面不能被重复预占。
    expect(h.retention.claim(page)).toBe(false);
    h.retention.finish(page);
    expect(h.retention.claim(page)).toBe(true);
    h.retention.finish(page);
  });

  it("waits for the next state event after the agent refuses a recycle", async () => {
    const h = createHarness();
    const oldest = h.page("oldest");
    h.retention.register(oldest);
    h.retention.activity(oldest);
    oldest.visible = false;
    await h.flush();
    // 其余四页错峰注册（每 6 分钟一页），保证只有 oldest 一页先到期；
    // 注册触发的评估已逐次冲刷，调度在 oldest 到期（30 分钟）处武装定时器。
    const fresh = [h.page("n1"), h.page("n2"), h.page("n3"), h.page("n4")];
    for (const page of fresh) {
      h.advance(6 * 60_000);
      h.retention.register(page);
      h.retention.activity(page);
      page.visible = false;
      await h.flush();
    }
    h.advance(6 * 60_000);
    // Agent 原子裁决拒绝（suspend 返回 false 且页面保持运行）。
    oldest.suspend.mockResolvedValueOnce(false);
    h.advance(60_000);
    await h.flush();
    expect(oldest.suspend).toHaveBeenCalledTimes(1);
    // 被拒候选不重新武装定时器（调度只取未到期候选）；无状态事件时不再重试。
    h.advance(60_000);
    await h.flush();
    expect(oldest.suspend).toHaveBeenCalledTimes(1);
    // 下一次状态事件（activity → changed）才允许重试。
    h.retention.activity(fresh[0]!);
    await h.flush();
    expect(oldest.suspend).toHaveBeenCalledTimes(2);
  });

  it("drops released pages from the background quota", async () => {
    const h = createHarness();
    const five = Array.from({ length: 5 }, (_, index) => h.page(`p${index}`));
    for (const page of five) {
      h.retention.register(page);
      h.retention.activity(page);
      page.visible = false;
    }
    h.retention.release(five[4]!);
    h.advance(31 * 60_000);
    h.retention.changed();
    await h.flush();
    // 释放后后台只剩 4 页：永不回收。
    for (const page of five) expect(page.suspend).not.toHaveBeenCalled();
    expect(h.retention.claim(five[0]!)).toBe(false);
  });
});
