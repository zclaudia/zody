// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { SettingsHeaderBreadcrumb } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));

afterEach(cleanup);

describe("settings touch targets", () => {
  it("Select trigger 与 Switch 在 coarse pointer 下补 44px 命中区，桌面 class 不变", () => {
    render(
      createElement(
        Select,
        null,
        createElement(
          SelectTrigger,
          { "data-testid": "select-trigger" },
          createElement(SelectValue, { placeholder: "value" }),
        ),
      ),
    );
    const trigger = screen.getByTestId("select-trigger");
    expect(trigger.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:min-h-11");

    cleanup();
    const switchView = render(createElement(Switch, { "data-testid": "switch" }));
    const switchElement = switchView.getByTestId("switch");
    expect(switchElement.className).toContain(
      "[@media(hover:none)_and_(pointer:coarse)]:after:-inset-y-[14px]",
    );
  });

  it("SettingsSearchInput 清除按钮在触屏态是 44px，输入框使用 iOS 兼容字号", () => {
    const onClear = vi.fn();
    render(
      createElement(SettingsSearchInput, {
        value: "plugin",
        clearLabel: "Clear search",
        clearTestId: "settings-search-clear",
        onClear,
        onChange: vi.fn(),
      }),
    );
    const input = screen.getByRole("searchbox");
    expect(input.className).toContain(
      "[@media(hover:none)_and_(pointer:coarse)]:text-mobile-input-safe",
    );
    const clear = screen.getByTestId("settings-search-clear");
    expect(clear.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:size-11");
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("资源页操作组保持 More/Refresh/New 顺序，并补触屏命中区", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(SettingsResourceHeaderActions, {
          onImport: vi.fn(),
          onRefresh: vi.fn(),
          onNew: vi.fn(),
          newLabel: "New",
        }),
      ),
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["", "", "New"]);
    expect(buttons[0]?.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:size-11");
    expect(buttons[1]?.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:size-11");
    expect(buttons[2]?.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:min-h-11");
  });

  it("SettingsHeaderBreadcrumb 的可点击层级补 44px 命中区", () => {
    render(
      createElement(SettingsHeaderBreadcrumb, {
        ariaLabel: "Settings path",
        items: [{ label: "Memory", onSelect: vi.fn() }, { label: "z-code" }],
      }),
    );
    expect(buttons()[0]?.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:min-h-11");
  });
});

function buttons(): HTMLElement[] {
  return screen.getAllByRole("button");
}
