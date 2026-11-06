// @vitest-environment jsdom

import { createElement, useEffect, useState, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SHORTCUT_COMMANDS } from "@zody/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { ModelProviderSectionLayout } from "@/settings/model-provider-section/SectionLayout.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { SettingsBreadcrumbProvider } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsRangeControl, SettingsRow } from "@/settings/SettingsPageParts.js";
import { SettingsPresentationProvider } from "@/settings/SettingsPresentationContext.js";
import { ShortcutBindingRow } from "@/settings/ShortcutBindingRow.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
    localePreference: "system",
    setLocalePreference: vi.fn(),
  }),
}));

afterEach(cleanup);

function mobileTree(node: ReactElement, isMobile = true) {
  return createElement(SettingsPresentationProvider, { isMobile }, node);
}

function provider(providerId: string, label: string): ProviderSettingsFormProvider {
  return {
    providerId,
    providerName: label,
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: { group: "standard-personal" },
    config: { group: "standard-personal", label },
    models: [],
  } as ProviderSettingsFormProvider;
}

const navigationGroups: ModelProviderNavGroup[] = [
  {
    id: "custom",
    title: "Custom providers",
    items: [
      {
        key: "custom:provider-a",
        type: "custom",
        label: "Provider A",
        provider: provider("provider-a", "Provider A"),
        statusActive: true,
      },
      {
        key: "custom:provider-b",
        type: "custom",
        label: "Provider B",
        provider: provider("provider-b", "Provider B"),
        statusActive: true,
      },
    ],
  },
];

function providerLayout(overrides: Record<string, unknown> = {}) {
  const props = {
    description: "description",
    refreshLabel: "refresh",
    loadingLabel: "loading",
    presetLoading: false,
    customLoading: false,
    onRefresh: vi.fn(),
    addProviderLabel: "Add provider",
    onAddProvider: vi.fn(),
    navigationGroups,
    selectedNodeKey: "custom:provider-a",
    onSelectNavItem: vi.fn(),
    reorderableProviderIds: new Set(["provider-a", "provider-b"]),
    empty: false,
    mobileDetailOpen: false,
    onCloseMobileDetail: vi.fn(),
    ...overrides,
  };
  return props;
}

function renderProviderLayout({
  isMobile = true,
  onItemsChange = vi.fn(),
  overrides = {},
}: {
  isMobile?: boolean;
  onItemsChange?: ReturnType<typeof vi.fn>;
  overrides?: Record<string, unknown>;
} = {}) {
  const build = () =>
    createElement(
      TooltipProvider,
      null,
      mobileTree(
        createElement(
          SettingsBreadcrumbProvider,
          { onItemsChange, sectionLabel: "Model providers" },
          createElement(
            ModelProviderSectionLayout,
            providerLayout(overrides),
            createElement("div", { "data-testid": "provider-detail" }, "detail content"),
          ),
        ),
        isMobile,
      ),
    );
  const view = render(build());
  return { view, build, container: view.container, onItemsChange };
}

describe("mobile settings presentation context", () => {
  it("SettingsRow 在手机呈现为标签在上、控件在下的单列，桌面保持原 grid class", () => {
    const { container } = render(
      mobileTree(
        createElement(SettingsRow, {
          label: "Label",
          description: "Description",
          control: createElement("div", { "data-slot": "select-trigger" }, "control"),
        }),
      ),
    );

    const row = container.querySelector("[data-settings-row-layout]");
    expect(row?.getAttribute("data-settings-row-layout")).toBe("stacked");
    const grid = row?.firstElementChild;
    expect(grid?.className).toContain("grid-cols-1");
    expect(grid?.className).not.toContain("grid-cols-[minmax(0,1fr)_192px]");
    const control = row?.querySelector("[data-settings-row-control]");
    expect(control?.className).toContain("flex-wrap");
    expect(control?.className).toContain("justify-start");
    expect(control?.className).toContain("[&_input:not([type=range])]:text-mobile-input-safe");

    cleanup();

    const desktop = render(
      mobileTree(
        createElement(SettingsRow, {
          label: "Label",
          control: createElement("div", null, "control"),
        }),
        false,
      ),
    );
    const desktopRow = desktop.container.querySelector("[data-settings-row-layout]");
    expect(desktopRow?.getAttribute("data-settings-row-layout")).toBe("inline");
    expect(desktopRow?.firstElementChild?.className).toContain("grid-cols-[minmax(0,1fr)_192px]");
    expect(desktopRow?.querySelector("[data-settings-row-control]")?.className).toContain(
      "flex-nowrap",
    );
  });

  it("SettingsRangeControl 在手机可收缩到 320px 内容宽度，桌面保持 280px", () => {
    const mobile = render(
      mobileTree(
        createElement(SettingsRangeControl, {
          value: 14,
          min: 12,
          max: 20,
          step: 1,
          onChange: vi.fn(),
          valueLabel: "14",
        }),
      ),
    );
    expect(mobile.container.firstElementChild?.className).toContain("w-full");
    expect(mobile.container.firstElementChild?.className).toContain("max-w-[280px]");
    cleanup();

    const desktop = render(
      createElement(SettingsRangeControl, {
        value: 14,
        min: 12,
        max: 20,
        step: 1,
        onChange: vi.fn(),
        valueLabel: "14",
      }),
    );
    expect(desktop.container.firstElementChild?.className).toContain("w-[280px]");
  });
});

