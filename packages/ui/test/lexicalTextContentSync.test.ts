import { describe, expect, it, vi } from "vitest";
import { createTextContentSyncController } from "@/LexicalChatInput.js";

function createController(overrides: {
  onChange: (text: string) => void;
  taskId?: string | null;
  getIsComposing?: () => boolean;
}) {
  return createTextContentSyncController({
    taskId: null,
    getIsComposing: () => false,
    ...overrides,
  });
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe("createTextContentSyncController（perf-8 onChange 序列化合批）", () => {
  it("非 dirty update 不下发", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: false, nextText: "hello" });
    await flushMicrotasks();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("dirty update 在微任务冲刷点下发一次", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    // 同步阶段不下发（合批等待当前任务结束）。
    expect(onChange).not.toHaveBeenCalled();
    await flushMicrotasks();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("同一任务内多次 update（IME 组合提交）合并为一次下发，取最后文本", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "你" });
    controller.handleEditorUpdate({ isDirty: true, nextText: "你好" });
    controller.handleEditorUpdate({ isDirty: true, nextText: "你好，世界" });
    await flushMicrotasks();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("你好，世界");
  });

  it("与上次下发文本相同的 update 不重复下发（去重语义与旧实现一致）", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    await flushMicrotasks();
    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    await flushMicrotasks();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("评审回归：同任务净回退到已下发文本，不下发过期中间值（终态与旧实现一致）", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    await flushMicrotasks();
    expect(onChange).toHaveBeenLastCalledWith("hello");

    // 同一任务内：先删到 "hell"（已排队待冲刷），冲刷前又组合回 "hello"。
    // 修复前：第二个 update 因 nextText === lastEmittedText 提前 return，
    // 冲刷把过期的中间值 "hell" 当终态下发；编辑器真实状态是 "hello"。
    controller.handleEditorUpdate({ isDirty: true, nextText: "hell" });
    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    await flushMicrotasks();

    // 终态等于已下发值：跳过冗余下发，父组件现值 "hello" 即终态——
    // 与旧实现（逐次 emit "hell"、"hello"，终态相同）最终状态一致。
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("同任务净回退到不同于已下发值的终态：冲刷下发最终值而非中间值", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    await flushMicrotasks();

    controller.handleEditorUpdate({ isDirty: true, nextText: "hel" });
    controller.handleEditorUpdate({ isDirty: true, nextText: "hell" });
    await flushMicrotasks();

    expect(onChange).toHaveBeenLastCalledWith("hell");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("跨批次文本回退（撤销）能再次下发", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    await flushMicrotasks();
    controller.handleEditorUpdate({ isDirty: true, nextText: "hell" });
    await flushMicrotasks();

    expect(onChange).toHaveBeenLastCalledWith("hell");
  });

  it("空文档首帧（nextText=''）与旧实现一致：不下发", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "" });
    await flushMicrotasks();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("dispose 后丢弃在途微任务，不再向旧 onChange 下发", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });

    controller.handleEditorUpdate({ isDirty: true, nextText: "hello" });
    controller.dispose();
    await flushMicrotasks();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("程序化改写 tag 透传给 recordInputLag（经 shouldReportInputLag 短路，不抛错）", async () => {
    const onChange = vi.fn();
    const controller = createController({ onChange });
    const programmaticTags = new Set(["programmatic"]);

    expect(() => {
      controller.handleEditorUpdate({
        isDirty: true,
        nextText: "restored",
        tags: programmaticTags,
      });
    }).not.toThrow();
    await flushMicrotasks();

    expect(onChange).toHaveBeenCalledWith("restored");
  });
});
