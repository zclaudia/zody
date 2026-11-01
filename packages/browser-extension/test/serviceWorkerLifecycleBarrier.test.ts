import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 通过 fake chrome 直接驱动 service worker 的 message handler，验证 detachAll 屏障：
 * cleanup 未释放时 tabs.create 不能触碰 Chrome API。
 */
describe("service worker detachAll lifecycle barrier", () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;

  afterEach(() => {
    if (originalChrome === undefined) {
      delete (globalThis as { chrome?: unknown }).chrome;
    } else {
      (globalThis as { chrome?: unknown }).chrome = originalChrome;
    }
    vi.resetModules();
  });

  it("blocks tabs.create until the old detachAll cleanup finishes", async () => {
    const messageListeners: Listener[] = [];
    const createdTabs: number[] = [];
    const removedTabs: number[] = [];
    const cleanupGate = deferred();
    let blockAttachmentRead = true;
    let nextTabId = 100;

    const sessionValues: Record<string, unknown> = {};
    const localValues: Record<string, unknown> = {};
    const storageArea = (values: Record<string, unknown>) => ({
      async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
        const list = keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const key of list) {
          if (key in values) result[key] = values[key];
        }
        return result;
      },
      async set(items: Record<string, unknown>): Promise<void> {
        Object.assign(values, items);
      },
      async remove(keys: string | string[]): Promise<void> {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      },
    });

    const fakeChrome = {
      runtime: {
        id: "test-extension",
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getContexts: async () => [],
        sendMessage: async () => ({ ok: true }),
        onMessage: {
          addListener: (listener: Listener) => messageListeners.push(listener),
        },
        onInstalled: { addListener: () => undefined },
        onStartup: { addListener: () => undefined },
      },
      storage: {
        local: storageArea(localValues),
        session: {
          async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
            if (blockAttachmentRead && keys === "zody.attachments") {
              await cleanupGate.promise;
              blockAttachmentRead = false;
            }
            return storageArea(sessionValues).get(keys);
          },
          set: storageArea(sessionValues).set,
          remove: storageArea(sessionValues).remove,
        },
      },
      offscreen: {
        Reason: {
          WORKERS: "WORKERS",
          DOM_PARSER: "DOM_PARSER",
          BLOBS: "BLOBS",
          TESTING: "TESTING",
        },
        createDocument: async () => undefined,
        closeDocument: async () => undefined,
      },
      tabs: {
        query: async () => [],
        get: async (tabId: number) => ({
          id: tabId,
          active: false,
          url: "about:blank",
          title: "",
        }),
        create: async () => {
          const id = nextTabId++;
          createdTabs.push(id);
          return { id, active: false, url: "about:blank", title: "", windowId: 1 };
        },
        remove: async (tabId: number) => {
          removedTabs.push(tabId);
        },
        onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
      },
      debugger: {
        attach: async () => undefined,
        detach: async () => undefined,
        sendCommand: async () => ({}),
        getTargets: async () => [],
        onEvent: { addListener: () => undefined },
        onDetach: { addListener: () => undefined },
      },
      action: {
        setBadgeText: async () => undefined,
        setBadgeBackgroundColor: async () => undefined,
      },
    };

    (globalThis as { chrome?: unknown }).chrome = fakeChrome;
    await import("../src/service-worker.js");
    await tick();
    const listener = messageListeners[0];
    if (!listener) throw new Error("service worker message listener was not registered");

    const responses: unknown[] = [];
    const send = (message: unknown) =>
      new Promise<void>((resolve) => {
        listener(message, {}, (response) => {
          responses.push(response);
          resolve();
        });
      });

    // 先启动 detachAll；其 registry 读取被受控延迟。
    const detachDone = send({
      target: "worker",
      op: "detachAll",
      payload: { reason: "window_transfer" },
    });
    const createDone = send({
      target: "worker",
      op: "tabs.create",
      payload: { active: false, url: "about:blank" },
    });
    await tick();
    // cleanup 未完成：Chrome API 不能被调用。
    expect(createdTabs).toEqual([]);

    cleanupGate.resolve();
    await Promise.all([detachDone, createDone]);
    expect(createdTabs).toHaveLength(1);
    // 新 agent tab 不在旧 cleanup 的关闭集合里。
    expect(removedTabs).toEqual([]);
    expect(responses).toContainEqual({ ok: true });
  });
});
