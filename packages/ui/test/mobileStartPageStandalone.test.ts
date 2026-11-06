// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebRemoteControlMobileStartPage,
  WebRemoteControlStandaloneStoreProvider,
  ZodyIntlProvider,
  useZodyStore,
} from "../src/index.js";

/**
 * A-MO-01 回归：空态 StartPage 的渲染树只有 ZodyIntlProvider（bootstrap 不挂 Root，
 * 没有 Root 自带的 StoreProvider），而头部 ThemeMenu 无条件使用 useZodyStore。
 * 修复前因缺少 StoreProvider 上下文而直接白屏；
 * WebRemoteControlStandaloneStoreProvider 用本地 broadcast 补齐上下文。
 */

function renderStartPage(options?: {
  openOtherProject?: {
    listDirectory(path?: string): Promise<unknown>;
    openWorkspacePath(path: string): Promise<string>;
    onOpened(workspaceKey: string): void | Promise<void>;
  };
}) {
  return render(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        WebRemoteControlStandaloneStoreProvider,
        null,
        createElement(WebRemoteControlMobileStartPage, {
          desktopWindowState: "none",
          recentProjects: [],
          onOpenRecentProject: vi.fn(),
          onOpenDesktopWindow: vi.fn(),
          onOpenSettings: vi.fn(),
          ...(options?.openOtherProject ? { openOtherProject: options.openOtherProject } : {}),
        }),
      ),
    ),
  );
}

describe("mobile start page standalone store context", () => {
  afterEach(() => cleanup());

  it("缺少 StoreProvider 时使用当前 hook 名称诊断", () => {
    function MissingProvider() {
      useZodyStore((state) => state);
      return null;
    }
    expect(() => render(createElement(MissingProvider))).toThrow(
      "useZodyStore 必须在 StoreProvider 内使用",
    );
  });

  it("无 Root/StoreProvider 的渲染树中 StartPage 不再抛 useZodyStore 错误", async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    try {
      renderStartPage();
      // 头部主题按钮（触发原崩溃的 ThemeMenu）与空列表提示均可见。
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "选择主题" })).toBeTruthy(),
      );
      expect(document.body.textContent).toContain("最近项目");
      // 「打开其他项目」入口在宿主提供能力时出现。
      renderStartPage({
        openOtherProject: {
          listDirectory: vi.fn(async () => ({ ok: false, error: "unreadable" })),
          openWorkspacePath: vi.fn(async () => "/w"),
          onOpened: vi.fn(),
        },
      });
      await waitFor(() =>
        expect(document.querySelector("[data-mobile-remote-open-other-project]")).toBeTruthy(),
      );
      const storeErrors = errors.filter((args) =>
        String(args[0]).includes("useZodyStore"),
      );
      expect(storeErrors).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
