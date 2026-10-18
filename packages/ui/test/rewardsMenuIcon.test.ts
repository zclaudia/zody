import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

// fork（F4.1b）：侧栏头像菜单的 Rewards 入口已随官方账号入口摘除，
// 原「真实入口 JSX / 奖励中心礼物图标」两个源码断言用例删除。
// fork（F4.4）：Rewards 组件与 i18n 文案已删除；本文件仅保留内嵌网页导航间距契约用例。

it("内嵌网页导航保留顶部和左右间距，移除底部内边距", async () => {
  const source = await readFile("packages/ui/src/components/EmbeddedWebsiteHeader.tsx", "utf8");
  expect(source).toContain('className="bg-background px-6 py-4 pb-0 max-sm:px-4"');
});
