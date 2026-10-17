import { createHash } from "node:crypto";
import {
  isWebRemoteControlChannelProtocolVersionSupported,
  negotiateWebRemoteControlAppProtocol,
  WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION,
  type WebRemoteControlAppProtocolRange,
  type WebRemoteControlAppProtocolUpgradeTarget,
  type WebRemoteControlChannelFrameOf,
} from "@zcode/shared";
import type { RemoteGatewayBackendLogger } from "./remoteGatewayBackendTypes.js";

/**
 * `hello` 校验、appProtocol 协商与替换时序（方案「关闭语义」第 1-4 步）。
 *
 * 单独拆文件是为了让 gatewayDeviceTransport.ts 只保留 channel 生命周期与发送入口；
 * 本模块只依赖 host 回调，不持有 socket 或 session。
 */

export interface GatewayDeviceHelloRecord {
  readonly channelId: string;
  ready: boolean;
  closing: boolean;
  clientInstanceId?: string;
  appProtocol?: number;
}

export interface GatewayDeviceHelloHost<T extends GatewayDeviceHelloRecord> {
  readonly logger: RemoteGatewayBackendLogger;
  readonly appProtocolRange: WebRemoteControlAppProtocolRange;
  readonly desktopAppVersion: string;
  readonly closeAckTimeoutMs: number;
  getActive(): T | undefined;
  /**
   * 同步完成替换时序第 1 步（旧 channel 进入 closing）和第 3 步（新 channel 挂接）。
   * 调用方必须在这两个动作之间不做任何 await。
   */
  activate(record: T, previous: T | undefined): void;
  sendFrame(record: T, frame: unknown): boolean;
  sendClose(
    record: T,
    reason: "incompatible-version" | "superseded",
    upgrade?: WebRemoteControlAppProtocolUpgradeTarget,
  ): boolean;
  close(record: T, reason: string): void;
  clearHelloTimeout(record: T): void;
  stopHeartbeat(record: T): void;
  startHeartbeat(record: T): void;
  /** 替换时序第 4 步的兜底计时。 */
  scheduleClose(record: T, reason: string, delayMs: number): void;
  notifyPaired(replaced: boolean): void;
}

export function acceptGatewayChannelHello<T extends GatewayDeviceHelloRecord>(
  record: T,
  frame: WebRemoteControlChannelFrameOf<"hello">,
  host: GatewayDeviceHelloHost<T>,
): void {
  if (!isWebRemoteControlChannelProtocolVersionSupported(frame.protocolVersion)) {
    const upgrade: WebRemoteControlAppProtocolUpgradeTarget =
      frame.protocolVersion < WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION ? "mobile" : "desktop";
    host.logger.info("[remote-access] gateway channel hello rejected", {
      channelId: record.channelId,
      reason: "protocol-version",
      upgrade,
    });
    host.sendClose(record, "incompatible-version", upgrade);
    host.close(record, "incompatible-version");
    return;
  }
  const negotiation = negotiateWebRemoteControlAppProtocol(
    host.appProtocolRange,
    frame.appProtocol,
  );
  if (!negotiation.ok) {
    host.logger.info("[remote-access] gateway channel hello rejected", {
      channelId: record.channelId,
      reason: "app-protocol",
      upgrade: negotiation.upgrade,
    });
    host.sendClose(record, "incompatible-version", negotiation.upgrade);
    host.close(record, "incompatible-version");
    return;
  }

  const previous = host.getActive();
  record.ready = true;
  record.clientInstanceId = frame.clientInstanceId;
  record.appProtocol = negotiation.appProtocol;
  host.clearHelloTimeout(record);
  if (previous && previous !== record) {
    // 第 1 步：旧 channel 同步进入 closing，不再接收除 close_ack 外的帧。
    previous.closing = true;
    host.stopHeartbeat(previous);
    host.clearHelloTimeout(previous);
  }
  // 第 3 步：新 channel 立即挂接为当前 channel，出站数据从这一刻起只发往新 channel。
  host.activate(record, previous);
  if (previous && previous !== record) {
    beginSupersededClosing(previous, record, host);
  }

  host.sendFrame(record, {
    type: "hello_ack",
    appProtocol: negotiation.appProtocol,
    desktopAppVersion: host.desktopAppVersion,
  });
  host.startHeartbeat(record);
  host.logger.info("[remote-access] gateway channel attached", {
    channelId: record.channelId,
    // 日志只记录 sha256 前 8 位（方案「日志」）。
    clientInstanceId: createHash("sha256").update(frame.clientInstanceId).digest("hex").slice(0, 8),
    appProtocol: negotiation.appProtocol,
  });
  // hello_ack 与 onSendReady 都不等待旧 channel 确认。
  host.notifyPaired(previous !== undefined);
}

/**
 * 第 2/4 步。同一 clientInstanceId 是同一部手机重连：不发 close，直接异步关闭；
 * 不同 id 才发 close{superseded}，并等待 close_ack 或 2 秒兜底。
 */
function beginSupersededClosing<T extends GatewayDeviceHelloRecord>(
  previous: T,
  current: T,
  host: GatewayDeviceHelloHost<T>,
): void {
  const silent = !previous.ready || previous.clientInstanceId === current.clientInstanceId;
  if (silent) {
    queueMicrotask(() => host.close(previous, "superseded-silent"));
    return;
  }
  if (!host.sendClose(previous, "superseded")) {
    host.close(previous, "superseded-send-failed");
    return;
  }
  host.scheduleClose(previous, "superseded-ack-timeout", host.closeAckTimeoutMs);
}
