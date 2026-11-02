// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlMobileSettingsMenu } from "@/WebRemoteControlMobileSettingsMenu.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

describe("WebRemoteControlMobileSettingsMenu", () => {
  afterEach(cleanup);

  it("只保留一个设置入口，并进入共享应用设置", async () => {
    const onOpenAppSettings = vi.fn();
    render(createElement(WebRemoteControlMobileSettingsMenu, { onOpenAppSettings }));

    const trigger = screen.getByRole("button", {
      name: "webRemoteControl.mobileSettings.trigger",
    });
    expect(trigger.className).toContain("size-11");
    // Radix DropdownMenuTrigger 通过 Enter/空格/ArrowDown 打开；jsdom 的 click 不会触发。
    fireEvent.keyDown(trigger, { key: "Enter" });

    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(1);
    // 不再提供独立的“连接设置”菜单项；连接配置已进入 SettingsPage 的平台可见分区。
    expect(
      screen.queryByRole("menuitem", {
        name: "webRemoteControl.mobileSettings.connection",
      }),
    ).toBeNull();

    fireEvent.click(items[0]!);
    expect(onOpenAppSettings).toHaveBeenCalledTimes(1);
  });

  it("没有设置动作时不渲染触发器", () => {
    render(createElement(WebRemoteControlMobileSettingsMenu, {}));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
