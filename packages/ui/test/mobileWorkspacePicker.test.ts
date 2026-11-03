// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebRemoteControlMobileDirectoryListResult } from "@zody/shared";
import { MobileWorkspacePicker } from "../src/MobileWorkspacePicker.js";
import { ZodyIntlProvider } from "../src/i18n/IntlProvider.js";

// jsdom 没有布局，真实 useVirtualizer 视口高度为 0 时一行也不渲染；
// 这里替换为确定性 fake（全部行展开），行渲染本身由真机/桌面环境验证。
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 44,
        end: (index + 1) * 44,
        size: 44,
      })),
    getTotalSize: () => count * 44,
    measure: () => {},
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
}));

/**
 * 第二批 E1：手机「打开其他项目」选择器。
 * 目录事实全部来自注入的 listDirectory（app 级 payload 的归一形态），
 * 这里用 fake 注入断言：目录渲染、错误码本地化、打开收口与失败提示。
 */

function listResult(entries: Array<{ name: string; path: string; isSymbolicLink?: boolean }>) {
  return {
    ok: true as const,
    resolvedPath: entries[0]?.path.split("/").slice(0, -1).join("/") || "/",
    parentPath: "/",
    entries,
  };
}

function renderPicker(
  listDirectory: (path?: string) => Promise<WebRemoteControlMobileDirectoryListResult>,
  openWorkspacePath: (path: string) => Promise<string>,
  onOpened: (workspaceKey: string) => void | Promise<void> = vi.fn(),
) {
  return render(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(MobileWorkspacePicker, {
        listDirectory,
        openWorkspacePath,
        onClose: vi.fn(),
        onOpened,
      }),
    ),
  );
}

describe("MobileWorkspacePicker", () => {
  afterEach(() => cleanup());

  it("渲染桌面目录条目；确认后提交所选目录并回调 onOpened", async () => {
    const listDirectory = vi.fn(async () =>
      listResult([
        { name: "alpha", path: "/home/dev/alpha" },
        { name: "beta", path: "/home/dev/beta", isSymbolicLink: true },
      ]),
    );
    const openWorkspacePath = vi.fn(async () => "/home/dev");
    const onOpened = vi.fn();
    renderPicker(listDirectory, openWorkspacePath, onOpened);

    // 起点请求不带 path（桌面回 homedir 及其条目）。
    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith());
    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    expect(screen.getByText("beta")).toBeTruthy();

    const openButton = screen.getByTestId("mobile-workspace-picker-open");
    expect(openButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(openButton);

    await waitFor(() => expect(openWorkspacePath).toHaveBeenCalledWith("/home/dev"));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("/home/dev"));
  });

  it("列表错误码映射为本地化提示，不把稳定错误码原样暴露给用户", async () => {
    const listDirectory = vi.fn(async (path?: string) => {
      // picker 起点与 DirectoryBrowser 的 initialPath 都会请求根目录（每次现读，幂等）。
      if (path === undefined || path === "/") {
        return listResult([{ name: "home", path: "/home" }]);
      }
      return { ok: false, error: "not-found" } as WebRemoteControlMobileDirectoryListResult;
    });
    renderPicker(
      listDirectory,
      vi.fn(async () => "/x"),
    );

    await waitFor(() => expect(screen.getByText("home")).toBeTruthy());
    // 进入子目录触发 not-found：注入层把 code 转成本地化文案后抛给 DirectoryBrowser，
    // 组件按「无法读取目录：<文案>」呈现（i18n 插值），断言按包含匹配。
    fireEvent.click(screen.getByText("home"));
    await waitFor(() => expect(document.body.textContent).toContain("目录不存在，或已被移动。"));
  });

  it("打开失败的稳定错误码（如开关关闭）显示可操作提示且不调用 onOpened", async () => {
    const listDirectory = vi.fn(async () => listResult([{ name: "dev", path: "/home/dev" }]));
    const openWorkspacePath = vi.fn(async () => {
      throw new Error("arbitrary-path-disabled");
    });
    const onOpened = vi.fn();
    renderPicker(listDirectory, openWorkspacePath, onOpened);

    // DirectoryBrowser 的首次目录读取是异步：等「打开此目录」可用（selectedPath 已就位）再点。
    await waitFor(() =>
      expect(screen.getByTestId("mobile-workspace-picker-open").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId("mobile-workspace-picker-open"));

    await waitFor(() =>
      expect(screen.getByTestId("mobile-workspace-picker-error").textContent).toContain(
        "允许手机打开任意本地目录",
      ),
    );
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("home-4/home-5: 触屏态不自动聚焦路径输入，关闭与 footer 按钮命中区 ≥44px", async () => {
    // 本仓 jsdom 未实现 window.matchMedia：先注入再还原，保证 isCoarseTouchDevice() 命中触屏分支。
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === "(hover: none) and (pointer: coarse)",
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }),
    });
    try {
      const { container } = renderPicker(
        vi.fn(async () => listResult([{ name: "alpha", path: "/home/dev/alpha" }])),
        vi.fn(async () => "/home/dev"),
      );

      await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
      // 手机打开选择器的主流程是浏览目录：路径输入不得 autoFocus（软键盘会立即盖住列表）。
      expect(container.querySelector("input")?.getAttribute("autofocus")).toBeNull();
      // 右上关闭按钮（size icon 基线 28px）与 footer 主按钮（size lg 基线 32px）在触屏态抬到 ≥44px。
      const closeButton = container.querySelector("header button");
      expect(closeButton?.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:size-11");
      expect(screen.getByTestId("mobile-workspace-picker-open").className).toContain(
        "[@media(hover:none)_and_(pointer:coarse)]:h-11",
      );
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: originalMatchMedia,
        });
      } else {
        delete (window as { matchMedia?: unknown }).matchMedia;
      }
    }
  });
});
