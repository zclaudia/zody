import {
  createWebRemoteControlChannelDataFrame,
  WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import type { RemoteGatewayChannel } from "./remoteGatewayBackendTypes.js";
import { measureUtf8Bytes, prepareOutboundPayload } from "./gatewayDeviceTransportSupport.js";
import type {
  GatewayDevicePayloadSendResult,
  GatewayDeviceTransportSession,
  GatewayDeviceTransportSessionOptions,
} from "./gatewayDeviceTransportTypes.js";

/** 会话与出站 payload 编解码单独拆文件，channel 状态机留在 gatewayDeviceTransport.ts。 */

export interface GatewayDeviceActiveTarget {
  channel: RemoteGatewayChannel;
  ready: boolean;
  closing: boolean;
  appProtocol?: number;
}

export interface GatewayDeviceTransportSessionHost {
  readonly maxBufferedAmountBytes: number;
  getActiveTarget(): GatewayDeviceActiveTarget | undefined;
  bufferedAmount(channelId: string): number;
  logBackpressure(channelId: string, bufferedAmount: number): void;
  logUnsupportedPayload(zcodeType: string, appProtocol: number): void;
  logSendFailure(zcodeType: string, channelId: string, error: unknown): void;
  isDisposed(): boolean;
  setActiveSession(options: GatewayDeviceTransportSessionOptions | undefined): void;
  getActiveSession(): GatewayDeviceTransportSessionOptions | undefined;
  /** 当前 channel 是否 ready；start() 用它决定回 paired 还是 waiting_terminal。 */
  hasReadyChannel(): boolean;
  closeAllForDesktopStopping(): void;
  disconnectCurrent(): void;
}

export function sendGatewayDevicePayload(
  host: GatewayDeviceTransportSessionHost,
  payload: WebRemoteControlAppPayload,
): GatewayDevicePayloadSendResult {
  const target = host.getActiveTarget();
  if (!target || !target.ready || target.closing || target.appProtocol === undefined) {
    return { kind: "unavailable" };
  }
  // 发送前必须先判 isOpen：CLOSING/CLOSED 状态下 send() 会静默丢帧。
  if (!target.channel.isOpen) {
    return { kind: "unavailable" };
  }
  const prepared = prepareOutboundPayload(payload, target.appProtocol);
  if (!prepared) {
    host.logUnsupportedPayload(payload.zcode_type, target.appProtocol);
    return { kind: "unavailable" };
  }
  const json = JSON.stringify(createWebRemoteControlChannelDataFrame(prepared));
  const bytes = measureUtf8Bytes(json);
  if (bytes > WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES) {
    return { kind: "oversize", bytes, maxBytes: WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES };
  }
  const bufferedAmount = host.bufferedAmount(target.channel.channelId);
  if (bufferedAmount > host.maxBufferedAmountBytes) {
    host.logBackpressure(target.channel.channelId, bufferedAmount);
    return { kind: "unavailable" };
  }
  try {
    target.channel.send(json);
  } catch (error) {
    host.logSendFailure(payload.zcode_type, target.channel.channelId, error);
    return { kind: "unavailable" };
  }
  return { kind: "sent", bytes };
}

export function measureGatewayDevicePayloadBytes(payload: WebRemoteControlAppPayload): number {
  return measureUtf8Bytes(JSON.stringify(createWebRemoteControlChannelDataFrame(payload)));
}

export function createGatewayDeviceTransportSession(
  host: GatewayDeviceTransportSessionHost,
  options: GatewayDeviceTransportSessionOptions,
): GatewayDeviceTransportSession {
  return {
    usesGatewayChannel: true,
    start() {
      if (host.isDisposed()) return;
      host.setActiveSession(options);
      if (host.hasReadyChannel()) {
        options.onStateChange("paired");
        options.onSendReady?.({ kind: "same-socket" });
      } else {
        options.onStateChange("waiting_terminal");
      }
    },
    sendPayload(payload) {
      return sendGatewayDevicePayload(host, payload).kind === "sent";
    },
    sendPayloadResult: (payload) => sendGatewayDevicePayload(host, payload),
    measurePayloadBytes: measureGatewayDevicePayloadBytes,
    disconnectClient() {
      if (host.getActiveSession() !== options) return;
      host.disconnectCurrent();
    },
    dispose() {
      // 已被新的 manager runtime 替换的旧会话不能再关闭当前 channel。
      if (host.getActiveSession() !== options) return;
      host.setActiveSession(undefined);
      host.closeAllForDesktopStopping();
    },
  };
}
