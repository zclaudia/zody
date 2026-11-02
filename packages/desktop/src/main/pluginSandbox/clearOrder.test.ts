import { PlatformChannels } from "@zody/shared";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => {
  const order: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const storage = {
    clearStorageData: vi.fn(async () => {
      order.push("clear");
    }),
    clearCache: vi.fn(async () => {
      order.push("cache");
    }),
  };
  return { order, handlers, storage };
});
vi.mock("electron", () => ({
  app: { getPath: () => "/fixture", getLocale: () => "en" },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler),
  },
  session: { fromPartition: () => state.storage },
  webContents: { fromId: () => ({ id: 1, isDestroyed: () => false, once: vi.fn() }) },
}));
vi.mock("node:fs/promises", () => ({ readdir: async () => [] }));
vi.mock("./session.js", () => ({ preparePluginSandboxSession: vi.fn() }));
vi.mock("./guestPolicy.js", () => ({
  attachPluginSandboxGuest: () => () => state.order.push("ports closed"),
  configurePluginSandboxGuest: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.order.length = 0;
  state.handlers.clear();
});

function makeGuest() {
  const navigation = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  let destroyed = false;
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    loadURL: vi.fn(() => {
      state.order.push("navigate");
      entered.resolve();
      return navigation.promise;
    }),
    close: vi.fn(() => {
      state.order.push("close");
      requested.resolve();
    }),
  });
  return {
    guest,
    navigation,
    entered,
    requested,
    destroy() {
      destroyed = true;
      state.order.push("destroyed");
      guest.emit("destroyed");
    },
  };
}

async function fixture() {
  const { installPluginSandboxHost } = await import("./host.js");
  const host = installPluginSandboxHost({
    rendererDir: "/fixture",
    aliasDir: "/fixture",
    preloadPath: "/fixture",
  });
  const base = {
    instance: { runtimeId: "fixture", generation: 1, token: "one", appIdentity: "a".repeat(64) },
    ownerWebContentsId: 1,
    sessionId: "session",
    pluginId: "plugin",
    scopeId: "scope",
    serverName: "server",
    html: "<html></html>",
  };
  const register = (overrides: Partial<typeof base> = {}) =>
    host.registerFromHost({ ...base, ...overrides });
  const attach = (
    guest: ReturnType<typeof makeGuest>["guest"],
    handle: ReturnType<typeof register>,
  ) =>
    host.attachGuest({
      guest: guest as never,
      hostWebContents: { id: 1 } as never,
      ...handle,
    });
  const handle = register();
  const first = makeGuest();
  attach(first.guest as never, handle);
  return {
    host,
    handle,
    register,
    attach,
    makeGuest,
    guest: first.guest,
    navigation: first.navigation,
    entered: first.entered,
    requested: first.requested,
    destroy: first.destroy,
    dispose(initId = handle.initId) {
      return state.handlers.get(PlatformChannels.PluginSandboxDispose)!(
        { sender: { id: 1 } },
        handle.sandboxId,
        initId,
      );
    },
  };
}
async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

describe("MCP App browser data clearing order", () => {
  it("waits for the document to stop and the guest to close, while registration stays sealed", async () => {
    const f = await fixture();
    const clearing = f.host.clearBrowserData();
    await f.entered.promise;
    expect(f.guest.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
    expect(f.guest.close).not.toHaveBeenCalled();
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    expect(() => f.host.registerFromHost({} as never)).toThrow("being cleared");
    const preventDefault = vi.fn();
    f.guest.emit("will-prevent-unload", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    f.navigation.resolve();
    await f.requested.promise;
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    f.destroy();
    await clearing;
    expect(state.order).toEqual([
      "ports closed",
      "navigate",
      "close",
      "destroyed",
      "clear",
      "cache",
    ]);
    expect(f.guest.listenerCount("will-prevent-unload")).toBe(0);
    expect(() => f.host.registerFromHost({} as never)).toThrow("being cleared");
  });

  it("joins an in-flight dispose instead of losing the still-running guest", async () => {
    const f = await fixture();
    let disposed = false;
    const disposal = Promise.resolve(f.dispose()).then(() => {
      disposed = true;
    });
    await f.entered.promise;
    const clearing = f.host.clearBrowserData();
    expect(disposed).toBe(false);
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    f.navigation.resolve();
    await f.requested.promise;
    f.destroy();
    await Promise.all([clearing, disposal]);
    expect(f.guest.loadURL).toHaveBeenCalledOnce();
    expect(f.guest.close).toHaveBeenCalledOnce();
    expect(state.storage.clearStorageData).toHaveBeenCalledOnce();
    expect(disposed).toBe(true);
  });

  it("fails clearing if a live document could not be stopped", async () => {
    const f = await fixture();
    const clearing = f.host.clearBrowserData();
    const rejected = expect(clearing).rejects.toThrow("navigation failed");
    await f.entered.promise;
    f.navigation.reject(new Error("navigation failed"));
    await rejected;
    expect(f.guest.close).not.toHaveBeenCalled();
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    expect(state.storage.clearCache).not.toHaveBeenCalled();
    expect(f.guest.listenerCount("will-prevent-unload")).toBe(0);
    expect(() => f.host.registerFromHost({} as never)).toThrow("being cleared");
  });

  it("accepts navigation aborted by actual webview removal", async () => {
    const f = await fixture();
    const clearing = f.host.clearBrowserData();
    await f.entered.promise;
    f.destroy();
    f.navigation.reject(new Error("ERR_ABORTED"));
    await clearing;
    expect(f.guest.close).not.toHaveBeenCalled();
    expect(state.storage.clearStorageData).toHaveBeenCalledOnce();
  });

  it("does not start stopping a guest for a stale initId", async () => {
    const f = await fixture();
    await f.dispose(0);
    expect(f.guest.loadURL).not.toHaveBeenCalled();
    expect(f.guest.close).not.toHaveBeenCalled();
    f.destroy();
  });

  // I20：撤销/清理开始后迟到挂载的 guest 必须停止并纳入清理等待；不能清完存储后仍有页面写入。
  it("waits for a guest attached after revocation to stop before clearing browser data", async () => {
    const f = await fixture();
    const lateHandle = f.register({ serverName: "server-late", scopeId: "scope-late" });
    const clearing = f.host.clearBrowserData();
    await f.entered.promise;
    const late = f.makeGuest();
    f.attach(late.guest as never, lateHandle);
    await late.entered.promise;
    let cleared = false;
    void clearing.finally(() => {
      cleared = true;
    });
    // 先让撤销开始前已挂载的 guest 完成停止，清理才会继续。
    f.navigation.resolve();
    await f.requested.promise;
    f.destroy();
    await flush();
    expect(cleared).toBe(false);
    expect(state.storage.clearStorageData).not.toHaveBeenCalled();
    late.navigation.resolve();
    await late.requested.promise;
    late.destroy();
    await clearing;
    expect(cleared).toBe(true);
    expect(state.storage.clearStorageData).toHaveBeenCalledOnce();
  });
});
