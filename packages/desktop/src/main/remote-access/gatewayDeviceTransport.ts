import {
  WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE,
  WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS,
  type WebRemoteControlAppProtocolRange,
  type WebRemoteControlAppProtocolUpgradeTarget,
  type WebRemoteControlChannelCloseReason,
} from "@zcode/shared";
import type {
  RemoteGatewayBackendLogger,
  RemoteGatewayChannel,
  RemoteGatewayChannelClosedInfo,
  RemoteGatewayChannelOffer,
} from "./remoteGatewayBackendTypes.js";
import { sendRemoteGatewayChannelClose } from "./remoteGatewayBackendSupport.js";
import {
  createGatewayDeviceSocketRegistry,
  defaultGatewayDeviceSocketFactory,
} from "./gatewayDeviceTransportSocketRegistry.js";
import { WEB_REMOTE_CONTROL_CHANNEL_MAX_BUFFERED_BYTES } from "./gatewayDeviceTransportSupport.js";
import {
  handleGatewayChannelMessage,
  type GatewayDeviceInboundChannel,
  type GatewayDeviceInboundHost,
} from "./gatewayDeviceTransportInbound.js";
import {
  acceptGatewayChannelHello,
  type GatewayDeviceHelloHost,
} from "./gatewayDeviceTransportHello.js";
import {
  createGatewayDeviceTransportSession,
  type GatewayDeviceTransportSessionHost,
} from "./gatewayDeviceTransportSession.js";
import type {
  GatewayDeviceTransport,
  GatewayDeviceTransportDependencies,
  GatewayDeviceTransportSession,
  GatewayDeviceTransportSessionOptions,
} from "./gatewayDeviceTransportTypes.js";

export type * from "./gatewayDeviceTransportTypes.js";
export { WEB_REMOTE_CONTROL_CHANNEL_MAX_BUFFERED_BYTES } from "./gatewayDeviceTransportSupport.js";

