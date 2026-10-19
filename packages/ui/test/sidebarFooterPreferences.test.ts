// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds, TID_LOGIN_TRIGGER } from "@zcode/shared";

// spec: docs/ui/workspace-sidebar-footer.md（方案 1A：Labeled rows）。

const h = vi.hoisted(() => ({
  zoomListener: null as null | ((state: { zoomLevel: number }) => void),
  platform: {
    executeDesktopCommand: vi.fn(),
    getDesktopZoomLevel: vi.fn(),
    onDesktopZoomLevelChanged: vi.fn(),
  },
  store: {
    interfaceMode: "coding",
    setInterfaceMode: vi.fn(),
  },
}));

vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => h.platform }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) => selector(h.store),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => null,
}));
vi.mock("@/WorkspaceWebRemoteControlTrigger.js", () => ({
  WorkspaceWebRemoteControlTrigger: () => null,
}));

async function renderFooter(props: Record<string, unknown> = {}) {
  const { WorkspaceSidebarFooter } = await import("@/WorkspaceSidebarFooter.js");
  const onThemeChange = vi.fn();
  const onLocaleChange = vi.fn();
  render(
    createElement(WorkspaceSidebarFooter, {
      theme: "zai-dark",
      localeMenuValue: "system",
      onThemeChange,
      onLocaleChange,
      isDesktop: true,
      ...props,
    }),
  );
  return { onThemeChange, onLocaleChange };
}

function openPanel() {
  fireEvent.click(screen.getByTestId(TID_LOGIN_TRIGGER));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.interfaceMode = "coding";
  h.zoomListener = null;
  h.platform.getDesktopZoomLevel.mockResolvedValue({ zoomLevel: 0 });
  h.platform.onDesktopZoomLevelChanged.mockImplementation((listener) => {
    h.zoomListener = listener;
    return () => {};
  });
});
afterEach(cleanup);

describe("侧栏左下偏好面板", () => {
  it("触发器展示 zcoder 品牌，不再出现 Connect / 头像入口", async () => {
    await renderFooter();
    const trigger = screen.getByTestId(TID_LOGIN_TRIGGER);
    expect(trigger.textContent).toContain("zcoder");
    expect(trigger.textContent).not.toContain("sidebar.profile.notLoggedIn");
    expect(trigger.getAttribute("aria-label")).toBe("sidebar.preferences.title");
    expect(trigger.querySelector("img")).not.toBeNull();
  });

  it("面板按 Theme → Language → Interface mode → Zoom 顺序展示标签行", async () => {
    await renderFooter();
    openPanel();
    const labels = screen.getAllByTestId("sidebar-preference-row").map((row) => row.dataset.pref);
    expect(labels).toEqual(["theme", "locale", "interfaceMode", "zoom"]);
    expect(screen.queryByTestId("profile-menu-header")).toBeNull();
  });

  it("主题分段控件回写调用方，方向键移动并立即生效", async () => {
    const { onThemeChange } = await renderFooter();
    openPanel();
    const group = screen.getByRole("radiogroup", { name: "settings.themeMode" });
    const dark = screen.getByRole("radio", { name: "sidebar.settings.theme.zai-dark" });
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(dark.tabIndex).toBe(0);

    fireEvent.click(screen.getByRole("radio", { name: "sidebar.settings.theme.zai-light" }));
    expect(onThemeChange).toHaveBeenLastCalledWith("zai-light");

    fireEvent.keyDown(group, { key: "ArrowRight" });
    // 从当前选中 Dark（末项）向右循环回到 System。
    expect(onThemeChange).toHaveBeenLastCalledWith("system");
  });

  it("界面模式选项 value 为 coding / office（CR-01：不得残留旧名 general）", async () => {
    await renderFooter();
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "sidebar.preferences.mode.office" }));
    expect(h.store.setInterfaceMode).toHaveBeenLastCalledWith("office");
    fireEvent.click(screen.getByRole("radio", { name: "sidebar.preferences.mode.coding" }));
    expect(h.store.setInterfaceMode).toHaveBeenLastCalledWith("coding");
  });

  it("缩放步进器按 1.1^level 展示百分比并执行桌面命令", async () => {
    await renderFooter();
    openPanel();
    expect(screen.getByTestId("sidebar-zoom-reset").textContent).toBe("100%");
    // 默认档禁用重置，未到边界可放大缩小。
    expect(screen.getByTestId("sidebar-zoom-reset")).toHaveProperty("disabled", true);

    act(() => h.zoomListener?.({ zoomLevel: 2 }));
    expect(screen.getByTestId("sidebar-zoom-reset").textContent).toBe("121%");

    fireEvent.click(screen.getByRole("button", { name: "titleBar.menu.view.zoomIn" }));
    expect(h.platform.executeDesktopCommand).toHaveBeenLastCalledWith(DesktopCommandIds.ZoomIn);
    fireEvent.click(screen.getByRole("button", { name: "titleBar.menu.view.zoomOut" }));
    expect(h.platform.executeDesktopCommand).toHaveBeenLastCalledWith(DesktopCommandIds.ZoomOut);
    fireEvent.click(screen.getByTestId("sidebar-zoom-reset"));
    expect(h.platform.executeDesktopCommand).toHaveBeenLastCalledWith(DesktopCommandIds.ResetZoom);

    act(() => h.zoomListener?.({ zoomLevel: 5 }));
    expect(screen.getByRole("button", { name: "titleBar.menu.view.zoomIn" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("非桌面端不展示缩放行", async () => {
    await renderFooter({ isDesktop: false });
    openPanel();
    const labels = screen.getAllByTestId("sidebar-preference-row").map((row) => row.dataset.pref);
    expect(labels).toEqual(["theme", "locale", "interfaceMode"]);
  });
});
