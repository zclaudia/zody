import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zody/services";
import type { FileEntry, FileWatchEvent } from "@zody/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useMobileWorkspaceFiles } from "@/hooks/useMobileWorkspaceFiles.js";
import { MOBILE_FILE_SAVE_RANGE_BYTES } from "@/mobileFileBrowserSave.js";

const WORKSPACE_PATH = "/workspace";
const SRC_PATH = "/workspace/src";

type MobileFilesResult = ReturnType<typeof useMobileWorkspaceFiles>;

const MOBILE_DIRECTORY_BUDGET = { maxEntries: 5_000, maxResponseBytes: 1024 * 1024 };

function file(path: string): FileEntry {
  return { name: path.split("/").pop() ?? path, path, type: "file" };
}

function directory(path: string): FileEntry {
  return { name: path.split("/").pop() ?? path, path, type: "directory" };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface CreateWatcherHarnessOptions {
  watchError?: boolean;
  saveFileSize?: number;
  pendingRanges?: Array<(bytes: Uint8Array) => void>;
  platform?: unknown;
}

function createMobileFilesHarness(options: CreateWatcherHarnessOptions = {}) {
  const entriesByDirectory = new Map<string, FileEntry[]>([
    [WORKSPACE_PATH, [directory(SRC_PATH), file(`${WORKSPACE_PATH}/a.ts`)]],
    [SRC_PATH, [file(`${SRC_PATH}/old.ts`)]],
  ]);
  const watcherListeners = new Map<string, (event: FileWatchEvent) => void>();
  const watchedPathById = new Map<string, string>();
  let latestResult: MobileFilesResult | null = null;

  const services = {
    fileService: {
      readdir: vi.fn(async ({ path }: { path: string }) => entriesByDirectory.get(path) ?? []),
      stat: vi.fn(async () => ({
        path: "/workspace/big.bin",
        type: "file" as const,
        size: options.saveFileSize ?? 0,
        mtimeMs: 1,
      })),
      readFileRange: vi.fn(
        ({ length }: { offset: number; length: number }) =>
          new Promise<Uint8Array>((resolve) => {
            options.pendingRanges?.push(() => resolve(new Uint8Array(length)));
          }),
      ),
    },
    fileWatcherService: {
      onDynamicChange: (id: string) => (listener: (event: FileWatchEvent) => void) => {
        watcherListeners.set(id, listener);
        return {
          dispose() {
            watcherListeners.delete(id);
          },
        };
      },
      unwatch: vi.fn(async ({ id }: { id: string }) => {
        watcherListeners.delete(id);
        watchedPathById.delete(id);
      }),
      watch: vi.fn(async ({ path }: { path: string }) => {
        if (options.watchError) {
          throw new Error("FSEvents unsupported");
        }
        const id = `watch:${path}`;
        watchedPathById.set(id, path);
        return { id };
      }),
    },
  } as unknown as IServiceAccessor;

  function Probe() {
    latestResult = useMobileWorkspaceFiles({ workspacePath: WORKSPACE_PATH });
    return null;
  }

  const root: Root = createRoot(installMinimalDom());
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services },
          createElement(
            TabStoreProvider,
            null,
            createElement(
              PlatformProvider,
              { platform: (options.platform ?? {}) as never },
              createElement(Probe),
            ),
          ),
        ),
      );
      await flushMicrotasks();
    });
  };

  return {
    get latestResult() {
      if (!latestResult) {
        throw new Error("mobile files hook result is not ready");
      }
      return latestResult;
    },
    root,
    services,
    async fireWatcherChange(path: string) {
      const watcherId = [...watchedPathById.entries()].find(
        ([, watchedPath]) => watchedPath === path,
      )?.[0];
      if (!watcherId) {
        throw new Error(`missing watcher for ${path}`);
      }
      await act(async () => {
        watcherListeners.get(watcherId)?.({ dirPath: path });
        await flushMicrotasks();
      });
    },
    render,
    setDirectoryEntries(path: string, entries: FileEntry[]) {
      entriesByDirectory.set(path, entries);
    },
    watchedPaths() {
      return [...watchedPathById.values()];
    },
  };
}

