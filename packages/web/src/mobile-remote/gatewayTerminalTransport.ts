/* eslint-disable max-lines -- 手机端 gateway transport 需要集中维护控制连接、channel、心跳、宽限与凭证复核状态机。 */
import {
  GatewayClient,
  defaultSocketFactory,
  type FetchLike,
  type GatewayClientOptions,
  type GatewayClientState,
  type GatewayDiscoveryBackend,
  type SocketFactory,
  type WebSocketLike,
} from "@zclaudia/gateway-client";
import type { BackendPresenceV4 } from "@zclaudia/gateway-protocol";
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE,
  WEB_REMOTE_CONTROL_BACKEND_CAPABILITY,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_KIND,
  WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
  WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  gateWebRemoteControlAppPayloadVersion,
  isWebRemoteControlChannelHeartbeatExpired,
  negotiateWebRemoteControlAppProtocol,
  parseWebRemoteControlAppPayload,
  parseWebRemoteControlChannelFrameJson,
  type WebRemoteControlAppPayload,
  type WebRemoteControlChannelFrameOf,
  type WebRemoteControlFailure,
} from "@zcode/shared";

/**
 * 手机端 gateway transport（T3.4，方案「失败原因与恢复」）。
 *
 * 职责边界：
 * - 封装 `@zclaudia/gateway-client`：控制连接重连、registry 能力位检查、channel 生命周期；
 * - channel 内帧协议：`hello`/`hello_ack` 版本协商、`data`、心跳、`close{superseded}` 的 close_ack；
 * - 从注入的 `socketFactory` 扣住数据 socket，读取 gateway `close(code, reason)` 的 reason；
 * - 失败原因映射：可恢复的 desktop-disconnected 有 60 秒宽限，gateway-unreachable 30 秒；
 * - 凭证复核：每次关闭最多一次、至少间隔 30 秒，429/网络错误按可恢复处理；
 * - `session-conflict` 后锁住自动重连，等用户主动 `recoverConnection()`。
 *
 * 不负责应用 payload 的请求语义（`payloadRequester.ts`）和 UI 状态映射（`bootstrap.tsx`）。
 */

export type GatewayTerminalTransportState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "suspended"
  | "closed"
  | "error";

/** `raw` 保留 relay 时代的 fault code，避免上层 RPC 传输的降级路径分叉。 */
export const GATEWAY_TERMINAL_RAW_FRAME_TOO_LARGE_FAULT = "remote.rpcFrame.envelopeTooLarge";

/** 方案「背压」：数据 socket 的 bufferedAmount 超过 4 MiB 时返回 unavailable。 */
export const GATEWAY_TERMINAL_SEND_BUFFERED_AMOUNT_LIMIT_BYTES = 4 * 1024 * 1024;

/** 方案「失败原因与恢复」：电脑离线宽限 60 秒。 */
export const GATEWAY_TERMINAL_DESKTOP_OFFLINE_GRACE_MS = 60_000;
/** 控制连接持续失败超过 30 秒进入 gateway-unreachable。 */
export const GATEWAY_TERMINAL_GATEWAY_UNREACHABLE_TIMEOUT_MS = 30_000;
/** 凭证复核的最小间隔；关闭后复核本身也按 IP 计额。 */
export const GATEWAY_TERMINAL_CREDENTIAL_REVERIFY_INTERVAL_MS = 30_000;
/** 方案：channel 被 reject 后按退避重试，连续 3 次后显示可重试错误。 */
export const GATEWAY_TERMINAL_CHANNEL_REJECT_RETRY_LIMIT = 3;

export interface GatewayTerminalTransportVersionInfo {
  appProtocol: number;
  desktopAppVersion: string;
}

type GatewayTerminalSocketClose = {
  code: number;
  reason: string;
  wasClean: boolean;
};

type GatewayTerminalDiagnosticBase = {
  state: GatewayTerminalTransportState;
  timestamp: number;
  visibilityState: string;
  online: boolean;
  hiddenDurationMs?: number;
};

export type GatewayTerminalTransportDiagnostic =
  | (GatewayTerminalDiagnosticBase & {
      type: "state-transition";
      previousState: GatewayTerminalTransportState;
    })
  | (GatewayTerminalDiagnosticBase & {
      type: "socket-close";
      channel: "control" | "data";
      code: number;
      reason: string;
      wasClean: boolean;
      wasReady: boolean;
    })
  | (GatewayTerminalDiagnosticBase & { type: "socket-error" })
  | (GatewayTerminalDiagnosticBase & { type: "recover-start" })
  | (GatewayTerminalDiagnosticBase & { type: "recover-scheduled"; delayMs: number })
  | (GatewayTerminalDiagnosticBase & { type: "heartbeat-timeout" })
  | (GatewayTerminalDiagnosticBase & {
      type: "credential-reverify";
      outcome: "authorized" | "unauthorized" | "rate-limited" | "unreachable";
    })
  | (GatewayTerminalDiagnosticBase & {
      type: "protocol-error";
      code: string;
      offendingType?: string;
    })
  | (GatewayTerminalDiagnosticBase & { type: "channel-rejected"; attempt: number });