export function createGatewayDeviceTransport(
  dependencies: GatewayDeviceTransportDependencies,
): GatewayDeviceTransport {
  const logger: RemoteGatewayBackendLogger = dependencies.logger;
  const now = dependencies.now ?? Date.now;
  const helloTimeoutMs = dependencies.helloTimeoutMs ?? WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS;
  const heartbeatIntervalMs =
    dependencies.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs =
    dependencies.heartbeatTimeoutMs ?? WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS;
  const closeAckTimeoutMs =
    dependencies.closeAckTimeoutMs ?? WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS;
  const maxBufferedAmountBytes =
    dependencies.maxBufferedAmountBytes ?? WEB_REMOTE_CONTROL_CHANNEL_MAX_BUFFERED_BYTES;
  const appProtocolRange: WebRemoteControlAppProtocolRange =
    dependencies.appProtocolRange ?? WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE;
  const sockets = createGatewayDeviceSocketRegistry(
    dependencies.createSocket ?? defaultGatewayDeviceSocketFactory,
  );

  interface ChannelRecord {
    readonly channelId: string;
    channel: RemoteGatewayChannel;
    clientInstanceId?: string;
    appProtocol?: number;
    ready: boolean;
    closing: boolean;
    finalized: boolean;
    lastInboundAt: number;
    pingCounter: number;
    inbound?: GatewayDeviceInboundChannel;
    helloTimeout?: ReturnType<typeof setTimeout>;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    closeAckTimeout?: ReturnType<typeof setTimeout>;
  }
  const channelRecords = new Map<string, ChannelRecord>();
  let activeRecord: ChannelRecord | undefined;
  let activeSession: GatewayDeviceTransportSessionOptions | undefined;
  let disposed = false;

  function clearHelloTimeout(record: ChannelRecord): void {
    if (record.helloTimeout) {
      clearTimeout(record.helloTimeout);
      record.helloTimeout = undefined;
    }
  }

  function stopHeartbeat(record: ChannelRecord): void {
    if (record.heartbeatTimer) {
      clearInterval(record.heartbeatTimer);
      record.heartbeatTimer = undefined;
    }
  }

  function finalizeRecord(record: ChannelRecord, reason: string): void {
    if (record.finalized) return;
    const wasActiveReady = record === activeRecord && record.ready;
    record.finalized = true;
    clearHelloTimeout(record);
    stopHeartbeat(record);
    if (record.closeAckTimeout) {
      clearTimeout(record.closeAckTimeout);
      record.closeAckTimeout = undefined;
    }
    channelRecords.delete(record.channel.channelId);
    sockets.release(record.channel.channelId);
    if (record === activeRecord) {
      activeRecord = undefined;
      if (wasActiveReady && !disposed && !record.closing) {
        logger.info("[remote-access] gateway channel disconnected", {
          channelId: record.channel.channelId,
          reason,
        });
        activeSession?.onStateChange("waiting_terminal");
      }
    }
  }

  function closeRecord(record: ChannelRecord, reason: string): void {
    finalizeRecord(record, reason);
    if (!record.channel.isOpen) {
      return;
    }
    try {
      record.channel.close();
    } catch (error) {
      logger.warn("[remote-access] failed to close gateway channel", {
        channelId: record.channel.channelId,
        error,
      });
    }
  }

  function sendFrame(record: ChannelRecord, frame: unknown): boolean {
    if (!record.channel.isOpen) {
      return false;
    }
    try {
      record.channel.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      logger.warn("[remote-access] failed to send gateway channel frame", {
        channelId: record.channel.channelId,
        error,
      });
      return false;
    }
  }

  function sendCloseFrame(
    record: ChannelRecord,
    reason: WebRemoteControlChannelCloseReason,
    upgrade?: WebRemoteControlAppProtocolUpgradeTarget,
  ): boolean {
    if (!record.channel.isOpen) {
      return false;
    }
    try {
      sendRemoteGatewayChannelClose(record.channel, reason, upgrade);
      return true;
    } catch (error) {
      logger.warn("[remote-access] failed to send gateway channel close", {
        channelId: record.channel.channelId,
        reason,
        error,
      });
      return false;
    }
  }

  function emitPairedState(replaced: boolean): void {
    const session = activeSession;
    if (!session) return;
    session.onStateChange("paired");
    session.onSendReady?.({ kind: replaced ? "reconnected-socket" : "same-socket" });
  }

  const inboundHost: GatewayDeviceInboundHost = {
    now,
    logger,
    getSession() {
      return activeSession;
    },
    onHello(channel, frame) {
      const record = channelRecords.get(channel.channelId);
      if (record) {
        acceptGatewayChannelHello(record, frame, helloHost);
      }
    },
  };

  /** 入站解析模块只需要 channel 的安全视图，不能直接拿到 transport 的闭包状态。 */
  function createInboundView(record: ChannelRecord): GatewayDeviceInboundChannel {
    return {
      channelId: record.channel.channelId,
      get ready() {
        return record.ready;
      },
      get closing() {
        return record.closing;
      },
      get appProtocol() {
        return record.appProtocol;
      },
      markInbound(atMs) {
        record.lastInboundAt = atMs;
      },
      sendFrame(frame) {
        return sendFrame(record, frame);
      },
      finishClosing() {
        closeRecord(record, "superseded-acknowledged");
      },
      close(reason) {
        closeRecord(record, reason);
      },
    };
  }

  function startHeartbeat(record: ChannelRecord): void {
    stopHeartbeat(record);
    record.lastInboundAt = now();
    record.heartbeatTimer = setInterval(() => {
      if (record.finalized || record.closing || record !== activeRecord) return;
      const timestamp = now();
      if (timestamp - record.lastInboundAt >= heartbeatTimeoutMs) {
        logger.warn("[remote-access] gateway channel heartbeat timed out", {
          channelId: record.channel.channelId,
        });
        closeRecord(record, "heartbeat-timeout");
        return;
      }
      record.pingCounter += 1;
      if (
        !sendFrame(record, { type: "ping", id: `${timestamp.toString(36)}-${record.pingCounter}` })
      ) {
        closeRecord(record, "heartbeat-send-failed");
      }
    }, heartbeatIntervalMs);
  }

  const helloHost: GatewayDeviceHelloHost<ChannelRecord> = {
    logger,
    appProtocolRange,
    desktopAppVersion: dependencies.desktopAppVersion,
    closeAckTimeoutMs,
    getActive() {
      return activeRecord;
    },
    activate(record, previous) {
      activeRecord = record;
      if (previous && previous !== record) {
        // 第 1 步：旧 channel 同步进入 closing，不再接收除 close_ack 外的帧。
        previous.closing = true;
        stopHeartbeat(previous);
        clearHelloTimeout(previous);
      }
    },
    sendFrame,
    sendClose(record, reason, upgrade) {
      return sendCloseFrame(record, reason, upgrade);
    },
    close(record, reason) {
      closeRecord(record, reason);
    },
    clearHelloTimeout,
    stopHeartbeat,
    startHeartbeat,
    scheduleClose(record, reason, delayMs) {
      record.closeAckTimeout = setTimeout(() => closeRecord(record, reason), delayMs);
    },
    notifyPaired(replaced) {
      emitPairedState(replaced);
    },
  };

  function closeAllForDesktopStopping(): void {
    for (const record of Array.from(channelRecords.values())) {
      if (record.ready) {
        sendCloseFrame(record, "desktop-stopping");
      }
      closeRecord(record, "desktop-stopping");
    }
  }

  const sessionHost: GatewayDeviceTransportSessionHost = {
    maxBufferedAmountBytes,
    getActiveTarget() {
      const record = activeRecord;
      return record
        ? {
            channel: record.channel,
            ready: record.ready,
            closing: record.closing,
            appProtocol: record.appProtocol,
          }
        : undefined;
    },
    bufferedAmount(channelId) {
      return sockets.bufferedAmount(channelId);
    },
    logBackpressure(channelId, bufferedAmount) {
      logger.warn("[remote-access] gateway channel backpressure", {
        channelId,
        bufferedAmount,
        maxBufferedAmountBytes,
      });
    },
    logUnsupportedPayload(zcodeType, appProtocol) {
      logger.debug("[remote-access] app payload outside negotiated version not sent", {
        zcodeType,
        appProtocol,
      });
    },
    logSendFailure(zcodeType, channelId, error) {
      logger.warn("[remote-access] failed to send gateway app payload", {
        channelId,
        zcodeType,
        error,
      });
    },
    isDisposed() {
      return disposed;
    },
    setActiveSession(options) {
      activeSession = options;
    },
    getActiveSession() {
      return activeSession;
    },
    hasReadyChannel() {
      return activeRecord?.ready === true;
    },
    closeAllForDesktopStopping,
    disconnectCurrent() {
      const record = activeRecord;
      if (!record) return;
      sendCloseFrame(record, "desktop-stopping");
      closeRecord(record, "desktop-disconnect");
    },
  };

  function createSession(
    options: GatewayDeviceTransportSessionOptions,
  ): GatewayDeviceTransportSession {
    return createGatewayDeviceTransportSession(sessionHost, options);
  }

  return {
    socketFactory: sockets.socketFactory,

    handleChannel(channel, offer: RemoteGatewayChannelOffer) {
      if (disposed) {
        channel.close();
        return;
      }
      const record: ChannelRecord = {
        channelId: channel.channelId,
        channel,
        ready: false,
        closing: false,
        finalized: false,
        lastInboundAt: now(),
        pingCounter: 0,
      };
      channelRecords.set(channel.channelId, record);
      record.inbound = createInboundView(record);
      const inbound = record.inbound;
      // 必须在第一个 await 之前同步注册：SDK 不缓存消息，hello 可能紧跟着 handler 返回到达。
      try {
        channel.onMessage((message) => handleGatewayChannelMessage(inbound, message, inboundHost));
        channel.onClose(() => finalizeRecord(record, "socket-closed"));
      } catch (error) {
        logger.warn("[remote-access] failed to register gateway channel handlers", {
          channelId: channel.channelId,
          error,
        });
        closeRecord(record, "handler-registration-failed");
        return;
      }
      record.helloTimeout = setTimeout(() => {
        if (record.ready || record.closing || record.finalized) return;
        logger.info("[remote-access] gateway channel hello timed out", {
          channelId: record.channel.channelId,
          timeoutMs: helloTimeoutMs,
        });
        closeRecord(record, "hello-timeout");
      }, helloTimeoutMs);
      logger.debug("[remote-access] gateway channel offered", {
        channelId: channel.channelId,
        kind: offer.kind ?? channel.kind,
      });
    },

    handleGatewayChannelClosed(info: RemoteGatewayChannelClosedInfo) {
      logger.info("[remote-access] gateway channel closed", {
        channelId: info.channelId,
        reason: info.reason,
      });
      const record = channelRecords.get(info.channelId);
      if (record) {
        finalizeRecord(record, `gateway:${info.reason}`);
      }
    },

    createSession,

    dispose() {
      disposed = true;
      activeSession = undefined;
      closeAllForDesktopStopping();
      sockets.clear();
    },
  };
}
