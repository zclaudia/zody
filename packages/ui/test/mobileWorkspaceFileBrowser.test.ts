// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { FileEntry } from "@zcode/shared";
import {
  MOBILE_FILE_SAVE_MAX_BYTES,
  MOBILE_FILE_SAVE_RANGE_BYTES,
} from "../src/mobileFileBrowserSave.js";
import {
  getMobileFileBrowserParentDirectory,
  resolveMobileFileBrowserError,
} from "../src/mobileFileBrowserModel.js";
import { MobileWorkspaceFileBrowser } from "../src/MobileWorkspaceFileBrowser.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { StoreProvider } from "../src/store/StoreProvider.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";

// 预览正文（CodeViewer/Office 渲染）与本文件断言的 header/错误/保存面无关，按
// previewPaneHeavyContent.test.ts 的既有模式替换为轻量占位，聚焦浏览器组件行为。
vi.mock("@/previewPaneContent.js", () => ({
  PreviewPaneContent: () => createElement("div", { "data-preview-pane-content": "mounted" }),
}));

const WORKSPACE_PATH = "/workspace";
const REVEAL_FILE_PATH = `${WORKSPACE_PATH}/report.bin`;

function file(path: string): FileEntry {
  return { name: path.split("/").pop() ?? path, path, type: "file" };
}

function errnoError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe("mobile workspace file browser integration", () => {
  it("uses a dedicated authenticated-scope browser with bounded reads and preview capability", () => {
    const source = readFileSync("packages/ui/src/MobileWorkspaceFileBrowser.tsx", "utf8");
    const hookSource = readFileSync(
      "packages/ui/src/hooks/useMobileWorkspaceFiles.ts",
      "utf8",
    );

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

    expect(resolveMobileFileBrowserError(new Error("UNSUPPORTED_EXTERNAL_DIRECTORY"))).toMatchObject(
      {
        category: "unsupportedExternalDirectory",
        messageId: "mobileFileBrowser.unsupportedExternalDirectory",
        keepPreviousEntries: false,
      },
    );
  });
});

function createBrowserHarness(options: { refreshError?: () => Error; revealFile?: boolean } = {}) {
  const firstEntries = [file(`${WORKSPACE_PATH}/alpha.txt`)];
  const saveFile = vi.fn(async () => ({ success: true }));
  let readdirCalls = 0;
  const services = {
    fileService: {
      readdir: vi.fn(async () => {
        readdirCalls += 1;
        // 首次加载成功以获得旧列表；之后的刷新（含 watcher 重读）按注入错误失败。
        if (readdirCalls > 1 && options.refreshError) {
          throw options.refreshError();
        }
        return firstEntries;
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
      ZCodeIntlProvider,
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
        errnoError(
          "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
          "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
        ),
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
});
