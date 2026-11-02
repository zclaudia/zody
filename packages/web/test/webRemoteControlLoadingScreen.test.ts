// @vitest-environment jsdom

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebRemoteControlLoadingScreen } from "../src/webRemoteControlLoadingScreen.js";

/**
 * settings-4：连接加载页是弱网等待时的全屏唯一内容，原先标题/描述/步骤行全是
 * text-ui-xs（10px），手机上辨识吃力。锁定按角色提升后的字号，防止回退。
 */
describe("web remote control loading screen", () => {
  it("uses readable waiting-state typography instead of 10px metadata sizes", () => {
    render(createElement(WebRemoteControlLoadingScreen, { state: "waiting" }));

    const title = screen.getByRole("heading", { level: 1 });
    expect(title.className).toContain("text-ui-base");
    expect(title.className).not.toContain("text-ui-xs");

    // 描述与步骤行是次要信息，至少 text-ui-sm（12px）。
    const description = title.parentElement?.nextElementSibling;
    expect(description?.className).toContain("text-ui-sm");
    const stepRow = document.querySelector("section .grid > div");
    expect(stepRow?.className).toContain("text-ui-sm");
    expect(stepRow?.className).not.toContain("text-ui-xs");
  });
});
