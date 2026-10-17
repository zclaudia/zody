import { afterEach, describe, expect, it } from "vitest";
import type {
  GatewayClientOptions,
  GatewayClientState,
  GatewayDiscoveryBackend,
  SocketFactory,
  WebSocketLike,
} from "@zclaudia/gateway-client";
import type { BackendPresenceV4 } from "@zclaudia/gateway-protocol";
import {
  GATEWAY_TERMINAL_SEND_BUFFERED_AMOUNT_LIMIT_BYTES,
  GatewayTerminalTransport,
  type GatewayTerminalChannelLike,
  type GatewayTerminalClientLike,
  type GatewayTerminalTransportDiagnostic,
  type GatewayTerminalTransportOptions,
  type GatewayTerminalTransportState,
} from "../src/mobile-remote/gatewayTerminalTransport.js";
import type {
  WebRemoteControlAppPayload,
  WebRemoteControlChannelFrame,
  WebRemoteControlFailure,
} from "@zcode/shared";

/**
 * T3.4 方案「验收」第 6 条：用 fake client 覆盖 GatewayTerminalTransport。
 *
 * fake client 通过 transport 注入的 `socketFactory` 创建控制/数据 socket，和真实
 * `@zclaudia/gateway-client` 一样：
 * - 控制连接 URL 以 `/ws` 结尾；
 * - channel 数据连接形如 `/channel/<id>?ticket=…`，gateway 拆除时对数据 socket
 *   `close(1000, reason)`，SDK 的 `onClose` 不带参数。
 * 这样测试覆盖的是 transport 真实使用的「从 socket close 事件取 reason」路径。
 */

type FakeListener = (event: { code?: number; reason?: string; data?: unknown }) => void;

class FakeSocket implements WebSocketLike {
  binaryType = "arraybuffer";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<FakeListener>>();

