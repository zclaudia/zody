import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  EXTENSION_BRIDGE_DEFAULT_PORT,
  EXTENSION_BRIDGE_HOST,
  EXTENSION_BRIDGE_MAX_FRAME_BYTES,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  type ExtensionBridgeClientMessage,
  type ExtensionBridgeServerMessage,
} from "@zcode/shared/browser-extension-transport";
import { BridgeConnection } from "./bridgeConnection.js";
import { createPairingCode } from "./crypto.js";
import {
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_PAIRING_ATTEMPTS,
  DEFAULT_MAX_RESUME_ATTEMPTS,
  DEFAULT_PAIRING_TTL_MS,
  ExtensionBridgeError,
  type ExtensionBridgeConnectionInfo,
  type ExtensionBridgeLogger,
  type ExtensionBridgeRequestMessage,
  type ExtensionBridgeServerOptions,
  type ExtensionPairingSession,
  type ExtensionPairingTicket,
} from "./types.js";

const NOOP_LOGGER: ExtensionBridgeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Desktop Main 的 Chrome 扩展 loopback 桥。
 *
 * 只负责：127.0.0.1 监听、配对/重连鉴权、连接注册、generation 发放与 requestId 传输关联。
 * 不保存 task/session/workspace/tab claim 业务状态（这些属于 Host），也不实现 P1 Host router。
 */
export class ExtensionBridgeServer {
  private wss: WebSocketServer | null = null;
  private actualPort = 0;
  private readonly options: ExtensionBridgeServerOptions;
  private readonly logger: ExtensionBridgeLogger;
  private readonly now: () => number;
  private readonly pairingTtlMs: number;
  private readonly challengeTtlMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxPairingAttempts: number;
  private readonly maxResumeAttempts: number;
  private readonly capabilitiesVersion: number;
  private readonly pairingSessions = new Map<string, ExtensionPairingSession>();
  private readonly pairingTimers = new Map<string, NodeJS.Timeout>();
  private readonly connections = new Map<string, BridgeConnection>();

  constructor(options: ExtensionBridgeServerOptions) {
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.maxPairingAttempts = options.maxPairingAttempts ?? DEFAULT_MAX_PAIRING_ATTEMPTS;
    this.maxResumeAttempts = options.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;
    this.capabilitiesVersion = options.capabilitiesVersion ?? 1;
  }

