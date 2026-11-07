// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  captureImageComposerTarget,
  registerImageComposerTarget,
} from "@/image-preview-editor/composerTarget.js";

// F15（上游 a60ba6a7 image-preview-editor/composerTarget.ts）：焦点 Composer 捕获通道。
// 合同见 docs/ui/image-preview-editor.md：同步单次请求-应答、先到先得、释放后旧引用 append=false。

describe("captureImageComposerTarget / registerImageComposerTarget", () => {
  it("无注册时捕获返回 null（无接收方提示的判定来源）", () => {
    expect(captureImageComposerTarget()).toBeNull();
  });

  it("注册后捕获返回目标，append 同步透传返回值", () => {
    const append = vi.fn(() => true);
    const unregister = registerImageComposerTarget({ append });
    const target = captureImageComposerTarget();
    expect(target).not.toBeNull();
    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    expect(target!.append(file)).toBe(true);
    expect(append).toHaveBeenCalledWith(file);

    unregister();
  });

  it("unregister 后：捕获回到 null，已捕获的旧目标 append 恒 false（防迟到写入旧 scope）", () => {
    const append = vi.fn(() => true);
    const unregister = registerImageComposerTarget({ append });
    const stale = captureImageComposerTarget();
    unregister();
    expect(captureImageComposerTarget()).toBeNull();
    expect(stale!.append(new File([], "b.png", { type: "image/png" }))).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it("多次注册先到先得：首个活跃接收方占坑，后续注册不抢占", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerImageComposerTarget({ append: first });
    const unregisterSecond = registerImageComposerTarget({ append: second });
    const target = captureImageComposerTarget();
    target!.append(new File([], "c.png", { type: "image/png" }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    unregisterFirst();
    unregisterSecond();
  });

  it("首个接收方释放后，捕获落到下一个活跃接收方", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerImageComposerTarget({ append: first });
    const unregisterSecond = registerImageComposerTarget({ append: second });
    unregisterFirst();
    const target = captureImageComposerTarget();
    target!.append(new File([], "d.png", { type: "image/png" }));
    expect(second).toHaveBeenCalledTimes(1);

    unregisterSecond();
  });

  it("支持注入隔离 EventTarget：不影响 window 默认通道", () => {
    const bus = new EventTarget();
    const append = vi.fn(() => true);
    const unregister = registerImageComposerTarget({ append }, bus);
    expect(captureImageComposerTarget(bus)).not.toBeNull();
    expect(captureImageComposerTarget()).toBeNull();

    unregister();
  });
});
