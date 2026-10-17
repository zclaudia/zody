import {
  gateWebRemoteControlAppPayloadVersion,
  parseWebRemoteControlAppPayload,
  parseWebRemoteControlChannelFrameJson,
  WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
  type WebRemoteControlChannelFrame,
  type WebRemoteControlChannelFrameOf,
} from "@zcode/shared";
import type {
  RemoteGatewayBackendLogger,
  RemoteGatewayChannelMessage,
} from "./remoteGatewayBackendTypes.js";
import { isRawTransportCandidate } from "./gatewayDeviceTransportSupport.js";
import type { GatewayDeviceTransportSessionOptions } from "./gatewayDeviceTransportTypes.js";

/** 入站帧解析与分发；channel 记录生命周期仍在 gatewayDeviceTransport.ts。 */

export interface GatewayDeviceInboundChannel {
  readonly channelId: string;
  readonly ready: boolean;
  readonly closing: boolean;
  readonly appProtocol?: number;
  markInbound(atMs: number): void;
  sendFrame(frame: unknown): boolean;
  finishClosing(): void;
  close(reason: string): void;
}

export interface GatewayDeviceInboundHost {
  now(): number;
  readonly logger: RemoteGatewayBackendLogger;
  getSession(): GatewayDeviceTransportSessionOptions | undefined;
  onHello(
    channel: GatewayDeviceInboundChannel,
    frame: WebRemoteControlChannelFrameOf<"hello">,
  ): void;
}

function readSafePayloadType(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const zcodeType = (payload as { zcode_type?: unknown }).zcode_type;
  return typeof zcodeType === "string" ? zcodeType : undefined;
}

function handleDataFrame(
  channel: GatewayDeviceInboundChannel,
  frame: WebRemoteControlChannelFrameOf<"data">,
  host: GatewayDeviceInboundHost,
): void {
  if (!channel.ready || channel.appProtocol === undefined) {
    return;
  }
  const session = host.getSession();
  if (isRawTransportCandidate(frame.payload) && session?.onRawTransportPayload?.(frame.payload)) {
    return;
  }
  const payload = parseWebRemoteControlAppPayload(frame.payload);
  if (!payload) {
    host.logger.warn("[remote-access] invalid gateway app payload dropped", {
      channelId: channel.channelId,
      zcodeType: readSafePayloadType(frame.payload),
    });
    return;
  }
  const appProtocol = channel.appProtocol;
  const gate = gateWebRemoteControlAppPayloadVersion(payload, appProtocol);
  if (gate.kind === "unsupported-version") {
    // 只发诊断帧，不改变连接状态和页面（方案「版本兼容」）。
    host.logger.warn("[remote-access] app payload outside negotiated version dropped", {
      channelId: channel.channelId,
      zcodeType: gate.offendingType,
      field: gate.offendingField,
      appProtocol,
    });
    channel.sendFrame(gate.protocolError);
    return;
  }
  session?.onPayload(payload);
}

function handleFrame(
  channel: GatewayDeviceInboundChannel,
  frame: WebRemoteControlChannelFrame,
  host: GatewayDeviceInboundHost,
): void {
  switch (frame.type) {
    case "hello":
      if (channel.ready) {
        host.logger.warn("[remote-access] duplicate gateway channel hello dropped", {
          channelId: channel.channelId,
        });
        return;
      }
      host.onHello(channel, frame);
      return;
    case "data":
      handleDataFrame(channel, frame, host);
      return;
    case "ping":
      if (channel.ready) {
        channel.sendFrame({ type: "pong", id: frame.id });
      }
      return;
    case "pong":
      return;
    case "close":
      host.logger.info("[remote-access] gateway channel close received", {
        channelId: channel.channelId,
        reason: frame.reason,
      });
      channel.close(`peer-close:${frame.reason}`);
      return;
    case "close_ack":
    case "hello_ack":
    case "protocol_error":
      // close_ack 只在 closing 阶段处理；其余两种方向不对，按未知帧丢弃。
      host.logger.debug("[remote-access] unexpected gateway channel frame", {
        channelId: channel.channelId,
        frameType: frame.type,
      });
      return;
  }
}

export function handleGatewayChannelMessage(
  channel: GatewayDeviceInboundChannel,
  message: RemoteGatewayChannelMessage,
  host: GatewayDeviceInboundHost,
): void {
  channel.markInbound(host.now());
  if (message.binary || typeof message.data !== "string") {
    // 协议只使用 text 帧；binary 帧不进入业务层。
    host.logger.debug("[remote-access] binary gateway channel frame dropped", {
      channelId: channel.channelId,
    });
    return;
  }
  const parsed = parseWebRemoteControlChannelFrameJson(message.data);
  if (parsed.kind === "discarded") {
    if (parsed.reason === "oversize") {
      host.logger.warn("[remote-access] oversize gateway channel frame dropped", {
        channelId: channel.channelId,
        bytes: parsed.bytes,
        maxBytes: WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
      });
      host.getSession()?.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
    } else {
      host.logger.debug("[remote-access] invalid gateway channel frame dropped", {
        channelId: channel.channelId,
        reason: parsed.reason,
        frameType: parsed.frameType,
        bytes: parsed.bytes,
      });
    }
    return;
  }
  if (channel.closing) {
    // 替换时序第 1 步：closing 期间除 close_ack 外的入站帧一律丢弃。
    if (parsed.frame.type === "close_ack") {
      channel.finishClosing();
    }
    return;
  }
  handleFrame(channel, parsed.frame, host);
}
