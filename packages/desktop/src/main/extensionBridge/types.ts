import type {
  ExtensionBridgeClientMessage,
  ExtensionBridgeRequestMessage,
  ExtensionConnectionId,
  ExtensionProfileInstanceId,
  ExtensionTabsCloseMessage,
  ExtensionTabsCreateMessage,
} from "@zody/shared/browser-extension-transport";

/** Bridge 层稳定错误码；Host/UI 不解析 message 文本做流程判断。 */
export type ExtensionBridgeErrorCode =
  | "port_in_use"
  | "not_started"
  | "backend_unavailable"
  | "duplicate_request_id"
  | "request_timeout"
  | "socket_closed"
  | "result_too_large"
  | "invalid_state";

export class ExtensionBridgeError extends Error {
  readonly code: ExtensionBridgeErrorCode;

  constructor(code: ExtensionBridgeErrorCode, message: string) {
    super(message);
    this.name = "ExtensionBridgeError";
    this.code = code;
  }
}

export interface ExtensionBridgeLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** 由 Main 凭据存储持久化的配对记录；含共享密钥，禁止进入日志/发现元数据。 */
export interface ExtensionStoredCredential {
  profileInstanceId: ExtensionProfileInstanceId;
  extensionId: string;
  /** ECDH + HKDF 派生的共享密钥，base64url。 */
  sharedSecret: string;
  clientPublicKey: string;
  pairedAt: string;
  windowId?: string;
}

export interface ExtensionCredentialStore {
  get(profileInstanceId: string): Promise<ExtensionStoredCredential | null>;
  set(credential: ExtensionStoredCredential): Promise<void>;
  delete(profileInstanceId: string): Promise<void>;
  /** 已配对 Profile 的只读快照；设置页只能看到控制器按窗口过滤后的结果。 */
  list(): Promise<ExtensionStoredCredential[]>;
}

/** generation 由 Main 持久化递增；Host 只采用受信握手发放的值。 */
export interface ExtensionGenerationStore {
  next(profileInstanceId: string): Promise<number>;
}

export interface ExtensionPairingSession {
  pairingSessionId: string;
  pairingCode: string;
  windowId: string;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
  /** hello 到达后写入；只对发起窗口展示，配对码仍只在 beginPairing 返回值中。 */
  extensionId?: string;
  profileInstanceId?: string;
}

export interface ExtensionPairingTicket {
  pairingSessionId: string;
  pairingCode: string;
  windowId: string;
  expiresAt: number;
}

export interface ExtensionBridgeConnectionInfo {
  profileInstanceId: ExtensionProfileInstanceId;
  connectionId: ExtensionConnectionId;
  browserId: string;
  generation: number;
  extensionId: string;
  /** 该 Profile 绑定的 Zody 窗口；连接事件只投递给这个窗口的 Host。 */
  windowId: string;
}

export interface ExtensionBridgeServerOptions {
  /** 默认 127.0.0.1；生产由 Settings 固定端口，测试可传 0 领取随机端口。 */
  port?: number;
  /** manifest key 推导出的固定扩展 ID；hello 与 Origin 都要匹配。 */
  expectedExtensionId: string;
  credentialStore: ExtensionCredentialStore;
  generationStore: ExtensionGenerationStore;
  logger?: ExtensionBridgeLogger;
  now?: () => number;
  pairingTtlMs?: number;
  challengeTtlMs?: number;
  handshakeTimeoutMs?: number;
  maxPairingAttempts?: number;
  maxResumeAttempts?: number;
  capabilitiesVersion?: number;
  /** 首次认证 / 重连认证成功后触发；Host 据此领取 generation/descriptor。 */
  onAuthenticated?: (connection: ExtensionBridgeConnectionInfo) => void;
  onDisconnected?: (info: {
    profileInstanceId: string;
    connectionId: string;
    reason: string;
  }) => void;
  /** 已认证连接上收到的非结果消息（cdp.event / target.*）；P0 不接 Host router。 */
  onExtensionMessage?: (profileInstanceId: string, message: ExtensionBridgeClientMessage) => void;
}

export type {
  ExtensionBridgeRequestMessage,
  ExtensionTabsCloseMessage,
  ExtensionTabsCreateMessage,
};

export const DEFAULT_PAIRING_TTL_MS = 2 * 60 * 1000;
export const DEFAULT_CHALLENGE_TTL_MS = 30 * 1000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_MAX_PAIRING_ATTEMPTS = 5;
export const DEFAULT_MAX_RESUME_ATTEMPTS = 3;
export const EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS = 30 * 1000;
