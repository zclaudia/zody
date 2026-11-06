import type { Transport } from "@modelcontextprotocol/client";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle } from "@zody/shared/mcp-apps";
import { describe, expect, it, vi } from "vitest";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import {
  createPluginUiHostController,
  type PluginUiHostControllerDeps,
} from "./pluginUiHostController.js";

const handle: PluginSandboxHandle = {
  sandboxId: "old",
  initId: 1,
  partition: "partition",
  shellUrl: "shell",
  instance: { runtimeId: "agent", generation: 1, token: "one", appIdentity: "a".repeat(64) },
};
function fixture(overrides: Partial<PluginUiHostControllerDeps> = {}) {
  const prepared = Promise.withResolvers<PluginSandboxHandle>();
  const entered = Promise.withResolvers<void>();
  const mounted = Promise.withResolvers<void>();
  const order: string[] = [];
  const close = vi.fn(async () => {
    order.push("revoke");
  });
  const dispose = vi.fn(async () => {
    order.push("guest");
  });
  const prepare = vi.fn(() => {
    entered.resolve();
    return prepared.promise;
  });
  const subscribe = vi.fn(async () => {});
  const unsubscribe = vi.fn(async () => {});
  const onPhase = vi.fn((phase: string) => {
    if (phase === "mounted") mounted.resolve();
  });
  const ports: {
    current?: (event: { sandboxId: string; initId: number; port: unknown }) => void;
  } = {};
  const deps = {
    bridge: {
      prepareSandbox: prepare,
      validateInstance: async () => {},
      closeInstance: close,
      subscribeResource: subscribe,
      unsubscribeResource: unsubscribe,
    },
    platform: {
      getOwnerWebContentsId: async () => 1,
      disposeSandbox: dispose,
      onPorts: (
        listener: (event: { sandboxId: string; initId: number; port: unknown }) => void,
      ) => {
        ports.current = listener;
        return () => {};
      },
    },
    scope: { workspacePath: "/w", sessionId: "s", scope: { kind: "surface", surfaceId: "panel" } },
    presentation: { pluginId: "p", serverName: "m", resourceUri: "ui://app" },
    initialHostContext: {},
    hostVersion: "fixture",
    getToolFeed: () => ({}),
    getWidgetState: vi.fn(() => undefined),
    getHostCapabilities: () => ({}),
    onPhase,
    onDisplayModeRequest: (mode: string) => mode,
    onHeight: () => {},
    onOpenExternal: () => {},
    createTransport: vi.fn(),
    ...overrides,
  } as unknown as PluginUiHostControllerDeps;
  return {
    controller: createPluginUiHostController(deps),
    deps,
    prepared,
    entered,
    mounted,
    close,
    dispose,
    order,
    onPhase,
    ports,
    prepare,
    subscribe,
    unsubscribe,
  };
}
describe("controller preparation and disposal", () => {
  it("delivers a source revocation received while recycling fails", async () => {
    const f = fixture();
    let revoked!: () => void;
    const response = Promise.withResolvers<boolean>();
    f.deps.bridge.recycleInstance = () => response.promise;
    f.deps.onInstanceClosed = vi.fn();
    f.deps.resourceNotifications = {
      register: (_generation, target) => {
        revoked = () => target.notifyInstanceClosed?.();
        return () => {};
      },
    };
    f.controller.start();
    await f.entered.promise;
    f.prepared.resolve(handle);
    await f.mounted.promise;
    const recycling = f.controller.tryRecycle();
    revoked();
    expect(f.deps.onInstanceClosed).not.toHaveBeenCalled();
    response.reject(new Error("connection lost"));
    await expect(recycling).rejects.toThrow("connection lost");
    expect(f.deps.onInstanceClosed).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it("waits for late preparation to release only its original credential and guest", async () => {
    const old = fixture();
    old.controller.start();
    await old.entered.promise;
    const disposal = old.controller.dispose();
    const newer = fixture();
    newer.controller.start();
    await newer.entered.promise;
    newer.prepared.resolve({
      ...handle,
      sandboxId: "new",
      instance: { ...handle.instance, token: "two", generation: 2 },
    });
    await newer.mounted.promise;
    old.prepared.resolve(handle);
    await disposal;
    expect(old.order).toEqual(["revoke", "guest"]);
    expect(old.dispose).toHaveBeenCalledExactlyOnceWith("old", 1);
    expect(newer.controller.phase).toBe("mounted");
    expect(newer.dispose).not.toHaveBeenCalled();
    await newer.controller.dispose();
  });
  it("revokes before releasing the guest and makes repeated disposal idempotent", async () => {
    const f = fixture();
    f.controller.start();
    await f.entered.promise;
    f.prepared.resolve(handle);
    await f.mounted.promise;
    const a = f.controller.dispose(),
      b = f.controller.dispose();
    expect(a).toBe(b);
    await a;
    expect(f.order).toEqual(["revoke", "guest"]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  // I20：显式撤销（删除/重载/来源失效）后，迟到的端口与结果不得重新挂载或复活页面。
  it("does not revive a disposed page when a late port or result arrives", async () => {
    const f = fixture();
    f.controller.start();
    await f.entered.promise;
    f.prepared.resolve(handle);
    await f.mounted.promise;
    const disposal = f.controller.dispose();
    f.ports.current?.({ sandboxId: "old", initId: 2, port: {} });
    f.controller.notifyToolResult({ content: [] } as never);
    await disposal;
    expect(f.deps.createTransport).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.controller.phase).toBe("disposed");
  });
});

type RequestHandler = (request: Record<string, unknown>) => Promise<unknown>;
/** 假 AppBridge：记录注册的请求 handler 与创建时收到的 hostContext，不接真实协议。 */
function createFakeHostBridge() {
  const handlers = new Map<string, RequestHandler>();
  const contexts: McpUiHostContext[] = [];
  const host = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setHostContext: vi.fn(),
    sendToolInput: vi.fn(async () => {}),
    sendToolResult: vi.fn(async () => {}),
    sendToolCancelled: vi.fn(async () => {}),
    teardownResource: vi.fn(async () => ({})),
    getAppCapabilities: vi.fn(() => undefined),
    notification: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [] })),
    setNotificationHandler: vi.fn(),
    setRequestHandler: vi.fn((method: string, ...rest: unknown[]) => {
      handlers.set(method, rest[rest.length - 1] as RequestHandler);
    }),
    oninitialized: undefined as (() => void) | undefined,
  };
  return {
    host,
    handlers,
    contexts,
    create: (_hostInfo: unknown, _capabilities: unknown, context: McpUiHostContext) => {
      contexts.push(context);
      return host as unknown as PluginUiHostBridge;
    },
  };
}

