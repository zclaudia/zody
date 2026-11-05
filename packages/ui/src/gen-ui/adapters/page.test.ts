// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const bridges: Array<{
    capabilities: { experimental?: Record<string, unknown> };
    options: { hostContext?: Record<string, unknown> };
    handlers: Map<string, { handler: (...args: never[]) => unknown }>;
    hostContexts: Array<Record<string, unknown>>;
    oninitialized?: () => void;
  }> = [];
  const sendFollowUp = vi.fn(async () => {});
  const actions = { sendFollowUp };
  const plane: {
    mount: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    prepareUnmount: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    captureBounds: () => Record<string, number>;
    onVisibility?: (visible: boolean) => void;
  } = {
    mount: vi.fn(),
    bind: vi.fn(() => () => {}),
    preview: vi.fn(),
    focus: vi.fn(),
    prepareUnmount: vi.fn(),
    dispose: vi.fn(),
    captureBounds: () => ({}),
  };
  return { bridges, sendFollowUp, actions, plane };
});

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: class {
    capabilities: { experimental?: Record<string, unknown> };
    options: { hostContext?: Record<string, unknown> };
    handlers = new Map<string, { handler: (...args: never[]) => unknown }>();
    hostContexts: Array<Record<string, unknown>> = [];
    onerror: unknown;
    oninitialized?: () => void;
    onsizechange: unknown;
    onopenlink: unknown;
    constructor(
      _client: unknown,
      _info: unknown,
      capabilities: { experimental?: Record<string, unknown> },
      options: { hostContext?: Record<string, unknown> },
    ) {
      this.capabilities = capabilities;
      this.options = options;
      hoisted.bridges.push(this);
    }
    setRequestHandler(method: string, _schemas: unknown, handler: (...args: never[]) => unknown) {
      this.handlers.set(method, { handler });
    }
    setHostContext(context: Record<string, unknown>) {
      this.hostContexts.push(context);
    }
    async connect() {}
    async close() {}
  },
}));

vi.mock("@/plugin-ui/hostPrimitives.js", () => ({
  createPluginUiPagePlane: (options: { onVisibility: (visible: boolean) => void }) => {
    hoisted.plane.onVisibility = options.onVisibility;
    return hoisted.plane;
  },
  createPluginUiMessagePortTransport: () => ({}),
  getPluginUiSessionActions: () => hoisted.actions,
  readPluginUiStyleVariables: () => ({}),
}));

const { createGenUiPage } = await import("./page.js");

const target = {
  workspacePath: "/workspace",
  sessionId: "session",
  path: "/workspace/gen-ui/card.html",
  instanceKey: "instance",
};
const handle = {
  sandboxId: "sandbox",
  initId: 1,
  partition: "persist:test",
  shellUrl: "shell",
  instance: { runtimeId: "runtime", generation: 1, token: "token", appIdentity: "a".repeat(64) },
};

async function fixture(
  initialState: unknown = null,
  options: { gesture?: boolean } = { gesture: true },
) {
  const ports: { current?: (event: { sandboxId: string; initId: number; port: unknown }) => void } =
    {};
  const setState = vi.fn(async () => {});
  const openExternal = vi.fn();
  const consumeUserGesture = vi.fn(async () => options.gesture !== false);
  const stateChanges: Array<(change: unknown) => void> = [];
  const state = {
    readDocument: vi.fn(async () => ({ path: target.path, html: "<div>card</div>" })),
    prepareSandbox: vi.fn(async () => handle),
    getState: vi.fn(async () => initialState),
    setState,
    listState: vi.fn(async () => []),
    onStateChanged: (listener: (change: unknown) => void) => {
      stateChanges.push(listener);
      return { dispose() {} };
    },
  };
  const page = createGenUiPage({
    target,
    files: state as never,
    state: state as never,
    platform: {
      getOwnerWebContentsId: async () => 1,
      disposeSandbox: vi.fn(async () => {}),
      consumeUserGesture,
      onPorts: (listener: typeof ports.current) => {
        ports.current = listener;
        return () => {};
      },
    } as never,
    openExternal,
    confirm: vi.fn(async () => "confirmed"),
  });
  await vi.waitFor(() => expect(page.isBusy()).toBe(false));
  ports.current!({ sandboxId: handle.sandboxId, initId: handle.initId, port: {} });
  const bridge = hoisted.bridges.at(-1)!;
  bridge.oninitialized?.();
  hoisted.plane.onVisibility?.(true);
  return { page, bridge, setState, openExternal, consumeUserGesture, stateChanges };
}

