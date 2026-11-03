// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zody/services";
import type { FileEntry } from "@zody/shared";
import {
  MOBILE_FILE_SAVE_MAX_BYTES,
  MOBILE_FILE_SAVE_RANGE_BYTES,
} from "../src/mobileFileBrowserSave.js";
import {
  getMobileFileBrowserParentDirectory,
  resolveMobileFileBrowserError,
} from "../src/mobileFileBrowserModel.js";
import { MobileWorkspaceFileBrowser } from "../src/MobileWorkspaceFileBrowser.js";
import { ZodyIntlProvider } from "../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { StoreProvider } from "../src/store/StoreProvider.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";

// 预览正文（CodeViewer/Office 渲染）与本文件断言的 header/错误/保存面无关，按
// previewPaneHeavyContent.test.ts 的既有模式替换为轻量占位，聚焦浏览器组件行为。
vi.mock("@/previewPaneContent.js", () => ({
  PreviewPaneContent: () => createElement("div", { "data-preview-pane-content": "mounted" }),
}));

// jsdom 没有布局，真实 useVirtualizer 视口高度为 0 时一行也不渲染；
// 这里替换为确定性 fake（全部行展开），行渲染本身由真机/桌面环境验证。
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 48,
        end: (index + 1) * 48,
        size: 48,
      })),
    getTotalSize: () => count * 48,
    measure: () => {},
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
}));

const WORKSPACE_PATH = "/workspace";
const REVEAL_FILE_PATH = `${WORKSPACE_PATH}/report.bin`;

function file(path: string): FileEntry {
  return { name: path.split("/").pop() ?? path, path, type: "file" };
}

function directory(path: string): FileEntry {
  return { name: path.split("/").filter(Boolean).pop() ?? path, path, type: "directory" };
}

