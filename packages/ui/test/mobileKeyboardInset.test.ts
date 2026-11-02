// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMobileKeyboardInsetTracker } from "@/lib/mobileKeyboardInset.js";

const CSS_VARIABLE = "--zcode-keyboard-inset";
const root = () => document.documentElement;

/**
 * jsdom 没有 visualViewport（spec §2.4 降级分支的天然覆盖）；
 * 这里用 EventTarget 派生桩补出 height/offsetTop 与事件派发能力，
 * resize/scroll 用 target.dispatchEvent(new Event(name)) 触发。
 */
function createVisualViewportStub() {
  const target = new EventTarget();
  const stub = Object.assign(target, {
    height: 600,
    offsetTop: 0,
  });
  return stub;
}

/** 手动 rAF 队列：注册的回调由测试显式 flush，cancelAnimationFrame 真实移除，用于断言“取消待执行帧”。 */
let rafQueue: Map<number, FrameRequestCallback>;
let rafIdCounter: number;

function flushRaf() {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const callback of pending) {
    callback(performance.now());
  }
}

/**
 * tracker 是模块级单例（spec §2.4 幂等安装），测试间会串状态；
 * 每个用例创建的卸载函数登记到这里，afterEach 兜底清理，
 * 保证某个用例断言失败提前退出时，也不会把活动实例泄漏给后续用例。
 */
let disposers: Array<() => void>;

function track(dispose: () => void) {
  disposers.push(dispose);
  return dispose;
}

beforeEach(() => {
  rafQueue = new Map();
  rafIdCounter = 0;
  disposers = [];
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    rafIdCounter += 1;
    rafQueue.set(rafIdCounter, callback);
    return rafIdCounter;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id);
  });
});

afterEach(() => {
  // 逆序兜底卸载：卸载函数自身幂等，重复调用安全。
  for (const dispose of disposers.reverse()) {
    dispose();
  }
  vi.unstubAllGlobals();
  root().style.removeProperty(CSS_VARIABLE);
});

describe("installMobileKeyboardInsetTracker", () => {
  it("visualViewport 缺失时安装不抛错、不写变量，卸载与重复安装均为安全无操作", () => {
    // jsdom 默认无 visualViewport，且未 stub。
    expect(() => {
      const dispose = installMobileKeyboardInsetTracker();
      track(dispose);
      expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("");
      expect(() => dispose()).not.toThrow();
      expect(() => dispose()).not.toThrow();
      const reinstall = installMobileKeyboardInsetTracker();
      track(reinstall);
      expect(() => reinstall()).not.toThrow();
    }).not.toThrow();
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("");
  });

  it("安装时同步写入初值：innerHeight − (height + offsetTop)", () => {
    const visualViewport = createVisualViewportStub();
    vi.stubGlobal("visualViewport", visualViewport);

    track(installMobileKeyboardInsetTracker());

    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("200px");
  });

  it("键盘收起写 0px 且变量不删除；height + offsetTop 超出 innerHeight 时钳制为 0", () => {
    const visualViewport = createVisualViewportStub();
    vi.stubGlobal("visualViewport", visualViewport);
    track(installMobileKeyboardInsetTracker());

    // 键盘收起：height 回到 innerHeight。
    visualViewport.height = 800;
    visualViewport.dispatchEvent(new Event("resize"));
    flushRaf();
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("0px");
    expect(root().style.getPropertyValue(CSS_VARIABLE)).not.toBe("");

    // offsetTop 平移使 height + offsetTop 超过 innerHeight，max(0, …) 钳制为非负。
    visualViewport.height = 750;
    visualViewport.offsetTop = 100;
    visualViewport.dispatchEvent(new Event("scroll"));
    flushRaf();
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("0px");
  });

  it("resize/scroll 经 rAF 合并：同一帧多次触发只调度一次回调、只写一次变量", () => {
    const visualViewport = createVisualViewportStub();
    const addEventListenerSpy = vi.spyOn(visualViewport, "addEventListener");
    vi.stubGlobal("visualViewport", visualViewport);
    const setPropertySpy = vi.spyOn(root().style, "setProperty");

    track(installMobileKeyboardInsetTracker());
    setPropertySpy.mockClear();

    // 同一帧连发 2 次 resize + 1 次 scroll：只应调度一个 rAF 帧。
    visualViewport.height = 500;
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.offsetTop = 50;
    visualViewport.dispatchEvent(new Event("scroll"));
    expect(rafQueue.size).toBe(1);

    flushRaf();
    // 安装初值之外，本帧只有一次合并后的写入：250 = 800 − (500 + 50)。
    expect(setPropertySpy).toHaveBeenCalledTimes(1);
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("250px");

    // 已合并帧执行后再触发才产生下一次调度。
    visualViewport.dispatchEvent(new Event("resize"));
    expect(rafQueue.size).toBe(1);

    expect(addEventListenerSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(addEventListenerSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("卸载移除监听、取消待执行 rAF、删除变量；重复卸载安全", () => {
    const visualViewport = createVisualViewportStub();
    const removeEventListenerSpy = vi.spyOn(visualViewport, "removeEventListener");
    vi.stubGlobal("visualViewport", visualViewport);

    const dispose = track(installMobileKeyboardInsetTracker());
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("200px");

    // 排一个待执行帧后再卸载：帧应被取消，flush 不产生写入。
    visualViewport.height = 500;
    visualViewport.dispatchEvent(new Event("resize"));
    expect(rafQueue.size).toBe(1);

    dispose();
    dispose(); // 重复卸载安全

    expect(rafQueue.size).toBe(0);
    flushRaf();
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("");
    expect(removeEventListenerSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeEventListenerSpy).toHaveBeenCalledWith("scroll", expect.any(Function));

    // 卸载后事件不再触发调度。
    visualViewport.dispatchEvent(new Event("resize"));
    expect(rafQueue.size).toBe(0);
  });

  it("重复安装幂等：返回同一卸载函数、不叠加监听；卸载后再安装恢复完整功能", () => {
    const visualViewport = createVisualViewportStub();
    const addEventListenerSpy = vi.spyOn(visualViewport, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(visualViewport, "removeEventListener");
    vi.stubGlobal("visualViewport", visualViewport);

    const first = track(installMobileKeyboardInsetTracker());
    const second = installMobileKeyboardInsetTracker();
    expect(second).toBe(first);
    // 两组监听各一次，无叠加。
    expect(addEventListenerSpy).toHaveBeenCalledTimes(2);

    first();
    first(); // 重复调用安全
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(2);
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("");

    // 卸载后再安装：监听重新绑定、初值重新写入。
    const third = installMobileKeyboardInsetTracker();
    track(third);
    expect(third).not.toBe(first);
    expect(addEventListenerSpy).toHaveBeenCalledTimes(4);
    expect(root().style.getPropertyValue(CSS_VARIABLE)).toBe("200px");
  });

  it("无 visualViewport 分支同样幂等：重复安装返回同一无操作卸载函数", () => {
    const first = track(installMobileKeyboardInsetTracker());
    const second = installMobileKeyboardInsetTracker();
    expect(second).toBe(first);
    first();
    const third = installMobileKeyboardInsetTracker();
    track(third);
    expect(third).not.toBe(first);
  });
});
