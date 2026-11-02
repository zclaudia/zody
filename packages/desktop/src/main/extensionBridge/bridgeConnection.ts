/* eslint-disable max-lines -- 单条已认证 socket 的握手/证明/消息路由必须共享同一状态机与 compare-and-delete 语义。 */
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import { WebSocket as WebSocketValue } from "ws";
import {
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  ExtensionBridgeProtocolError,
  isExtensionBridgeResultMessage,
  parseExtensionBridgeClientMessage,
  serializeExtensionBridgeMessage,
  type ExtensionBridgeClientMessage,
  type ExtensionBridgeFatalErrorCode,
  type ExtensionBridgeServerMessage,
  type ExtensionHelloMessage,
  type ExtensionPairingProofMessage,
  type ExtensionResumeProofMessage,
  type ExtensionWelcomeMessage,
} from "@zody/shared/browser-extension-transport";
import {
  createClientResumeProof,
  createNonce,
  createPairingProof,
  createServerEcdhSession,
  createServerResumeProof,
  verifyProof,
  type ServerEcdhSession,
} from "./crypto.js";
import { pickActivePairingSession, rawDataToBuffer } from "./connectionHelpers.js";
import { PendingRequestRegistry } from "./pendingRequests.js";
import {
  ExtensionBridgeError,
  type ExtensionBridgeConnectionInfo,
  type ExtensionBridgeLogger,
  type ExtensionBridgeRequestMessage,
  type ExtensionCredentialStore,
  type ExtensionGenerationStore,
  type ExtensionPairingSession,
  type ExtensionStoredCredential,
} from "./types.js";

export type BridgeConnectionPhase =
  | "awaiting_hello"
  | "awaiting_pairing_proof"
  | "awaiting_resume_proof"
  | "authenticated"
  | "closed";

export interface BridgeConnectionDeps {
  expectedExtensionId: string;
  credentialStore: ExtensionCredentialStore;
  generationStore: ExtensionGenerationStore;
  logger: ExtensionBridgeLogger;
  now: () => number;
  pairingSessions: Map<string, ExtensionPairingSession>;
  handshakeTimeoutMs: number;
  challengeTtlMs: number;
  maxPairingAttempts: number;
  maxResumeAttempts: number;
  capabilitiesVersion: number;
  onAuthenticated: (connection: BridgeConnection) => void;
  onDisconnected: (connection: BridgeConnection, reason: string) => void;
  onExtensionMessage?: (profileInstanceId: string, message: ExtensionBridgeClientMessage) => void;
}

/** 单条已认证/握手中的 WebSocket 状态机。业务 owner 不在这一层。 */
export class BridgeConnection {
  readonly socket: WebSocket;
  phase: BridgeConnectionPhase = "awaiting_hello";
  connectionId = "";
  profileInstanceId = "";
  extensionId = "";
  generation = 0;
  /** 配对时由审核窗口写入，重连时从持久凭据恢复；空值不投递给任何 Host。 */
  windowId = "";