describe("Gen UI page dual-name wire", () => {
  it("advertises exactly the two Gen UI capability keys", async () => {
    const { bridge } = await fixture();
    expect(Object.keys(bridge.capabilities.experimental ?? {}).sort()).toEqual([
      "zcode/gen-ui",
      "zody/gen-ui",
    ]);
  });

  it("registers both method names against the same handler closure", async () => {
    const { bridge } = await fixture();
    for (const [canonical, legacy] of [
      ["zody/gen-ui/state", "zcode/gen-ui/state"],
      ["zody/gen-ui/follow-up", "zcode/gen-ui/follow-up"],
      ["zody/gen-ui/tweak", "zcode/gen-ui/tweak"],
      ["zody/gen-ui/presentation", "zcode/gen-ui/presentation"],
    ] as const) {
      expect(bridge.handlers.has(canonical)).toBe(true);
      expect(bridge.handlers.has(legacy)).toBe(true);
      // 旧名只是另一个 wire 名，不能拥有第二套 handler/owner。
      expect(bridge.handlers.get(legacy)!.handler).toBe(bridge.handlers.get(canonical)!.handler);
    }
  });

  it("saves once per request through either name, sharing one queue", async () => {
    const { bridge, setState } = await fixture();
    const params = { state: { modelContent: 1, privateContent: null } };
    await bridge.handlers.get("zody/gen-ui/state")!.handler(params as never);
    expect(setState).toHaveBeenCalledTimes(1);
    await bridge.handlers.get("zcode/gen-ui/state")!.handler(params as never);
    expect(setState).toHaveBeenCalledTimes(2);
    expect(setState).toHaveBeenLastCalledWith({
      target: {
        workspacePath: target.workspacePath,
        sessionId: target.sessionId,
        path: target.path,
      },
      state: params.state,
    });
  });

  it("sends exactly one follow-up through the legacy name", async () => {
    const { bridge } = await fixture();
    hoisted.sendFollowUp.mockClear();
    await bridge.handlers.get("zcode/gen-ui/follow-up")!.handler({ prompt: "hello" } as never);
    expect(hoisted.sendFollowUp).toHaveBeenCalledTimes(1);
    expect(hoisted.sendFollowUp).toHaveBeenCalledWith({
      prompt: "hello",
      source: { kind: "genUi", path: target.path, title: undefined },
    });
  });

  it("increments presentation projection once per request", async () => {
    const { bridge, page } = await fixture();
    await bridge.handlers.get("zcode/gen-ui/presentation")!.handler({ escape: true } as never);
    expect(page.getSnapshot().escapeSequence).toBe(1);
  });

  it("opens exactly one external URL per request after consuming one gesture", async () => {
    const { bridge, openExternal, consumeUserGesture } = await fixture();
    const onopenlink = (
      bridge as unknown as { onopenlink: (input: { url: string }) => Promise<unknown> }
    ).onopenlink;
    await onopenlink({ url: "https://example.com/rename-wire" });
    expect(consumeUserGesture).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/rename-wire");
  });

  it("rejects an external link without consuming a granted gesture", async () => {
    const { bridge, openExternal, consumeUserGesture } = await fixture(null, { gesture: false });
    const onopenlink = (
      bridge as unknown as { onopenlink: (input: { url: string }) => Promise<unknown> }
    ).onopenlink;
    await expect(onopenlink({ url: "https://example.com/denied" })).rejects.toThrow(/user gesture/);
    expect(consumeUserGesture).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("projects hostContext under both key pairs with the same object reference", async () => {
    const initial = { modelContent: "initial", privateContent: null };
    const { bridge, stateChanges, page } = await fixture(initial);
    const next = { modelContent: "next", privateContent: null };
    stateChanges[0]!({ target: { ...target }, state: next });
    page.setTweaks({});
    const context = bridge.hostContexts.at(-1)!;
    expect(context["zody/genUiState"]).toBe(context["zcode/genUiState"]);
    expect(context["zody/genUiState"]).toEqual(next);
    expect(context["zody/genUiTweaks"]).toBe(context["zcode/genUiTweaks"]);
    expect(context["zody/genUiTweaks"]).not.toBeNull();
  });
});