  constructor(readonly url: string) {}

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: string, listener: FakeListener): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array));
  }

  close(code = 1000, reason = ""): void {
    this.emitClose(code, reason);
  }

  open(): void {
    if (this.readyState === 1) return;
    this.readyState = 1;
    this.emit("open", {});
  }

  emitClose(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  emitMessage(data: string): void {
    this.emit("message", { data });
  }

  emitError(): void {
    this.emit("error", {});
  }

  frames(): WebRemoteControlChannelFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as WebRemoteControlChannelFrame);
  }

  private emit(type: string, event: { code?: number; reason?: string; data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeChannel implements GatewayTerminalChannelLike {
  private readonly messageHandlers = new Set<
    (message: { data: string | Uint8Array; binary: boolean }) => void
  >();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(
    readonly channelId: string,
    readonly socket: FakeSocket,
  ) {
    socket.addEventListener("message", (event) => {
      for (const handler of this.messageHandlers) {
        handler({ data: String(event.data), binary: false });
      }
    });
    socket.addEventListener("close", () => {
      if (this.closed) return;
      this.closed = true;
      for (const handler of this.closeHandlers) handler();
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === 1;
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data);
  }

  onMessage(
    handler: (message: { data: string | Uint8Array; binary: boolean }) => void,
  ): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    this.socket.close(1000);
  }
}

class FakeGatewayClient implements GatewayTerminalClientLike {
  readonly registry: BackendPresenceV4[] = [];
  readonly openChannelCalls: { target: string; kind?: string }[] = [];
  readonly channelSockets: FakeSocket[] = [];
  connectionState: GatewayClientState = "idle";
  connectCalls = 0;
  closeCalls = 0;
  discoverCalls = 0;
  connectImpl?: () => Promise<void>;
  openChannelImpl?: (target: string, kind?: string) => Promise<GatewayTerminalChannelLike>;
  discoverImpl?: () => Promise<GatewayDiscoveryBackend[]>;

  private readonly createSocket: SocketFactory;
  private readonly wsBase: string;
  private readonly stateHandlers = new Set<(state: GatewayClientState) => void>();
  private readonly registryHandlers = new Set<(items: BackendPresenceV4[]) => void>();
  private readonly channels: FakeChannel[] = [];
  private channelSequence = 0;
  controlSocket?: FakeSocket;

  constructor(options: GatewayClientOptions) {
    this.createSocket = options.socketFactory!;
    this.wsBase = options.url.replace(/^http/, "ws").replace(/\/+$/, "");
  }

  onState(handler: (state: GatewayClientState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onRegistry(handler: (items: BackendPresenceV4[]) => void): () => void {
    this.registryHandlers.add(handler);
    return () => this.registryHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectImpl) {
      return this.connectImpl();
    }
    await this.bringControlOnline();
  }

  close(): void {
    this.closeCalls += 1;
    for (const channel of this.channels.splice(0)) {
      channel.close();
    }
    this.controlSocket?.close(1000);
    this.controlSocket = undefined;
    this.setState("closed");
  }

  async openChannel(target: string, kind?: string): Promise<GatewayTerminalChannelLike> {
    this.openChannelCalls.push({ target, kind });
    if (this.openChannelImpl) {
      return this.openChannelImpl(target, kind);
    }
    this.channelSequence += 1;
    const socket = this.createSocket(
      `${this.wsBase}/channel/ch-${this.channelSequence}?ticket=ticket`,
    ) as FakeSocket;
    this.channelSockets.push(socket);
    socket.open();
    const channel = new FakeChannel(`ch-${this.channelSequence}`, socket);
    this.channels.push(channel);
    return channel;
  }

  async discoverBackends(): Promise<GatewayDiscoveryBackend[]> {
    this.discoverCalls += 1;
    if (this.discoverImpl) {
      return this.discoverImpl();
    }
    return [];
  }

  async bringControlOnline(): Promise<void> {
    this.setState("connecting");
    this.controlSocket = this.createSocket(`${this.wsBase}/ws`) as FakeSocket;
    this.controlSocket.open();
    this.setState("connected");
    for (const handler of this.registryHandlers) handler([...this.registry]);
  }

  emitControlClose(code = 1006, reason = ""): void {
    this.controlSocket?.emitClose(code, reason);
    for (const channel of this.channels.splice(0)) channel.close();
    this.setState("connecting");
  }

  emitRegistry(items: BackendPresenceV4[]): void {
    this.registry.splice(0, this.registry.length, ...items);
    for (const handler of this.registryHandlers) handler([...items]);
  }

  emitChannelMessage(frame: unknown): void {
    const socket = this.channelSockets.at(-1);
    if (!socket) throw new Error("no channel socket");
    socket.emitMessage(JSON.stringify(frame));
  }

  lastChannelSocket(): FakeSocket {
    const socket = this.channelSockets.at(-1);
    if (!socket) throw new Error("no channel socket");
    return socket;
  }

  lastChannelFrames(): WebRemoteControlChannelFrame[] {
    return this.lastChannelSocket().frames();
  }

  private setState(state: GatewayClientState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}

function presence(overrides: Partial<BackendPresenceV4> = {}): BackendPresenceV4 {
  return {
    namespace: "zcode",
    backendId: "backend-1",
    instanceId: "instance-1",
    deviceId: "device-1",
    name: "MacBook",
    channel: "control",
    visible: true,
    capabilities: ["zcode-remote-control"],
    backendProtocolVersion: 4,
    epoch: 1,
    connectedAt: 1,
    lastSeenAt: 1,
    ...overrides,
  };
}

function waitUntil(
  assertion: () => boolean,
  timeoutMs = 2_000,
  label = "assertion",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (assertion()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 2);
    };
    tick();
  });
}

interface Harness {
  transport: GatewayTerminalTransport;
  client: FakeGatewayClient;
  states: GatewayTerminalTransportState[];
  failures: WebRemoteControlFailure[];
  payloads: WebRemoteControlAppPayload[];
  diagnostics: GatewayTerminalTransportDiagnostic[];
  errors: Error[];
  faults: string[];
  sendReadyCount: number;
  now: { ms: number };
  options: GatewayTerminalTransportOptions;
}

const activeTransports: GatewayTerminalTransport[] = [];

function createHarness(overrides: Partial<GatewayTerminalTransportOptions> = {}): Harness {
  const states: GatewayTerminalTransportState[] = [];
  const failures: WebRemoteControlFailure[] = [];
  const payloads: WebRemoteControlAppPayload[] = [];
  const diagnostics: GatewayTerminalTransportDiagnostic[] = [];
  const errors: Error[] = [];
  const faults: string[] = [];
  const now = { ms: 1_000_000 };
  const counters = { sendReady: 0 };
  let client: FakeGatewayClient | undefined;
  const harness: Harness = {
    transport: undefined as unknown as GatewayTerminalTransport,
    client: undefined as unknown as FakeGatewayClient,
    states,
    failures,
    payloads,
    diagnostics,
    errors,
    faults,
    sendReadyCount: 0,
    now,
    options: {},
  };
  const options: GatewayTerminalTransportOptions = {
    gatewayUrl: "http://gateway.test",
    namespace: "zcode",
    credential: "zgd_test_credential",
    backendId: "backend-1",
    clientInstanceId: "client-instance-1",
    clientName: "test-phone",
    appVersion: "1.0.0",
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    desktopOfflineGraceMs: 60_000,
    gatewayUnreachableTimeoutMs: 30_000,
    credentialReverifyMinIntervalMs: 30_000,
    heartbeatIntervalMs: 1_000,
    helloAckTimeoutMs: 1_000,
    now: () => now.ms,
    socketFactory: (url) => new FakeSocket(url),
    createClient: (sdkOptions) => {
      client = new FakeGatewayClient(sdkOptions);
      return client;
    },
    onPayload: (payload) => payloads.push(payload),
    onRawTransportPayload: () => false,
    onRawTransportFault: (reasonCode) => faults.push(reasonCode),
    onStateChange: (state) => states.push(state),
    onFailure: (failure) => failures.push(failure),
    onError: (error) => errors.push(error),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onSendReady: () => {
      counters.sendReady += 1;
      harness.sendReadyCount = counters.sendReady;
    },
    ...overrides,
  };
  const transport = new GatewayTerminalTransport(options);
  harness.transport = transport;
  harness.client = client!;
  harness.options = options;
  activeTransports.push(transport);
  // 让 overrides 在构造后仍可读取实际生效的 fake client。
  if (!harness.client) throw new Error("fake client was not created");
  return harness;
}

async function startReady(harness: Harness): Promise<FakeSocket> {
  harness.client.registry.splice(0, harness.client.registry.length, presence());
  harness.transport.start();
  await waitUntil(() => harness.client.openChannelCalls.length === 1, 2_000, "first channel");
  const socket = harness.client.lastChannelSocket();
  await waitUntil(() => socket.sent.length >= 1, 2_000, "hello frame");
  harness.client.emitChannelMessage({
    type: "hello_ack",
    appProtocol: 2,
    desktopAppVersion: "1.5.0",
  });
  await waitUntil(() => harness.states.includes("ready"), 2_000, "ready state");
  return socket;
}

afterEach(() => {
  for (const transport of activeTransports.splice(0)) {
    transport.dispose();
  }
});

describe("GatewayTerminalTransport", () => {
  it("在 connect 前注册状态/registry，并在控制连接重连后重新打开 channel", async () => {
    const harness = createHarness();
    const socket = await startReady(harness);

    expect(harness.client.openChannelCalls[0]).toEqual({
      target: "backend-1",
      kind: "zcode-remote",
    });
    expect(socket.frames()[0]).toEqual({
      type: "hello",
      protocolVersion: 1,
      appProtocol: { min: 1, max: 2 },
      clientInstanceId: "client-instance-1",
      clientName: "test-phone",
      appVersion: "1.0.0",
    });
    expect(harness.sendReadyCount).toBe(1);

    harness.client.emitControlClose(1006, "");
    await waitUntil(() => harness.states.includes("reconnecting"), 2_000, "reconnecting");
    await harness.client.bringControlOnline();
    await waitUntil(() => harness.client.openChannelCalls.length === 2, 2_000, "second channel");

    const secondSocket = harness.client.lastChannelSocket();
    expect(secondSocket).not.toBe(socket);
    harness.client.emitChannelMessage({
      type: "hello_ack",
      appProtocol: 2,
      desktopAppVersion: "1.5.0",
    });
    await waitUntil(() => harness.sendReadyCount === 2, 2_000, "second send-ready");
    expect(harness.states.at(-1)).toBe("ready");
  });

  it.each(["backend_offline", "epoch_changed", "timeout"] as const)(
    "数据 socket 以 %s 关闭时先进入宽限，超过 60 秒后进入 desktop-disconnected，registry 恢复后自动重连",
    async (reason) => {
      const harness = createHarness({ desktopOfflineGraceMs: 20 });
      const socket = await startReady(harness);

      // 模拟电脑下线：registry 里没有该 backend，重开 channel 需要等 registry 恢复。
      harness.client.emitRegistry([]);
      socket.emitClose(1000, reason);
      await waitUntil(() => harness.states.includes("reconnecting"), 2_000, "reconnecting");
      await waitUntil(() => harness.failures.length === 1, 2_000, "grace failure");
      expect(harness.failures[0]).toMatchObject({ reason: "desktop-disconnected" });
      expect(harness.failures[0]?.message).toContain(reason);

      harness.client.emitRegistry([presence()]);
      await waitUntil(() => harness.client.openChannelCalls.length === 2, 2_000, "auto reopen");
      harness.client.emitChannelMessage({
        type: "hello_ack",
        appProtocol: 2,
        desktopAppVersion: "1.5.0",
      });
      await waitUntil(() => harness.states.at(-1) === "ready", 2_000, "auto ready");
    },
  );

  it("1006 或空 reason 按本地网络中断处理（可恢复，不进入 backend-unsupported）", async () => {
    const harness = createHarness({ desktopOfflineGraceMs: 20 });
    const socket = await startReady(harness);

    socket.emitClose(1006, "");
    await waitUntil(() => harness.failures.length === 1, 2_000, "grace failure");
    expect(harness.failures[0]).toMatchObject({ reason: "desktop-disconnected" });
    expect(harness.failures.some((failure) => failure.reason === "backend-unsupported")).toBe(
      false,
    );

    harness.client.emitRegistry([presence()]);
    await waitUntil(() => harness.client.openChannelCalls.length === 2, 2_000, "reopen");
  });

  it("registry 显示电脑在线但没有能力位时进入 backend-unsupported，不发起 channel、不自动重试", async () => {
    const harness = createHarness();
    harness.client.registry.splice(
      0,
      harness.client.registry.length,
      presence({ capabilities: [] }),
    );

    harness.transport.start();
    await waitUntil(() => harness.failures.length === 1, 2_000, "backend-unsupported");
    expect(harness.failures[0]).toMatchObject({ reason: "backend-unsupported" });
    expect(harness.client.openChannelCalls).toHaveLength(0);
    expect(harness.states.at(-1)).toBe("error");

    // 即使 registry 随后报告能力位，终态也不会自动重开 channel。
    harness.client.emitRegistry([presence()]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.client.openChannelCalls).toHaveLength(0);
  });

  it("channel 被 reject 时按退避重试，连续 3 次后显示可重试错误，手动 recover 后恢复", async () => {
    const harness = createHarness();
    await startReady(harness);

    harness.client.lastChannelSocket().emitClose(1000, "rejected");
    await waitUntil(() => harness.client.openChannelCalls.length === 2, 2_000, "retry 2");
    harness.client.lastChannelSocket().emitClose(1000, "rejected");
    await waitUntil(() => harness.client.openChannelCalls.length === 3, 2_000, "retry 3");
    harness.client.lastChannelSocket().emitClose(1000, "rejected");

    await waitUntil(() => harness.failures.length === 1, 2_000, "retry exhausted");
    expect(harness.failures[0]).toMatchObject({ reason: "desktop-disconnected" });
    expect(harness.states.at(-1)).toBe("error");
    const attemptsAfterExhaustion = harness.client.openChannelCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.client.openChannelCalls.length).toBe(attemptsAfterExhaustion);

    const recovery = harness.transport.recoverConnection(2_000);
    await waitUntil(
      () => harness.client.openChannelCalls.length === attemptsAfterExhaustion + 1,
      2_000,
      "manual retry",
    );
    harness.client.emitChannelMessage({
      type: "hello_ack",
      appProtocol: 2,
      desktopAppVersion: "1.5.0",
    });
    await recovery;
    expect(harness.states.at(-1)).toBe("ready");
  });

  it("数据 socket 在 hello_ack 前被 terminate 时也按拨号失败重试", async () => {
    const harness = createHarness();
    harness.client.registry.splice(0, harness.client.registry.length, presence());
    harness.transport.start();
    await waitUntil(() => harness.client.openChannelCalls.length === 1, 2_000, "first channel");

    harness.client.lastChannelSocket().emitClose(1006, "");
    await waitUntil(
      () => harness.client.openChannelCalls.length === 2,
      2_000,
      "retry after terminate",
    );
  });

  it("首次 connect 被 UNAUTHORIZED 拒绝时进入 gateway-credential-invalid", async () => {
    const harness = createHarness();
    harness.client.connectImpl = async () => {
      throw new Error("UNAUTHORIZED: bad credential");
    };

    harness.transport.start();
    await waitUntil(() => harness.failures.length === 1, 2_000, "credential failure");
    expect(harness.failures[0]).toMatchObject({ reason: "gateway-credential-invalid" });
    expect(harness.client.connectCalls).toBe(1);
    expect(harness.states.at(-1)).toBe("error");
  });

  it("每次控制连接关闭最多复核一次、间隔至少 30 秒；429 和网络错误按可恢复处理", async () => {
    const harness = createHarness();
    await startReady(harness);

    harness.client.discoverImpl = async () => {
      throw new Error("discoverBackends failed: HTTP 429");
    };
    const reverifyOutcomes = () =>
      harness.diagnostics
        .filter((entry) => entry.type === "credential-reverify")
        .map((entry) => (entry as { outcome: string }).outcome);

    harness.client.emitControlClose(1008, "");
    await waitUntil(() => reverifyOutcomes().length === 1, 2_000, "first reverify");
    expect(harness.client.discoverCalls).toBe(1);
    expect(
      harness.failures.some((failure) => failure.reason === "gateway-credential-invalid"),
    ).toBe(false);

    // 同一关闭窗口内的第二次复核被 in-flight/间隔闸门挡住。
    await harness.client.bringControlOnline();
    harness.client.emitControlClose(1008, "");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.client.discoverCalls).toBe(1);
    expect(reverifyOutcomes()).toHaveLength(1);

    harness.now.ms += 31_000;
    await harness.client.bringControlOnline();
    harness.client.emitControlClose(1008, "");
    await waitUntil(() => reverifyOutcomes().length === 2, 2_000, "second reverify");
    expect(harness.client.discoverCalls).toBe(2);
    expect(
      harness.failures.some((failure) => failure.reason === "gateway-credential-invalid"),
    ).toBe(false);

    harness.client.discoverImpl = async () => {
      throw new Error("network unavailable");
    };
    harness.now.ms += 31_000;
    await harness.client.bringControlOnline();
    harness.client.emitControlClose(1008, "");
    await waitUntil(() => reverifyOutcomes().length === 3, 2_000, "network reverify");
    expect(reverifyOutcomes().at(-1)).toBe("unreachable");
    expect(
      harness.failures.some((failure) => failure.reason === "gateway-credential-invalid"),
    ).toBe(false);
  });

  it("关闭后复核得到 401/403 才进入 gateway-credential-invalid；仅 1008 而复核成功时按可恢复处理", async () => {
    const harness = createHarness();
    await startReady(harness);

    harness.client.emitControlClose(1008, "");
    await waitUntil(() => harness.client.discoverCalls === 1, 2_000, "authorized reverify");
    expect(harness.failures).toHaveLength(0);

    harness.client.discoverImpl = async () => {
      throw new Error("discoverBackends failed: HTTP 403");
    };
    harness.now.ms += 31_000;
    await harness.client.bringControlOnline();
    harness.client.emitControlClose(1008, "");
    await waitUntil(
      () => harness.failures.some((failure) => failure.reason === "gateway-credential-invalid"),
      2_000,
      "credential invalid",
    );
    expect(harness.states.at(-1)).toBe("error");
  });

  it("收到 close{superseded} 时回 close_ack 并锁住自动重连", async () => {
    const harness = createHarness();
    const socket = await startReady(harness);

    harness.client.emitChannelMessage({ type: "close", reason: "superseded" });
    await waitUntil(() => harness.failures.length === 1, 2_000, "session conflict");
    expect(harness.failures[0]).toMatchObject({ reason: "session-conflict" });
    expect(socket.frames()).toContainEqual({ type: "close_ack" });
    expect(harness.states.at(-1)).toBe("error");

    await harness.client.bringControlOnline();
    harness.client.emitRegistry([presence()]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.client.openChannelCalls).toHaveLength(1);

    const recovery = harness.transport.recoverConnection(2_000);
    await waitUntil(() => harness.client.openChannelCalls.length === 2, 2_000, "manual reconnect");
    harness.client.emitChannelMessage({
      type: "hello_ack",
      appProtocol: 2,
      desktopAppVersion: "1.5.0",
    });
    await recovery;
    expect(harness.states.at(-1)).toBe("ready");
  });

  it("收到 close{incompatible-version} 时把 upgrade 交给上层", async () => {
    const harness = createHarness();
    await startReady(harness);

    harness.client.emitChannelMessage({
      type: "close",
      reason: "incompatible-version",
      upgrade: "desktop",
    });
    await waitUntil(() => harness.failures.length === 1, 2_000, "incompatible failure");
    expect(harness.failures[0]).toMatchObject({
      reason: "incompatible-version",
      upgrade: "desktop",
    });
  });

  it("hello_ack 协商出支持范围外的版本时回 close{incompatible-version} 并进入终态", async () => {
    const harness = createHarness();
    harness.client.registry.splice(0, harness.client.registry.length, presence());
    harness.transport.start();
    await waitUntil(() => harness.client.openChannelCalls.length === 1, 2_000, "first channel");

    harness.client.emitChannelMessage({
      type: "hello_ack",
      appProtocol: 99,
      desktopAppVersion: "9.0.0",
    });
    await waitUntil(() => harness.failures.length === 1, 2_000, "incompatible failure");
    expect(harness.failures[0]).toMatchObject({
      reason: "incompatible-version",
      upgrade: "mobile",
    });
    expect(harness.client.lastChannelFrames()).toContainEqual({
      type: "close",
      reason: "incompatible-version",
      upgrade: "mobile",
    });
  });

  it("按协商版本丢弃越界 payload 并回 protocol_error，不改变连接状态", async () => {
    const harness = createHarness();
    harness.client.registry.splice(0, harness.client.registry.length, presence());
    harness.transport.start();
    await waitUntil(() => harness.client.openChannelCalls.length === 1, 2_000, "first channel");
    harness.client.emitChannelMessage({
      type: "hello_ack",
      appProtocol: 1,
      desktopAppVersion: "1.4.0",
    });
    await waitUntil(() => harness.states.includes("ready"), 2_000, "ready");

    harness.client.emitChannelMessage({
      type: "data",
      payload: {
        zcode_type: "recent-projects-updated",
        result: { desktopWindowState: "open", recentProjects: [] },
      },
    });
    await waitUntil(
      () => harness.client.lastChannelFrames().some((frame) => frame.type === "protocol_error"),
      2_000,
      "protocol error",
    );
    expect(harness.payloads).toHaveLength(0);
    expect(harness.states.at(-1)).toBe("ready");

    harness.client.emitChannelMessage({
      type: "data",
      payload: {
        zcode_type: "app-error",
        reason: "unexpected-error",
        error: "still delivered",
      },
    });
    await waitUntil(() => harness.payloads.length === 1, 2_000, "v1 payload delivered");
    expect(harness.states.at(-1)).toBe("ready");
  });

  it("心跳：没有入站帧超过 45 秒判定 channel 已死并进入可恢复分支", async () => {
    const harness = createHarness({
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 20,
      desktopOfflineGraceMs: 10,
      now: () => Date.now(),
    });
    const socket = await startReady(harness);

    await waitUntil(
      () => socket.frames().some((frame) => frame.type === "ping"),
      2_000,
      "ping frame",
    );
    await waitUntil(() => harness.failures.length === 1, 2_000, "heartbeat failure");
    expect(harness.failures[0]).toMatchObject({ reason: "desktop-disconnected" });
  });

  it("sendPayloadResult：未 ready、背压、超限和正常发送", async () => {
    const harness = createHarness();
    const payload: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "hello",
    };

    expect(harness.transport.sendPayloadResult(payload)).toEqual({ kind: "unavailable" });
    expect(harness.transport.sendPayload(payload)).toBe(false);

    const socket = await startReady(harness);
    socket.bufferedAmount = GATEWAY_TERMINAL_SEND_BUFFERED_AMOUNT_LIMIT_BYTES + 1;
    expect(harness.transport.sendPayloadResult(payload)).toEqual({ kind: "unavailable" });
    const framesBefore = socket.frames().length;
    expect(socket.frames().length).toBe(framesBefore);

    socket.bufferedAmount = 0;
    const result = harness.transport.sendPayloadResult(payload);
    expect(result).toEqual({ kind: "sent", bytes: harness.transport.measurePayloadBytes(payload) });
    expect(harness.transport.sendPayload(payload)).toBe(true);

    const oversize: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(2 * 1024 * 1024),
    };
    expect(harness.transport.sendPayloadResult(oversize)).toMatchObject({ kind: "oversize" });
  });

  it("控制连接持续失败超过 30 秒进入 gateway-unreachable，之后仍自动重试", async () => {
    const harness = createHarness({ gatewayUnreachableTimeoutMs: 15 });
    harness.client.registry.splice(0, harness.client.registry.length, presence());
    let attempts = 0;
    harness.client.connectImpl = async () => {
      attempts += 1;
      throw new Error("network down");
    };

    harness.transport.start();
    await waitUntil(() => harness.failures.length === 1, 2_000, "gateway unreachable");
    expect(harness.failures[0]).toMatchObject({ reason: "gateway-unreachable" });
    expect(attempts).toBeGreaterThanOrEqual(1);
    await waitUntil(() => attempts >= 2, 2_000, "connect retry");

    harness.client.connectImpl = undefined;
    await waitUntil(() => harness.client.openChannelCalls.length === 1, 2_000, "recovered channel");
    expect(harness.states.at(-1)).not.toBe("error");
  });

  it("close{desktop-stopping} 走可恢复的 desktop-disconnected，而不是终态", async () => {
    const harness = createHarness({ desktopOfflineGraceMs: 15 });
    await startReady(harness);

    harness.client.emitChannelMessage({ type: "close", reason: "desktop-stopping" });
    expect(harness.failures).toHaveLength(0);
    await waitUntil(() => harness.failures.length === 1, 2_000, "desktop disconnected");
    expect(harness.failures[0]).toMatchObject({ reason: "desktop-disconnected" });
    expect(harness.states.at(-1)).not.toBe("error");
  });
});