type GatewayTerminalDiagnosticInput =
  | { type: "state-transition"; previousState: GatewayTerminalTransportState }
  | {
      type: "socket-close";
      channel: "control" | "data";
      code: number;
      reason: string;
      wasClean: boolean;
      wasReady: boolean;
    }
  | { type: "socket-error" }
  | { type: "recover-start" }
  | { type: "recover-scheduled"; delayMs: number }
  | { type: "heartbeat-timeout" }
  | {
      type: "credential-reverify";
      outcome: "authorized" | "unauthorized" | "rate-limited" | "unreachable";
    }
  | { type: "protocol-error"; code: string; offendingType?: string }
  | { type: "channel-rejected"; attempt: number };

/**
 * 生产实现的结构化接口：便于单测注入 fake client。
 * 字段刻意只覆盖 transport 用到的 SDK 子集，fake 不需要实现整个 GatewayClient。
 */
export interface GatewayTerminalChannelLike {
  readonly channelId: string;
  readonly isOpen: boolean;
  send(data: string | Uint8Array): void;
  onMessage(handler: (message: { data: string | Uint8Array; binary: boolean }) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
}

export interface GatewayTerminalClientLike {
  readonly connectionState: GatewayClientState;
  readonly registry: BackendPresenceV4[];
  onState(handler: (state: GatewayClientState) => void): () => void;
  onRegistry(handler: (items: BackendPresenceV4[]) => void): () => void;
  connect(): Promise<void>;
  close(): void;
  openChannel(target: string, kind?: string): Promise<GatewayTerminalChannelLike>;
  discoverBackends(): Promise<GatewayDiscoveryBackend[]>;
}

export interface GatewayTerminalTransportOptions {
  gatewayUrl: string;
  namespace: string;
  credential: string;
  backendId: string;
  clientInstanceId: string;
  clientName?: string;
  appVersion?: string;

  /** 平台注入点；生产环境由浏览器/WebView 的 WebSocket 实现，单测可换成 fake。 */
  socketFactory?: SocketFactory;
  fetchImpl?: FetchLike;
  createClient?: (options: GatewayClientOptions) => GatewayTerminalClientLike;
  now?: () => number;

  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  helloAckTimeoutMs?: number;
  desktopOfflineGraceMs?: number;
  gatewayUnreachableTimeoutMs?: number;
  credentialReverifyMinIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  channelRejectRetryLimit?: number;

  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onStateChange(state: GatewayTerminalTransportState): void;
  onFailure(failure: WebRemoteControlFailure): void;
  onError(error: Error): void;
  onDiagnostic?(diagnostic: GatewayTerminalTransportDiagnostic): void;
  onSendReady?(): void;
  onVersionNegotiated?(info: GatewayTerminalTransportVersionInfo): void;
}

interface TrackedSocket {
  socket: WebSocketLike;
  closeEvent?: GatewayTerminalSocketClose;
}

interface ReadyWaiter {
  resolve(): void;
  reject(failure: WebRemoteControlFailure): void;
  timer: ReturnType<typeof setTimeout>;
}

function readChannelIdFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const prefix = "/channel/";
    if (!pathname.startsWith(prefix)) {
      return undefined;
    }
    const channelId = decodeURIComponent(pathname.slice(prefix.length));
    return channelId ? channelId : undefined;
  } catch {
    return undefined;
  }
}

