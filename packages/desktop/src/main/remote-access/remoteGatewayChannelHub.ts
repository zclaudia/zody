import { WEB_REMOTE_CONTROL_CHANNEL_KIND } from "@zcode/shared";
import type {
  RemoteGatewayBackendLogger,
  RemoteGatewayBackendSdkLike,
  RemoteGatewayChannel,
  RemoteGatewayChannelClosedInfo,
  RemoteGatewayChannelHandler,
  RemoteGatewayChannelOffer,
} from "./remoteGatewayBackendTypes.js";
import { sendRemoteGatewayChannelClose } from "./remoteGatewayBackendSupport.js";

/**
 * gateway channel 的挂接与关闭记账。
 *
 * backend SDK 只按 kind 查表（`onChannel`），一个 kind 只有一个 handler；这里把
 * 「当前 channel 集合、关闭原因、desktop-stopping」集中到一处，避免 RemoteGatewayBackend
 * 同时管理连接生命周期和 channel 账本。
 */
export interface RemoteGatewayChannelHub {
  /** 在 connect() 之前调用：只注册 zcode-remote，其余 kind 由 SDK 回 channel_reject。 */
  registerKindHandler(sdk: RemoteGatewayBackendSdkLike): void;
  /** backend onMessage 入口：读取 channel_closed.reason。 */
  handleControlMessage(message: Record<string, unknown>): void;
  /** T3.3 的 transport；必须同步注册帧回调。 */
  setHandler(handler: RemoteGatewayChannelHandler | undefined): void;
  hasConnectedClient(): boolean;
  onClosed(handler: (info: RemoteGatewayChannelClosedInfo) => void): () => void;
  /** 配置变更/退出：先给每部手机发 close{desktop-stopping}，再清空账本。 */
  closeAllWithDesktopStopping(): void;
  /** SDK 断开后清空账本（不发送 close 帧）。 */
  clear(): void;
}

export function createRemoteGatewayChannelHub(
  logger: RemoteGatewayBackendLogger,
): RemoteGatewayChannelHub {
  const activeChannels = new Map<string, RemoteGatewayChannel>();
  const closedListeners = new Set<(info: RemoteGatewayChannelClosedInfo) => void>();
  let channelHandler: RemoteGatewayChannelHandler | undefined;

  function handleOffer(channel: RemoteGatewayChannel, offer: RemoteGatewayChannelOffer): void {
    const kind = offer.kind ?? channel.kind;
    // SDK 只会把注册过的 kind 交进来；这里保留一道校验，防止未来误设 default handler。
    if (kind !== WEB_REMOTE_CONTROL_CHANNEL_KIND) {
      logger.warn("[remote-access] gateway channel kind rejected", {
        channelId: channel.channelId,
        kind: kind ?? "none",
      });
      channel.close();
      return;
    }

    activeChannels.set(channel.channelId, channel);
    channel.onClose(() => {
      if (activeChannels.get(channel.channelId) === channel) {
        activeChannels.delete(channel.channelId);
      }
    });
    logger.debug("[remote-access] gateway channel offered", { channelId: channel.channelId });

    const handler = channelHandler;
    if (!handler) {
      // T3.3 接入前没有 transport 能消费 channel；立即关闭，避免手机停在等待 hello 的 10 秒超时。
      logger.warn("[remote-access] gateway channel rejected: no device transport attached", {
        channelId: channel.channelId,
      });
      activeChannels.delete(channel.channelId);
      channel.close();
      return;
    }

    // 同步转交，绝不 await：transport 必须在第一个 await 之前注册 onMessage/onClose。
    try {
      handler(channel, offer);
    } catch (error) {
      logger.error("[remote-access] gateway channel handler failed", {
        channelId: channel.channelId,
        error,
      });
      activeChannels.delete(channel.channelId);
      channel.close();
    }
  }

  return {
    registerKindHandler(sdk) {
      sdk.onChannel(WEB_REMOTE_CONTROL_CHANNEL_KIND, handleOffer);
    },

    handleControlMessage(message) {
      if (message.type !== "channel_closed") {
        return;
      }
      const channelId = typeof message.channelId === "string" ? message.channelId : "";
      if (!channelId) {
        logger.warn("[remote-access] malformed channel_closed message");
        return;
      }
      const reason = typeof message.reason === "string" ? message.reason : "unknown";
      activeChannels.delete(channelId);
      const info: RemoteGatewayChannelClosedInfo = { channelId, reason };
      logger.info("[remote-access] gateway channel closed", info);
      // Array.from 快照：监听者可能在回调里取消订阅，不能边迭代边改 Set。
      for (const listener of Array.from(closedListeners)) {
        listener(info);
      }
    },

    setHandler(handler) {
      channelHandler = handler;
    },

    hasConnectedClient() {
      return activeChannels.size > 0;
    },

    onClosed(handler) {
      closedListeners.add(handler);
      return () => {
        closedListeners.delete(handler);
      };
    },

    closeAllWithDesktopStopping() {
      if (activeChannels.size === 0) {
        return;
      }
      logger.info("[remote-access] closing gateway channels before disconnect", {
        channels: activeChannels.size,
      });
      // Array.from 快照：发送 close 帧可能同步触发 channel 的 onClose 回调并改 Map。
      for (const channel of Array.from(activeChannels.values())) {
        try {
          sendRemoteGatewayChannelClose(channel, "desktop-stopping");
        } catch (error) {
          logger.warn("[remote-access] failed to send desktop-stopping", {
            channelId: channel.channelId,
            error,
          });
        }
      }
      activeChannels.clear();
    },

    clear() {
      activeChannels.clear();
    },
  };
}
