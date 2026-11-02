// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMobileKeyboardInsetTracker } from "@/lib/mobileKeyboardInset.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";

/**
 * 走查 shell-1 的 Shell 集成测试：功能浮层打开时压入 overlay history 条目，
 * 系统返回（popstate 落回基础条目）优先关闭浮层而不是退出远控页/盖着浮层落回首页，
 * 前进落在 overlay 条目时按条目恢复浮层。
 */
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (
    selector: (state: { theme: string; setTheme: (theme: string) => void }) => unknown,
  ) => selector({ theme: "dark", setTheme: vi.fn() }),
}));

function renderChatShell() {
  return render(
    createElement(WebRemoteControlMobileShell, {
      activeTaskId: "task-1",
      activeWorkspacePath: "/workspace/app",
      chatContent: createElement("main", { "data-testid": "chat-content" }),
      initialNavigationIntent: "chat",
      onSelectTask: vi.fn(),
      renderChatHeader: () => createElement("header", { "data-testid": "chat-header" }),
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [], tasks: [] })),
        switchWorkspace: vi.fn(async () => {}),
        getMobileCapabilities: vi.fn(() => ({ fileBrowser: 1, historySearch: 1 })),
        getMobileConnection: vi.fn(() => ({ backendId: "b", connectionGeneration: 1 })),
      },
    }),
  );
}

function dispatchPopState(state: unknown) {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
}

describe("WebRemoteControlMobileShell overlay history", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "visualViewport");
    document.documentElement.style.removeProperty("--zcode-keyboard-inset");
    vi.unstubAllGlobals();
    window.history.replaceState(null, "");
    vi.restoreAllMocks();
  });

  it("打开搜索浮层时压入 overlay history 条目", () => {
    renderChatShell();

    fireEvent.click(screen.getByLabelText("mobileSearch.title"));

    expect(document.querySelector('[data-mobile-feature-overlay="search"]')).not.toBeNull();
    expect(window.history.state).toEqual({
      zcodeMobilePage: "chat",
      zcodeMobileOverlay: "search",
    });
  });

  it("系统返回落在基础条目时优先关闭浮层，页面保持在聊天页", () => {
    renderChatShell();
    fireEvent.click(screen.getByLabelText("mobileSearch.title"));
    expect(document.querySelector('[data-mobile-feature-overlay="search"]')).not.toBeNull();

    dispatchPopState({ zcodeMobilePage: "chat" });

    expect(document.querySelector('[data-mobile-feature-overlay="search"]')).toBeNull();
    expect(document.querySelector('[data-mobile-page="chat"]')).not.toBeNull();
  });

  it("系统返回落在首页基础条目时关闭浮层并回到首页", () => {
    renderChatShell();
    fireEvent.click(screen.getByLabelText("mobileSearch.title"));

    dispatchPopState(null);

    expect(document.querySelector('[data-mobile-feature-overlay="search"]')).toBeNull();
    expect(document.querySelector('[data-mobile-page="chat"]')).toBeNull();
  });

  it("前进落在 overlay 条目时按条目恢复浮层", () => {
    renderChatShell();

    // 用 search 验证恢复路径：files 内容组件依赖 ServiceProvider，与本测试无关。
    dispatchPopState({ zcodeMobilePage: "chat", zcodeMobileOverlay: "search" });

    expect(document.querySelector('[data-mobile-feature-overlay="search"]')).not.toBeNull();
  });

  it("设置 history 条目由 SettingsPage 处理，Shell 不关闭现有浮层或切换宿主页面", () => {
    renderChatShell();
    fireEvent.click(screen.getByLabelText("mobileSearch.title"));

    dispatchPopState({
      zcodeMobilePage: "chat",
      zcodeMobileSettings: { view: "section", section: "appearance" },
    });
    expect(document.querySelector('[data-mobile-feature-overlay="search"]')).not.toBeNull();
    expect(document.querySelector('[data-mobile-page="chat"]')).not.toBeNull();

    dispatchPopState({
      zcodeMobilePage: "chat",
      zcodeMobileConnectionSettings: true,
    });
    expect(document.querySelector('[data-mobile-feature-overlay="search"]')).not.toBeNull();
    expect(document.querySelector('[data-mobile-page="chat"]')).not.toBeNull();
  });

  it("Shell 卸载不回收页面级 keyboard inset tracker（spec §2.2 唯一所有者是安装点 main.tsx）", () => {
    // main.tsx:23 在 React 挂载前安装页面级 tracker 并刻意丢弃卸载函数（变量生命周期等于页面）。
    // 若 Shell 挂载安装 + cleanup 卸载，幂等语义会让它拿到同一个页面级卸载函数，
    // 断连回到设置页/选电脑页时把 tracker 与 --zcode-keyboard-inset 一并删掉，键盘避让失效。
    vi.stubGlobal("innerHeight", 800);
    Object.defineProperty(window, "visualViewport", {
      value: Object.assign(new EventTarget(), { height: 600, offsetTop: 0 }),
      configurable: true,
    });
    const pageLevelUninstall = installMobileKeyboardInsetTracker();

    const { unmount } = renderChatShell();
    expect(document.documentElement.style.getPropertyValue("--zcode-keyboard-inset")).toBe("200px");

    unmount();
    expect(document.documentElement.style.getPropertyValue("--zcode-keyboard-inset")).toBe("200px");

    pageLevelUninstall();
    expect(document.documentElement.style.getPropertyValue("--zcode-keyboard-inset")).toBe("");
  });
});