function isRawTransportCandidate(payload: WebRemoteControlAppPayload): boolean {
  return payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorizedError(error: unknown): boolean {
  return /UNAUTHORIZED|HTTP 401|\b401\b/i.test(readErrorMessage(error));
}

function isFatalGatewayHandshakeError(error: unknown): boolean {
  return /PROTOCOL_VERSION_MISMATCH|INVALID_MESSAGE/i.test(readErrorMessage(error));
}

type CredentialReverifyOutcome = "authorized" | "unauthorized" | "rate-limited" | "unreachable";

function classifyCredentialReverifyError(error: unknown): CredentialReverifyOutcome {
  const message = readErrorMessage(error);
  // gateway 对未认证失败按 IP 计额；429 必须按可恢复处理，不能据此判定凭证无效。
  if (/\b429\b|RATE_LIMITED/i.test(message)) {
    return "rate-limited";
  }
  if (/\b401\b|\b403\b|UNAUTHORIZED|FORBIDDEN/i.test(message)) {
    return "unauthorized";
  }
  return "unreachable";
}

function createFailure(
  reason: WebRemoteControlFailure["reason"],
  message?: string,
  upgrade?: WebRemoteControlFailure["upgrade"],
): WebRemoteControlFailure {
  return { reason, message, ...(upgrade ? { upgrade } : {}) };
}

export class GatewayTerminalTransport {
  private readonly options: GatewayTerminalTransportOptions;
  private readonly client: GatewayTerminalClientLike;
  private readonly unsubscribeState: () => void;
  private readonly unsubscribeRegistry: () => void;
  private readonly payloadSerializer = new WebRemoteControlRelayPayloadSerializer();
  private readonly now: () => number;
  private readonly trackedSockets = new Map<string, TrackedSocket>();
  private readonly channelSockets = new Map<string, TrackedSocket>();
  private readonly readyWaiters = new Set<ReadyWaiter>();

  private state: GatewayTerminalTransportState = "idle";
  private channel?: GatewayTerminalChannelLike;
  private channelSocket?: WebSocketLike;
  private unsubscribeChannelMessage?: () => void;
  private unsubscribeChannelClose?: () => void;
  private helloAckTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private desktopOfflineGraceTimer?: ReturnType<typeof setTimeout>;
  private gatewayUnreachableTimer?: ReturnType<typeof setTimeout>;

  private disposed = false;
  private suspended = false;
  private sessionConflictLatched = false;
  private autoRetrySuspended = false;
  private terminal = false;
  private hadReadySession = false;
  private awaitingHelloAck = false;
  private channelOpenInFlight = false;
  private connecting = false;
  private channelRejectAttempts = 0;
  private reconnectAttempt = 0;
  private pingSequence = 0;
  private lastInboundAt = 0;
  private appProtocol?: number;
  private desktopAppVersion?: string;
  private hiddenStartedAt?: number;
  private credentialReverifyInFlight = false;
  private lastCredentialReverifyAt?: number;
  private desktopOfflineFailureEmitted = false;
  private gatewayUnreachableFailureEmitted = false;

  constructor(options: GatewayTerminalTransportOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const socketFactory = this.createTrackedSocketFactory();
    const clientOptions: GatewayClientOptions = {
      url: options.gatewayUrl,
      credential: options.credential,
      namespace: options.namespace,
      reconnect: true,
      reconnectMinMs: options.reconnectMinMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      socketFactory,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
    this.client = (options.createClient ?? ((sdkOptions) => new GatewayClient(sdkOptions)))(
      clientOptions,
    );
    // 在 connect() 前注册状态/registry handler：SDK 不缓存事件，晚注册会丢首帧。
    this.unsubscribeState = this.client.onState((state) => this.handleClientState(state));
    this.unsubscribeRegistry = this.client.onRegistry((items) => this.handleRegistry(items));
  }

  start(): void {
    if (this.disposed) {
      return;
    }
    this.suspended = false;
    this.sessionConflictLatched = false;
    this.autoRetrySuspended = false;
    this.terminal = false;
    this.reconnectAttempt = 0;
    this.channelRejectAttempts = 0;
    this.setState("connecting");
    void this.connectControl();
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.payloadSerializer.prepare(payload).bytes;
  }

  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    const prepared = this.payloadSerializer.prepare(payload);
    if (prepared.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    const channel = this.channel;
    if (this.state !== "ready" || !channel?.isOpen) {
      return { kind: "unavailable" };
    }
    // SDK 的 GatewayChannel 不暴露 bufferedAmount，也没有 send 返回值；
    // 这里读 socketFactory 扣住的底层 socket，超过 4 MiB 交给上层缓冲和 ACK 重放。
    const bufferedAmount =
      (this.channelSocket as unknown as { bufferedAmount?: number } | undefined)?.bufferedAmount ??
      0;
    if (bufferedAmount > GATEWAY_TERMINAL_SEND_BUFFERED_AMOUNT_LIMIT_BYTES) {
      return { kind: "unavailable" };
    }
    try {
      channel.send(prepared.json);
      return { kind: "sent", bytes: prepared.bytes };
    } catch {
      return { kind: "unavailable" };
    }
  }

  suspend(): void {
    if (this.state !== "ready" && this.state !== "connecting" && this.state !== "reconnecting") {
      return;
    }
    this.hiddenStartedAt = this.now();
    // 先置 suspended，再关闭 channel/client：它们的 close 回调按状态短路，不会触发重连。
    this.suspended = true;
    this.clearTimers();
    this.closeCurrentChannel(false);
    this.client.close();
    this.setState("suspended");
  }

  async recoverConnection(timeoutMs = 15_000): Promise<void> {
    this.emitDiagnostic({ type: "recover-start" });
    this.suspended = false;
    this.sessionConflictLatched = false;
    this.autoRetrySuspended = false;
    this.terminal = false;
    this.channelRejectAttempts = 0;
    this.reconnectAttempt = 0;
    this.clearTimers();
    if (this.state === "ready" && this.channel?.isOpen) {
      return;
    }
    this.setState("reconnecting");
    void this.connectControl();
    await this.waitForReady(timeoutMs);
  }

  recoverInBackground(): void {
    if (this.disposed || this.sessionConflictLatched || this.state === "ready") {
      return;
    }
    this.suspended = false;
    this.clearTimers();
    void this.connectControl();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimers();
    this.closeCurrentChannel(true);
    this.unsubscribeState();
    this.unsubscribeRegistry();
    this.client.close();
    this.rejectReadyWaiters(new Error("Gateway terminal transport disposed."));
    this.setState("closed");
  }

  private createTrackedSocketFactory(): SocketFactory {
    const baseSocketFactory = this.options.socketFactory ?? defaultSocketFactory;
    return (url) => {
      const socket = baseSocketFactory(url);
      const tracked: TrackedSocket = { socket };
      this.trackedSockets.set(url, tracked);
      const channelId = readChannelIdFromUrl(url);
      if (channelId) {
        this.channelSockets.set(channelId, tracked);
      }
      socket.addEventListener("close", (event) => {
        const closeEvent: GatewayTerminalSocketClose = {
          code: event.code,
          reason: event.reason ?? "",
          wasClean: (event as { wasClean?: boolean }).wasClean ?? false,
        };
        tracked.closeEvent = closeEvent;
        this.emitDiagnostic({
          type: "socket-close",
          channel: channelId ? "data" : "control",
          code: closeEvent.code,
          reason: closeEvent.reason,
          wasClean: closeEvent.wasClean,
          wasReady: this.state === "ready",
        });
        if (!channelId) {
          this.handleControlSocketClose(closeEvent);
        }
      });
      return socket;
    };
  }

  private async connectControl(): Promise<void> {
    if (this.disposed || this.suspended || this.sessionConflictLatched || this.terminal) {
      return;
    }
    if (this.connecting) {
      return;
    }
    if (this.client.connectionState === "connected") {
      this.maybeOpenChannel();
      return;
    }
    this.connecting = true;
    try {
      // client SDK 首次 connect() 失败后状态会卡在 connecting，后续 connect() 直接返回；
      // 必须先 close() 再重连（方案「Gateway 使用约定」的已复核缺陷）。
      if (this.client.connectionState === "connecting") {
        this.client.close();
      }
      await this.client.connect();
    } catch (error) {
      this.emitDiagnostic({ type: "socket-error" });
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      if (isUnauthorizedError(error)) {
        this.enterTerminalFailure(
          createFailure(
            "gateway-credential-invalid",
            "Gateway rejected the device credential during connect.",
          ),
        );
        return;
      }
      if (isFatalGatewayHandshakeError(error)) {
        this.enterTerminalFailure(
          createFailure("unexpected-error", `Gateway handshake failed: ${readErrorMessage(error)}`),
        );
        return;
      }
      this.client.close();
      this.startGatewayUnreachableTimer();
      this.setState(this.hadReadySession ? "reconnecting" : "connecting");
      this.scheduleConnectRetry();
    } finally {
      this.connecting = false;
    }
  }

  private handleClientState(state: GatewayClientState): void {
    if (this.disposed || this.suspended || this.sessionConflictLatched || this.terminal) {
      return;
    }
    switch (state) {
      case "connecting":
        this.startGatewayUnreachableTimer();
        this.setState(this.hadReadySession ? "reconnecting" : "connecting");
        break;
      case "connected":
        this.clearGatewayUnreachableTimer(true);
        this.reconnectAttempt = 0;
        this.setState(this.hadReadySession ? "reconnecting" : "connecting");
        this.maybeOpenChannel();
        break;
      case "closed":
        this.startGatewayUnreachableTimer();
        this.setState("reconnecting");
        break;
      case "idle":
        break;
    }
  }

  private handleRegistry(items: BackendPresenceV4[]): void {
    if (this.disposed || this.suspended || this.sessionConflictLatched || this.terminal) {
      return;
    }
    const presence = items.find((item) => item.backendId === this.options.backendId);
    if (!presence) {
      // registry 是 liveness 视图：电脑离线时条目消失，等它重新上线再重开 channel。
      return;
    }
    if (!presence.capabilities.includes(WEB_REMOTE_CONTROL_BACKEND_CAPABILITY)) {
      this.enterBackendUnsupportedFailure();
      return;
    }
    if (!this.channel && !this.channelOpenInFlight && !this.autoRetrySuspended) {
      this.maybeOpenChannel();
    }
  }

  private maybeOpenChannel(): void {
    if (
      this.disposed ||
      this.suspended ||
      this.sessionConflictLatched ||
      this.terminal ||
      this.autoRetrySuspended ||
      this.channel ||
      this.channelOpenInFlight
    ) {
      return;
    }
    if (this.client.connectionState !== "connected") {
      return;
    }
    const presence = this.client.registry.find((item) => item.backendId === this.options.backendId);
    if (!presence) {
      return;
    }
    if (!presence.capabilities.includes(WEB_REMOTE_CONTROL_BACKEND_CAPABILITY)) {
      this.enterBackendUnsupportedFailure();
      return;
    }
    this.channelOpenInFlight = true;
    this.setState(this.hadReadySession ? "reconnecting" : "connecting");
    void this.openChannel();
  }

  private async openChannel(): Promise<void> {
    try {
      const channel = await this.client.openChannel(
        this.options.backendId,
        WEB_REMOTE_CONTROL_CHANNEL_KIND,
      );
      this.channelOpenInFlight = false;
      if (this.disposed || this.suspended || this.sessionConflictLatched || this.terminal) {
        channel.close();
        return;
      }
      this.attachChannel(channel);
    } catch (error) {
      this.channelOpenInFlight = false;
      if (this.disposed || this.suspended || this.sessionConflictLatched || this.terminal) {
        return;
      }
      this.emitDiagnostic({ type: "socket-error" });
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      if (
        /BACKEND_OFFLINE|not found or offline|Not connected|Connection closed/i.test(
          readErrorMessage(error),
        )
      ) {
        this.enterDesktopOfflineGrace("backend_offline");
        return;
      }
      this.handleRejectedChannelAttempt();
    }
  }

  private attachChannel(channel: GatewayTerminalChannelLike): void {
    this.detachChannel();
    this.channel = channel;
    this.channelSocket = this.channelSockets.get(channel.channelId)?.socket;
    this.awaitingHelloAck = true;
    this.lastInboundAt = this.now();
    // 必须在第一个 await 之前同步注册：SDK 不缓存帧，桌面可能在 openChannel resolve 后立刻回 hello_ack。
    this.unsubscribeChannelMessage = channel.onMessage((message) =>
      this.handleChannelMessage(channel, message),
    );
    this.unsubscribeChannelClose = channel.onClose(() => this.handleChannelClosed(channel));
    const hello: WebRemoteControlChannelFrameOf<"hello"> = {
      type: "hello",
      protocolVersion: WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
      appProtocol: WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE,
      clientInstanceId: this.options.clientInstanceId.trim(),
      clientName: this.options.clientName?.trim() || "mobile-browser",
      appVersion: this.options.appVersion?.trim() || "web",
    };
    if (!this.sendFrameOn(channel, hello)) {
      this.handleChannelClosed(channel);
      return;
    }
    this.helloAckTimer = setTimeout(() => {
      this.helloAckTimer = undefined;
      if (this.channel !== channel || !this.awaitingHelloAck) {
        return;
      }
      this.awaitingHelloAck = false;
      this.detachChannel();
      try {
        channel.close();
      } catch {
        // 关闭失败只影响本次 channel；重试路径仍会创建新 channel。
      }
      this.handleRejectedChannelAttempt();
    }, this.options.helloAckTimeoutMs ?? WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS);
  }

  private handleChannelMessage(
    channel: GatewayTerminalChannelLike,
    message: { data: string | Uint8Array; binary: boolean },
  ): void {
    if (channel !== this.channel) {
      return;
    }
    if (message.binary) {
      // ZCode 只使用 text 帧；binary 不是本层协议。只记诊断，不按 RPC raw fault 降级 bridge。
      this.emitDiagnostic({ type: "protocol-error", code: "binary-frame" });
      return;
    }
    const raw =
      typeof message.data === "string" ? message.data : new TextDecoder().decode(message.data);
    const parsed = parseWebRemoteControlChannelFrameJson(raw, {
      maxFrameBytes: WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
    });
    if (parsed.kind === "discarded") {
      if (parsed.reason === "oversize") {
        this.options.onRawTransportFault?.(GATEWAY_TERMINAL_RAW_FRAME_TOO_LARGE_FAULT);
      }
      return;
    }
    const frame = parsed.frame;
    this.lastInboundAt = this.now();
    switch (frame.type) {
      case "hello_ack":
        this.handleHelloAck(channel, frame);
        break;
      case "data":
        this.handleDataFrame(frame);
        break;
      case "ping":
        this.sendFrameOn(channel, { type: "pong", id: frame.id });
        break;
      case "pong":
        break;
      case "close":
        this.handleCloseFrame(channel, frame);
        break;
      case "close_ack":
        break;
      case "protocol_error":
        this.emitDiagnostic({
          type: "protocol-error",
          code: frame.code,
          ...(frame.offendingType ? { offendingType: frame.offendingType } : {}),
        });
        break;
      case "hello":
        // 手机是 hello 的发起方；收到对端的 hello 说明实现异常，忽略。
        break;
    }
  }

  private handleHelloAck(
    channel: GatewayTerminalChannelLike,
    frame: WebRemoteControlChannelFrameOf<"hello_ack">,
  ): void {
    if (channel !== this.channel || !this.awaitingHelloAck) {
      return;
    }
    this.awaitingHelloAck = false;
    this.clearHelloAckTimer();
    const negotiation = negotiateWebRemoteControlAppProtocol(
      { min: frame.appProtocol, max: frame.appProtocol },
      WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE,
    );
    if (!negotiation.ok) {
      this.sendFrameOn(channel, {
        type: "close",
        reason: "incompatible-version",
        upgrade: negotiation.upgrade,
      });
      this.enterTerminalFailure(
        createFailure(
          "incompatible-version",
          "Desktop negotiated an app protocol outside the supported range.",
          negotiation.upgrade,
        ),
      );
      return;
    }
    this.appProtocol = negotiation.appProtocol;
    this.desktopAppVersion = frame.desktopAppVersion;
    this.hadReadySession = true;
    this.channelRejectAttempts = 0;
    this.reconnectAttempt = 0;
    this.autoRetrySuspended = false;
    this.clearDesktopOfflineGrace();
    this.clearGatewayUnreachableTimer(true);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.setState("ready");
    this.options.onVersionNegotiated?.({
      appProtocol: this.appProtocol,
      desktopAppVersion: this.desktopAppVersion,
    });
    this.startHeartbeat();
    // onSendReady 在 ready 之后触发：上层 flush 缓冲/重放未 ACK 批次时 sendPayload 必须已可用。
    this.options.onSendReady?.();
  }

  private handleDataFrame(frame: WebRemoteControlChannelFrameOf<"data">): void {
    if (this.awaitingHelloAck || this.appProtocol === undefined) {
      return;
    }
    const payload = parseWebRemoteControlAppPayload(frame.payload);
    if (!payload) {
      return;
    }
    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) {
      return;
    }
    const gate = gateWebRemoteControlAppPayloadVersion(payload, this.appProtocol);
    if (gate.kind === "unsupported-version") {
      this.sendFrameOn(this.channel, gate.protocolError);
      this.emitDiagnostic({
        type: "protocol-error",
        code: "unsupported-version",
        offendingType: gate.offendingType,
      });
      return;
    }
    this.options.onPayload(payload);
  }

  private handleCloseFrame(
    channel: GatewayTerminalChannelLike,
    frame: WebRemoteControlChannelFrameOf<"close">,
  ): void {
    // 方案：收到 close 后立即回 close_ack，桌面据此确认 superseded 已送达。
    this.sendFrameOn(channel, { type: "close_ack" });
    this.clearHelloAckTimer();
    this.awaitingHelloAck = false;
    switch (frame.reason) {
      case "superseded":
        this.sessionConflictLatched = true;
        this.enterTerminalFailure(
          createFailure(
            "session-conflict",
            "Another mobile client replaced this remote-control connection.",
          ),
        );
        break;
      case "incompatible-version":
        this.enterTerminalFailure(
          createFailure(
            "incompatible-version",
            "Desktop rejected the app protocol version.",
            frame.upgrade,
          ),
        );
        break;
      case "desktop-stopping":
      case "client-leaving":
        this.closeCurrentChannel(false);
        this.enterDesktopOfflineGrace(frame.reason);
        break;
    }
  }

  private handleChannelClosed(channel: GatewayTerminalChannelLike): void {
    if (channel !== this.channel) {
      return;
    }
    const closeEvent = this.channelSockets.get(channel.channelId)?.closeEvent;
    this.channelSockets.delete(channel.channelId);
    const wasAwaitingHelloAck = this.awaitingHelloAck;
    this.detachChannel();
    if (this.disposed || this.suspended || this.sessionConflictLatched || this.terminal) {
      return;
    }
    if (wasAwaitingHelloAck) {
      // 还没收到 hello_ack 就关闭：桌面还没确认远端是否接受 channel，按 reject/拨号失败重试。
      this.handleRejectedChannelAttempt();
      return;
    }
    const reason = closeEvent && closeEvent.code === 1000 ? closeEvent.reason : "";
    switch (reason) {
      case "superseded":
        // 正常情况下应用层 close{superseded} 先到并已进入终态；这里兜底 socket 先关闭、
        // close 帧丢失的情况，避免停在 ready 且永不重连。
        this.sessionConflictLatched = true;
        this.enterTerminalFailure(
          createFailure(
            "session-conflict",
            "Another mobile client replaced this remote-control connection.",
          ),
        );
        return;
      case "incompatible-version":
        // 同上：拿不到 close 帧里的 upgrade 时仍进入终态，交由 T4.2 提示双方版本不兼容。
        this.enterTerminalFailure(
          createFailure("incompatible-version", "Desktop rejected the app protocol version."),
        );
        return;
      case "rejected":
        this.handleRejectedChannelAttempt();
        return;
      case "backend_offline":
      case "epoch_changed":
      case "timeout":
      case "closed":
        this.enterDesktopOfflineGrace(reason);
        return;
      default:
        // 1006 或空 reason：手机本地网络中断，按可恢复处理。
        this.enterDesktopOfflineGrace("local-network");
        return;
    }
  }

  private handleRejectedChannelAttempt(): void {
    if (this.disposed || this.terminal || this.sessionConflictLatched) {
      return;
    }
    this.channelRejectAttempts += 1;
    this.emitDiagnostic({ type: "channel-rejected", attempt: this.channelRejectAttempts });
    this.setState("reconnecting");
    if (
      this.channelRejectAttempts >=
      (this.options.channelRejectRetryLimit ?? GATEWAY_TERMINAL_CHANNEL_REJECT_RETRY_LIMIT)
    ) {
      // 电脑有能力位却被连续拒绝：按桌面临时拨号失败处理，不标记为不可用，也不自动继续重试。
      this.autoRetrySuspended = true;
      this.clearTimers();
      this.setState("error");
      this.options.onFailure(
        createFailure(
          "desktop-disconnected",
          "Desktop repeatedly rejected the remote-control channel; retry manually.",
        ),
      );
      return;
    }
    this.scheduleChannelReopen();
  }

  private enterDesktopOfflineGrace(reason: string): void {
    this.setState("reconnecting");
    if (!this.desktopOfflineGraceTimer && !this.desktopOfflineFailureEmitted) {
      this.desktopOfflineGraceTimer = setTimeout(() => {
        this.desktopOfflineGraceTimer = undefined;
        if (this.disposed || this.state === "ready" || this.terminal) {
          return;
        }
        this.desktopOfflineFailureEmitted = true;
        // 可恢复失败：transport 继续监听 registry，电脑恢复在线后自动重开 channel。
        this.options.onFailure(
          createFailure("desktop-disconnected", `Desktop connection lost (${reason}).`),
        );
      }, this.options.desktopOfflineGraceMs ?? GATEWAY_TERMINAL_DESKTOP_OFFLINE_GRACE_MS);
    }
    // registry 没有这台电脑时只监听 registry：避免对 BACKEND_OFFLINE 反复发起 channel_open。
    if (this.client.connectionState === "connected" && this.hasOnlineCapableBackend()) {
      this.scheduleChannelReopen();
    }
  }

  private hasOnlineCapableBackend(): boolean {
    const presence = this.client.registry.find((item) => item.backendId === this.options.backendId);
    return Boolean(presence?.capabilities.includes(WEB_REMOTE_CONTROL_BACKEND_CAPABILITY));
  }

  private enterBackendUnsupportedFailure(): void {
    if (this.terminal || this.sessionConflictLatched) {
      return;
    }
    this.enterTerminalFailure(
      createFailure(
        "backend-unsupported",
        "The selected desktop is online but does not advertise zcode-remote-control.",
      ),
    );
  }

  private enterTerminalFailure(failure: WebRemoteControlFailure): void {
    if (this.terminal || this.disposed) {
      return;
    }
    this.terminal = true;
    this.clearTimers();
    this.closeCurrentChannel(false);
    this.rejectReadyWaitersWithFailure(failure);
    this.setState("error");
    this.options.onFailure(failure);
    // 停止 SDK 的静默重连：终态必须由用户或上层显式恢复。
    this.client.close();
  }

  private rejectReadyWaitersWithFailure(failure: WebRemoteControlFailure): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    this.readyWaiters.clear();
  }

  private scheduleChannelReopen(): void {
    if (
      this.reconnectTimer ||
      this.disposed ||
      this.suspended ||
      this.terminal ||
      this.sessionConflictLatched ||
      this.autoRetrySuspended ||
      this.channel ||
      this.channelOpenInFlight
    ) {
      return;
    }
    const delayMs = this.nextReconnectDelay();
    this.emitDiagnostic({ type: "recover-scheduled", delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.maybeOpenChannel();
    }, delayMs);
  }

  private scheduleConnectRetry(): void {
    if (this.reconnectTimer || this.disposed || this.suspended) {
      return;
    }
    const delayMs = this.nextReconnectDelay();
    this.emitDiagnostic({ type: "recover-scheduled", delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed || this.suspended) {
        return;
      }
      void this.connectControl();
    }, delayMs);
  }

  private nextReconnectDelay(): number {
    const minMs = this.options.reconnectMinMs ?? 1_000;
    const maxMs = this.options.reconnectMaxMs ?? 30_000;
    const delayMs = Math.min(maxMs, minMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    return delayMs;
  }

  private startGatewayUnreachableTimer(): void {
    if (
      this.gatewayUnreachableTimer ||
      this.gatewayUnreachableFailureEmitted ||
      this.disposed ||
      this.suspended ||
      this.terminal
    ) {
      return;
    }
    this.gatewayUnreachableTimer = setTimeout(() => {
      this.gatewayUnreachableTimer = undefined;
      if (this.state === "ready" || this.disposed || this.terminal) {
        return;
      }
      this.gatewayUnreachableFailureEmitted = true;
      // 可恢复：SDK 退避重连，成功后自动回到首页。
      this.options.onFailure(
        createFailure("gateway-unreachable", "Could not reach the gateway within 30 seconds."),
      );
    }, this.options.gatewayUnreachableTimeoutMs ?? GATEWAY_TERMINAL_GATEWAY_UNREACHABLE_TIMEOUT_MS);
  }

  private clearGatewayUnreachableTimer(resetEmitted: boolean): void {
    if (this.gatewayUnreachableTimer) {
      clearTimeout(this.gatewayUnreachableTimer);
      this.gatewayUnreachableTimer = undefined;
    }
    if (resetEmitted) {
      this.gatewayUnreachableFailureEmitted = false;
    }
  }

  private handleControlSocketClose(closeEvent: GatewayTerminalSocketClose): void {
    if (this.disposed || this.suspended || this.terminal || this.sessionConflictLatched) {
      return;
    }
    this.startGatewayUnreachableTimer();
    // 1008 不等同于凭证无效（也可能是限流/握手超时），只触发一次独立 HTTP 复核。
    void this.reverifyCredential(closeEvent);
  }

  private async reverifyCredential(closeEvent: GatewayTerminalSocketClose): Promise<void> {
    if (this.disposed || this.credentialReverifyInFlight) {
      return;
    }
    const nowMs = this.now();
    if (
      this.lastCredentialReverifyAt !== undefined &&
      nowMs - this.lastCredentialReverifyAt <
        (this.options.credentialReverifyMinIntervalMs ??
          GATEWAY_TERMINAL_CREDENTIAL_REVERIFY_INTERVAL_MS)
    ) {
      return;
    }
    this.lastCredentialReverifyAt = nowMs;
    this.credentialReverifyInFlight = true;
    try {
      await this.client.discoverBackends();
      this.emitDiagnostic({ type: "credential-reverify", outcome: "authorized" });
    } catch (error) {
      const outcome = classifyCredentialReverifyError(error);
      this.emitDiagnostic({ type: "credential-reverify", outcome });
      if (outcome === "unauthorized") {
        this.enterTerminalFailure(
          createFailure(
            "gateway-credential-invalid",
            `Gateway credential verification failed after close (${closeEvent.code}${
              closeEvent.reason ? ` ${closeEvent.reason}` : ""
            }).`,
          ),
        );
      }
    } finally {
      this.credentialReverifyInFlight = false;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastInboundAt = this.now();
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    const intervalMs =
      this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (this.state !== "ready" || !this.channel?.isOpen) {
        return;
      }
      if (
        isWebRemoteControlChannelHeartbeatExpired(
          this.lastInboundAt,
          this.now(),
          this.options.heartbeatTimeoutMs ?? WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS,
        )
      ) {
        this.emitDiagnostic({ type: "heartbeat-timeout" });
        const channel = this.channel;
        this.detachChannel();
        try {
          channel?.close();
        } catch {
          // 半开 socket 关闭失败不影响后续重建。
        }
        this.enterDesktopOfflineGrace("heartbeat-timeout");
        return;
      }
      this.pingSequence += 1;
      this.sendFrameOn(this.channel, { type: "ping", id: `p${this.pingSequence}` });
      this.scheduleHeartbeat();
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private closeCurrentChannel(sendClientLeaving: boolean): void {
    const channel = this.channel;
    if (!channel) {
      return;
    }
    if (sendClientLeaving) {
      this.sendFrameOn(channel, { type: "close", reason: "client-leaving" });
    }
    const channelId = channel.channelId;
    this.detachChannel();
    this.channelSockets.delete(channelId);
    try {
      channel.close();
    } catch {
      // 关闭动作是 best-effort；SDK/对端会在控制连接上收到 channel_closed。
    }
  }

  private detachChannel(): void {
    this.clearHelloAckTimer();
    this.stopHeartbeat();
    this.unsubscribeChannelMessage?.();
    this.unsubscribeChannelMessage = undefined;
    this.unsubscribeChannelClose?.();
    this.unsubscribeChannelClose = undefined;
    this.channel = undefined;
    this.channelSocket = undefined;
    this.awaitingHelloAck = false;
  }

  private clearHelloAckTimer(): void {
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer);
      this.helloAckTimer = undefined;
    }
  }

  private clearDesktopOfflineGrace(): void {
    if (this.desktopOfflineGraceTimer) {
      clearTimeout(this.desktopOfflineGraceTimer);
      this.desktopOfflineGraceTimer = undefined;
    }
    this.desktopOfflineFailureEmitted = false;
  }

  private clearTimers(): void {
    this.clearHelloAckTimer();
    this.stopHeartbeat();
    this.clearDesktopOfflineGrace();
    this.clearGatewayUnreachableTimer(false);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private sendFrameOn(channel: GatewayTerminalChannelLike | undefined, frame: unknown): boolean {
    if (!channel?.isOpen) {
      return false;
    }
    try {
      channel.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    if (this.state === "ready") {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.readyWaiters.delete(waiter);
          reject(
            createFailure(
              "connection-recovery-timeout",
              "Gateway terminal transport did not recover before timeout.",
            ),
          );
        }, timeoutMs),
      };
      this.readyWaiters.add(waiter);
    });
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.readyWaiters.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(createFailure("unexpected-error", error.message));
    }
    this.readyWaiters.clear();
  }

  private setState(state: GatewayTerminalTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    this.emitDiagnostic({ type: "state-transition", previousState });
    this.options.onStateChange(state);
    if (state === "ready") {
      this.resolveReadyWaiters();
    }
  }

  private emitDiagnostic(input: GatewayTerminalDiagnosticInput): void {
    if (!this.options.onDiagnostic) {
      return;
    }
    const visibilityState = typeof document === "undefined" ? "unknown" : document.visibilityState;
    const hiddenDurationMs =
      this.hiddenStartedAt !== undefined && visibilityState !== "hidden"
        ? this.now() - this.hiddenStartedAt
        : undefined;
    if (hiddenDurationMs !== undefined) {
      this.hiddenStartedAt = undefined;
    }
    this.options.onDiagnostic({
      ...input,
      state: this.state,
      timestamp: this.now(),
      visibilityState,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(hiddenDurationMs !== undefined ? { hiddenDurationMs } : {}),
    } as GatewayTerminalTransportDiagnostic);
  }
}
