import {
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  parseExtensionBridgeServerMessage,
  serializeExtensionBridgeMessage,
  type ExtensionBridgeClientMessage,
  type ExtensionBridgeServerMessage,
  type ExtensionHelloMessage,
} from "@zody/shared/browser-extension-transport";
import {
  createClientResumeProof,
  createPairingProof,
  deriveSharedSecret,
  generateClientKeyPair,
  verifyServerResumeProof,
  type StoredClientKeyPair,
} from "./crypto.js";
import { routeHostCommand } from "./hostCommandRouter.js";
import { log } from "./log.js";
import { projectNativeMessage } from "./nativeEvents.js";
import {
  STORAGE_KEYS,
  type BridgeClientStorage,
  type BridgeStatus,
  type StoredPairingChallenge,
} from "./storage.js";
import type { NativeBridgeMessage, WorkerRequest, WorkerResponse } from "./workerProtocol.js";

const OPEN_STATE = 1;

/** 与真实 WebSocket 解耦，便于测试注入；扩展运行时使用浏览器原生 WebSocket。 */
export interface BridgeSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ExtensionBridgeClientOptions {
  storage: BridgeClientStorage;
  extensionId: string;
  extensionVersion: string;
  createSocket: (url: string) => BridgeSocketLike;
  sendToWorker: (message: WorkerRequest) => Promise<WorkerResponse>;
  onStatus: (status: BridgeStatus) => void;
  defaultPort?: number;
  now?: () => number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/**
 * Offscreen document 的唯一连接状态机：配对 / 双向 resume / 消息路由。
 * 不保存业务队列、session 或 workspace；Host 命令只做传输转发。
 */
export class ExtensionBridgeClient {
  private readonly storage: BridgeClientStorage;
  private readonly now: () => number;
  private profileInstanceId = "";
  private identityPromise: Promise<void> | null = null;
  private keyPair: StoredClientKeyPair | null = null;
  private sharedSecret: string | null = null;
  private pendingPairing: StoredPairingChallenge | null = null;
  private resumeChallenge: { connectionId: string; nonce: string } | null = null;
  private socket: BridgeSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private connecting = false;
  /** 每次主动替换/停止连接递增；阻止进行中的旧 connect 在 await 后创建 socket。 */
  private connectionEpoch = 0;
  private serverMessageChain: Promise<void> = Promise.resolve();
  private lastFatalMessage: string | null = null;

  constructor(private readonly options: ExtensionBridgeClientOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.ensureIdentity();
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connectionEpoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "client_stop");
  }

  forceReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.connectionEpoch += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "manual_reconnect");
    // 重新读取 bridgePort 后立即连接，不等待上一次的退避计时器。
    void this.connect().catch((error: unknown) => {
      log.error(
        "failed to reconnect bridge client",
        error instanceof Error ? error.name : "unknown",
      );
    });
  }

  /** Popup 提交配对码；只对当前服务端下发且用户核对过的 pairingSessionId 生效。 */
  async submitPairingCode(pairingCode: string, pairingSessionId: string): Promise<void> {
    const pending = this.pendingPairing;
    if (!pending || pending.pairingSessionId !== pairingSessionId) {
      throw new Error("pairing challenge is not active");
    }
    if (pending.expiresAt <= this.now()) throw new Error("pairing challenge expired");
    if (!this.keyPair) throw new Error("client key pair is missing");
    const trimmed = pairingCode.replace(/\s+/g, "");
    if (!trimmed) throw new Error("pairing code is empty");
    const derived = await deriveSharedSecret(this.keyPair.privateJwk, pending.serverPublicKey);
    // 先本地保存派生密钥；若 welcome 丢失，重连仍可用它完成 resume。
    this.sharedSecret = derived;
    await this.storage.set(STORAGE_KEYS.sharedSecret, derived);
    const proof = await createPairingProof(trimmed, pending.nonce);
    this.sendClient({ type: "pairing.proof", pairingSessionId, nonce: pending.nonce, proof });
    this.emitStatus({ state: "connecting" });
  }

  handleNativeMessage(message: NativeBridgeMessage): void {
    this.sendClient(projectNativeMessage(message));
  }

  private ensureIdentity(): Promise<void> {
    if (this.identityPromise) return this.identityPromise;
    this.identityPromise = this.loadIdentity().catch((error: unknown) => {
      this.identityPromise = null;
      throw error;
    });
    return this.identityPromise;
  }

  private async loadIdentity(): Promise<void> {
    const existingProfile = await this.storage.get<string>(STORAGE_KEYS.profileInstanceId);
    if (existingProfile) {
      this.profileInstanceId = existingProfile;
    } else {
      this.profileInstanceId = crypto.randomUUID();
      await this.storage.set(STORAGE_KEYS.profileInstanceId, this.profileInstanceId);
    }
    const existingKeyPair = await this.storage.get<StoredClientKeyPair>(STORAGE_KEYS.clientKeyPair);
    if (existingKeyPair?.privateJwk && existingKeyPair.publicKey) {
      this.keyPair = existingKeyPair;
    } else {
      this.keyPair = await generateClientKeyPair();
      await this.storage.set(STORAGE_KEYS.clientKeyPair, this.keyPair);
    }
    this.sharedSecret = (await this.storage.get<string>(STORAGE_KEYS.sharedSecret)) ?? null;
    this.pendingPairing =
      (await this.storage.get<StoredPairingChallenge>(STORAGE_KEYS.pairing)) ?? null;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket || this.connecting) return;
    this.connecting = true;
    const epoch = ++this.connectionEpoch;
    try {
      await this.ensureIdentity();
      const port =
        (await this.storage.get<number>(STORAGE_KEYS.bridgePort)) ?? this.options.defaultPort;
      // await 期间可能被 stop/forceReconnect，旧调用不得再创建 socket。
      if (this.stopped || this.socket || epoch !== this.connectionEpoch) return;
      if (!port || !Number.isInteger(port) || port <= 0) {
        this.emitStatus({ state: "error", message: "invalid bridge port" });
        return;
      }
      this.emitStatus({ state: "connecting" });
      const socket = this.options.createSocket(`ws://127.0.0.1:${port}`);
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.reconnectAttempt = 0;
        const hello: ExtensionHelloMessage = {
          type: "hello",
          protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          extensionId: this.options.extensionId,
          extensionVersion: this.options.extensionVersion,
          profileInstanceId: this.profileInstanceId,
          clientPublicKey: this.keyPair?.publicKey ?? "",
        };
        this.sendClient(hello);
      };
      socket.onmessage = (event) => {
        // 旧 socket 的消息在新连接建立后必须完全丢弃，不能触发 detachAll/状态变化。
        if (this.socket !== socket) return;
        this.serverMessageChain = this.serverMessageChain
          .then(() => {
            if (this.socket !== socket) return undefined;
            return this.handleServerRaw(event.data);
          })
          .catch((error: unknown) => {
            log.warn("failed to handle server message", error instanceof Error ? error.name : "");
          });
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        void this.handleSocketClosed(event.code);
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        log.warn("bridge socket error");
      };
    } finally {
      this.connecting = false;
    }
  }

  private async handleSocketClosed(code: number): Promise<void> {
    // socket 关闭后扩展本地解除全部调试；用户 tab 留在 Chrome，agent tab 由 Host 侧决定。
    try {
      await this.options.sendToWorker({
        target: "worker",
        op: "detachAll",
        payload: { reason: "socket_closed" },
      });
    } catch {
      log.debug("detachAll after socket close was not delivered");
    }
    if (this.lastFatalMessage) {
      const message = this.lastFatalMessage;
      this.lastFatalMessage = null;
      this.emitStatus({ state: "error", message });
    } else {
      this.emitStatus({ state: "disconnected", message: `socket closed (${code})` });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const base = this.options.reconnectDelayMs ?? 1_000;
    const maximum = this.options.maxReconnectDelayMs ?? 15_000;
    const delay = Math.min(base * 2 ** (this.reconnectAttempt - 1), maximum);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error: unknown) => {
        log.error(
          "failed to reconnect bridge client",
          error instanceof Error ? error.name : "unknown",
        );
      });
    }, delay);
  }

  private async handleServerRaw(raw: unknown): Promise<void> {
    if (typeof raw !== "string") {
      log.warn("bridge server sent a non-text frame");
      return;
    }
    let message: ExtensionBridgeServerMessage;
    try {
      message = parseExtensionBridgeServerMessage(raw);
    } catch (error) {
      log.warn("bridge server message rejected", error instanceof Error ? error.name : "unknown");
      this.socket?.close(4002, "invalid_server_message");
      return;
    }
    await this.handleServerMessage(message);
  }

  private async handleServerMessage(message: ExtensionBridgeServerMessage): Promise<void> {
    switch (message.type) {
      case "pairing.required": {
        this.pendingPairing = {
          pairingSessionId: message.pairingSessionId,
          nonce: message.nonce,
          serverPublicKey: message.serverPublicKey,
          expiresAt: message.expiresAt,
        };
        await this.storage.set(STORAGE_KEYS.pairing, this.pendingPairing);
        this.emitStatus({
          state: "pairing",
          pairingSessionId: message.pairingSessionId,
          message: "Enter the pairing code shown in Zody",
        });
        return;
      }
      case "resume.challenge": {
        if (!this.sharedSecret) {
          this.lastFatalMessage =
            "paired credential is missing; revoke pairing in Zody and pair again";
          this.socket?.close(4002, "missing_shared_secret");
          return;
        }
        this.resumeChallenge = {
          connectionId: message.connectionId,
          nonce: message.nonce,
        };
        const proof = await createClientResumeProof(
          this.sharedSecret,
          message.nonce,
          message.connectionId,
        );
        this.sendClient({
          type: "resume.proof",
          connectionId: message.connectionId,
          proof,
        });
        this.emitStatus({ state: "connecting" });
        return;
      }
      case "welcome": {
        if (message.serverProof) {
          const challenge = this.resumeChallenge;
          const verified =
            this.sharedSecret &&
            challenge &&
            challenge.connectionId === message.connectionId &&
            (await verifyServerResumeProof(
              this.sharedSecret,
              challenge.nonce,
              message.connectionId,
              message.serverProof,
            ));
          if (!verified) {
            this.lastFatalMessage = "server resume proof is invalid";
            this.socket?.close(4002, "server_proof_invalid");
            return;
          }
          // 新连接不恢复旧 attachment；清理完成前不能处理后续 Host 命令。
          await this.options
            .sendToWorker({
              target: "worker",
              op: "detachAll",
              payload: { reason: "socket_closed" },
            })
            .catch(() => undefined);
        }
        this.resumeChallenge = null;
        this.pendingPairing = null;
        await this.storage.remove(STORAGE_KEYS.pairing);
        this.emitStatus({
          state: "connected",
          generation: message.generation,
          message: `connected to Zody (generation ${message.generation})`,
        });
        return;
      }
      case "fatalError": {
        log.warn("bridge fatal error", message.code);
        if (message.code === "pairing_failed" && message.retryable) {
          // 可重试的配对失败：保持 lastFatalMessage 为空，重连后会拿到新的 nonce。
          this.emitStatus({ state: "pairing", message: message.message });
        } else {
          this.lastFatalMessage = `${message.code}: ${message.message}`;
          this.emitStatus({ state: "error", message: this.lastFatalMessage });
        }
        return;
      }
      default: {
        // 修复原因：服务端消息此前在 offscreen 串行处理。一个触发 confirm/alert 的
        // Input/evaluate 命令会阻塞 chrome.debugger.sendCommand，导致 handleJavaScriptDialog、
        // detach 等解阻塞命令排在它后面，页面永远无法恢复。握手消息仍需串行；认证后的
        // Host 命令由 Host 的 per-tab 队列保证顺序，offscreen 只按 requestId 并发转发。
        //
        // session.detachAll 是唯一例外：它是生命周期屏障，必须 await 到 worker 清理完成，
        // 后续 welcome/create/attach 才能进入同一条串行链。
        const route = routeHostCommand(
          {
            callWorker: (request: WorkerRequest) => this.callWorker(request),
            sendClient: (clientMessage: ExtensionBridgeClientMessage) =>
              this.sendClient(clientMessage),
          },
          message,
        );
        if (message.type === "session.detachAll") {
          await route;
        } else {
          void route;
        }
        return;
      }
    }
  }

  private async callWorker(message: WorkerRequest): Promise<WorkerResponse> {
    try {
      return await this.options.sendToWorker(message);
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error instanceof Error ? error.message : "worker call failed",
          failureCode: "internal_error",
        },
      };
    }
  }

  private sendClient(message: ExtensionBridgeClientMessage): void {
    if (!this.socket || this.socket.readyState !== OPEN_STATE) {
      log.debug("dropping client message; socket is not open", message.type);
      return;
    }
    try {
      this.socket.send(serializeExtensionBridgeMessage(message));
    } catch (error) {
      log.warn(
        "failed to serialize client message",
        message.type,
        error instanceof Error ? error.name : "",
      );
    }
  }

  private emitStatus(partial: Omit<BridgeStatus, "updatedAt" | "profileInstanceId">): void {
    this.options.onStatus({
      ...partial,
      profileInstanceId: this.profileInstanceId || undefined,
      updatedAt: this.now(),
    });
  }
}
