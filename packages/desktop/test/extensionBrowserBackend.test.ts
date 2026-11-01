import { describe, expect, it } from "vitest";
import type {
  ExtensionBridgeClientMessage,
  ExtensionBridgeRequestMessage,
  ExtensionBridgeServerMessage,
  ExtensionNativeTab,
} from "@zcode/shared/browser-extension-transport";
import type { BrowserCommand } from "@zcode/shared";
import { ExtensionCdpTransport } from "../src/browser-core/extensionCdpTransport.js";
import { ExtensionBrowserBackend } from "../src/host/extensionBrowserBackend.js";
import type {
  ExtensionHostConnection,
  ExtensionHostEvent,
  ExtensionTransportClient,
} from "../src/host/extensionTransportClient.js";

const PROFILE = "profile-instance-1234567890";
const BROWSER_ID = `extension:${PROFILE}`;
const CONNECTION: ExtensionHostConnection = {
  profileInstanceId: PROFILE,
  browserId: BROWSER_ID,
  generation: 3,
  connectionId: "connection-1234567890",
  windowId: "42",
};

type RequestOfType<T extends ExtensionBridgeRequestMessage["type"]> = Extract<
  ExtensionBridgeRequestMessage,
  { type: T }
>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeExtensionTransport implements ExtensionTransportClient {
  connection: ExtensionHostConnection | undefined = CONNECTION;
  readonly requests: ExtensionBridgeRequestMessage[] = [];
  readonly sent: ExtensionBridgeServerMessage[] = [];
  readonly events = new Set<(event: ExtensionHostEvent) => void>();
  readonly connectionListeners = new Set<
    (change: { connected: boolean; connection: ExtensionHostConnection }) => void
  >();
  activeByNativeTab = new Map<number, number>();
  maxConcurrentByNativeTab = new Map<number, number>();
  activeGlobal = 0;
  maxActiveGlobal = 0;
  currentUrl = "about:blank";
  currentTitle = "";
  delayMs = 0;
  blockedMethod: string | null = null;
  blocked: Promise<void> | null = null;
  failCdpWith: "target_unavailable" | null = null;
  throwOnMethod: string | null = null;
  lastTargetRef: RequestOfType<"cdp.request">["targetRef"] | null = null;
  nextNativeTabId = 40;
  readonly canceledWireRequestIds: string[] = [];

  async listConnections(): Promise<ExtensionHostConnection[]> {
    return this.connection ? [this.connection] : [];
  }

  async request(
    _profileInstanceId: string,
    message: ExtensionBridgeRequestMessage,
  ): Promise<ExtensionBridgeClientMessage> {
    this.requests.push(message);
    return this.respond(message);
  }

  async send(_profileInstanceId: string, message: ExtensionBridgeServerMessage): Promise<boolean> {
    this.sent.push(message);
    return true;
  }

  handleResult(): void {}
  handleConnectionChanged(): void {}
  handleEvent(): void {}
  onConnectionChange(
    listener: (change: { connected: boolean; connection: ExtensionHostConnection }) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  onEvent(listener: (event: ExtensionHostEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  getConnection(profileInstanceId: string): ExtensionHostConnection | undefined {
    return this.connection?.profileInstanceId === profileInstanceId ? this.connection : undefined;
  }
  dispose(): void {}

  emitConnection(connected: boolean): void {
    if (!this.connection) return;
    for (const listener of this.connectionListeners)
      listener({ connected, connection: this.connection });
  }

  emit(message: ExtensionBridgeClientMessage): void {
    for (const listener of this.events) {
      listener({ profileInstanceId: PROFILE, message });
    }
  }

  readonly order: string[] = [];

  private async track<T>(nativeTabId: number, operation: () => Promise<T>): Promise<T> {
    this.order.push(`start:${nativeTabId}`);
    const active = (this.activeByNativeTab.get(nativeTabId) ?? 0) + 1;
    this.activeByNativeTab.set(nativeTabId, active);
    this.maxConcurrentByNativeTab.set(
      nativeTabId,
      Math.max(this.maxConcurrentByNativeTab.get(nativeTabId) ?? 0, active),
    );
    this.activeGlobal += 1;
    this.maxActiveGlobal = Math.max(this.maxActiveGlobal, this.activeGlobal);
    try {
      if (this.delayMs > 0) await sleep(this.delayMs);
      return await operation();
    } finally {
      this.activeGlobal -= 1;
      this.activeByNativeTab.set(nativeTabId, active - 1);
    }
  }

  private async respond(
    message: ExtensionBridgeRequestMessage,
  ): Promise<ExtensionBridgeClientMessage> {
    if (message.type === "tabs.list") {
      return {
        type: "tabs.list.result",
        requestId: message.requestId,
        ok: true,
        tabs: [
          {
            nativeTabId: 41,
            active: true,
            url: "https://example.com/user-page?token=secret#frag",
            title: "User Page",
          },
        ],
      };
    }
    if (message.type === "tabs.create") {
      const nativeTabId = ++this.nextNativeTabId;
      const tab: ExtensionNativeTab = {
        nativeTabId,
        active: false,
        url: message.url ?? "about:blank",
        title: "",
      };
      return { type: "tabs.create.result", requestId: message.requestId, ok: true, tab };
    }
    if (message.type === "debugger.attach") {
      this.currentUrl = "about:blank";
      return {
        type: "debugger.attach.result",
        requestId: message.requestId,
        ok: true,
        attachmentId: `attachment-${message.target.nativeTabId}`,
        nativeTabId: message.target.nativeTabId,
        url: this.currentUrl,
      };
    }
    if (message.type === "debugger.detach") {
      return { type: "debugger.detach.result", requestId: message.requestId, ok: true };
    }
    if (message.type === "tabs.close") {
      return { type: "tabs.close.result", requestId: message.requestId, ok: true };
    }
    if (message.type === "cdp.request") {
      this.lastTargetRef = message.targetRef;
      return this.track(message.targetRef.nativeTabId, async () => {
        if (this.throwOnMethod === message.method) {
          throw Object.assign(new Error("extension transport lost"), {
            code: "request_timeout",
          });
        }
        if (this.blockedMethod === message.method) {
          await this.blocked;
        }
        if (this.failCdpWith) {
          return {
            type: "cdp.result",
            requestId: message.requestId,
            attachmentId: message.targetRef.attachmentId,
            nativeTabId: message.targetRef.nativeTabId,
            ok: false,
            failure: { code: this.failCdpWith, message: "attachment is stale" },
          };
        }
        const result = this.cdpResult(message);
        return {
          type: "cdp.result",
          requestId: message.requestId,
          attachmentId: message.targetRef.attachmentId,
          nativeTabId: message.targetRef.nativeTabId,
          ...(message.targetId ? { targetId: message.targetId } : {}),
          ok: true,
          result,
        };
      });
    }
    throw new Error(`unexpected request: ${message.type}`);
  }

  private cdpResult(message: RequestOfType<"cdp.request">): unknown {
    if (message.method === "Page.navigate") {
      this.currentUrl = String(message.params.url);
      return {};
    }
    if (message.method === "Page.reload") return {};
    if (message.method === "Page.getNavigationHistory") {
      return { currentIndex: 0, entries: [{ id: 1, url: this.currentUrl }] };
    }
    if (message.method === "Page.captureScreenshot") {
      return { data: Buffer.from("png").toString("base64") };
    }
    if (message.method === "Runtime.evaluate") {
      const expression = String(message.params.expression);
      if (expression.includes("document.readyState")) {
        return { result: { value: "complete" } };
      }
      if (expression.includes("location.href")) {
        return {
          result: {
            value: {
              url: this.currentUrl,
              title: this.currentTitle,
              scrollX: 0,
              scrollY: 0,
              viewportWidth: 1280,
              viewportHeight: 720,
            },
          },
        };
      }
      if (expression.includes("window.innerWidth")) {
        return { result: { value: { width: 1280, height: 720 } } };
      }
    }
    return {};
  }
}

function createBackend(options: { commandTimeoutMs?: number; navigationTimeoutMs?: number } = {}): {
  backend: ExtensionBrowserBackend;
  transport: FakeExtensionTransport;
} {
  const transport = new FakeExtensionTransport();
  const cdp = new ExtensionCdpTransport({
    request: (message) => transport.request(PROFILE, message),
    cancel: (requestId) => transport.canceledWireRequestIds.push(requestId),
  });
  const backend = new ExtensionBrowserBackend({
    transport,
    cdp,
    navigationTimeoutMs: options.navigationTimeoutMs ?? 500,
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
  });
  return { backend, transport };
}

function context(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    requestId: `request-${Math.random()}`,
    sessionId: "session-1",
    workspaceKey: "workspace-1",
    workspaceIdentity: "workspace-1",
    clientMode: "desktop-continuous" as const,
    sessionContext: "live" as const,
    browserId: BROWSER_ID,
    browserGeneration: 3,
    ...overrides,
  };
}

async function newTab(
  backend: ExtensionBrowserBackend,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const result = await backend.execute(context(overrides), { method: "newTab" });
  expect(result.ok).toBe(true);
  return result.tab!;
}

describe("ExtensionBrowserBackend", () => {
  it("creates background tabs and exposes only Host logical ids", async () => {
    const { backend, transport } = createBackend();
    const tab = await newTab(backend, { requestId: "create-1" });
    expect(tab.tabId).toMatch(/^extab:/);
    expect(tab.active).toBeUndefined();
    const create = transport.requests.find((request) => request.type === "tabs.create");
    expect(create).toMatchObject({ active: false, url: "about:blank" });
    expect(transport.requests.some((request) => request.type === "debugger.attach")).toBe(true);
  });

  for (const decision of ["denied", "dismissed"] as const) {
    it(`returns permission_denied after the user ${decision} a claim without re-requesting or attaching`, async () => {
      const { backend, transport } = createBackend();
      const firstClaim = await backend.execute(context(), {
        method: "claimTab",
        tabId: "extuser:41",
      });
      expect(firstClaim).toMatchObject({
        ok: false,
        error: { code: "authorization_required", sideEffect: "none" },
      });
      const claimRequests = () =>
        transport.sent.filter((message) => message.type === "claim.request") as Array<
          Extract<ExtensionBridgeServerMessage, { type: "claim.request" }>
        >;
      expect(claimRequests()).toHaveLength(1);
      const claimId = claimRequests()[0]?.claimId;
      if (!claimId) throw new Error("claim.request was not sent");

      transport.emit({
        type: "claim.decision",
        claimId,
        nativeTabId: 41,
        decision,
      } as ExtensionBridgeClientMessage);
      const attachCount = transport.requests.filter(
        (request) => request.type === "debugger.attach",
      ).length;

      const retry = await backend.execute(context(), {
        method: "claimTab",
        tabId: "extuser:41",
      });
      expect(retry).toMatchObject({
        ok: false,
        error: { code: "permission_denied", sideEffect: "none" },
      });
      // 不得重新发送 claim.request，也不得 attach。
      expect(claimRequests()).toHaveLength(1);
      expect(
        transport.requests.filter((request) => request.type === "debugger.attach"),
      ).toHaveLength(attachCount);

      // 拒绝事实只消费一次；之后的 claim 才视为新的显式用户意图。
      const explicitAgain = await backend.execute(context(), {
        method: "claimTab",
        tabId: "extuser:41",
      });
      expect(explicitAgain).toMatchObject({
        ok: false,
        error: { code: "authorization_required" },
      });
      expect(claimRequests()).toHaveLength(2);
    });
  }

  it("navigates, reads state and captures a viewport screenshot", async () => {
    const { backend, transport } = createBackend();
    const tab = await newTab(backend);
    transport.currentTitle = "Example";

    const navigate = await backend.execute(context(), {
      method: "navigate",
      url: "https://example.com/",
      tabId: tab.tabId,
    });
    expect(navigate).toMatchObject({
      ok: true,
      state: { url: "https://example.com/", title: "Example" },
      meta: { backendType: "extension", browserId: BROWSER_ID, browserGeneration: 3 },
    });

    const state = await backend.execute(context(), { method: "getState", tabId: tab.tabId });
    expect(state).toMatchObject({ ok: true, state: { url: "https://example.com/" } });

    const screenshot = await backend.execute(context(), {
      method: "screenshot",
      tabId: tab.tabId,
    });
    expect(screenshot).toMatchObject({
      ok: true,
      image: { base64: Buffer.from("png").toString("base64"), mimeType: "image/png" },
    });
  });

  it("fails closed for fullPage, viewport emulation and coordinate CUA", async () => {
    const { backend, transport } = createBackend();
    const tab = await newTab(backend);
    transport.requests.length = 0;
    for (const command of [
      { method: "screenshot", fullPage: true, tabId: tab.tabId },
      { method: "browserViewportSet", width: 800, height: 600, tabId: tab.tabId },
      { method: "click", x: 10, y: 20, tabId: tab.tabId },
    ] satisfies BrowserCommand[]) {
      const result = await backend.execute(context(), command);
      expect(result).toMatchObject({ ok: false, error: { code: "capability_unsupported" } });
    }
    expect(transport.requests.some((request) => request.type === "cdp.request")).toBe(false);

    // P2：不依赖坐标的键盘输入是支持的；它仍走 CDP trusted input，不伪装成坐标 CUA。
    const keypress = await backend.execute(context(), {
      method: "cuaKeypress",
      keys: ["Meta", "A"],
      tabId: tab.tabId,
    });
    expect(keypress).toMatchObject({ ok: true });
    expect(
      transport.requests.some(
        (request) => request.type === "cdp.request" && request.method === "Input.dispatchKeyEvent",
      ),
    ).toBe(true);
  });

  it("isolates tabs by session and workspace", async () => {
    const { backend } = createBackend();
    const tab = await newTab(backend, { requestId: "isolation-create" });

    const otherSession = await backend.execute(context({ sessionId: "session-2" }), {
      method: "list",
    });
    const otherWorkspace = await backend.execute(context({ workspaceKey: "workspace-2" }), {
      method: "list",
    });
    const owner = await backend.execute(context(), { method: "list" });
    expect(otherSession.tabs).toEqual([]);
    expect(otherWorkspace.tabs).toEqual([]);
    expect(owner.tabs?.map((candidate) => candidate.tabId)).toEqual([tab.tabId]);

    const stolen = await backend.execute(context({ sessionId: "session-2" }), {
      method: "getState",
      tabId: tab.tabId,
    });
    expect(stolen).toMatchObject({ ok: false, error: { code: "target_unavailable" } });
  });

  it("rejects stale generations and disconnected profiles without falling back", async () => {
    const { backend, transport } = createBackend();
    const stale = await backend.execute(context({ browserGeneration: 2 }), { method: "list" });
    expect(stale).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });

    await newTab(backend);
    transport.connection = undefined;
    const disconnected = await backend.execute(context(), { method: "list" });
    expect(disconnected).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
  });

  it("rejects duplicate requestIds before dispatching a second backend call", async () => {
    const { backend, transport } = createBackend();
    let release!: () => void;
    const tab = await newTab(backend);
    transport.blockedMethod = "Runtime.evaluate";
    transport.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = backend.execute(context({ requestId: "duplicate-1" }), {
      method: "getState",
      tabId: tab.tabId,
    });
    const second = await backend.execute(context({ requestId: "duplicate-1" }), {
      method: "getState",
      tabId: tab.tabId,
    });
    expect(second).toMatchObject({ ok: false, error: { code: "duplicate_request_id" } });
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("serializes commands on one tab and runs different tabs in parallel", async () => {
    const { backend, transport } = createBackend();
    const first = await newTab(backend);
    const second = await newTab(backend);
    transport.delayMs = 20;

    await Promise.all([
      backend.execute(context(), { method: "getState", tabId: first.tabId }),
      backend.execute(context(), { method: "getState", tabId: first.tabId }),
    ]);
    expect(transport.maxConcurrentByNativeTab.get(41)).toBe(1);

    await Promise.all([
      backend.execute(context(), { method: "getState", tabId: first.tabId }),
      backend.execute(context(), { method: "getState", tabId: second.tabId }),
    ]);
    // 同 tab 串行：每 tab 的峰值并发始终为 1。
    expect(transport.maxConcurrentByNativeTab.get(41)).toBe(1);
    expect(transport.maxConcurrentByNativeTab.get(42)).toBe(1);
    // 不同 tab 并行：全局峰值必须大于 1。
    expect(transport.maxActiveGlobal, transport.order.join(",")).toBeGreaterThan(1);
  });

  it("turns a late result after target.detached into target_unavailable", async () => {
    const { backend, transport } = createBackend();
    const tab = await newTab(backend);
    let release!: () => void;
    transport.blockedMethod = "Runtime.evaluate";
    transport.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const command = backend.execute(context(), { method: "getState", tabId: tab.tabId });
    await sleep(1);
    const targetRef = transport.lastTargetRef!;
    transport.emit({ type: "target.detached", targetRef, reason: "user_cancel" });
    release();
    await expect(command).resolves.toMatchObject({
      ok: false,
      error: { code: "target_unavailable" },
    });
  });

  it("keeps transport target_unavailable structured instead of execution_error", async () => {
    const { backend, transport } = createBackend();
    const tab = await newTab(backend);
    transport.failCdpWith = "target_unavailable";
    const result = await backend.execute(context(), { method: "getState", tabId: tab.tabId });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "target_unavailable", sideEffect: "none" },
    });
  });

  it("marks pre-dispatch failures as sideEffect none", async () => {
    const { backend, transport } = createBackend();
    const stale = await backend.execute(context({ browserGeneration: 2 }), {
      method: "newTab",
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "backend_unavailable", sideEffect: "none" },
    });

    const tab = await newTab(backend);
    const invalidUrl = await backend.execute(context(), {
      method: "navigate",
      url: "ftp://example.com/file",
      tabId: tab.tabId,
    });
    expect(invalidUrl).toMatchObject({
      ok: false,
      error: { code: "navigation_blocked", sideEffect: "none" },
    });
    // URL 校验必须发生在 Page.navigate 之前。
    expect(
      transport.requests.some(
        (request) => request.type === "cdp.request" && request.method === "Page.navigate",
      ),
    ).toBe(false);
  });

  it("marks a dispatched side-effecting command with unknown transport result uncertain", async () => {
    const { backend, transport } = createBackend();
    const tab = await newTab(backend);
    transport.throwOnMethod = "Page.navigate";
    const result = await backend.execute(context(), {
      method: "navigate",
      url: "https://example.com/lost",
      tabId: tab.tabId,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "execution_error", sideEffect: "uncertain" },
    });
  });

  it("cancels only the target command and releases its wire request", async () => {
    const { backend, transport } = createBackend({ commandTimeoutMs: 5_000 });
    const tab = await newTab(backend);
    let release!: () => void;
    transport.blockedMethod = "Runtime.evaluate";
    transport.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = backend.execute(context({ requestId: "cancel-target" }), {
      method: "evaluate",
      expression: "1 + 1",
      tabId: tab.tabId,
    });
    await sleep(1);

    const cancelled = await backend.execute(context({ requestId: "cancel-command" }), {
      method: "cancelRequest",
      requestId: "cancel-target",
    });
    expect(cancelled).toMatchObject({ ok: true, value: { cancelled: true } });
    expect(transport.canceledWireRequestIds.length).toBeGreaterThan(0);

    release();
    await expect(running).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "uncertain" },
    });

    const unknown = await backend.execute(context({ requestId: "cancel-unknown" }), {
      method: "cancelRequest",
      requestId: "not-running",
    });
    expect(unknown).toMatchObject({ ok: true, value: { cancelled: false } });
  });

  it("turnEnded aborts only requests for that turn", async () => {
    const { backend, transport } = createBackend({ commandTimeoutMs: 5_000 });
    const tab = await newTab(backend);
    let release!: () => void;
    transport.blockedMethod = "Runtime.evaluate";
    transport.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = backend.execute(context({ requestId: "turn-target", turnId: "turn-1" }), {
      method: "evaluate",
      expression: "1 + 1",
      tabId: tab.tabId,
    });
    await sleep(1);
    const ended = await backend.execute(context({ requestId: "turn-end", turnId: "turn-1" }), {
      method: "turnEnded",
      turnId: "turn-1",
    });
    expect(ended.ok).toBe(true);
    release();
    await expect(running).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "uncertain" },
    });
  });

  it("times out a dispatched command as uncertain and leaves the tab usable", async () => {
    const { backend, transport } = createBackend({ commandTimeoutMs: 40 });
    const tab = await newTab(backend);
    let release!: () => void;
    transport.blockedMethod = "Runtime.evaluate";
    transport.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await backend.execute(context({ requestId: "timeout-command" }), {
      method: "evaluate",
      expression: "1 + 1",
      tabId: tab.tabId,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "timeout", sideEffect: "uncertain" },
    });
    expect(transport.canceledWireRequestIds.length).toBeGreaterThan(0);

    transport.blockedMethod = null;
    release();
    const state = await backend.execute(context({ requestId: "after-timeout" }), {
      method: "getState",
      tabId: tab.tabId,
    });
    expect(state).toMatchObject({ ok: true });
  });

  it("finalize changes lifecycle without closing or detaching the tab", async () => {
    const { backend, transport } = createBackend();
    const tab = await newTab(backend);
    transport.requests.length = 0;
    const finalized = await backend.execute(context(), {
      method: "finalize",
      tabId: tab.tabId,
      deliverable: true,
    });
    expect(finalized).toMatchObject({
      ok: true,
      meta: { lifecycle: "deliverable" },
    });
    expect(transport.requests.some((request) => request.type === "tabs.close")).toBe(false);
    expect(transport.requests.some((request) => request.type === "debugger.detach")).toBe(false);
    const list = await backend.execute(context(), { method: "list" });
    expect(list.tabs?.[0]?.lifecycle).toBe("deliverable");
  });

  it("closeSession closes agent tabs and only detaches user tabs", async () => {
    const { backend, transport } = createBackend();
    transport.nextNativeTabId = 50;
    await newTab(backend);
    // 两阶段 claim 的第二次调用 attach 用户 tab。
    const firstClaim = await backend.execute(context(), {
      method: "claimTab",
      tabId: "extuser:41",
    });
    expect(firstClaim).toMatchObject({ error: { code: "authorization_required" } });
    const claim = transport.sent.find((message) => message.type === "claim.request");
    if (!claim || claim.type !== "claim.request") throw new Error("claim.request missing");
    transport.emit({
      type: "claim.decision",
      claimId: claim.claimId,
      nativeTabId: 41,
      decision: "granted",
    } as ExtensionBridgeClientMessage);
    const claimed = await backend.execute(context(), {
      method: "claimTab",
      tabId: "extuser:41",
    });
    expect(claimed.ok).toBe(true);
    transport.requests.length = 0;

    const closed = await backend.execute(context(), { method: "closeSession" });
    expect(closed.ok).toBe(true);
    const results = transport.requests.map((request) => request.type);
    // agent tab: detach + tabs.close；user tab: 仅 detach，不关闭原生 tab。
    expect(results.filter((type) => type === "tabs.close")).toHaveLength(1);
    expect(results.filter((type) => type === "debugger.detach")).toHaveLength(2);
    const list = await backend.execute(context(), { method: "list" });
    expect(list.tabs).toEqual([]);
  });

  it("finalizeTabs marks keep without closing omitted tabs", async () => {
    const { backend, transport } = createBackend();
    const first = await newTab(backend);
    const second = await newTab(backend);
    transport.requests.length = 0;

    // 遗漏的 tab 不关闭、不 detach。
    const omitted = await backend.execute(context(), {
      method: "finalizeTabs",
      keep: [],
    });
    expect(omitted.ok).toBe(true);
    expect(transport.requests.filter((request) => request.type === "tabs.close")).toHaveLength(0);
    expect(transport.requests.filter((request) => request.type === "debugger.detach")).toHaveLength(
      0,
    );

    // handoff 只更新 lifecycle；deliverable 释放 debugger 但保留 Chrome tab。
    const finalized = await backend.execute(context(), {
      method: "finalizeTabs",
      keep: [
        { tabId: first.tabId, status: "handoff" },
        { tabId: second.tabId, status: "deliverable" },
      ],
    });
    expect(finalized.ok).toBe(true);
    expect(transport.requests.filter((request) => request.type === "debugger.detach")).toHaveLength(
      1,
    );
    expect(transport.requests.filter((request) => request.type === "tabs.close")).toHaveLength(0);
    const list = await backend.execute(context(), { method: "list" });
    expect(list.tabs?.map((tab) => tab.tabId)).toEqual([first.tabId]);
    expect(list.tabs?.[0]?.lifecycle).toBe("handoff");
  });

  it("finalizeTabs isolates sessions and rejects unknown tab ids", async () => {
    const { backend } = createBackend();
    const owned = await newTab(backend);
    const other = await backend.execute(context({ sessionId: "session-2" }), {
      method: "newTab",
    });
    if (!other.ok || !other.tab) throw new Error("other session tab was not created");

    const unknown = await backend.execute(context(), {
      method: "finalizeTabs",
      keep: [{ tabId: other.tab.tabId, status: "deliverable" }],
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: "backend_unavailable" },
    });

    // 其它 session 的 tab 不受当前 session finalizeTabs 影响。
    const finalized = await backend.execute(context(), {
      method: "finalizeTabs",
      keep: [{ tabId: owned.tabId, status: "handoff" }],
    });
    expect(finalized.ok).toBe(true);
    const otherList = await backend.execute(context({ sessionId: "session-2" }), {
      method: "list",
    });
    expect(otherList.tabs?.map((tab) => tab.tabId)).toEqual([other.tab.tabId]);
  });

  it("finalizeTabs deliverable releases a user tab without closing Chrome", async () => {
    const { backend, transport } = createBackend();
    const firstClaim = await backend.execute(context(), {
      method: "claimTab",
      tabId: "extuser:41",
    });
    expect(firstClaim).toMatchObject({ error: { code: "authorization_required" } });
    const claim = transport.sent.find((message) => message.type === "claim.request");
    if (!claim || claim.type !== "claim.request") throw new Error("claim.request missing");
    transport.emit({
      type: "claim.decision",
      claimId: claim.claimId,
      nativeTabId: 41,
      decision: "granted",
    } as ExtensionBridgeClientMessage);
    const claimed = await backend.execute(context(), { method: "claimTab", tabId: "extuser:41" });
    if (!claimed.ok || !claimed.tab) throw new Error("user tab was not claimed");
    transport.requests.length = 0;

    const finalized = await backend.execute(context(), {
      method: "finalizeTabs",
      keep: [{ tabId: claimed.tab.tabId, status: "deliverable" }],
    });
    expect(finalized.ok).toBe(true);
    expect(transport.requests.filter((request) => request.type === "debugger.detach")).toHaveLength(
      1,
    );
    expect(transport.requests.filter((request) => request.type === "tabs.close")).toHaveLength(0);
    expect((await backend.execute(context(), { method: "list" })).tabs).toEqual([]);
  });

  it("closeSession closeTabs:true also closes session-owned user tabs", async () => {
    const { backend, transport } = createBackend();
    transport.nextNativeTabId = 60;
    await newTab(backend);
    const firstClaim = await backend.execute(context(), {
      method: "claimTab",
      tabId: "extuser:41",
    });
    expect(firstClaim).toMatchObject({ error: { code: "authorization_required" } });
    const claim = transport.sent.find((message) => message.type === "claim.request");
    if (!claim || claim.type !== "claim.request") throw new Error("claim.request missing");
    transport.emit({
      type: "claim.decision",
      claimId: claim.claimId,
      nativeTabId: 41,
      decision: "granted",
    } as ExtensionBridgeClientMessage);
    await backend.execute(context(), { method: "claimTab", tabId: "extuser:41" });
    transport.requests.length = 0;

    const closed = await backend.execute(context(), { method: "closeSession", closeTabs: true });
    expect(closed.ok).toBe(true);
    expect(transport.requests.filter((request) => request.type === "tabs.close")).toHaveLength(2);
    expect((await backend.execute(context(), { method: "list" })).tabs).toEqual([]);
  });

  it("closes a logical tab after detach and preserves other tabs", async () => {
    const { backend, transport } = createBackend();
    const first = await newTab(backend);
    const second = await newTab(backend);
    const closed = await backend.execute(context(), { method: "close", tabId: first.tabId });
    expect(closed.ok).toBe(true);
    expect(transport.requests.some((request) => request.type === "tabs.close")).toBe(true);
    const list = await backend.execute(context(), { method: "list" });
    expect(list.tabs?.map((tab) => tab.tabId)).toEqual([second.tabId]);
  });
});
