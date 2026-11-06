// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlMobileSettingsButton } from "@/WebRemoteControlMobileSettingsButton.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

describe("WebRemoteControlMobileSettingsButton", () => {
  afterEach(cleanup);

  it("点击一次直接进入共享应用设置，不再展开菜单", () => {
    const onOpenAppSettings = vi.fn();
    render(createElement(WebRemoteControlMobileSettingsButton, { onOpenAppSettings }));

    const trigger = screen.getByRole("button", {
      name: "webRemoteControl.mobileSettings.trigger",
    });
    expect(trigger.className).toContain("size-11");
    // 入口只有一个动作：点击即进入 SettingsPage，不出现任何菜单层。
    fireEvent.click(trigger);
    expect(onOpenAppSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("没有设置动作时不渲染触发器", () => {
    render(createElement(WebRemoteControlMobileSettingsButton, {}));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