const fakeTransport = () => ({ close: async () => {} }) as unknown as Transport;

async function mount(f: ReturnType<typeof fixture>) {
  f.controller.start();
  await f.entered.promise;
  f.prepared.resolve(handle);
  await f.mounted.promise;
  f.ports.current?.({ sandboxId: handle.sandboxId, initId: handle.initId, port: {} });
}

describe("MCP Apps host projection and single-write boundaries (R52)", () => {
  it("sends the widget state initial value as both registered hostContext keys from one snapshot read", async () => {
    const state = Object.freeze({ draft: "hello" });
    const fake = createFakeHostBridge();
    const f = fixture({
      getWidgetState: vi.fn(() => state),
      createAppBridge: fake.create,
      createTransport: fakeTransport,
    });
    await mount(f);
    expect(f.deps.getWidgetState).toHaveBeenCalledTimes(1);
    const context = fake.contexts[0]!;
    expect(context["zody/widgetState"]).toBe(state);
    expect(context["zcode/widgetState"]).toBe(state);
    // 只登记这两个键，不引入第三份表示。
    expect(Object.keys(context).filter((key) => key.endsWith("widgetState"))).toEqual([
      "zody/widgetState",
      "zcode/widgetState",
    ]);
    await f.controller.dispose();
  });

  it("coalesces duplicate resources/subscribe into one bridge subscription per attachment", async () => {
    const fake = createFakeHostBridge();
    const f = fixture({ createAppBridge: fake.create, createTransport: fakeTransport });
    await mount(f);
    const subscribe = fake.handlers.get("resources/subscribe")!;
    await subscribe({ params: { uri: "ui://r" } });
    await subscribe({ params: { uri: "ui://r" } });
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    expect(f.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ uri: "ui://r", generation: 1 }),
    );
    // 端口换代（页面重挂载）：旧代际订阅退订一次，新请求再订阅一次——不叠加第二条业务写入。
    f.ports.current?.({ sandboxId: handle.sandboxId, initId: 2, port: {} });
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    const resubscribe = fake.handlers.get("resources/subscribe")!;
    await resubscribe({ params: { uri: "ui://r" } });
    expect(f.subscribe).toHaveBeenCalledTimes(2);
    await f.controller.dispose();
  });

  it("treats host context refresh as projection only and writes widget state once per page request", async () => {
    const fake = createFakeHostBridge();
    const onUpdateWidgetState = vi.fn(async () => {});
    const f = fixture({
      createAppBridge: fake.create,
      createTransport: fakeTransport,
      onUpdateWidgetState,
    });
    await mount(f);
    fake.host.oninitialized?.();
    expect(f.controller.phase).toBe("running");
    f.controller.updateHostContext({ theme: "dark" });
    f.controller.updateHostContext({ displayMode: "fullscreen" });
    expect(fake.host.setHostContext).toHaveBeenCalledTimes(2);
    // UI 刷新只更新 hostContext 投影：不重新准备实例、不产生订阅或第二份业务写入。
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.subscribe).not.toHaveBeenCalled();
    const setWidgetState = fake.handlers.get("ui/set-widget-state")!;
    await setWidgetState({ widgetState: { a: 1 } });
    expect(onUpdateWidgetState).toHaveBeenCalledTimes(1);
    expect(onUpdateWidgetState).toHaveBeenCalledWith({ a: 1 });
    await f.controller.dispose();
  });
});
