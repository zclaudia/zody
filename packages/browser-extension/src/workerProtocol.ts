import type {
  ExtensionAttachTarget,
  ExtensionClaimDecision,
  ExtensionTabClass,
  ExtensionTargetDetachReason,
  ExtensionTargetRef,
} from "@zody/shared/browser-extension-transport";

/** Offscreen document ↔ MV3 service worker 的内部控制消息。 */
export type WorkerOperation =
  | "tabs.list"
  | "tabs.create"
  | "tabs.close"
  | "debugger.attach"
  | "debugger.detach"
  | "cdp.request"
  | "request.cancel"
  | "detachAll"
  | "claim.request"
  | "claim.cancel"
  | "claim.list"
  | "claim.decide"
  // Chrome offscreen document 不暴露 chrome.storage；由 service worker 代理持久化。
  | "storage.get"
  | "storage.set"
  | "storage.remove";

export interface WorkerRequest {
  target: "worker";
  op: WorkerOperation;
  payload?: unknown;
}

export interface WorkerError {
  /** CDP 数字错误码（chrome.debugger.sendCommand 的 error.code）。 */
  code?: number;
  message: string;
  /** 非 CDP 失败时映射到 transport failure code。 */
  failureCode?: "target_unavailable" | "invalid_message" | "internal_error";
}

export interface WorkerResponse {
  ok: boolean;
  data?: unknown;
  error?: WorkerError;
}

export interface NativeAttachment {
  attachmentId: string;
  browserId: string;
  browserGeneration: number;
  connectionId: string;
  nativeTabId: number;
  /** 由 Host 在 attach 时声明；扩展清理时据此决定关闭还是仅 detach。 */
  tabClass: ExtensionTabClass;
  targetId?: string;
}

export interface TabsListPayload {
  tabs: Array<{
    nativeTabId: number;
    active: boolean;
    url: string;
    title: string;
    windowId?: number;
  }>;
}

export interface TabsCreatePayload {
  /** 协议层只允许后台创建；保留字段便于 worker 显式记录约束。 */
  active: false;
  url?: string;
}

export interface TabsClosePayload {
  nativeTabId: number;
}

export interface AttachPayload {
  target: ExtensionAttachTarget;
}

export interface DetachPayload {
  targetRef: ExtensionTargetRef;
}

export interface CdpRequestPayload {
  /** Host 命令在扩展 wire 上的 requestId；cancel 只按该 id 终止 evaluate。 */
  requestId: string;
  targetRef: ExtensionTargetRef;
  method: string;
  params: Record<string, unknown>;
  targetId?: string;
}

export interface DetachAllPayload {
  reason: ExtensionTargetDetachReason;
}

export interface CancelPayload {
  targetRequestId: string;
}

/** Pending claim 由 service worker 投影给 Popup；授权事实仍由 Host 决定。 */
export interface PendingClaimRecord {
  claimId: string;
  nativeTabId: number;
  expiresAt: number;
}

export interface ClaimRequestPayload {
  claimId: string;
  nativeTabId: number;
  expiresAt: number;
}

export interface ClaimCancelPayload {
  claimId: string;
}

export interface ClaimDecidePayload {
  claimId: string;
  decision: ExtensionClaimDecision;
  /** 防止 Popup 过期页面替新 claim 作决定。 */
  nativeTabId: number;
}

export interface ClaimListPayload {
  claims: Array<
    PendingClaimRecord & {
      title?: string;
      url?: string;
    }
  >;
}

export interface StorageGetPayload {
  key: string;
}

export interface StorageSetPayload {
  key: string;
  value: unknown;
}

export interface StorageRemovePayload {
  key: string;
}

/** Service worker → offscreen document 的 Chrome 事件投影。 */
export type NativeBridgeMessage =
  | {
      target: "offscreen";
      type: "native.event";
      attachment: NativeAttachment;
      method: string;
      params: Record<string, unknown>;
    }
  | {
      target: "offscreen";
      type: "native.detached";
      attachment: NativeAttachment;
      reason: ExtensionTargetDetachReason;
    }
  | {
      target: "offscreen";
      type: "native.targetClosed";
      attachment: NativeAttachment;
    }
  | {
      target: "offscreen";
      type: "native.claimDecision";
      claimId: string;
      nativeTabId: number;
      decision: ExtensionClaimDecision;
    };

/** Popup → service worker 的控制消息。 */
export type PopupBridgeMessage =
  | {
      target: "worker";
      type: "pairing.submit";
      pairingCode: string;
      pairingSessionId: string;
    }
  | { target: "worker"; type: "reconnect" };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
