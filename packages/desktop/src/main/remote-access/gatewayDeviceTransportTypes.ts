import type { GatewayBackendOptions } from "@zclaudia/gateway-backend";
import type { WebRemoteControlAppPayload, WebRemoteControlAppProtocolRange } from "@zcode/shared";
import type { WebRemoteControlDeviceTransportState } from "../webRemoteControlTransport.js";
import type {
  RemoteGatewayBackendLogger,
  RemoteGatewayChannel,
  RemoteGatewayChannelClosedInfo,
  RemoteGatewayChannelOffer,
} from "./remoteGatewayBackendTypes.js";

/**
 * GatewayDeviceTransport 的公共契约（T3.3）。
 *
 * 单独拆文件的原因与 T3.2 相同：`gatewayDeviceTransport.ts` 只保留帧处理和替换时序，
 * 受 lint `max-lines` 限制。manager 通过结构类型消费 `GatewayDeviceTransportSession`。
 */

export type GatewayDevicePayloadSendResult =
  | { kind: "sent"; bytes: number }
  | { kind: "unavailable" }
  | { kind: "oversize"; bytes: number; maxBytes: number };

/**
 * manager 的 `createDeviceTransport` 每次 start 拿到的会话视图。
 *
 * 它不持有 channel：channel 的唯一所有者是 App 级 `GatewayDeviceTransport`。
 * `dispose()` 只解绑本会话的回调并用 `close{desktop-stopping}` 关闭当前 channel，
 * transport 本身可以在下一次 start 时复用。
 */
export interface GatewayDeviceTransportSession {
  /** 告诉 manager：没有 relay 配对/二维码阶段（T5.1 删除 relay 后即可去掉）。 */
  readonly usesGatewayChannel: true;
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult(payload: WebRemoteControlAppPayload): GatewayDevicePayloadSendResult;
  measurePayloadBytes(payload: WebRemoteControlAppPayload): number;
  disconnectClient(): void;
  dispose(): void;
}

/** 回调形状与 `WebRemoteControlDeviceTransportOptions` 的对应字段一致，避免 transport 依赖 relay 类型。 */
export interface GatewayDeviceTransportSessionOptions {
  onStateChange(state: WebRemoteControlDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  onError?(error: Error): void;
}

/** SDK `socketFactory` 的精确形状；数据 socket 在这里被扣住以读取 `bufferedAmount`。 */
export type GatewayDeviceSocketFactory = NonNullable<GatewayBackendOptions["socketFactory"]>;
export type GatewayDeviceSocket = ReturnType<GatewayDeviceSocketFactory>;

export interface GatewayDeviceTransportDependencies {
  logger: RemoteGatewayBackendLogger;
  /** 写入 `hello_ack.desktopAppVersion`。 */
  desktopAppVersion: string;
  /** 单测注入 fake socket；生产默认使用 Electron 的全局 WebSocket。 */
  createSocket?: GatewayDeviceSocketFactory;
  now?: () => number;
  helloTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  closeAckTimeoutMs?: number;
  maxBufferedAmountBytes?: number;
  /** 桌面支持的 appProtocol 区间；单测用它覆盖两种 upgrade 方向。 */
  appProtocolRange?: WebRemoteControlAppProtocolRange;
}

export interface GatewayDeviceTransport {
  /** 传给 `RemoteGatewayBackendDependencies.socketFactory`。 */
  readonly socketFactory: GatewayDeviceSocketFactory;
  /** 传给 `RemoteGatewayBackend.setChannelHandler`；同步注册，绝不 await。 */
  handleChannel(channel: RemoteGatewayChannel, offer: RemoteGatewayChannelOffer): void;
  /** 订阅 `RemoteGatewayBackend.onChannelClosed`，拿到 gateway 下发的关闭原因。 */
  handleGatewayChannelClosed(info: RemoteGatewayChannelClosedInfo): void;
  createSession(options: GatewayDeviceTransportSessionOptions): GatewayDeviceTransportSession;
  /** 进程退出兜底：关闭所有 channel 并清空计时器。 */
  dispose(): void;
}
