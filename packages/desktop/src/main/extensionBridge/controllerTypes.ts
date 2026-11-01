import type {
  ExtensionBridgeClientMessage,
  ExtensionBridgeRequestMessage,
  ExtensionBridgeServerMessage,
} from "@zcode/shared/browser-extension-transport";
import type { BrowserExtensionBridgeStatus } from "@zcode/shared";
import type { ExtensionStoredCredential } from "./types.js";

/** Main 侧 Host 投递句柄；Host 退出时必须 unregister，避免事件写进已退出进程。 */
export interface ExtensionHostEndpoint {
  postMessage(message: unknown): void;
}

export interface ExtensionConnectionSnapshot {
  profileInstanceId: string;
  browserId: string;
  generation: number;
  connectionId: string;
  windowId: string;
}

export interface ExtensionTransportHostRequest {
  op: "list" | "request" | "send";
  profileInstanceId?: string;
  message?: ExtensionBridgeRequestMessage | ExtensionBridgeServerMessage;
}

export interface ExtensionTransportHostResult {
  ok: boolean;
  connections?: ExtensionConnectionSnapshot[];
  message?: ExtensionBridgeClientMessage;
  error?: { code: string; message: string };
}

export interface ExtensionBridgeController {
  start(): Promise<{ ok: boolean; port?: number; error?: string }>;
  stop(): Promise<void>;
  registerHost(windowId: number, host: ExtensionHostEndpoint): void;
  unregisterHost(windowId: number): void;
  handleHostRequest(
    windowId: number,
    request: ExtensionTransportHostRequest,
  ): Promise<ExtensionTransportHostResult>;
  /** Settings P3 使用的入口；配对码只返回给发起窗口。 */
  beginPairing(windowId: number): {
    pairingSessionId: string;
    pairingCode: string;
    expiresAt: number;
  } | null;
  cancelPairing(windowId: number, pairingSessionId: string): void;
  /** 当前窗口可见的 Profile（本窗口绑定 + 孤儿）与发起窗口的配对状态。 */
  getStatus(windowId: number): Promise<BrowserExtensionBridgeStatus>;
  /** 只更新当前窗口的默认 backend；null 表示恢复 IAB 默认。 */
  setDefaultBrowserId(
    windowId: number,
    browserId: string | null,
  ): Promise<{ ok: boolean; error?: string }>;
  listCredentials(): Promise<ExtensionStoredCredential[]>;
  revokeProfile(profileInstanceId: string): Promise<void>;
  /** 设置页撤销入口：只允许当前窗口或孤儿 Profile，避免跨活动窗口越权。 */
  revokeProfileForWindow(
    profileInstanceId: string,
    windowId: number,
  ): Promise<{ ok: boolean; error?: string }>;
  /**
   * 把已配对 Profile 的绑定显式转移到目标窗口。旧窗口立即失效，connection 领取更大的
   * 持久 generation。设置页入口还要求 Profile 对目标窗口可见。
   */
  transferProfile(
    profileInstanceId: string,
    targetWindowId: number,
  ): Promise<{ ok: boolean; error?: string }>;
  transferProfileToWindow(
    profileInstanceId: string,
    targetWindowId: number,
  ): Promise<{ ok: boolean; error?: string }>;
  /** 新端口启动成功后才切换；失败时恢复旧端口，不自动扫描。 */
  setPort(port: number): Promise<{ ok: boolean; port?: number; error?: string }>;
  getConfiguredPort(): number;
  /** 测试/诊断用：关闭指定 Profile 的 socket，触发扩展本地清理和重连。 */
  disconnectProfile(profileInstanceId: string, reason: string): void;
}