function errnoError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe("mobile workspace file browser integration", () => {
  it("uses a dedicated authenticated-scope browser with bounded reads and preview capability", () => {
    const source = readFileSync("packages/ui/src/MobileWorkspaceFileBrowser.tsx", "utf8");
    const hookSource = readFileSync("packages/ui/src/hooks/useMobileWorkspaceFiles.ts", "utf8");

    expect(source).toContain('data-testid="mobile-file-browser"');
    expect(source).toContain('actionsCapability="read-only"');
    expect(source).toContain("entry.isSymbolicLink ?");
    expect(source).toContain("useVirtualizer({");
    expect(source).toContain("useMobileWorkspaceFiles({");
    expect(source).not.toContain("useWorkspaceServices");
    expect(hookSource).toContain("mobileBudget: MOBILE_DIRECTORY_BUDGET");
    expect(hookSource).toContain("maxEntries: 5_000, maxResponseBytes: 1024 * 1024");
    expect(hookSource).toContain("watch({ path: viewDirectory })");
    expect(hookSource).toContain("openRequest.target.workspacePath !== workspacePath");
    expect(hookSource).toContain("platform?.saveFile");
  });

  it("keeps native file saves within the specified per-file and per-range limits", () => {
    expect(MOBILE_FILE_SAVE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(MOBILE_FILE_SAVE_RANGE_BYTES).toBe(1024 * 1024);
  });

  it("keeps back navigation inside the workspace root on POSIX and Windows paths", () => {
    expect(getMobileFileBrowserParentDirectory("/repo/sub", "/repo")).toBe("/repo");
    expect(getMobileFileBrowserParentDirectory("/repo", "/repo")).toBeNull();
    expect(getMobileFileBrowserParentDirectory("C:\\repo\\sub", "C:\\repo")).toBe("C:\\repo");
    expect(getMobileFileBrowserParentDirectory("C:\\repo", "C:\\repo")).toBeNull();
  });
});

describe("resolveMobileFileBrowserError（MF05 错误三分类）", () => {
  it("classifies directory-too-large, offline, not-found, unreadable and generic errors", () => {
    expect(
      resolveMobileFileBrowserError(errnoError("DIRECTORY_TOO_LARGE", "too many entries")),
    ).toMatchObject({
      category: "directoryTooLarge",
      messageId: "mobileFileBrowser.directoryTooLarge",
      keepPreviousEntries: false,
    });

    const offline = errnoError(
      "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
      "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
    );
    expect(resolveMobileFileBrowserError(offline)).toMatchObject({
      category: "offline",
      messageId: "mobileFileBrowser.offline",
      keepPreviousEntries: true,
    });

    expect(
      resolveMobileFileBrowserError(errnoError("ENOENT", "no such file or directory")),
    ).toMatchObject({
      category: "notFound",
      messageId: "mobileFileBrowser.directoryNotFound",
      keepPreviousEntries: true,
    });
    // RPC 边界丢掉 code 时按 message 里的 errno 兜底。
    expect(resolveMobileFileBrowserError(new Error("EACCES: permission denied"))).toMatchObject({
      category: "unreadable",
      messageId: "mobileFileBrowser.directoryUnreadable",
      keepPreviousEntries: true,
    });
    expect(
      resolveMobileFileBrowserError(errnoError("EPERM", "EPERM: operation not permitted")),
    ).toMatchObject({ category: "unreadable" });

    expect(resolveMobileFileBrowserError(new Error("boom"))).toMatchObject({
      category: "generic",
      messageId: "workspaceFileTree.readFailed",
      keepPreviousEntries: true,
    });

    expect(
      resolveMobileFileBrowserError(new Error("UNSUPPORTED_EXTERNAL_DIRECTORY")),
    ).toMatchObject({
      category: "unsupportedExternalDirectory",
      messageId: "mobileFileBrowser.unsupportedExternalDirectory",
      keepPreviousEntries: false,
    });
  });
});

function createBrowserHarness(
  options: {
    refreshError?: () => Error;
    revealFile?: boolean;
    /** 注入一个可进入的子目录，用于面包屑/滚动复位/等待态用例。 */
    subdirectory?: string;
    /** 子目录导航的 readdir 永远挂起，模拟弱网等待态。 */
    hangSubdirectoryRead?: boolean;
  } = {},
) {
  const firstEntries = [file(`${WORKSPACE_PATH}/alpha.txt`)];
  const subdirectoryPath = options.subdirectory
    ? `${WORKSPACE_PATH}/${options.subdirectory}`
    : null;
  const rootEntries = subdirectoryPath
    ? [...firstEntries, directory(subdirectoryPath)]
    : firstEntries;
  let readdirCalls = 0;
  const saveFile = vi.fn(async () => ({ success: true }));
  const services = {
    fileService: {
      readdir: vi.fn(async ({ path }: { path: string }) => {
        readdirCalls += 1;
        // 首次加载成功以获得旧列表；之后的刷新（含 watcher 重读）按注入错误失败。
        if (readdirCalls > 1 && options.refreshError) {
          throw options.refreshError();
        }
        if (subdirectoryPath && path === subdirectoryPath) {
          if (options.hangSubdirectoryRead) {
            return new Promise<FileEntry[]>(() => undefined);
          }
          return [file(`${subdirectoryPath}/inner.txt`)];
        }
        return rootEntries;
      }),
      stat: vi.fn(async () => ({
        path: REVEAL_FILE_PATH,
        type: "file" as const,
        size: 8,
        mtimeMs: 1,
      })),
      // 挂起的 range 读取让 saving 保持 true，用于断言 Cancel 按钮出现。
      readFileRange: vi.fn(() => new Promise<Uint8Array>(() => undefined)),
      readTextFile: vi.fn(async () => ({
        path: REVEAL_FILE_PATH,
        content: "",
        offset: 0,
        bytesRead: 0,
        totalBytes: 0,
        truncated: false,
        isBinary: true,
      })),
    },
    fileWatcherService: {
      watch: vi.fn(async ({ path }: { path: string }) => ({ id: `watch:${path}` })),
      unwatch: vi.fn(async () => undefined),
      onDynamicChange: () => ({ dispose() {} }),
    },
  } as unknown as IServiceAccessor;
  const platform = {
    saveFile,
    getInstalledEditors: async () => [],
    openInEditor: async () => ({ success: false }),
  };
  const broadcastService = {
    send: async () => undefined,
    onMessage: () => ({ dispose() {} }),
  };

  const view = render(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        StoreProvider,
        { broadcastService: broadcastService as never },
        createElement(
          ServiceProvider,
          { services },
          createElement(
            TabStoreProvider,
            null,
            createElement(
              PlatformProvider,
              { platform: platform as never },
              createElement(MobileWorkspaceFileBrowser, {
                workspacePath: WORKSPACE_PATH,
                workspaceName: "workspace",
                // 错误/旧列表用例停留在目录列表态；保存用例通过 revealPath 进入文件预览。
                openRequest: options.revealFile
                  ? {
                      id: 1,
                      target: {
                        workspacePath: WORKSPACE_PATH,
                        workspaceName: "workspace",
                        revealPath: REVEAL_FILE_PATH,
                      },
                    }
                  : null,
                onClose: () => undefined,
              }),
            ),
          ),
        ),
      ),
    ),
  );
  return { saveFile, services, view };
}

