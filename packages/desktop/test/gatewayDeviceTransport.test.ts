import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
  WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
  WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import {
  createGatewayDeviceTransport,
  WEB_REMOTE_CONTROL_CHANNEL_MAX_BUFFERED_BYTES,
} from "../src/main/remote-access/gatewayDeviceTransport.js";
import type {
  GatewayDeviceSocket,
  GatewayDeviceSocketFactory,
  GatewayDeviceTransportDependencies,
} from "../src/main/remote-access/gatewayDeviceTransportTypes.js";
import type {
  RemoteGatewayChannel,
  RemoteGatewayChannelMessage,
} from "../src/main/remote-access/remoteGatewayBackendTypes.js";

class FakeSocket {
  binaryType = "arraybuffer";
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener as (event: unknown) => void);
    this.listeners.set(type, handlers);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(
      typeof data === "string"
        ? data
        : new TextDecoder().decode(
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          ),
    );
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const handler of Array.from(this.listeners.get("close") ?? [])) {
      handler({ code: 1000, reason: "" });
    }
  }

  emit(type: string, event: unknown): void {
    for (const handler of Array.from(this.listeners.get(type) ?? [])) {
      handler(event);
    }
  }
}

class FakeChannel implements RemoteGatewayChannel {
  readonly kind = "zcode-remote";
  isOpen = true;
  readonly sent: string[] = [];
  private readonly messageHandlers = new Set<(message: RemoteGatewayChannelMessage) => void>();
  private readonly closeHandlers = new Set<() => void>();

  constructor(readonly channelId: string) {}

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const handler of Array.from(this.closeHandlers)) {
      handler();
    }
  }

  onMessage(handler: (message: RemoteGatewayChannelMessage) => void): () => void {
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

  hasMessageHandler(): boolean {
    return this.messageHandlers.size > 0;
  }

  deliver(frame: unknown): void {
    const text = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const handler of Array.from(this.messageHandlers)) {
      handler({ data: text, binary: false });
    }
  }

  frames(): Array<Record<string, any>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, any>);
  }
}

function hello(
  clientInstanceId = "client-1",
  appProtocol = {
    min: 1,
    max: WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
  },
) {
  return {
    type: "hello",
    protocolVersion: WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
    appProtocol,
    clientInstanceId,
    clientName: "Phone",
    appVersion: "1.0.0",
  };
}

function dataFrame(payload: unknown) {
  return { type: "data", payload };
}

function createHarness(
  overrides: Partial<GatewayDeviceTransportDependencies> = {},
  sessionOptions: { session: boolean } = { session: true },
) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const transport = createGatewayDeviceTransport({
    logger,
    desktopAppVersion: "9.9.9",
    createSocket: ((url: string) => {
      socketUrls.push(url);
      return new FakeSocket() as unknown as GatewayDeviceSocket;
    }) as GatewayDeviceSocketFactory,
    ...overrides,
  });
  const socketUrls: string[] = [];
  const states: string[] = [];
  const payloads: WebRemoteControlAppPayload[] = [];
  const sendReady = vi.fn();
  const rawFault = vi.fn();
  const session = transport.createSession({
    onStateChange: (state) => states.push(state),
    onPayload: (payload) => payloads.push(payload),
    onRawTransportFault: rawFault,
    onSendReady: sendReady,
  });
  if (sessionOptions.session) {
    session.start();
  }
  return { transport, session, logger, states, payloads, sendReady, rawFault, socketUrls };
}

