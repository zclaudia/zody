import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾，Linux 上是无操作。
const readTimelineSource = () =>
  readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8").replaceAll("\r\n", "\n");

describe("ConversationTimeline scrollbar gutter", () => {
  it("reserves stable scrollbar space on the shared conversation viewport", () => {
    const source = readTimelineSource();

    expect(source).toContain("overflow-y-auto [scrollbar-gutter:stable]");
  });

  // fork（F4.8）：分享选择滚动锁/隐藏轮导航的源码断言随会话分享功能删除。
});
