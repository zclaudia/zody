import { describe, expect, it, vi } from "vitest";
import {
  ZODY_GLOBALS_EVENT,
  ZODY_GLOBALS_EVENT_CANONICAL,
  createPluginSandboxAliasRuntime,
  type AliasAppLike,
} from "./aliasRuntime.js";

type HostContext = Record<string, unknown>;

function fixture(hostContext: HostContext = {}) {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const notificationHandlers = new Map<
    string,
    (notification: { params?: { uri?: string } }) => void
  >();
  const connect = vi.fn(async () => {});
  const app = {
    connect,
    getHostVersion: () => ({ name: "host", version: "1" }),
    getHostCapabilities: () => ({ experimental: {} }),
    getHostContext: () => hostContext,
    ontoolinput: undefined,
    ontoolresult: undefined,
    ontoolcancelled: undefined,
    onhostcontextchanged: undefined,
    callServerTool: vi.fn(async () => ({ content: [] })),
    readServerResource: vi.fn(async () => ({ contents: [] })),
    listServerResources: vi.fn(async () => ({ resources: [] })),
    request: vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      requests.push(request);
      return {};
    }),
    setNotificationHandler: vi.fn((method: string, handler: never) => {
      notificationHandlers.set(method, handler);
    }),
    openLink: vi.fn(async () => ({})),
    requestDisplayMode: vi.fn(async ({ mode }: { mode: string }) => ({ mode })),
    sendSizeChanged: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({})),
    updateModelContext: vi.fn(async () => ({})),
    downloadFile: vi.fn(async () => ({})),
  } as unknown as AliasAppLike;
  const onChange = vi.fn();
  const runtime = createPluginSandboxAliasRuntime({
    app,
    protocolVersion: "2026-01-26",
    onChange,
  });
  return { app, runtime, requests, onChange, notificationHandlers, connect };
}

describe("alias runtime namespace and single projection", () => {
  it("locks both globals event names and keeps them distinct", () => {
    // legacy 值字节锁定；canonical 是本批新增名（spec §1.1）。
    expect(ZODY_GLOBALS_EVENT).toBe("zcode:globals");
    expect(ZODY_GLOBALS_EVENT_CANONICAL).toBe("zody:globals");
    expect(ZODY_GLOBALS_EVENT_CANONICAL).not.toBe(ZODY_GLOBALS_EVENT);
  });

  it("hands the host change to onChange once per change (one projection, two names later)", async () => {
    const { app, runtime, onChange } = fixture({ theme: "dark" });
    await runtime.zcode.ready();
    onChange.mockClear();
    app.ontoolinput!({ arguments: { marker: "one" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toMatchObject({ toolInput: { marker: "one" } });
  });

  it("seeds widgetState from the canonical context key first and falls back to legacy", async () => {
    const canonical = { modelContent: "canonical", privateContent: null };
    const legacy = { modelContent: "legacy", privateContent: null };
    const both = fixture({ "zody/widgetState": canonical, "zcode/widgetState": legacy });
    await both.runtime.zcode.ready();
    expect(both.runtime.zcode.widgetState).toEqual(canonical);

    const oldHost = fixture({ "zcode/widgetState": legacy });
    await oldHost.runtime.zcode.ready();
    expect(oldHost.runtime.zcode.widgetState).toEqual(legacy);
  });

  it("keeps a canonical null snapshot instead of falling back to a stale legacy value", async () => {
    const runtimeFixture = fixture({
      "zody/widgetState": null,
      "zcode/widgetState": { modelContent: "stale", privateContent: null },
    });
    await runtimeFixture.runtime.zcode.ready();
    expect(runtimeFixture.runtime.zcode.widgetState).toBeNull();
  });

  it("connects lazily exactly once for zody and zcode access", async () => {
    const { runtime, connect } = fixture();
    expect(runtime.zcode.toolInput).toBeNull();
    expect(runtime.zcode.toolInput).toBeNull();
    await runtime.zcode.ready();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers once per change and drops removed listeners", async () => {
    const { app, runtime } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = runtime.zcode.subscribe(first);
    runtime.zcode.subscribe(second);
    app.ontoolresult!({ content: [], structuredContent: { ok: true } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    offFirst();
    app.ontoolcancelled!({ reason: "user" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("registers one notification handler per method and fans out each resource update once", async () => {
    const { runtime, notificationHandlers } = fixture();
    const one = vi.fn();
    const two = vi.fn();
    runtime.zcode.onResourceUpdated(one);
    runtime.zcode.onResourceUpdated(two);
    expect(notificationHandlers.size).toBe(2);
    notificationHandlers.get("notifications/resources/updated")!({ params: { uri: "ui://a" } });
    expect(one).toHaveBeenCalledWith("ui://a");
    expect(two).toHaveBeenCalledWith("ui://a");
    expect(one).toHaveBeenCalledTimes(1);
  });

  it("sends one set-widget-state request per call and notifies once", async () => {
    const { app, runtime, requests } = fixture();
    // 先完成懒握手，避免 connect 的首次 notify 混入保存次数。
    await runtime.zcode.ready();
    const listener = vi.fn();
    runtime.zcode.subscribe(listener);
    await runtime.zcode.setWidgetState({ modelContent: 1, privateContent: null });
    await runtime.zcode.setWidgetState({ modelContent: 2, privateContent: null });
    expect(requests.filter((request) => request.method === "ui/set-widget-state")).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(app.sendMessage).not.toHaveBeenCalled();
  });

  it("opens one external link per call", async () => {
    const { app, runtime } = fixture();
    const openLink = vi.mocked(app.openLink);
    runtime.zcode.openExternal({ href: "https://example.com/rename-wire" });
    await vi.waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(openLink).toHaveBeenCalledWith({ url: "https://example.com/rename-wire" });
  });
});
