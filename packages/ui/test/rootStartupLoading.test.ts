import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading, ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

describe("RootStartupLoading", () => {
  it("引导使用静态品牌图标时展示应用图标且不播放呼吸动画", () => {
    const html = renderToStaticMarkup(createElement(ZCodeStartupLogoBadge, { animated: false }));
    expect(html).toContain("<img");
    expect(html).toContain("zody-logo.png");
    expect(html).not.toContain("zcode-startup-logo-breathe");
    expect(html).not.toContain("M134.4");
  });
  it("启动阻塞态使用应用图标而不是可见 loading 文案", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain("<img");
    expect(html).toContain("zody-logo.png");
    expect(html).toContain("zcode-startup-logo-breathe");
    expect(html).not.toContain("M134.4");
    expect(html).toContain("bg-background");
    expect(html).not.toContain(">加载中...<");
  });
});
