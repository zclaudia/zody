import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const headerSource = readFileSync(
  new URL("../src/WorkspaceHeaderSections.tsx", import.meta.url),
  "utf8",
);

describe("WorkspaceHeaderSections「更多」触发按钮触控命中区（dialogs-4）", () => {
  // 渲染该组件需要完整 workspace store/services 夹具；此处沿用 dropdownMenuContentWidth.test.ts
  // 的源码断言模式，锁定触发按钮上的触屏命中区扩展不被回退。
  it("「更多」触发按钮在触屏态用伪元素扩出 ≥44px 命中区，桌面渲染不变", () => {
    // 定位渲染处（文件头 import 里也出现该常量），从 data-testid 所在按钮块取窗口。
    const triggerIndex = headerSource.indexOf("data-testid={TID_WORKSPACE_MORE_BUTTON}");
    expect(triggerIndex).toBeGreaterThan(-1);
    const triggerBlock = headerSource.slice(triggerIndex, triggerIndex + 1200);
    expect(triggerBlock).toContain("relative");
    expect(triggerBlock).toContain("[@media(hover:none)_and_(pointer:coarse)]:before:absolute");
    expect(triggerBlock).toContain("[@media(hover:none)_and_(pointer:coarse)]:before:-inset-2.5");
  });
});
