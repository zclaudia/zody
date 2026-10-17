import type {
  GatewayDeviceSocket,
  GatewayDeviceSocketFactory,
} from "./gatewayDeviceTransportTypes.js";

/**
 * 扣住 SDK 建立的 WebSocket（T3.3）。
 *
 * 两个 SDK 的 `GatewayChannel` 都不暴露 `bufferedAmount`，`send()` 也没有返回值，
 * 底层 socket 只能经 `socketFactory` 拿到。控制连接 URL 以 `/ws` 结尾，channel 数据连接
 * 形如 `/channel/<id>?ticket=…`；这里只登记数据连接，发送前按 `channelId` 读背压。
 */
export interface GatewayDeviceSocketRegistry {
  readonly socketFactory: GatewayDeviceSocketFactory;
  bufferedAmount(channelId: string): number;
  release(channelId: string): void;
  clear(): void;
}

/** gateway 数据面固定为 `/channel/<channelId>`（zclaudia-gateway server.ts）。 */
export function extractGatewayChannelIdFromSocketUrl(url: string): string | undefined {
  const match = /(?:^|\/)channel\/([^/?#]+)/u.exec(url);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function readBufferedAmount(socket: GatewayDeviceSocket | undefined): number {
  // WebSocketLike 类型没有声明 bufferedAmount（WHATWG WebSocket 有），这里按结构读取。
  const value = (socket as { bufferedAmount?: unknown } | undefined)?.bufferedAmount;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createGatewayDeviceSocketRegistry(
  createSocket: GatewayDeviceSocketFactory,
): GatewayDeviceSocketRegistry {
  const sockets = new Map<string, GatewayDeviceSocket>();

  const socketFactory: GatewayDeviceSocketFactory = (url) => {
    const socket = createSocket(url);
    const channelId = extractGatewayChannelIdFromSocketUrl(url);
    if (!channelId) {
      // 控制连接（`/ws`）不参与 channel 背压；仍然原样返回给 SDK。
      return socket;
    }
    sockets.set(channelId, socket);
    // gateway 拆除 channel 时 socket 会被关闭；在 onClose 之前先释放，避免 map 泄漏。
    socket.addEventListener("close", () => {
      if (sockets.get(channelId) === socket) {
        sockets.delete(channelId);
      }
    });
    return socket;
  };

  return {
    socketFactory,
    bufferedAmount(channelId) {
      return readBufferedAmount(sockets.get(channelId));
    },
    release(channelId) {
      sockets.delete(channelId);
    },
    clear() {
      sockets.clear();
    },
  };
}

/** 生产默认实现：Electron 41 的 main 进程提供全局 WebSocket。 */
export const defaultGatewayDeviceSocketFactory: GatewayDeviceSocketFactory = (url) => {
  const WebSocketCtor = (globalThis as { WebSocket?: new (socketUrl: string) => unknown })
    .WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new WebSocketCtor(url) as unknown as GatewayDeviceSocket;
};
