// F17 步骤③（ROW_OVERSCAN 收紧与未知长轮一屏估高，上游 a60ba6a7 移植）：
// 源级守卫测试。沿用 v4ConversationTimelineScrollbarGutter.test.ts 的源断言约定——
// overscan 常量与 estimateSize 的 fallback 接线都在组件内部，jsdom 下视口高度不可得，
// 行为效果由浏览器 harness M3（conversation-timeline-perf-baseline.test.mjs 的
// locateJump 场景）验证；这里防止两处接线被后续改动静默回退。
// spec：docs/ui/chat-virtual-scroll.md「步骤③契约」。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾，Linux 上是无操作。
const readTimelineSource = () =>
  readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8").replaceAll("\r\n", "\n");

describe("ConversationTimeline overscan 与未知轮估高", () => {
  it("ROW_OVERSCAN 收紧为 2：虚拟单元是一整轮长正文，8 轮缓冲会把跳转放大成数十屏布局工作", () => {
    const source = readTimelineSource();

    expect(source).toContain("const ROW_OVERSCAN = 2;");
  });

  it("estimateSize 对未测量轮以视口一屏高度作保守预算，视口不可得时回落固定估计", () => {
    const source = readTimelineSource();

    // 一屏估高（clientHeight）必须作为 estimate 的 fallback 接入，且保留 0/undefined 回落。
    expect(source).toContain(
      "scrollRef.current?.clientHeight || DEFAULT_ROW_HEIGHT_ESTIMATE_PX",
    );
  });
});