  /** 端口占用时抛出 `port_in_use`；不会自动扫描其他端口。 */
  async start(): Promise<{ port: number }> {
    if (this.wss) return { port: this.actualPort };
    const port = this.options.port ?? EXTENSION_BRIDGE_DEFAULT_PORT;
    const wss = new WebSocketServer({
      host: EXTENSION_BRIDGE_HOST,
      port,
      maxPayload: EXTENSION_BRIDGE_MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      this.handleSocket(socket, request);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          wss.off("error", onError);
          wss.off("listening", onListening);
        };
        wss.once("error", onError);
        wss.once("listening", onListening);
      });
    } catch (error) {
      wss.close();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        throw new ExtensionBridgeError(
          "port_in_use",
          `extension bridge port ${port} is already in use`,
        );
      }
      throw error;
    }
    const address = wss.address();
    this.actualPort = typeof address === "object" && address ? address.port : port;
    this.wss = wss;
    this.logger.info("[extension-bridge] listening", {
      host: EXTENSION_BRIDGE_HOST,
      port: this.actualPort,
    });
    return { port: this.actualPort };
  }

  async stop(): Promise<void> {
    for (const connection of this.connections.values()) {
      connection.finalize("server_stop");
      connection.socket.close(1001, "server_stop");
    }
    this.connections.clear();
    for (const timer of this.pairingTimers.values()) clearTimeout(timer);
    this.pairingTimers.clear();
    this.pairingSessions.clear();
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  /**
   * 发起窗口生成一次性高熵配对码。同一窗口只保留一个配对会话。
   * 返回值中的 pairingCode 只返回给调用方（Settings），不得写入日志。
   */
  beginPairing(input: { windowId: string }): ExtensionPairingTicket {
    const windowId = input.windowId.trim();
    if (!windowId) throw new ExtensionBridgeError("invalid_state", "windowId is required");
    for (const [id, session] of this.pairingSessions) {
      if (session.windowId !== windowId) continue;
      session.consumed = true;
      this.pairingSessions.delete(id);
      clearTimeout(this.pairingTimers.get(id));
      this.pairingTimers.delete(id);
    }
    const pairingSessionId = randomUUID();
    const pairingCode = createPairingCode();
    const expiresAt = this.now() + this.pairingTtlMs;
    const session: ExtensionPairingSession = {
      pairingSessionId,
      pairingCode,
      windowId,
      expiresAt,
      attempts: 0,
      consumed: false,
    };
    this.pairingSessions.set(pairingSessionId, session);
    const timer = setTimeout(() => {
      if (this.pairingSessions.get(pairingSessionId) !== session) return;
      session.consumed = true;
      this.pairingSessions.delete(pairingSessionId);
      this.pairingTimers.delete(pairingSessionId);
    }, this.pairingTtlMs);
    timer.unref?.();
    this.pairingTimers.set(pairingSessionId, timer);
    this.logger.info("[extension-bridge] pairing session created", {
      pairingSessionId,
      windowId,
      expiresAt,
    });
    return { pairingSessionId, pairingCode, windowId, expiresAt };
  }

  cancelPairing(pairingSessionId: string): void {
    const session = this.pairingSessions.get(pairingSessionId);
    if (session) session.consumed = true;
    this.pairingSessions.delete(pairingSessionId);
    clearTimeout(this.pairingTimers.get(pairingSessionId));
    this.pairingTimers.delete(pairingSessionId);
  }

  getPairingSession(pairingSessionId: string): Omit<ExtensionPairingSession, "pairingCode"> | null {
    const session = this.pairingSessions.get(pairingSessionId);
    if (!session) return null;
    return {
      pairingSessionId: session.pairingSessionId,
      windowId: session.windowId,
      expiresAt: session.expiresAt,
      attempts: session.attempts,
      consumed: session.consumed,
    };
  }

  /** 发起窗口的状态只读取自己的未完成配对；配对码永不从这里返回。 */
  getActivePairingForWindow(windowId: string): {
    pairingSessionId: string;
    windowId: string;
    expiresAt: number;
    extensionId?: string;
    profileInstanceId?: string;
  } | null {
    let selected: ExtensionPairingSession | null = null;
    for (const session of this.pairingSessions.values()) {
      if (session.windowId !== windowId || session.consumed) continue;
      if (session.expiresAt <= this.now()) continue;
      if (!selected || session.expiresAt > selected.expiresAt) selected = session;
    }
    if (!selected) return null;
    return {
      pairingSessionId: selected.pairingSessionId,
      windowId: selected.windowId,
      expiresAt: selected.expiresAt,
      ...(selected.extensionId ? { extensionId: selected.extensionId } : {}),
      ...(selected.profileInstanceId
        ? { profileInstanceId: selected.profileInstanceId }
        : {}),
    };
  }

  /** 实际监听端口；未启动时为 0。 */
  getListeningPort(): number {
    return this.actualPort;
  }

  isConnected(profileInstanceId: string): boolean {
    return this.connections.get(profileInstanceId)?.isAuthenticated() ?? false;
  }

  getConnectionInfo(profileInstanceId: string): ExtensionBridgeConnectionInfo | null {
    return this.connections.get(profileInstanceId)?.info ?? null;
  }

  listConnectedProfiles(): ExtensionBridgeConnectionInfo[] {
    return [...this.connections.values()].map((connection) => connection.info);
  }

  /** 向扩展发送不需要响应的消息（request.cancel / session.detachAll）。 */
  send(profileInstanceId: string, message: ExtensionBridgeServerMessage): boolean {
    const connection = this.connections.get(profileInstanceId);
    if (!connection?.isAuthenticated()) return false;
    return connection.send(message);
  }

  /** 发送带 requestId 的请求，并按连接内 compare-and-delete 等待结果。 */
  async request(
    profileInstanceId: string,
    message: ExtensionBridgeRequestMessage,
    timeoutMs?: number,
  ): Promise<ExtensionBridgeClientMessage> {
    const connection = this.connections.get(profileInstanceId);
    if (!connection?.isAuthenticated()) {
      throw new ExtensionBridgeError("backend_unavailable", "extension profile is not connected");
    }
    return connection.request(message, timeoutMs);
  }

  /**
   * 跨窗口转移：同一 socket 领取新 generation 并改绑目标窗口。
   *
   * 顺序：先 session.detachAll 让扩展关闭 agent tab/释放 user tab，再持久递增 generation、
   * 更新凭据窗口绑定，最后把新 welcome 发给扩展。旧 Host 的 pending 由 controller 的
   * disconnected 事件 settle；旧 socket 的迟到 close 仍按 connectionId 判定。
   */
  async transferBinding(
    profileInstanceId: string,
    targetWindowId: string,
  ): Promise<ExtensionBridgeConnectionInfo> {
    const windowId = targetWindowId.trim();
    if (!windowId) throw new ExtensionBridgeError("invalid_state", "target windowId is required");
    const connection = this.connections.get(profileInstanceId);
    if (!connection?.isAuthenticated()) {
      throw new ExtensionBridgeError("backend_unavailable", "extension profile is not connected");
    }
    connection.send({ type: "session.detachAll", reason: "window_transfer" });
    const generation = await this.options.generationStore.next(profileInstanceId);
    const credential = await this.options.credentialStore.get(profileInstanceId);
    if (credential) {
      await this.options.credentialStore.set({ ...credential, windowId });
    }
    connection.updateBinding(windowId, generation);
    connection.send({
      type: "welcome",
      connectionId: connection.connectionId,
      protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      browserId: `extension:${profileInstanceId}`,
      profileInstanceId,
      generation,
      capabilitiesVersion: this.capabilitiesVersion,
    });
    this.logger.info("[extension-bridge] 连接窗口转移", {
      profileInstanceId,
      windowId,
      generation,
    });
    return connection.info;
  }

  /**
   * Host 退出：对绑定该窗口的 Profile 发送 detachAll，并立即作废旧 generation。
   *
   * socket 保留，但同窗口新 Host 重启后拿到的是新的持久 generation；旧 CLI 持久
   * browserGeneration 不能继续控制该 Profile。新 Host 注册时由 controller 等待本方法完成后
   * 再投递连接快照。
   */
  async invalidateHostBinding(windowId: string): Promise<void> {
    // snapshot：循环内有 await，不能让新连接/替换在迭代过程中改变集合。
    for (const connection of Array.from(this.connections.values())) {
      if (connection.windowId !== windowId || !connection.isAuthenticated()) continue;
      const profileInstanceId = connection.profileInstanceId;
      connection.send({ type: "session.detachAll", reason: "host_exit" });
      const generation = await this.options.generationStore.next(profileInstanceId);
      const credential = await this.options.credentialStore.get(profileInstanceId);
      if (credential) {
        await this.options.credentialStore.set({ ...credential, windowId });
      }
      connection.updateBinding(windowId, generation);
      connection.send({
        type: "welcome",
        connectionId: connection.connectionId,
        protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        browserId: `extension:${profileInstanceId}`,
        profileInstanceId,
        generation,
        capabilitiesVersion: this.capabilitiesVersion,
      });
      this.logger.info("[extension-bridge] Host 退出使绑定失效", {
        profileInstanceId,
        windowId,
        generation,
      });
    }
  }

  /** Host 退出/撤销时先通知 detachAll，再关闭 socket；扩展自身也会在 close 时清理。 */
  disconnect(profileInstanceId: string, reason: string): void {
    const connection = this.connections.get(profileInstanceId);
    if (!connection) return;
    const detachReason =
      reason === "host_exit" || reason === "window_transfer" ? "host_exit" : "socket_closed";
    connection.send({ type: "session.detachAll", reason: detachReason });
    connection.finalize(reason);
    connection.socket.close(1000, reason.slice(0, 123));
  }

  /** 用户撤销配对：删除共享密钥并断开当前连接。 */
  async revokeProfile(profileInstanceId: string): Promise<void> {
    await this.options.credentialStore.delete(profileInstanceId);
    this.disconnect(profileInstanceId, "pairing_revoked");
  }

  private handleSocket(socket: WebSocket, request: IncomingMessage): void {
    const expectedOrigin = `chrome-extension://${this.options.expectedExtensionId}`;
    const origin = request.headers.origin;
    // Origin 只是防御层，不是鉴权事实；不匹配时直接拒绝，缺失时仍要求配对/重连证明。
    if (origin && origin !== expectedOrigin) {
      this.logger.warn("[extension-bridge] rejected unexpected origin");
      socket.close(4403, "origin mismatch");
      return;
    }
    const connection = new BridgeConnection(
      {
        expectedExtensionId: this.options.expectedExtensionId,
        credentialStore: this.options.credentialStore,
        generationStore: this.options.generationStore,
        logger: this.logger,
        now: this.now,
        pairingSessions: this.pairingSessions,
        handshakeTimeoutMs: this.handshakeTimeoutMs,
        challengeTtlMs: this.challengeTtlMs,
        maxPairingAttempts: this.maxPairingAttempts,
        maxResumeAttempts: this.maxResumeAttempts,
        capabilitiesVersion: this.capabilitiesVersion,
        onAuthenticated: (authenticated) => this.handleAuthenticated(authenticated),
        onDisconnected: (disconnected, reason) => this.handleDisconnected(disconnected, reason),
        onExtensionMessage: (profileInstanceId, message) =>
          this.options.onExtensionMessage?.(profileInstanceId, message),
      },
      socket,
    );
    socket.on("message", (data, isBinary) => {
      connection.enqueueMessage(data, isBinary);
    });
    socket.on("close", (code) => {
      connection.finalize(`socket_close:${code}`);
    });
    socket.on("error", () => {
      connection.finalize("socket_error");
    });
  }

  private handleAuthenticated(connection: BridgeConnection): void {
    const profileInstanceId = connection.profileInstanceId;
    const existing = this.connections.get(profileInstanceId);
    if (existing && existing !== connection) {
      // 同一 Profile 只保留一条已认证 socket；换新后旧连接立即失效。
      existing.closeForReplacement();
    }
    this.connections.set(profileInstanceId, connection);
    this.options.onAuthenticated?.(connection.info);
  }

  private handleDisconnected(connection: BridgeConnection, reason: string): void {
    const profileInstanceId = connection.profileInstanceId;
    if (!profileInstanceId) return;
    if (this.connections.get(profileInstanceId) === connection) {
      this.connections.delete(profileInstanceId);
    }
    this.options.onDisconnected?.({
      profileInstanceId,
      connectionId: connection.connectionId,
      reason,
    });
  }
}

export type { ExtensionBridgeConnectionInfo } from "./types.js";