  private readonly pendingRequests = new PendingRequestRegistry();
  private serverEcdh: ServerEcdhSession | null = null;
  private clientPublicKey = "";
  private nonce = "";
  private pairingSessionId = "";
  private expiresAt = 0;
  private attempts = 0;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private finalized = false;
  /** 单连接串行处理；异步 dispatch 不能与后续帧交叉推进握手状态。 */
  private messageChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: BridgeConnectionDeps,
    socket: WebSocket,
  ) {
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      this.fail("unauthorized", "handshake timeout");
    }, deps.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
  }

  get info(): ExtensionBridgeConnectionInfo {
    return {
      profileInstanceId: this.profileInstanceId,
      connectionId: this.connectionId,
      browserId: `extension:${this.profileInstanceId}`,
      generation: this.generation,
      extensionId: this.extensionId,
      windowId: this.windowId,
    };
  }

  isAuthenticated(): boolean {
    return this.phase === "authenticated";
  }

  /** socket 入口只入队，不直接并发调用异步 dispatch。 */
  enqueueMessage(data: RawData, isBinary: boolean): void {
    this.messageChain = this.messageChain
      .then(() => this.handleMessage(data, isBinary))
      .catch((error: unknown) => {
        this.deps.logger.error("[extension-bridge] 串行消息处理失败", {
          connectionId: this.connectionId || undefined,
          error: error instanceof Error ? error.name : "unknown",
        });
      });
  }

  async handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (this.finalized) return;
    if (isBinary) {
      this.fail("invalid_message", "binary frames are not supported");
      return;
    }
    const buffer = rawDataToBuffer(data);
    let message: ExtensionBridgeClientMessage;
    try {
      message = parseExtensionBridgeClientMessage(buffer.toString("utf8"));
    } catch (error) {
      const code =
        error instanceof ExtensionBridgeProtocolError && error.code === "frame_too_large"
          ? "frame_too_large"
          : "invalid_message";
      this.fail(code, error instanceof Error ? error.message : "invalid frame");
      return;
    }
    try {
      await this.dispatch(message, buffer.byteLength);
    } catch (error) {
      this.deps.logger.error("[extension-bridge] 处理消息失败", {
        connectionId: this.connectionId || undefined,
        extensionId: this.extensionId || undefined,
        error: error instanceof Error ? error.name : "unknown",
      });
      this.fail("internal_error", "unexpected bridge error");
    }
  }

  send(message: ExtensionBridgeServerMessage): boolean {
    if (this.finalized || this.socket.readyState !== WebSocketValue.OPEN) return false;
    try {
      this.socket.send(serializeExtensionBridgeMessage(message));
      return true;
    } catch {
      return false;
    }
  }

  request(
    message: ExtensionBridgeRequestMessage,
    timeoutMs?: number,
  ): Promise<ExtensionBridgeClientMessage> {
    if (this.phase !== "authenticated") {
      return Promise.reject(
        new ExtensionBridgeError(
          "backend_unavailable",
          "extension connection is not authenticated",
        ),
      );
    }
    return this.pendingRequests.request(message, (request) => this.send(request), timeoutMs);
  }

  /**
   * 窗口转移：socket/connectionId 仍是同一物理连接，只更新绑定窗口与 generation。
   * 旧 generation 的 Host binding 与 wire TargetRef 因此全部失效。
   */
  updateBinding(windowId: string, generation: number): void {
    this.windowId = windowId;
    this.generation = generation;
  }

  closeForReplacement(): void {
    this.deps.logger.info("[extension-bridge] 关闭被替换的已认证连接", {
      connectionId: this.connectionId,
      generation: this.generation,
    });
    this.finalize("replaced");
    this.socket.close(4001, "replaced");
  }

  finalize(reason: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.phase = "closed";
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.pendingRequests.rejectAll(
      new ExtensionBridgeError("socket_closed", "extension socket closed"),
    );
    this.deps.onDisconnected(this, reason);
  }

  private async dispatch(message: ExtensionBridgeClientMessage, byteLength: number): Promise<void> {
    if (!this.deps.expectedExtensionId) {
      this.fail("internal_error", "bridge extension id is not configured");
      return;
    }
    if (!this.isAuthenticated()) {
      await this.dispatchHandshake(message);
      return;
    }
    if (isExtensionBridgeResultMessage(message)) {
      this.pendingRequests.settle(message, byteLength);
      return;
    }
    if (
      message.type === "cdp.event" ||
      message.type === "target.updated" ||
      message.type === "target.detached" ||
      message.type === "target.closed" ||
      // P2：用户在 Popup 的授权决定属于 Host 业务状态，Main 只转发，不解释。
      message.type === "claim.decision"
    ) {
      this.deps.onExtensionMessage?.(this.profileInstanceId, message);
      return;
    }
    this.fail("unauthorized", `message ${message.type} is not allowed after authentication`);
  }

  private async dispatchHandshake(message: ExtensionBridgeClientMessage): Promise<void> {
    if (message.type === "hello") {
      if (this.phase !== "awaiting_hello") {
        this.fail("unauthorized", "hello is only accepted once");
        return;
      }
      await this.handleHello(message);
      return;
    }
    if (message.type === "pairing.proof") {
      if (this.phase !== "awaiting_pairing_proof") {
        this.fail("unauthorized", "pairing proof is not expected");
        return;
      }
      await this.handlePairingProof(message);
      return;
    }
    if (message.type === "resume.proof") {
      if (this.phase !== "awaiting_resume_proof") {
        this.fail("unauthorized", "resume proof is not expected");
        return;
      }
      await this.handleResumeProof(message);
      return;
    }
    this.fail("unauthorized", `message ${message.type} is not allowed before authentication`);
  }

  private async handleHello(message: ExtensionHelloMessage): Promise<void> {
    if (message.protocolVersion !== EXTENSION_BRIDGE_PROTOCOL_VERSION) {
      this.fail("protocol_version_mismatch", "unsupported extension bridge protocol version");
      return;
    }
    if (message.extensionId !== this.deps.expectedExtensionId) {
      this.fail("unauthorized", "unexpected extension id");
      return;
    }
    this.extensionId = message.extensionId;
    this.profileInstanceId = message.profileInstanceId;
    this.clientPublicKey = message.clientPublicKey;
    this.connectionId = randomUUID();

    const credential = await this.deps.credentialStore.get(this.profileInstanceId);
    if (credential) {
      this.windowId = credential.windowId ?? "";
      this.nonce = createNonce();
      this.expiresAt = this.deps.now() + this.deps.challengeTtlMs;
      this.phase = "awaiting_resume_proof";
      this.send({
        type: "resume.challenge",
        connectionId: this.connectionId,
        nonce: this.nonce,
        expiresAt: this.expiresAt,
      });
      return;
    }

    const session = pickActivePairingSession(this.deps.pairingSessions, this.deps.now());
    if (!session) {
      this.fail("pairing_unavailable", "no active pairing session in Zody");
      return;
    }
    if (session.expiresAt <= this.deps.now()) {
      this.deps.pairingSessions.delete(session.pairingSessionId);
      this.fail("pairing_expired", "pairing session expired");
      return;
    }
    this.pairingSessionId = session.pairingSessionId;
    // 设置页需要在用户输入配对码前核对扩展 ID 与本机 Profile 实例；配对码始终只返回
    // beginPairing 的发起窗口，不会进入 status。
    session.extensionId = message.extensionId;
    session.profileInstanceId = message.profileInstanceId;
    this.windowId = session.windowId;
    this.nonce = createNonce();
    this.expiresAt = session.expiresAt;
    this.serverEcdh = createServerEcdhSession();
    this.phase = "awaiting_pairing_proof";
    this.send({
      type: "pairing.required",
      pairingSessionId: session.pairingSessionId,
      nonce: this.nonce,
      serverPublicKey: this.serverEcdh.publicKey,
      expiresAt: session.expiresAt,
    });
  }

  private async handlePairingProof(message: ExtensionPairingProofMessage): Promise<void> {
    if (message.pairingSessionId !== this.pairingSessionId || message.nonce !== this.nonce) {
      this.fail("pairing_failed", "pairing proof does not match the active challenge");
      return;
    }
    if (this.expiresAt <= this.deps.now()) {
      this.deps.pairingSessions.delete(message.pairingSessionId);
      this.fail("pairing_expired", "pairing session expired");
      return;
    }
    const session = this.deps.pairingSessions.get(message.pairingSessionId);
    if (!session || session.consumed) {
      this.fail("pairing_expired", "pairing session is no longer active");
      return;
    }
    session.attempts += 1;
    if (session.attempts > this.deps.maxPairingAttempts) {
      this.deps.pairingSessions.delete(session.pairingSessionId);
      this.fail("pairing_attempts_exceeded", "too many pairing attempts");
      return;
    }
    if (!verifyProof(createPairingProof(session.pairingCode, this.nonce), message.proof)) {
      this.fail("pairing_failed", "pairing proof rejected", true);
      return;
    }
    if (!this.serverEcdh) {
      this.fail("internal_error", "pairing ECDH state is missing");
      return;
    }
    const sharedSecret = this.serverEcdh.deriveSharedSecret(this.clientPublicKey);
    const credential: ExtensionStoredCredential = {
      profileInstanceId: this.profileInstanceId,
      extensionId: this.extensionId,
      sharedSecret,
      clientPublicKey: this.clientPublicKey,
      pairedAt: new Date(this.deps.now()).toISOString(),
      windowId: session.windowId,
    };
    await this.deps.credentialStore.set(credential);
    this.deps.pairingSessions.delete(session.pairingSessionId);
    await this.completeAuthentication();
  }

  private async handleResumeProof(message: ExtensionResumeProofMessage): Promise<void> {
    if (message.connectionId !== this.connectionId) {
      this.fail("resume_failed", "resume proof connection id mismatch");
      return;
    }
    if (this.expiresAt <= this.deps.now()) {
      this.fail("resume_failed", "resume challenge expired");
      return;
    }
    this.attempts += 1;
    if (this.attempts > this.deps.maxResumeAttempts) {
      this.fail("resume_failed", "too many resume attempts");
      return;
    }
    const credential = await this.deps.credentialStore.get(this.profileInstanceId);
    if (!credential) {
      this.fail("resume_failed", "profile is not paired");
      return;
    }
    const expected = createClientResumeProof(
      credential.sharedSecret,
      this.nonce,
      this.connectionId,
    );
    if (!verifyProof(expected, message.proof)) {
      this.fail("resume_failed", "resume proof rejected");
      return;
    }
    const serverProof = createServerResumeProof(
      credential.sharedSecret,
      this.nonce,
      this.connectionId,
    );
    await this.completeAuthentication(serverProof);
  }

  private async completeAuthentication(serverProof?: string): Promise<void> {
    const generation = await this.deps.generationStore.next(this.profileInstanceId);
    this.generation = generation;
    this.phase = "authenticated";
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    const welcome: ExtensionWelcomeMessage = {
      type: "welcome",
      connectionId: this.connectionId,
      protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      browserId: `extension:${this.profileInstanceId}`,
      profileInstanceId: this.profileInstanceId,
      generation,
      capabilitiesVersion: this.deps.capabilitiesVersion,
      ...(serverProof ? { serverProof } : {}),
    };
    this.deps.onAuthenticated(this);
    this.send(welcome);
    this.deps.logger.info("[extension-bridge] 扩展连接已认证", {
      connectionId: this.connectionId,
      generation,
      resume: Boolean(serverProof),
    });
  }

  private fail(code: ExtensionBridgeFatalErrorCode, message: string, retryable?: boolean): void {
    this.send({
      type: "fatalError",
      code,
      message,
      ...(retryable === undefined ? {} : { retryable }),
    });
    this.finalize(`fatal:${code}`);
    this.socket.close(4002, code);
  }
}
