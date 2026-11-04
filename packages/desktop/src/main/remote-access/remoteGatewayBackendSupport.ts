import { GatewayBackend, type HttpServeResponse } from "@zclaudia/gateway-backend";
import {
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
  WEB_REMOTE_CONTROL_BACKEND_CAPABILITY,
  WEB_REMOTE_CONTROL_UI_BACKEND_CAPABILITY,
  tryNormalizeRemoteAccessGatewayUrl,
  webRemoteControlChannelCloseFrameSchema,
  type RemoteAccessGatewayConnectionErrorReason,
  type RemoteAccessGatewayConnectionStatus,
  type WebRemoteControlAppProtocolUpgradeTarget,
  type WebRemoteControlChannelCloseReason,
} from "@zcode/shared";
import type {
  RemoteGatewayBackendConfig,
  RemoteGatewayBackendSdkFactory,
  RemoteGatewayBackendSdkLike,
  RemoteGatewayChannel,
  RemoteGatewayHttpHandler,
} from "./remoteGatewayBackendTypes.js";

/** 配置归一化 + 错误映射 + close 帧编码；与连接生命周期分开，便于单测和复用。 */

export interface ResolvedConfig {
  enabled: boolean;
  baseUrl: string;
  namespace: string;
  credential?: string;
  complete: boolean;
  /** 包含凭证，只用于相等判断，绝不写日志。 */
  signature: string;
}

export function resolveConfig(
  config: RemoteGatewayBackendConfig,
  allowInsecureTransport: boolean,
): ResolvedConfig {
  const rawUrl = config.gatewayUrl.trim();
  const endpoint = rawUrl
    ? tryNormalizeRemoteAccessGatewayUrl(rawUrl, { allowInsecureTransport })
    : undefined;
  const baseUrl = endpoint?.baseUrl ?? "";
  const namespace = config.namespace.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE;
  const credential = config.credential?.trim() || undefined;
  return {
    enabled: config.enabled,
    baseUrl,
    namespace,
    credential,
    complete: baseUrl !== "" && credential !== undefined,
    signature: JSON.stringify([config.enabled, baseUrl, namespace, credential ?? ""]),
  };
}

/** backend 能力位：远控是基础能力，UI capability 只在真正接入 provider 时附加。 */
export function resolveGatewayCapabilities(hasMobileUiHandler: boolean): string[] {
  return hasMobileUiHandler
    ? [WEB_REMOTE_CONTROL_BACKEND_CAPABILITY, WEB_REMOTE_CONTROL_UI_BACKEND_CAPABILITY]
    : [WEB_REMOTE_CONTROL_BACKEND_CAPABILITY];
}

/**
 * 旧 SDK 代次的兜底响应。
 *
 * 配置换代、测试连接、REPLACED、异常关闭和 dispose 后，旧 SDK 可能仍有在途的
 * `http_request`。此时不能把旧制品当成本代次内容返回，也不能落入通用代理；
 * 用有界的 503 + no-store 让手机按网络错误处理。
 */
export function createStaleMobileUiHttpResponse(): HttpServeResponse {
  return { status: 503, headers: { "cache-control": "no-store" } };
}

/**
 * 把 provider 绑定到单次 SDK 实例：只有仍为 active 且 backend 未 disposed 的代次
 * 才能读取 UI 制品。
 */
export function registerMobileUiHttpHandler(
  sdk: RemoteGatewayBackendSdkLike,
  handler: RemoteGatewayHttpHandler,
  isCurrentSdk: () => boolean,
): void {
  sdk.serveHttp((request) =>
    isCurrentSdk() ? handler(request) : createStaleMobileUiHttpResponse(),
  );
}

/**
 * 发送应用层 `close` 帧。`incompatible-version` 必须带 `upgrade`，否则 schema 直接拒绝，
 * 避免把缺少升级方向的帧发给手机。
 */
export function sendRemoteGatewayChannelClose(
  channel: RemoteGatewayChannel,
  reason: WebRemoteControlChannelCloseReason,
  upgrade?: WebRemoteControlAppProtocolUpgradeTarget,
): void {
  const frame = webRemoteControlChannelCloseFrameSchema.parse({
    type: "close",
    reason,
    ...(upgrade !== undefined ? { upgrade } : {}),
  });
  channel.send(JSON.stringify(frame));
}

/** SDK 错误码 → UI 状态。未列出的码（handshake timeout、protocol error 等）统一归入 unreachable。 */
export function mapBackendError(
  error: { code: string } | null,
): RemoteAccessGatewayConnectionErrorReason | undefined {
  switch (error?.code) {
    case "REPLACED":
      return "replaced";
    case "AUTH_FAILED":
      return "credential-invalid";
    case "GATEWAY_REJECTED":
    case "GATEWAY_UNREACHABLE":
    case "HANDSHAKE_TIMEOUT":
    case "PROTOCOL_ERROR":
    case "CONNECT_FAILED":
      return "unreachable";
    default:
      return undefined;
  }
}

export function isSameStatus(
  left: RemoteAccessGatewayConnectionStatus,
  right: RemoteAccessGatewayConnectionStatus,
): boolean {
  if (left.state !== right.state) {
    return false;
  }
  if (left.state === "online" && right.state === "online") {
    return left.backendId === right.backendId && left.epoch === right.epoch;
  }
  if (left.state === "error" && right.state === "error") {
    return left.reason === right.reason;
  }
  return true;
}

export const defaultCreateBackend: RemoteGatewayBackendSdkFactory = (options) =>
  new GatewayBackend(options);