describe("MobileWorkspaceFileBrowser 错误与保存 UI（MF05/MF08）", () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    [
      "notFound",
      () => errnoError("ENOENT", "ENOENT: no such file or directory"),
      "目录不存在，或已被移动。",
    ],
    ["unreadable", () => errnoError("EACCES", "EACCES: permission denied"), "没有权限读取该目录。"],
    [
      "offline",
      () =>
        errnoError("ZCODE_REMOTE_WORKSPACE_DISCONNECTED", "ZCODE_REMOTE_WORKSPACE_DISCONNECTED"),
      "远程工作区已断开，重连后自动刷新。",
    ],
  ])("刷新失败(%s)时显示分类文案与旧列表标识", async (category, createError, expectedCopy) => {
    const { view } = createBrowserHarness({ refreshError: createError });

    const refreshButton = await screen.findByRole("button", { name: "刷新文件树" });
    await waitFor(() => {
      expect(refreshButton.getAttribute("disabled")).toBeNull();
    });
    fireEvent.click(refreshButton);

    const alert = await waitFor(() => {
      const node = view.container.querySelector(`[data-mobile-file-error="${category}"]`);
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(alert.textContent).toContain(expectedCopy);
    // 旧列表仍在渲染，并带有明确的“旧列表”标识（MF05）。
    expect(alert.querySelector("[data-mobile-file-stale-list]")).not.toBeNull();
    expect(alert.textContent).toContain("以下为出错前的目录内容，可能已过期。");
  });

  it("目录超限时整体替换为超限提示，不渲染旧列表也不带旧列表标识", async () => {
    const { view } = createBrowserHarness({
      refreshError: () => errnoError("DIRECTORY_TOO_LARGE", "DIRECTORY_TOO_LARGE: too many"),
    });

    const refreshButton = await screen.findByRole("button", { name: "刷新文件树" });
    await waitFor(() => {
      expect(refreshButton.getAttribute("disabled")).toBeNull();
    });
    fireEvent.click(refreshButton);

    const alert = await waitFor(() => {
      const node = view.container.querySelector('[data-mobile-file-error="directoryTooLarge"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(alert.textContent).toContain("目录超出手机浏览上限。");
    expect(alert.querySelector("[data-mobile-file-stale-list]")).toBeNull();
    // 超限截断的目录不能伪装成完整列表继续渲染。
    expect(view.container.querySelector("[data-mobile-file-row]")).toBeNull();
  });

  it("保存进行中显示取消按钮（MF08）", async () => {
    const { services } = createBrowserHarness({ revealFile: true });

    // openRequest 的 revealPath 是文件，进入预览后出现保存按钮。
    const saveButton = await screen.findByRole("button", { name: "保存原文件" });
    expect(screen.queryByRole("button", { name: "取消保存" })).toBeNull();

    fireEvent.click(saveButton);
    const cancelButton = await screen.findByRole("button", { name: "取消保存" });
    expect(cancelButton.getAttribute("disabled")).toBeNull();
    // 分块读取挂起时保存仍在进行：保存按钮禁用、原生保存尚未被调用。
    expect(saveButton.getAttribute("disabled")).not.toBeNull();
    expect(services.fileService.readFileRange).toHaveBeenCalled();
  });

  it("searchfile-2: 目录切换等待态下旧列表置灰禁用并显示加载指示", async () => {
    const { view } = createBrowserHarness({
      subdirectory: "sub",
      hangSubdirectoryRead: true,
    });

    // 首屏加载完成后出现可进入的子目录。
    fireEvent.click(await screen.findByText("sub"));

    // readdir 挂起：标题已切到新目录，但旧列表仍渲染——必须置灰禁用并叠加加载指示。
    const loadingBanner = await screen.findByText("加载中...");
    expect(loadingBanner.getAttribute("data-mobile-file-loading")).toBe("");
    const scrollContainer = view.container.querySelector("[aria-busy]");
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.getAttribute("aria-busy")).toBe("true");
    expect(scrollContainer?.className).toContain("opacity-50");
    expect(scrollContainer?.className).toContain("pointer-events-none");
    // 旧列表保留渲染（置灰而非清空），行内容仍可见但不可交互。
    expect(view.container.querySelector("[data-mobile-file-row]")).not.toBeNull();
  });

  it("searchfile-11/12: 进入子目录后滚动回顶部并出现可跳层的面包屑", async () => {
    const { view } = createBrowserHarness({ subdirectory: "sub" });

    const scrollContainer = await waitFor(() => {
      const node = view.container.querySelector("[aria-busy]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    await screen.findByText("sub");

    // 模拟用户在根目录已滚动到中部。
    scrollContainer.scrollTop = 120;
    fireEvent.click(screen.getByText("sub"));

    // 导航提交后同步回到顶部（searchfile-11）。
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(0));
    // 面包屑出现：根 + 当前子目录（searchfile-12）。
    const breadcrumb = view.container.querySelector("[data-mobile-file-breadcrumb]");
    expect(breadcrumb).not.toBeNull();
    expect(breadcrumb?.textContent).toContain("workspace");
    expect(breadcrumb?.textContent).toContain("sub");
    // 子目录内容已加载。
    await screen.findByText("inner.txt");

    // 点击根面包屑跳回 workspace 根，根目录条目重新可见。
    fireEvent.click(view.container.querySelector('[data-mobile-file-crumb="/workspace"]')!);
    await screen.findByText("alpha.txt");
    expect(scrollContainer.scrollTop).toBe(0);
  });

  it("searchfile-12 评审修复: 触屏态可点 crumb 命中区为 44×44 最小盒（两个方向同时达标）", async () => {
    // 本仓 jsdom 未实现 window.matchMedia：注入触屏态判定后还原。
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
      const { view } = createBrowserHarness({ subdirectory: "sub" });
      await screen.findByText("sub");
      fireEvent.click(screen.getByText("sub"));

      await waitFor(() =>
        expect(view.container.querySelector("[data-mobile-file-breadcrumb]")).not.toBeNull(),
      );
      const crumb = view.container.querySelector(
        '[data-mobile-file-crumb="/workspace"]',
      ) as HTMLElement;
      expect(crumb).not.toBeNull();
      // 水平与垂直都不依赖标签宽度/伪元素：直接是 44×44 最小盒。
      expect(crumb.className).toContain("min-h-11");
      expect(crumb.className).toContain("min-w-11");
      expect(crumb.className).not.toContain("before:");
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

  it("searchfile-11 回归守护: 预览关闭后恢复原滚动位置，不被目录切换复位效果清零", async () => {
    const { view } = createBrowserHarness();

    const scrollContainer = await waitFor(() => {
      const node = view.container.querySelector("[aria-busy]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    await screen.findByText("alpha.txt");

    // 在根目录滚动后点击文件行进入预览：行点击会把当前位置存入 savedScrollTop。
    scrollContainer.scrollTop = 120;
    fireEvent.click(screen.getByText("alpha.txt"));
    // 预览打开期间列表卸载（滚动容器不在 DOM），savedScrollTop 保留 120。
    await waitFor(() =>
      expect(view.container.querySelector("[data-preview-pane-content]")).not.toBeNull(),
    );
    expect(view.container.querySelector("[aria-busy]")).toBeNull();

    // 点返回关闭预览：应恢复到进入前的 120，而不是被目录复位效果清成 0。
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    await waitFor(() =>
      expect(view.container.querySelector("[data-preview-pane-content]")).toBeNull(),
    );
    const restoredContainer = view.container.querySelector("[aria-busy]") as HTMLElement;
    expect(restoredContainer).not.toBeNull();
    expect(restoredContainer.scrollTop).toBe(120);
  });
});