describe("useMobileWorkspaceFiles watcher（MF03）", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("目录 watch 后收到变更事件触发带 mobileBudget 的重读", async () => {
    const harness = createMobileFilesHarness();
    await harness.render();
    await act(async () => {
      harness.latestResult.navigateToDirectory(SRC_PATH);
      await flushMicrotasks();
    });

    expect(harness.latestResult.entries.map((entry) => entry.path)).toEqual([
      `${SRC_PATH}/old.ts`,
    ]);
    expect(harness.services.fileService.readdir).toHaveBeenLastCalledWith({
      path: SRC_PATH,
      includeHidden: true,
      mobileBudget: MOBILE_DIRECTORY_BUDGET,
    });

    harness.setDirectoryEntries(SRC_PATH, [file(`${SRC_PATH}/new.ts`)]);
    await harness.fireWatcherChange(SRC_PATH);

    expect(harness.latestResult.entries.map((entry) => entry.path)).toEqual([
      `${SRC_PATH}/new.ts`,
    ]);
    // watcher 触发的重读也必须携带 mobile budget，不能退回桌面全量语义。
    expect(harness.services.fileService.readdir).toHaveBeenLastCalledWith({
      path: SRC_PATH,
      includeHidden: true,
      mobileBudget: MOBILE_DIRECTORY_BUDGET,
    });

    act(() => {
      harness.root.unmount();
    });
  });

  it("切目录与卸载时释放旧目录的 watcher", async () => {
    const harness = createMobileFilesHarness();
    await harness.render();
    await act(async () => {
      harness.latestResult.navigateToDirectory(SRC_PATH);
      await flushMicrotasks();
    });
    expect(harness.watchedPaths()).toEqual([SRC_PATH]);

    await act(async () => {
      harness.latestResult.navigateToDirectory(WORKSPACE_PATH);
      await flushMicrotasks();
    });
    expect(harness.services.fileWatcherService.unwatch).toHaveBeenCalledWith({
      id: `watch:${SRC_PATH}`,
    });
    expect(harness.watchedPaths()).toEqual([WORKSPACE_PATH]);

    act(() => {
      harness.root.unmount();
    });
    await flushMicrotasks();
    expect(harness.services.fileWatcherService.unwatch).toHaveBeenCalledWith({
      id: `watch:${WORKSPACE_PATH}`,
    });
  });

  it("watch 建立失败时静默降级，列表仍可用", async () => {
    const harness = createMobileFilesHarness({ watchError: true });
    await harness.render();

    expect(harness.latestResult.error).toBeNull();
    expect(harness.latestResult.loading).toBe(false);
    expect(harness.latestResult.entries.map((entry) => entry.path)).toEqual([
      SRC_PATH,
      `${WORKSPACE_PATH}/a.ts`,
    ]);

    act(() => {
      harness.root.unmount();
    });
  });
});

describe("useMobileWorkspaceFiles 保存取消（MF08）", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  function createSaveHarness() {
    const pendingRanges: Array<(bytes: Uint8Array) => void> = [];
    const saveFile = vi.fn(async () => ({ success: true }));
    const harness = createMobileFilesHarness({
      saveFileSize: MOBILE_FILE_SAVE_RANGE_BYTES + 4,
      pendingRanges,
      platform: { saveFile },
    });
    return { harness, pendingRanges, saveFile };
  }

  it("取消保存停止后续 chunk 读取并回到可保存状态", async () => {
    const { harness, pendingRanges, saveFile } = createSaveHarness();
    await harness.render();
    await act(async () => {
      harness.latestResult.setPreviewPath("/workspace/big.bin");
      await flushMicrotasks();
    });

    let pendingSave: Promise<unknown> | undefined;
    await act(async () => {
      pendingSave = harness.latestResult.saveOriginal();
      await flushMicrotasks();
    });
    expect(harness.latestResult.saving).toBe(true);
    expect(harness.services.fileService.readFileRange).toHaveBeenCalledTimes(1);

    await act(async () => {
      harness.latestResult.cancelSave();
      pendingRanges[0]?.(new Uint8Array(MOBILE_FILE_SAVE_RANGE_BYTES));
      await flushMicrotasks();
    });

    await expect(pendingSave).resolves.toEqual({ success: false, canceled: true });
    expect(harness.latestResult.saving).toBe(false);
    // 取消后第二个 chunk 不再读取，也不会把半份数据交给原生保存。
    expect(harness.services.fileService.readFileRange).toHaveBeenCalledTimes(1);
    expect(saveFile).not.toHaveBeenCalled();

    act(() => {
      harness.root.unmount();
    });
  });

  it("同一闭包内发起新保存会先取消旧保存", async () => {
    const { harness, pendingRanges, saveFile } = createSaveHarness();
    await harness.render();
    await act(async () => {
      harness.latestResult.setPreviewPath("/workspace/big.bin");
      await flushMicrotasks();
    });

    let firstSave: Promise<unknown> | undefined;
    let secondSave: Promise<unknown> | undefined;
    await act(async () => {
      // 同一渲染闭包内连续调用两次（saving 闭包值都是 false），新保存必须先 abort 旧的。
      const saveOriginal = harness.latestResult.saveOriginal;
      firstSave = saveOriginal();
      secondSave = saveOriginal();
      await flushMicrotasks();
    });

    // chunk1 完成后循环才会请求 chunk2；分段 resolve 避免 resolver 尚未 push 就被消费。
    await act(async () => {
      pendingRanges[0]?.(new Uint8Array(MOBILE_FILE_SAVE_RANGE_BYTES));
      await flushMicrotasks();
    });
    await act(async () => {
      pendingRanges[1]?.(new Uint8Array(4));
      await flushMicrotasks();
    });

    await expect(firstSave).resolves.toEqual({ success: false, canceled: true });
    await expect(secondSave).resolves.toEqual({ success: true });
    // 只有第二次保存真正走到原生保存通道。
    expect(saveFile).toHaveBeenCalledTimes(1);

    act(() => {
      harness.root.unmount();
    });
  });
});
