// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Palette, Settings2 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobileSettingsIndex,
  MobileSettingsSectionHeader,
} from "@/settings/MobileSettingsNavigation.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

const groups = [
  {
    id: "basics",
    titleId: "settings.sidebar.group.basics",
    sections: [
      { id: "general", icon: Settings2, titleId: "settings.systemTitle" },
      { id: "appearance", icon: Palette, titleId: "settings.appearanceTitle" },
    ],
  },
] as const;

describe("MobileSettingsNavigation", () => {
  afterEach(cleanup);

  it("设置首页复用分组和完整文字，选择后进入分区", () => {
    const onSelectSection = vi.fn();
    const onBack = vi.fn();
    const onOpenOnboarding = vi.fn();

    render(
      createElement(MobileSettingsIndex, {
        groups,
        onSelectSection,
        onBack,
        onOpenOnboarding,
      }),
    );

    expect(screen.getByText("settings.sidebar.group.basics")).toBeTruthy();
    expect(screen.getByText("settings.systemTitle")).toBeTruthy();

    fireEvent.click(screen.getByTestId("mobile-settings-section-appearance"));
    expect(onSelectSection).toHaveBeenCalledWith("appearance");

    fireEvent.click(screen.getByLabelText("workspace.backToWorkspace"));
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("settings.onboarding"));
    expect(onOpenOnboarding).toHaveBeenCalledTimes(1);
  });

  it("分区 header 使用通用返回语义并保留 44px 命中区", () => {
    const onBack = vi.fn();

    render(
      createElement(MobileSettingsSectionHeader, {
        title: "settings.appearanceTitle",
        onBack,
      }),
    );

    const back = screen.getByLabelText("common.back");
    expect(back.className).toContain("size-11");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
