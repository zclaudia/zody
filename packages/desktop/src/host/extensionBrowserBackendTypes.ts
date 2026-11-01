import type { BrowserCommandResult, BrowserViewportSize } from "@zcode/shared";
import type { ExtensionTargetRef } from "@zcode/shared/browser-extension-transport";
import type { ExtensionCdpTransport } from "../browser-core/extensionCdpTransport.js";
import type {
  ExtensionHostConnection,
  ExtensionTransportClient,
} from "./extensionTransportClient.js";

/** Host 业务 owner 的会话/workspace 标识；window 由每个 window-scoped Host 隐含。 */
export interface ExtensionExecutionContext {
  requestId: string;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  sessionContext: "live" | "cached";
}

/** execute 必须携带调用方显式选择的 backend identity；router 不做隐式 fallback。 */
export interface ExtensionBackendExecuteContext extends ExtensionExecutionContext {
  browserId: string;
  /** 显式 backend identity；缺失时 backend 必须 fail closed，不能猜代次。 */
  browserGeneration?: number;
}

export interface ExtensionTabOwner {
  sessionId: string;
  workspaceKey: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface ExtensionManagedTab {
  /** Host 生成的公开 logical id；Chrome native tabId 不跨 backend 暴露。 */
  tabId: string;
  profileInstanceId: string;
  browserId: string;
  browserGeneration: number;
  connectionId: string;
  nativeTabId: number;
  attachmentId: string;
  targetRef: ExtensionTargetRef;
  owner: ExtensionTabOwner;
  tabClass: "agent" | "user";
  active: boolean;
  lifecycle?: "active" | "deliverable" | "handoff";
  url: string;
  title: string;
  viewport: BrowserViewportSize;
  closed: boolean;
}

export interface ExtensionBrowserBackendLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ExtensionBrowserBackendDeps {
  transport: ExtensionTransportClient;
  cdp: ExtensionCdpTransport;
  logger?: ExtensionBrowserBackendLogger;
  /** 页面 readyState 轮询预算。 */
  navigationTimeoutMs?: number;
  createTabId?: () => string;
  /** pending claim 的 Host TTL；默认 2 分钟，测试/真实 smoke 可缩短。 */
  claimTtlMs?: number;
  /** 用户 tab 上 JS dialog 未处理时的默认拒绝预算；默认 25 秒。 */
  dialogTimeoutMs?: number;
  /** 普通命令预算；默认 30 秒，claimTab 不进入该预算。 */
  commandTimeoutMs?: number;
  now?: () => number;
}

export interface ExtensionCommandContext extends ExtensionBackendExecuteContext {
  connection: ExtensionHostConnection;
}

export type ExtensionCommandResult = BrowserCommandResult;

export class ExtensionOperationError extends Error {
  constructor(
    readonly code:
      | "backend_unavailable"
      | "capability_unsupported"
      | "target_unavailable"
      | "navigation_blocked"
      | "authorization_required"
      | "permission_denied"
      | "timeout"
      | "cancelled"
      | "duplicate_request_id"
      | "execution_error",
    message: string,
    readonly sideEffect: "none" | "uncertain" = "none",
  ) {
    super(message);
    this.name = "ExtensionOperationError";
  }
}
