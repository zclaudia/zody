import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zody/services";
import type { FileEntry } from "@zody/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { useMobileWorkspaceFiles } from "@/hooks/useMobileWorkspaceFiles.js";

const WORKSPACE_PATH = "/workspace";

type MobileFilesResult = ReturnType<typeof useMobileWorkspaceFiles>;

function file(path: string): FileEntry {
  return { name: path.split("/").pop() ?? path, path, type: "file" };
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
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

interface RemoteServicesFixture {
  entries?: FileEntry[];
  deferReaddir?: { resolve: (entries: FileEntry[]) => void };
  readdirMock?: ReturnType<typeof vi.fn>;
  unwatchMock?: ReturnType<typeof vi.fn>;
  watchMock?: ReturnType<typeof vi.fn>;
}

function createRemoteServices(fixture: RemoteServicesFixture = {}): IServiceAccessor {
  const readdirMock =
    fixture.readdirMock ??
    vi.fn(async () => {
      if (fixture.deferReaddir) {
        return new Promise<FileEntry[]>((resolve) => {
          fixture.deferReaddir!.resolve = resolve;
        });
      }
      return fixture.entries ?? [];
    });
  const watchMock =
    fixture.watchMock ??
    vi.fn(async ({ path }: { path: string }) => ({ id: `watch:${path}` }));
  const unwatchMock = fixture.unwatchMock ?? vi.fn(async () => undefined);
  return {
    fileService: { readdir: readdirMock },
    fileWatcherService: {
      watch: watchMock,
      unwatch: unwatchMock,
      onDynamicChange: () => ({ dispose() {} }),
    },
  } as unknown as IServiceAccessor;
}

function resetRemoteWorkspaceSessionStore() {
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
}

function createRoutingHarness() {
  let currentIdentity: string | undefined;
  let currentRemoteSessionId: string | undefined;
  let latestResult: MobileFilesResult | null = null;

  function Probe() {
    latestResult = useMobileWorkspaceFiles({
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: currentIdentity,
      workspaceRemoteSessionId: currentRemoteSessionId,
    });
    return null;
  }

  const root: Root = createRoot(installMinimalDom());
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(ServiceProvider, { services: contextServices }, createElement(TabStoreProvider, null, createElement(Probe))),
      );
      await flushMicrotasks();
    });
  };

  const contextServices = {
    fileService: { readdir: vi.fn(async () => [file(`${WORKSPACE_PATH}/local.ts`)]) },
    fileWatcherService: {
      watch: vi.fn(async ({ path }: { path: string }) => ({ id: `local-watch:${path}` })),
      unwatch: vi.fn(async () => undefined),
      onDynamicChange: () => ({ dispose() {} }),
    },
  } as unknown as IServiceAccessor;

  return {
    contextServices,
    get latestResult() {
      if (!latestResult) {
        throw new Error("mobile files hook result is not ready");
      }
      return latestResult;
    },
    root,
    render,
    async setTarget(identity?: string, remoteSessionId?: string) {
      currentIdentity = identity;
      currentRemoteSessionId = remoteSessionId;
      await render();
    },
  };
}

describe("useMobileWorkspaceFiles 跨 identity 路由（MF04）", () => {
  afterEach(() => {
    resetRemoteWorkspaceSessionStore();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("identity A 的迟到 readdir 不渲染且其 watcher 被释放", async () => {
    const deferredA: { resolve: (entries: FileEntry[]) => void } = { resolve: () => undefined };
    const unwatchA = vi.fn(async () => undefined);
    const servicesA = createRemoteServices({ deferReaddir: deferredA, unwatchMock: unwatchA });
    const servicesB = createRemoteServices({
      entries: [file(`${WORKSPACE_PATH}/from-b.ts`)],
      unwatchMock: vi.fn(async () => undefined),
    });
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {
        "sess-a": { sessionId: "sess-a", services: servicesA },
        "sess-b": { sessionId: "sess-b", services: servicesB },
      },
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: { "identity-a": "sess-a", "identity-b": "sess-b" },
    });

    const harness = createRoutingHarness();
    await harness.setTarget("identity-a");
    expect(harness.latestResult.loading).toBe(true);

    // 切到 identity B：A 的读取仍在途。
    await harness.setTarget("identity-b");
    expect(harness.latestResult.entries.map((entry) => entry.path)).toEqual([
      `${WORKSPACE_PATH}/from-b.ts`,
    ]);

    // A 的迟到响应到达后不能覆盖 B 的列表。
    await act(async () => {
      deferredA.resolve([file(`${WORKSPACE_PATH}/from-a.ts`)]);
      await flushMicrotasks();
    });
    expect(harness.latestResult.entries.map((entry) => entry.path)).toEqual([
      `${WORKSPACE_PATH}/from-b.ts`,
    ]);
    // A 的 watcher 也必须随 identity 切换释放。
    await act(async () => {
      await flushMicrotasks();
    });
    expect(unwatchA).toHaveBeenCalledWith({ id: `watch:${WORKSPACE_PATH}` });

    act(() => {
      harness.root.unmount();
    });
  });

  it("remoteSessionId 变化触发 preview 与 watcher 全 reset", async () => {
    const unwatchA = vi.fn(async () => undefined);
    const watchA = vi.fn(async ({ path }: { path: string }) => ({ id: `watch:${path}` }));
    const servicesA = createRemoteServices({
      entries: [file(`${WORKSPACE_PATH}/a.ts`)],
      watchMock: watchA,
      unwatchMock: unwatchA,
    });
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {
        "sess-a1": { sessionId: "sess-a1", services: servicesA },
        "sess-a2": { sessionId: "sess-a2", services: servicesA },
      },
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: { "identity-a": "sess-a1" },
    });

    const harness = createRoutingHarness();
    await harness.setTarget("identity-a", "sess-a1");
    await act(async () => {
      harness.latestResult.navigateToDirectory(`${WORKSPACE_PATH}/sub`);
      harness.latestResult.setPreviewPath(`${WORKSPACE_PATH}/sub/a.ts`);
      await flushMicrotasks();
    });
    expect(harness.latestResult.previewPath).toBe(`${WORKSPACE_PATH}/sub/a.ts`);
    const watchCallsAfterFirstTarget = watchA.mock.calls.length;

    // remoteSessionId 变化（重连拿到新 session）：预览、目录与 watcher 必须整体复位。
    await harness.setTarget("identity-a", "sess-a2");
    expect(harness.latestResult.previewPath).toBeNull();
    expect(harness.latestResult.viewDirectory).toBe(WORKSPACE_PATH);
    expect(unwatchA).toHaveBeenCalled();
    // 旧 session 的 watcher 释放后按新目标重新建立。
    expect(watchA.mock.calls.length).toBeGreaterThan(watchCallsAfterFirstTarget);
    expect(watchA).toHaveBeenLastCalledWith({ path: WORKSPACE_PATH });

    act(() => {
      harness.root.unmount();
    });
  });

  it("resolvedRemoteSessionId 为空时不 fallback 本机 fileService，错误面显示离线", async () => {
    const harness = createRoutingHarness();
    // identity 未注册任何 session：远程目标必须保持断连态，而不是借本机 services 读目录。
    await harness.setTarget("identity-missing");

    expect(harness.contextServices.fileService.readdir).not.toHaveBeenCalled();
    expect(harness.latestResult.entries).toEqual([]);
    expect(isRemoteWorkspaceDisconnectedError(harness.latestResult.error)).toBe(true);
    expect(harness.latestResult.loading).toBe(false);

    act(() => {
      harness.root.unmount();
    });
  });
});
