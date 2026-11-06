// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginUiPages } from "./pluginUiPageRegistry.js";
import type { Page } from "./pluginUiHostTypes.js";

// F18（上游 a60ba6a7）：pluginUiPages 对 PluginUiBackgroundRetention 的接线反例。
// prepared 注册/注销、claim/finish 预占、settled/visibility→changed、released→release
// （docs/plugin-ui-background-execution.md §12.3/§12.5）。
// fake suspend 按真实 managedPage 语义建模：先 claim 预占，成功才 teardown 并 finish。
const realTimeout = setTimeout;
const flush = () => new Promise((resolve) => realTimeout(resolve, 0));

const created: Page[] = [];
function fakePage(n: number): Page {
  const state = { running: true };
  const page: Page = {
    kind: "mcp",
    key: `key-${n}`,
    task: `task-${n}`,
    visible: false,
    snapshot: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    update: vi.fn(),
    bind: vi.fn(() => () => {}),
    busy: () => false,
    running: () => state.running,
    suspend: vi.fn(async () => {
      if (!pluginUiPages.claimRecycle(page)) return false;
      try {
        state.running = false;
        return true;
      } finally {
        pluginUiPages.finishRecycle(page);
      }
    }),
    destroy: vi.fn(),
  };
  created.push(page);
  return page;
}

describe("pluginUiPages retention wiring", () => {
  afterEach(() => {
    vi.useRealTimers();
    // retention 是模块级单例：必须逐页 release，否则注册泄漏进后续用例污染配额。
    for (const page of created.splice(0)) pluginUiPages.released(page);
    pluginUiPages.clear();
  });

  it("grants claims to undeclared pages and shields declared pages within the 4/30 bounds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const undeclared = fakePage(0);
    await pluginUiPages.add(undeclared);
    expect(pluginUiPages.claimRecycle(undeclared)).toBe(true);
    pluginUiPages.finishRecycle(undeclared);

    const declared = fakePage(1);
    await pluginUiPages.add(declared);
    pluginUiPages.prepared(declared, true);
    pluginUiPages.visibility(declared, false);
    expect(pluginUiPages.claimRecycle(declared)).toBe(false);
    // 注销声明后回到默认隐藏即停路径，claim 直接放行。
    pluginUiPages.prepared(declared, false);
    expect(pluginUiPages.claimRecycle(declared)).toBe(true);
    pluginUiPages.finishRecycle(declared);
  });

  it("starts the default five-minute term for cold pages via prepared", async () => {
    vi.useFakeTimers();
    const page = fakePage(2);
    await pluginUiPages.add(page);
    // 冷页面没有 visibility 边沿；prepared 必须补一次边沿启动 5 分钟期限。
    pluginUiPages.prepared(page, false);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(page.suspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(page.suspend).toHaveBeenCalledTimes(1);
    expect(page.running()).toBe(false);
  });

  it("recycles the oldest idle declared page on the next state event beyond four", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const pages = [fakePage(10), fakePage(11), fakePage(12), fakePage(13), fakePage(14)];
    for (const page of pages) {
      await pluginUiPages.add(page);
      pluginUiPages.prepared(page, true);
      pluginUiPages.visibility(page, false);
    }
    // 冲刷注册/可见性触发的评估（闲置为 0，不会回收）。
    await flush();
    // 5 分钟默认期限到点：声明页 claim 拒绝（4/30 边界内），全部保留。
    vi.advanceTimersByTime(5 * 60_000);
    await flush();
    for (const page of pages) expect(page.running()).toBe(true);
    // 闲置到期后，下一次状态事件（visibility→activity→changed）按最旧回收。
    vi.advanceTimersByTime(26 * 60_000);
    pluginUiPages.visibility(pages[4]!, false);
    await flush();
    expect(pages[0]!.running()).toBe(false);
    for (const page of pages.slice(1)) expect(page.running()).toBe(true);
  });

  it("drops a page from the retention quota after released", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const pages = [fakePage(20), fakePage(21), fakePage(22), fakePage(23), fakePage(24)];
    for (const page of pages) {
      await pluginUiPages.add(page);
      pluginUiPages.prepared(page, true);
      pluginUiPages.visibility(page, false);
    }
    await flush();
    // 释放声明的页面回到默认隐藏即停；保留配额内（4 页）剩余声明页不因闲置被回收。
    pluginUiPages.released(pages[4]!);
    vi.advanceTimersByTime(31 * 60_000);
    await flush();
    expect(pages[4]!.running()).toBe(false);
    expect(pages[0]!.running()).toBe(true);
    expect(pages[1]!.running()).toBe(true);
    expect(pages[2]!.running()).toBe(true);
    expect(pages[3]!.running()).toBe(true);
  });
});
