import { describe, expect, it, vi } from "vitest";
import type {
  BackendErrorCode,
  BackendErrorInfo,
  GatewayBackendOptions,
  GatewayBackendState,
} from "@zclaudia/gateway-backend";
import {
  createRemoteGatewayBackend,
  sendRemoteGatewayChannelClose,
  type RemoteGatewayBackendConfig,
  type RemoteGatewayBackendSdkLike,
  type RemoteGatewayChannel,
  type RemoteGatewayChannelHandler,
} from "../src/main/remote-access/remoteGatewayBackend.js";

const COMPLETE_CONFIG: RemoteGatewayBackendConfig = {
  enabled: true,
  gatewayUrl: "https://gateway.example.com/base/",
  namespace: "zcode",
  credential: "zgb_secret-credential",
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function backendError(code: BackendErrorCode): BackendErrorInfo {
  return { code, message: code, occurredAt: 0 };
}

class FakeChannel implements RemoteGatewayChannel {
  readonly channelId: string;
  readonly kind: string;
  isOpen = true;
  readonly sent: string[] = [];
  private readonly closeHandlers = new Set<() => void>();

  constructor(
    channelId = "channel-1",
    kind = "zcode-remote",
    private readonly order?: string[],
  ) {
    this.channelId = channelId;
    this.kind = kind;
  }

  send(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.order?.push("channel.send");
    this.sent.push(text);
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.order?.push("channel.close");
    for (const handler of Array.from(this.closeHandlers)) {
      handler();
    }
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  frames(): unknown[] {
    return this.sent.map((text) => JSON.parse(text));
  }
}

class FakeBackend implements RemoteGatewayBackendSdkLike {
  readonly options: GatewayBackendOptions;
  readonly order: string[];
  readonly events: string[] = [];
  readonly kinds = new Map<string, RemoteGatewayChannelHandler>();
  readonly rejectedOffers: Array<{ kind: string; reason: string }> = [];
  state: GatewayBackendState = "idle";
  lastError: BackendErrorInfo | null = null;
  id = "";
  currentEpoch = 0;
  connectCalls = 0;
  closeCalls = 0;
  connectResult: { backendId: string; epoch: number } = { backendId: "backend-1", epoch: 1 };
  connectError?: BackendErrorInfo;
  connectGate?: Promise<void>;
  private readonly stateHandlers = new Set<(state: GatewayBackendState) => void>();
  private readonly messageHandlers = new Set<(message: Record<string, unknown>) => void>();

  constructor(options: GatewayBackendOptions, order: string[]) {
    this.options = options;
    this.order = order;
  }

  get connectionState(): GatewayBackendState {
    return this.state;
  }

  onState(handler: (state: GatewayBackendState) => void): () => void {
    this.stateHandlers.add(handler);
    this.events.push("onState");
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  onMessage(handler: (message: Record<string, unknown>) => void): () => void {
    this.messageHandlers.add(handler);
    this.events.push("onMessage");
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onChannel(kind: string, handler: RemoteGatewayChannelHandler): void {
    this.events.push(`onChannel:${kind}`);
    this.kinds.set(kind, handler);
  }

  async connect(): Promise<{ backendId: string; epoch: number }> {
    this.connectCalls += 1;
    this.events.push("connect");
    this.order.push("sdk.connect");
    this.setState("connecting");
    if (this.connectGate) {
      await this.connectGate;
    }
    if (this.connectError) {
      this.lastError = this.connectError;
      this.events.push("connect:rejected");
      throw new Error(this.connectError.code);
    }
    this.id = this.connectResult.backendId;
    this.currentEpoch = this.connectResult.epoch;
    this.lastError = null;
    this.setState("connected");
    return this.connectResult;
  }

  close(): void {
    this.closeCalls += 1;
    this.events.push("close");
    this.order.push("sdk.close");
    this.setState("closed");
  }

  emitState(state: GatewayBackendState): void {
    this.setState(state);
  }

  emitMessage(message: Record<string, unknown>): void {
    for (const handler of Array.from(this.messageHandlers)) {
      handler(message);
    }
  }

  offer(kind: string, channel: FakeChannel): boolean {
    const handler = this.kinds.get(kind);
    if (!handler) {
      this.rejectedOffers.push({ kind, reason: "no_handler" });
      return false;
    }
    // 与真实 backend SDK 一致：handler 返回后立即投递后续帧；这里只验证调用是同步的。
    handler(channel, { channelId: channel.channelId, kind });
    return true;
  }

  private setState(state: GatewayBackendState): void {
    this.state = state;
    for (const handler of Array.from(this.stateHandlers)) {
      handler(state);
    }
  }
}

function createHarness(initialConfig: RemoteGatewayBackendConfig = COMPLETE_CONFIG) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const backends: FakeBackend[] = [];
  const order: string[] = [];
  let config = initialConfig;
  const backend = createRemoteGatewayBackend({
    loadConfig: async () => config,
    logger,
    allowInsecureTransport: true,
    createBackend: (options) => {
      const fake = new FakeBackend(options, order);
      backends.push(fake);
      return fake;
    },
  });

  return {
    backend,
    backends,
    logger,
    order,
    setConfig(next: RemoteGatewayBackendConfig) {
      config = next;
    },
  };
}

function loggedText(logger: ReturnType<typeof createHarness>["logger"]): string {
  return JSON.stringify([
    ...logger.debug.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]);
}

describe("createRemoteGatewayBackend", () => {
  it("开关关闭时不建立连接，状态为 disabled", async () => {
    const harness = createHarness({ ...COMPLETE_CONFIG, enabled: false });

    await harness.backend.reloadConfig();

    expect(harness.backends).toHaveLength(0);
    expect(harness.backend.getStatus()).toEqual({ state: "disabled" });
  });

  it("开关打开但配置不完整时进入 error(unconfigured)，不发起连接", async () => {
    const cases: RemoteGatewayBackendConfig[] = [
      { ...COMPLETE_CONFIG, gatewayUrl: "" },
      { ...COMPLETE_CONFIG, gatewayUrl: "not a url" },
      { ...COMPLETE_CONFIG, credential: "" },
    ];

    for (const config of cases) {
      const harness = createHarness(config);
      await harness.backend.reloadConfig();
      expect(harness.backends).toHaveLength(0);
      expect(harness.backend.getStatus()).toEqual({ state: "error", reason: "unconfigured" });
    }
  });

  it("release 形态拒绝 http 地址（error(unconfigured)）", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const createBackend = vi.fn();
    const backend = createRemoteGatewayBackend({
      loadConfig: async () => ({ ...COMPLETE_CONFIG, gatewayUrl: "http://gateway.example.com" }),
      logger,
      allowInsecureTransport: false,
      createBackend,
    });

    await backend.reloadConfig();

    expect(createBackend).not.toHaveBeenCalled();
    expect(backend.getStatus()).toEqual({ state: "error", reason: "unconfigured" });
  });

  it("配置完整时在 connect() 之前注册 zcode-remote kind handler 并自报能力位", async () => {
    const harness = createHarness();

    await harness.backend.reloadConfig();

    expect(harness.backends).toHaveLength(1);
    const fake = harness.backends[0]!;
    expect(fake.options.capabilities).toEqual(["zcode-remote-control"]);
    expect(fake.options.url).toBe("https://gateway.example.com/base");
    expect(fake.options.namespace).toBe("zcode");
    expect(fake.options.credential).toBe("zgb_secret-credential");
    // kind handler、onMessage、onState 都在 connect 之前完成注册（SDK 不缓存帧）。
    expect(fake.events.indexOf("onChannel:zcode-remote")).toBeGreaterThanOrEqual(0);
    expect(fake.events.indexOf("onChannel:zcode-remote")).toBeLessThan(
      fake.events.indexOf("connect"),
    );
    expect(fake.events.indexOf("onMessage")).toBeLessThan(fake.events.indexOf("connect"));
    expect(fake.events.indexOf("onState")).toBeLessThan(fake.events.indexOf("connect"));
    expect(harness.backend.getStatus()).toEqual({
      state: "online",
      backendId: "backend-1",
      epoch: 1,
    });
  });

  it("连接不依赖窗口：只靠配置就能从 disabled 走到 online", async () => {
    const harness = createHarness();
    const statuses: string[] = [];
    harness.backend.onStatusChanged((status) => statuses.push(status.state));

    await harness.backend.reloadConfig();

    expect(statuses).toEqual(["connecting", "online"]);
  });

  it("REPLACED 映射到 error(replaced)", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;

    fake.lastError = backendError("REPLACED");
    fake.emitState("closed");

    expect(harness.backend.getStatus()).toEqual({ state: "error", reason: "replaced" });
    expect(loggedText(harness.logger)).toContain("replaced");
  });

  it("凭证无效映射到 error(credential-invalid)", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const backend = createRemoteGatewayBackend({
      loadConfig: async () => COMPLETE_CONFIG,
      logger,
      allowInsecureTransport: true,
      createBackend: (options) => {
        const fake = new FakeBackend(options, []);
        fake.connectError = backendError("AUTH_FAILED");
        return fake;
      },
    });

    await backend.reloadConfig();

    expect(backend.getStatus()).toEqual({ state: "error", reason: "credential-invalid" });
    expect(loggedText(logger)).toContain("credential invalid");
  });

  it("非 zcode-remote 的 kind 被拒绝（不注册 default handler）", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;
    const delegate = vi.fn();
    harness.backend.setChannelHandler(delegate);

    expect(fake.offer("rpc", new FakeChannel("channel-rpc", "rpc"))).toBe(false);
    expect(fake.rejectedOffers).toEqual([{ kind: "rpc", reason: "no_handler" }]);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("zcode-remote channel 同步交给 device transport；没有 transport 时立即关闭", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;

    const orphan = new FakeChannel("channel-orphan");
    expect(fake.offer("zcode-remote", orphan)).toBe(true);
    expect(orphan.isOpen).toBe(false);
    expect(loggedText(harness.logger)).toContain("no device transport");

    // transport 必须在第一个 await 之前注册 onMessage/onClose；这里只验证同步调用语义。
    let delegatedSynchronously = false;
    const delegate = vi.fn((channel: FakeChannel) => {
      delegatedSynchronously = channel.isOpen;
    });
    harness.backend.setChannelHandler(delegate);
    const channel = new FakeChannel("channel-1");
    expect(fake.offer("zcode-remote", channel)).toBe(true);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate.mock.calls[0]![0]).toBe(channel);
    expect(delegatedSynchronously).toBe(true);
    expect(harness.backend.hasConnectedClient()).toBe(true);
  });

  it("关闭时先发 close{desktop-stopping} 再断开 SDK", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;
    // 让 backend 依次通过 Teardown 的 order 记录观察到 send / close 的顺序。
    fake.order.length = 0;
    harness.backend.setChannelHandler(() => {});
    const channel = new FakeChannel("channel-1", "zcode-remote", fake.order);
    fake.offer("zcode-remote", channel);

    await harness.backend.applyConfig({ ...COMPLETE_CONFIG, enabled: false });

    expect(channel.frames()).toEqual([{ type: "close", reason: "desktop-stopping" }]);
    expect(fake.closeCalls).toBe(1);
    expect(fake.order.indexOf("channel.send")).toBeGreaterThanOrEqual(0);
    expect(fake.order.indexOf("channel.send")).toBeLessThan(fake.order.indexOf("sdk.close"));
    expect(harness.backend.getStatus()).toEqual({ state: "disabled" });
  });

  it("版本不兼容的 close 帧带 upgrade，hello 等待失败由 transport 关闭 channel", () => {
    const channel = new FakeChannel();

    sendRemoteGatewayChannelClose(channel, "incompatible-version", "mobile");
    sendRemoteGatewayChannelClose(channel, "incompatible-version", "desktop");
    sendRemoteGatewayChannelClose(channel, "desktop-stopping");

    expect(channel.frames()).toEqual([
      { type: "close", reason: "incompatible-version", upgrade: "mobile" },
      { type: "close", reason: "incompatible-version", upgrade: "desktop" },
      { type: "close", reason: "desktop-stopping" },
    ]);
    // incompatible-version 必须带 upgrade；缺了会解析失败，不会把错误帧发给手机。
    expect(() => sendRemoteGatewayChannelClose(channel, "incompatible-version")).toThrow();
  });

  it("配置变更串行执行，连续变更合并为最新值", async () => {
    const harness = createHarness();
    const firstGate = createDeferred<void>();
    const firstApply = harness.backend.applyConfig(COMPLETE_CONFIG);
    await vi.waitFor(() => expect(harness.backends).toHaveLength(1));
    const first = harness.backends[0]!;
    first.connectGate = firstGate.promise;

    const secondApply = harness.backend.applyConfig({
      ...COMPLETE_CONFIG,
      gatewayUrl: "https://gateway-b.example.com",
    });
    const thirdApply = harness.backend.applyConfig({
      ...COMPLETE_CONFIG,
      gatewayUrl: "https://gateway-c.example.com",
    });

    firstGate.resolve();
    await Promise.all([firstApply, secondApply, thirdApply]);

    expect(harness.backends).toHaveLength(2);
    expect(harness.backends[1]!.options.url).toBe("https://gateway-c.example.com");
    expect(harness.backends[1]!.connectCalls).toBe(1);
    expect(first.closeCalls).toBe(1);
    expect(harness.backend.getStatus()).toEqual({
      state: "online",
      backendId: "backend-1",
      epoch: 1,
    });
  });

  it("相同配置重复应用不重连（与连接无关的设置变化不触发重连）", async () => {
    const harness = createHarness();

    await harness.backend.reloadConfig();
    await harness.backend.reloadConfig();
    await harness.backend.applyConfig({ ...COMPLETE_CONFIG });

    expect(harness.backends).toHaveLength(1);
    expect(harness.backends[0]!.connectCalls).toBe(1);
    expect(harness.backends[0]!.closeCalls).toBe(0);
  });

  it("连接断开后的自动重连记录 warn，恢复后回到 online", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;

    fake.emitState("connecting");
    expect(harness.backend.getStatus()).toEqual({ state: "connecting" });
    expect(harness.logger.warn).toHaveBeenCalled();

    fake.emitState("connected");
    expect(harness.backend.getStatus()).toEqual({
      state: "online",
      backendId: "backend-1",
      epoch: 1,
    });
  });

  it("从 backend onMessage 读取 channel_closed.reason 并通知监听者", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;
    const closedEvents: Array<{ channelId: string; reason: string }> = [];
    harness.backend.onChannelClosed((info) => closedEvents.push(info));
    harness.backend.setChannelHandler(() => {});
    fake.offer("zcode-remote", new FakeChannel("channel-42"));

    fake.emitMessage({ type: "channel_closed", channelId: "channel-42", reason: "epoch_changed" });

    expect(closedEvents).toEqual([{ channelId: "channel-42", reason: "epoch_changed" }]);
    expect(harness.backend.hasConnectedClient()).toBe(false);
    expect(loggedText(harness.logger)).toContain("epoch_changed");
  });

  it("「测试连接」：表单值与生效值相同时复用连接，不重连", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();

    const result = await harness.backend.testConnection({
      gatewayUrl: COMPLETE_CONFIG.gatewayUrl,
      namespace: COMPLETE_CONFIG.namespace,
      credential: COMPLETE_CONFIG.credential,
    });

    expect(result).toEqual({
      ok: true,
      status: { state: "online", backendId: "backend-1", epoch: 1 },
    });
    expect(harness.backends).toHaveLength(1);
    expect(harness.backends[0]!.closeCalls).toBe(0);
  });

  it("配置读取失败不抛未处理 rejection，也不会拆掉现有连接", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const backends: FakeBackend[] = [];
    let failLoad = false;
    const backend = createRemoteGatewayBackend({
      loadConfig: async () => {
        if (failLoad) {
          throw new Error("credential service unavailable");
        }
        return COMPLETE_CONFIG;
      },
      logger,
      allowInsecureTransport: true,
      createBackend: (options) => {
        const fake = new FakeBackend(options, []);
        backends.push(fake);
        return fake;
      },
    });
    await backend.reloadConfig();

    failLoad = true;
    await expect(backend.reloadConfig()).resolves.toBeUndefined();

    expect(backends).toHaveLength(1);
    expect(backends[0]!.closeCalls).toBe(0);
    expect(backend.getStatus()).toEqual({
      state: "online",
      backendId: "backend-1",
      epoch: 1,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("「测试连接」：不同值先暂停现有连接，测完关闭测试连接并恢复生效配置", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();

    const result = await harness.backend.testConnection({
      gatewayUrl: "https://test.example.com",
      namespace: "zcode",
      credential: "zgb_test-credential",
    });

    expect(result).toEqual({
      ok: true,
      status: { state: "online", backendId: "backend-1", epoch: 1 },
    });
    // 生效连接、测试连接、恢复连接各一个实例。
    expect(harness.backends).toHaveLength(3);
    expect(harness.backends[0]!.closeCalls).toBe(1);
    expect(harness.backends[1]!.options.url).toBe("https://test.example.com");
    expect(harness.backends[1]!.closeCalls).toBe(1);
    expect(harness.backends[2]!.options.url).toBe("https://gateway.example.com/base");
    expect(harness.backend.getStatus()).toEqual({
      state: "online",
      backendId: "backend-1",
      epoch: 1,
    });
  });

  it("「测试连接」：有手机连接时禁用", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;
    harness.backend.setChannelHandler(() => {});
    fake.offer("zcode-remote", new FakeChannel("channel-1"));

    const result = await harness.backend.testConnection({
      gatewayUrl: "https://test.example.com",
      namespace: "zcode",
      credential: "zgb_test-credential",
    });

    expect(result).toEqual({ ok: false, reason: "mobile-connected" });
    expect(harness.backends).toHaveLength(1);
  });

  it("「测试连接」失败时返回映射后的失败原因，并恢复生效配置", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const backends: FakeBackend[] = [];
    let created = 0;
    const backend = createRemoteGatewayBackend({
      loadConfig: async () => COMPLETE_CONFIG,
      logger,
      allowInsecureTransport: true,
      createBackend: (options) => {
        created += 1;
        const fake = new FakeBackend(options, []);
        // 第 2 个实例是「测试连接」，让它握手失败；第 3 个实例负责恢复生效配置。
        if (created === 2) {
          fake.connectError = backendError("AUTH_FAILED");
        }
        backends.push(fake);
        return fake;
      },
    });
    await backend.reloadConfig();

    const result = await backend.testConnection({
      gatewayUrl: "https://test.example.com",
      namespace: "zcode",
      credential: "zgb_test-credential",
    });

    expect(result).toEqual({ ok: false, reason: "credential-invalid" });
    expect(backends).toHaveLength(3);
    expect(backends[1]!.options.url).toBe("https://test.example.com");
    expect(backends[1]!.closeCalls).toBe(1);
    expect(backends[2]!.options.url).toBe("https://gateway.example.com/base");
    // 测试连接失败后仍按生效配置恢复。
    expect(backend.getStatus()).toEqual({
      state: "online",
      backendId: "backend-1",
      epoch: 1,
    });
  });

  it("日志里不出现凭证内容", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    harness.backend.setChannelHandler(() => {});
    harness.backends[0]!.offer("zcode-remote", new FakeChannel());

    await harness.backend.testConnection({
      gatewayUrl: "https://test.example.com",
      namespace: "zcode",
      credential: "zgb_other-secret",
    });
    await harness.backend.applyConfig({ ...COMPLETE_CONFIG, enabled: false });

    const text = loggedText(harness.logger);
    expect(text).not.toContain("zgb_secret-credential");
    expect(text).not.toContain("zgb_other-secret");
  });

  it("dispose 发送 desktop-stopping 并停在 disabled，之后不再重连", async () => {
    const harness = createHarness();
    await harness.backend.reloadConfig();
    const fake = harness.backends[0]!;
    harness.backend.setChannelHandler(() => {});
    const channel = new FakeChannel("channel-1");
    fake.offer("zcode-remote", channel);

    await harness.backend.dispose();

    expect(channel.frames()).toEqual([{ type: "close", reason: "desktop-stopping" }]);
    expect(fake.closeCalls).toBe(1);
    expect(harness.backend.getStatus()).toEqual({ state: "disabled" });

    await harness.backend.reloadConfig();
    expect(harness.backends).toHaveLength(1);
  });
});