function attachClient(
  harness: ReturnType<typeof createHarness>,
  options: {
    channelId?: string;
    clientInstanceId?: string;
    appProtocol?: { min: number; max: number };
    startSession?: boolean;
  } = {},
) {
  const channelId = options.channelId ?? "channel-1";
  const socket = harness.transport.socketFactory(
    `wss://gateway.test/channel/${channelId}?ticket=ticket-1`,
  ) as unknown as FakeSocket;
  const channel = new FakeChannel(channelId);
  harness.transport.handleChannel(channel, { channelId, kind: "zcode-remote" });
  channel.deliver(hello(options.clientInstanceId, options.appProtocol));
  return { channel, socket };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GatewayDeviceTransport", () => {
  it("registers onMessage synchronously and accepts a hello delivered immediately", () => {
    const harness = createHarness();
    const channel = new FakeChannel("channel-sync");

    harness.transport.handleChannel(channel, { channelId: "channel-sync", kind: "zcode-remote" });
    // handler 返回时必须已经注册好回调：SDK 不缓存帧，hello 可能紧跟着到达。
    expect(channel.hasMessageHandler()).toBe(true);
    channel.deliver(hello());

    expect(channel.frames()).toContainEqual({
      type: "hello_ack",
      appProtocol: WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
      desktopAppVersion: "9.9.9",
    });
    expect(harness.states).toEqual(["waiting_terminal", "paired"]);
    expect(harness.sendReady).toHaveBeenCalledWith({ kind: "same-socket" });
  });

  it("negotiates the highest common appProtocol with the mobile range", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness, { appProtocol: { min: 1, max: 3 } });

    expect(channel.frames()).toContainEqual(
      expect.objectContaining({ type: "hello_ack", appProtocol: 2 }),
    );
  });

  it("rejects a protocolVersion mismatch with close{incompatible-version}", () => {
    const harness = createHarness();
    const channel = new FakeChannel("channel-version");
    harness.transport.handleChannel(channel, {
      channelId: "channel-version",
      kind: "zcode-remote",
    });
    channel.deliver({
      ...hello(),
      protocolVersion: WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION + 1,
    });

    expect(channel.frames()).toEqual([
      { type: "close", reason: "incompatible-version", upgrade: "desktop" },
    ]);
    expect(channel.isOpen).toBe(false);
    expect(harness.states).toEqual(["waiting_terminal"]);
  });

  it("points upgrade at the mobile app when the mobile max is below the desktop min", () => {
    const harness = createHarness({ appProtocolRange: { min: 2, max: 2 } });
    const { channel } = attachClient(harness, { appProtocol: { min: 1, max: 1 } });

    expect(channel.frames()).toEqual([
      { type: "close", reason: "incompatible-version", upgrade: "mobile" },
    ]);
    expect(channel.isOpen).toBe(false);
  });

  it("points upgrade at the desktop when the mobile min is above the desktop max", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness, { appProtocol: { min: 5, max: 6 } });

    expect(channel.frames()).toEqual([
      { type: "close", reason: "incompatible-version", upgrade: "desktop" },
    ]);
    expect(channel.isOpen).toBe(false);
  });

  it("closes a channel that does not send hello within the timeout", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const channel = new FakeChannel("channel-silent");
    harness.transport.handleChannel(channel, { channelId: "channel-silent", kind: "zcode-remote" });

    vi.advanceTimersByTime(WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS - 1);
    expect(channel.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(channel.isOpen).toBe(false);
    expect(harness.states).toEqual(["waiting_terminal"]);
  });

  it("sends close{superseded} to a different client and attaches the new channel before the ack", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = attachClient(harness, { channelId: "channel-1", clientInstanceId: "client-a" });
    first.channel.sent.length = 0;

    const second = attachClient(harness, { channelId: "channel-2", clientInstanceId: "client-b" });

    expect(first.channel.frames()).toEqual([{ type: "close", reason: "superseded" }]);
    expect(second.channel.frames()).toContainEqual(expect.objectContaining({ type: "hello_ack" }));
    // 新 channel 的 hello_ack / onSendReady 不等旧 channel 确认。
    expect(first.channel.isOpen).toBe(true);
    expect(harness.sendReady).toHaveBeenLastCalledWith({ kind: "reconnected-socket" });
    expect(harness.states).toEqual(["waiting_terminal", "paired", "paired"]);
  });

  it("silently replaces the same clientInstanceId without a superseded close", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = attachClient(harness, { channelId: "channel-1", clientInstanceId: "client-a" });
    first.channel.sent.length = 0;

    const second = attachClient(harness, { channelId: "channel-2", clientInstanceId: "client-a" });

    expect(first.channel.frames()).toEqual([]);
    await Promise.resolve();
    expect(first.channel.isOpen).toBe(false);
    expect(second.channel.isOpen).toBe(true);
  });

  it("closes the superseded channel after close_ack", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = attachClient(harness, { channelId: "channel-1", clientInstanceId: "client-a" });
    attachClient(harness, { channelId: "channel-2", clientInstanceId: "client-b" });

    expect(first.channel.isOpen).toBe(true);
    first.channel.deliver({ type: "close_ack" });
    expect(first.channel.isOpen).toBe(false);
  });

  it("force-closes the superseded channel after 2 seconds when close_ack is dropped", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = attachClient(harness, { channelId: "channel-1", clientInstanceId: "client-a" });
    const second = attachClient(harness, { channelId: "channel-2", clientInstanceId: "client-b" });

    vi.advanceTimersByTime(WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS - 1);
    expect(first.channel.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first.channel.isOpen).toBe(false);
    // 兜底关闭只影响旧 channel。
    expect(second.channel.isOpen).toBe(true);
  });

  it("drops every inbound frame except close_ack while a channel is closing", () => {
    const harness = createHarness();
    const first = attachClient(harness, { channelId: "channel-1", clientInstanceId: "client-a" });
    const second = attachClient(harness, { channelId: "channel-2", clientInstanceId: "client-b" });
    first.channel.sent.length = 0;
    const payloadCount = harness.payloads.length;

    first.channel.deliver(dataFrame({ zcode_type: "bootstrap-request", requestId: "req-1" }));
    first.channel.deliver(
      dataFrame({
        zcode_type: "workspace-open-request",
        requestId: "req-2",
        recentProjectId: "project-1",
      }),
    );
    first.channel.deliver(
      dataFrame({
        zcode_type: "platform-request",
        requestId: "req-3",
        method: "isDockerAvailable",
        args: undefined,
      }),
    );

    expect(harness.payloads).toHaveLength(payloadCount);
    expect(first.channel.frames()).toEqual([]);
    // 新 channel 不受旧 channel 的 closing 影响。
    expect(second.channel.isOpen).toBe(true);
  });

  it("sends outbound data only to the new channel after replacement", () => {
    const harness = createHarness();
    const first = attachClient(harness, { channelId: "channel-1", clientInstanceId: "client-a" });
    const second = attachClient(harness, { channelId: "channel-2", clientInstanceId: "client-b" });
    first.channel.sent.length = 0;
    second.channel.sent.length = 0;

    const result = harness.session.sendPayloadResult({
      zcode_type: "workspace-list-request",
      requestId: "req-outbound",
    });

    expect(result.kind).toBe("sent");
    expect(second.channel.frames()).toEqual([
      {
        type: "data",
        payload: { zcode_type: "workspace-list-request", requestId: "req-outbound" },
      },
    ]);
    expect(first.channel.frames()).toEqual([]);
  });

  it("returns to waiting when the gateway reports the channel closed", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness);

    harness.transport.handleGatewayChannelClosed({
      channelId: channel.channelId,
      reason: "epoch_changed",
    });

    expect(harness.states.at(-1)).toBe("waiting_terminal");
    expect(
      harness.session.sendPayloadResult({
        zcode_type: "workspace-list-request",
        requestId: "after-close",
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("closes the channel when the mobile sends close{client-leaving}", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness);

    channel.deliver({ type: "close", reason: "client-leaving" });

    expect(channel.isOpen).toBe(false);
    expect(harness.states.at(-1)).toBe("waiting_terminal");
  });

  it("sends a ping every 15 seconds and closes after 45 seconds without inbound frames", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const { channel } = attachClient(harness);
    channel.sent.length = 0;

    vi.advanceTimersByTime(WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS);
    expect(channel.frames().filter((frame) => frame.type === "ping")).toHaveLength(1);

    // 45 秒从最后一个入站帧（hello，t=0）算起：t=45s 才判死。
    vi.advanceTimersByTime(
      WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS -
        WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS -
        1,
    );
    expect(channel.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(channel.isOpen).toBe(false);
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  it("keeps the channel alive while inbound frames keep arriving", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const { channel } = attachClient(harness);

    for (let index = 0; index < 4; index += 1) {
      vi.advanceTimersByTime(WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS);
      channel.deliver({ type: "pong", id: `pong-${index}` });
    }

    expect(channel.isOpen).toBe(true);
    // start 时的 waiting_terminal 之后不应再退回 waiting。
    expect(harness.states).toEqual(["waiting_terminal", "paired"]);
  });

  it("returns unavailable without calling send when the channel is not open", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness);
    channel.sent.length = 0;
    channel.isOpen = false;

    const result = harness.session.sendPayloadResult({
      zcode_type: "workspace-list-request",
      requestId: "closed-channel",
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(channel.sent).toEqual([]);
  });

  it("returns unavailable when bufferedAmount exceeds 4 MiB", () => {
    const harness = createHarness();
    const { channel, socket } = attachClient(harness);
    channel.sent.length = 0;
    socket.bufferedAmount = WEB_REMOTE_CONTROL_CHANNEL_MAX_BUFFERED_BYTES + 1;

    const result = harness.session.sendPayloadResult({
      zcode_type: "workspace-list-request",
      requestId: "backpressure",
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(channel.sent).toEqual([]);
    expect(harness.logger.warn).toHaveBeenCalled();

    // 刚好等于阈值时仍然发送。
    socket.bufferedAmount = WEB_REMOTE_CONTROL_CHANNEL_MAX_BUFFERED_BYTES;
    expect(
      harness.session.sendPayloadResult({
        zcode_type: "workspace-list-request",
        requestId: "at-threshold",
      }).kind,
    ).toBe("sent");
  });

  it("returns oversize without sending for a frame above 1 MiB", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness);
    channel.sent.length = 0;

    const result = harness.session.sendPayloadResult({
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES + 1),
    });

    expect(result.kind).toBe("oversize");
    expect(channel.sent).toEqual([]);
  });

  it("drops an oversize inbound frame and reports a raw transport fault", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness);

    channel.deliver(
      JSON.stringify({ type: "ping", id: "x".repeat(WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES) }),
    );

    expect(harness.rawFault).toHaveBeenCalledWith("remote.rpcFrame.envelopeTooLarge");
    expect(channel.isOpen).toBe(true);
  });

  it("answers data outside the negotiated appProtocol with protocol_error instead of delivering it", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness, { appProtocol: { min: 1, max: 1 } });
    channel.sent.length = 0;

    channel.deliver(
      dataFrame({
        zcode_type: "recent-projects-updated",
        result: { desktopWindowState: "open", recentProjects: [] },
      }),
    );

    expect(harness.payloads).toEqual([]);
    expect(channel.frames()).toContainEqual({
      type: "protocol_error",
      code: "unsupported-version",
      offendingType: "recent-projects-updated",
    });
    expect(channel.isOpen).toBe(true);
  });

  it("omits appProtocol 2 fields when the negotiated version is 1", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness, { appProtocol: { min: 1, max: 1 } });
    channel.sent.length = 0;

    const result = harness.session.sendPayloadResult({
      zcode_type: "bootstrap-response",
      requestId: "bootstrap-1",
      success: true,
      result: {
        windowControlSessionId: "window-1",
        workspaces: [],
        tasks: [],
        desktopWindowState: "open",
        recentProjects: [{ id: "project-1", label: "demo", location: "/workspace" }],
      },
    });

    expect(result.kind).toBe("sent");
    const dataFrames = channel.frames().filter((frame) => frame.type === "data");
    const payload = dataFrames[0]!.payload as {
      result: Record<string, unknown>;
    };
    expect(payload.result.desktopWindowState).toBeUndefined();
    expect(payload.result.recentProjects).toBeUndefined();
    expect(payload.result.windowControlSessionId).toBe("window-1");
  });

  it("does not send appProtocol 2 payload types to a v1 client", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness, { appProtocol: { min: 1, max: 1 } });
    channel.sent.length = 0;

    const result = harness.session.sendPayloadResult({
      zcode_type: "recent-projects-updated",
      result: { desktopWindowState: "open", recentProjects: [] },
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(channel.sent).toEqual([]);
  });

  it("measures the serialized data frame, not just the payload", () => {
    const harness = createHarness();
    attachClient(harness);

    const bytes = harness.session.measurePayloadBytes({
      zcode_type: "workspace-list-request",
      requestId: "measure",
    });

    expect(bytes).toBe(
      Buffer.byteLength(
        JSON.stringify(dataFrame({ zcode_type: "workspace-list-request", requestId: "measure" })),
        "utf8",
      ),
    );
  });

  it("closes the channel and ignores further payloads on dispose", () => {
    const harness = createHarness();
    const { channel } = attachClient(harness);

    harness.session.dispose();

    expect(channel.frames()).toContainEqual({ type: "close", reason: "desktop-stopping" });
    expect(channel.isOpen).toBe(false);
    expect(
      harness.session.sendPayloadResult({
        zcode_type: "workspace-list-request",
        requestId: "after-dispose",
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("accepts a channel that arrives before a manager session exists and replays on start", () => {
    const harness = createHarness({}, { session: false });
    const { channel } = attachClient(harness);
    expect(channel.frames()).toContainEqual(expect.objectContaining({ type: "hello_ack" }));
    expect(harness.states).toEqual([]);

    harness.session.start();

    expect(harness.states).toEqual(["paired"]);
    expect(harness.sendReady).toHaveBeenCalledWith({ kind: "same-socket" });
  });
});