describe("mobile model provider list and detail", () => {
  it("手机先显示完整文字 Provider 列表，点击条目仍走现有 onSelectNavItem", () => {
    const onSelectNavItem = vi.fn();
    const { view, container } = renderProviderLayout({ overrides: { onSelectNavItem } });

    expect(container.querySelector('[data-model-provider-mobile-list="true"]')).toBeTruthy();
    expect(container.querySelector('[data-model-provider-split-panel="true"]')).toBeNull();
    expect(screen.getByText("Provider A")).toBeTruthy();
    expect(screen.getByText("Provider B")).toBeTruthy();
    expect(screen.getByTestId("model-provider-nav-item-custom:provider-b").className).toContain(
      "min-h-11",
    );

    fireEvent.click(screen.getByTestId("model-provider-nav-item-custom:provider-b"));
    expect(onSelectNavItem).toHaveBeenCalledWith(
      expect.objectContaining({ key: "custom:provider-b" }),
    );

    view.unmount();
  });

  it("手机详情只保留单个 Provider，并通过通用 breadcrumb 父级返回列表", () => {
    const onItemsChange = vi.fn();
    const onCloseMobileDetail = vi.fn();
    const { view, container } = renderProviderLayout({
      onItemsChange,
      overrides: { mobileDetailOpen: true, onCloseMobileDetail },
    });

    // 列表保持挂载但隐藏；详情可见，不能靠卸载详情换视图。
    expect(
      container.querySelector('[data-model-provider-mobile-list="true"]')?.className,
    ).toContain("hidden");
    expect(
      container.querySelector('[data-model-provider-mobile-detail="true"]')?.className,
    ).not.toContain("hidden");
    expect(screen.getByTestId("provider-detail").textContent).toBe("detail content");
    const items = onItemsChange.mock.lastCall?.[0] as Array<{
      label: string;
      onSelect?: () => void;
    }>;
    expect(items.map((item) => item.label)).toEqual(["Model providers", "Provider A"]);

    items[0]?.onSelect?.();
    expect(onCloseMobileDetail).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("返回列表只隐藏详情：同一子树/输入节点与草稿在往返后保持", () => {
    let mountCount = 0;
    function DraftProbe() {
      const [value, setValue] = useState("");
      useEffect(() => {
        mountCount += 1;
      }, []);
      return createElement("input", {
        "data-testid": "provider-draft",
        value,
        onChange: (event: { currentTarget: HTMLInputElement }) =>
          setValue(event.currentTarget.value),
      });
    }

    const build = (mobileDetailOpen: boolean) =>
      createElement(
        TooltipProvider,
        null,
        mobileTree(
          createElement(
            SettingsBreadcrumbProvider,
            { onItemsChange: vi.fn(), sectionLabel: "Model providers" },
            createElement(
              ModelProviderSectionLayout,
              providerLayout({ mobileDetailOpen }),
              createElement(DraftProbe),
            ),
          ),
        ),
      );

    const view = render(build(false));
    const detail = () => view.container.querySelector('[data-model-provider-mobile-detail="true"]');
    const list = () => view.container.querySelector('[data-model-provider-mobile-list="true"]');
    expect(detail()?.className).toContain("hidden");
    expect(list()?.className).not.toContain("hidden");

    const input = screen.getByTestId("provider-draft") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "draft value" } });
    expect(input.value).toBe("draft value");
    expect(mountCount).toBe(1);

    view.rerender(build(true));
    expect(screen.getByTestId("provider-draft")).toBe(input);
    expect(input.value).toBe("draft value");
    expect(detail()?.className).not.toContain("hidden");
    expect(list()?.className).toContain("hidden");
    expect(mountCount).toBe(1);

    view.rerender(build(false));
    expect(screen.getByTestId("provider-draft")).toBe(input);
    expect(input.value).toBe("draft value");
    expect(detail()?.className).toContain("hidden");
    expect(list()?.className).not.toContain("hidden");
    expect(mountCount).toBe(1);

    view.rerender(build(true));
    expect(screen.getByTestId("provider-draft")).toBe(input);
    expect(input.value).toBe("draft value");
    expect(mountCount).toBe(1);
    view.unmount();
  });

  it("桌面保持 56px/224px 双栏与 split-panel 标记", () => {
    const { container, view } = renderProviderLayout({
      isMobile: false,
      overrides: { mobileDetailOpen: true },
    });
    expect(container.querySelector('[data-model-provider-split-panel="true"]')).toBeTruthy();
    expect(container.querySelector('[data-model-provider-navigation-scroll="true"]')).toBeTruthy();
    expect(container.querySelector('[data-model-provider-mobile-list="true"]')).toBeNull();
    expect(container.querySelector('[data-model-provider-mobile-detail="true"]')).toBeNull();
    view.unmount();
  });

  it("Navigation 的 mobileList 使用完整文字行，不再保留 56px 图标栏 class", () => {
    const html = (isMobileList: boolean) =>
      renderToMarkup(
        createElement(ModelProviderSectionNavigation, {
          navigationGroups,
          selectedNodeKey: "custom:provider-a",
          customLoading: false,
          onSelectNavItem: vi.fn(),
          mobileList: isMobileList,
        }),
      );

    const mobile = html(true);
    expect(mobile).toContain("Provider A");
    expect(mobile).not.toContain("max-md:sr-only");
    expect(mobile).toContain("min-h-11");
    expect(mobile).not.toContain("max-md:size-8");

    const desktop = html(false);
    expect(desktop).toContain("max-md:sr-only");
    expect(desktop).toContain("max-md:size-8");
  });
});

