// F17 步骤④（批量测高与 measuredLayoutRevision，上游 a60ba6a7 移植）：源级守卫测试。
// 沿用 v4ConversationTimelineScrollbarGutter / v4TimelineOverscanEstimate 的源断言约定——
// revision 捕获/消费、前插批量测高 effect 与让位守卫、settle 发布、suppressAdjustment
// 前插条件都是组件内部 layout-effect 接线，行为由 SRM10 浏览器回归与基线 harness 覆盖；
// 这里防止接线被后续改动静默回退。spec：docs/ui/chat-virtual-scroll.md「步骤④契约」。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾，Linux 上是无操作。
const readTimelineSource = () =>
  readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8").replaceAll("\r\n", "\n");

describe("ConversationTimeline 批量测高与 measuredLayoutRevision", () => {
  it("revision 状态被捕获（不再丢弃）并进入 mountedRowsKey 与底部锚定 effect 依赖", () => {
    const source = readTimelineSource();

    expect(source).toContain("const [measuredLayoutRevision, commitMeasuredLayout] = useState(0);");
    // mountedRowsKey 以 revision 为失效代际：测高提交后挂载 DOM 对账重查。
    expect(source).toContain("String(measuredLayoutRevision),");
    expect(source).toContain("[liveUnit, measuredLayoutRevision, virtualRows]");
    // 底部锚定/滚动记忆恢复 effect 在 revision 提交后重新对账。
    expect(source.match(/measuredLayoutRevision,/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("前插/冷恢复批量测高 effect：layout 阶段差量 resizeItem，置 pending 并提交 revision", () => {
    const source = readTimelineSource();

    expect(source).toContain("contentMeasurementPendingRef.current = measurements.length > 0;");
    expect(source).toMatch(/querySelectorAll\(":scope > \[data-index\]"\)[^\n]*\?\? \[\]/);
  });

  it("pending 期间三个 effect 让位（滚动记忆恢复/前插锚点/底部锚定）", () => {
    const source = readTimelineSource();

    const guards = source.match(/if \(contentMeasurementPendingRef\.current\) return;/g) ?? [];
    expect(guards.length).toBe(3);
  });

  it("宽度校正 settle 结束发布 revision；suppressAdjustment 含前插抑制条件", () => {
    const source = readTimelineSource();

    // settle 定时器内发布既有生命周期结束（待定位搜索接管）：null 复位后、吸底前提交 revision。
    const timerIdx = source.indexOf("contentWidthResizeSettleTimerRef.current = window.setTimeout");
    const settleIdx =
      timerIdx === -1
        ? -1
        : source.indexOf("contentWidthResizeSettleTimerRef.current = null;", timerIdx);
    const publishIdx =
      settleIdx === -1
        ? -1
        : source.indexOf("commitMeasuredLayout((revision) => revision + 1);", settleIdx);
    const bottomIdx =
      settleIdx === -1 ? -1 : source.indexOf("if (followingRef.current) {", settleIdx);
    expect(settleIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(settleIdx);
    expect(bottomIdx).toBeGreaterThan(publishIdx);
    // 前插进行中（rows 首行 rowId < 锚点基线）抑制逐行补偿（容忍 prettier 换行）。
    const spaceFree = source.replace(/\s+/g, "");
    expect(spaceFree).toContain(
      "(rowsRef.current[0]?.rowId??Infinity)<prependAnchorRef.current.firstRowId",
    );
    // item 坐标比较改用 virtualizer 同批偏移，不混用原生 scrollTop。
    expect(source).toContain(
      "scrollTop: virtualizer.scrollOffset ?? scrollRef.current?.scrollTop ?? 0",
    );
  });
});