describe("mobile shortcut cards", () => {
  const entry = SHORTCUT_COMMANDS[0]!;
  const bindings = ["CmdOrCtrl+k"];

  function shortcutRow(onClearAll = vi.fn()) {
    return createElement(ShortcutBindingRow, {
      entry,
      commandLabel: "Open Command Center",
      bindings,
      isOverridden: false,
      isRecording: false,
      recording: null,
      menuChannelUnavailable: false,
      onRecord: vi.fn(),
      onSteal: vi.fn(),
      onClearAll,
    });
  }

  it("手机渲染纵向命令卡片，保留 scope 与全部 test id", () => {
    const onClearAll = vi.fn();
    render(mobileTree(shortcutRow(onClearAll)));

    const row = screen.getByTestId(`settings-shortcut-row-${entry.id}`);
    expect(row.getAttribute("data-settings-shortcut-layout")).toBe("card");
    expect(row.className).toContain("flex-col");
    expect(row.className).not.toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px]");
    expect(screen.getByText("Open Command Center")).toBeTruthy();
    expect(screen.getByTestId(`settings-shortcut-scope-${entry.id}`)).toBeTruthy();
    expect(screen.getByTestId(`settings-shortcut-bind-${entry.id}-0`)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`settings-shortcut-clear-${entry.id}`));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it("桌面保留固定表格列", () => {
    render(shortcutRow());
    const row = screen.getByTestId(`settings-shortcut-row-${entry.id}`);
    expect(row.getAttribute("data-settings-shortcut-layout")).toBe("table");
    expect(row.className).toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px]");
  });
});

function renderToMarkup(element: ReactElement): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, mobileTree(element, true)));
}
