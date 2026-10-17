import type { WebRemoteControlFailure } from "@zcode/shared";

/**
 * 手机远控的应用 payload 请求恢复层：一次可恢复失败后共用一次连接恢复并重试一次。
 * 与具体 transport 无关，relay 与后续的 gateway terminal transport 共用（T1.1）。
 */

interface WebRemoteControlRelayRequestRecoveryOptions {
  recoverTimeout?: boolean;
}

function isRecoverableRelayRequestFailure(
  error: unknown,
  options?: WebRemoteControlRelayRequestRecoveryOptions,
): boolean {
  const failure = error as Partial<WebRemoteControlFailure> | undefined;
  return (
    // Bugfix: gateway 链路的临时不可发送（channel 未 ready / 正在重开）与电脑离线都值得
    // 触发一次共用恢复；旧 relay 的 relay-unavailable 已随失败原因枚举删除。
    failure?.reason === "gateway-unreachable" ||
    failure?.reason === "desktop-disconnected" ||
    (options?.recoverTimeout === true && failure?.reason === "desktop-bootstrap-timeout")
  );
}

export function createWebRemoteControlRelayRequestRecovery(recoverConnection: () => Promise<void>) {
  let recoveryPromise: Promise<void> | undefined;

  async function recoverRelayRequestPath(): Promise<void> {
    if (!recoveryPromise) {
      // Bugfix: 多个请求同时撞上 relay suspect 窗口时必须共用一次恢复。
      // 否则每个请求都会触发 recoverConnection，容易把短暂抖动放大成连续重连。
      recoveryPromise = recoverConnection().finally(() => {
        recoveryPromise = undefined;
      });
    }
    await recoveryPromise;
  }

  return async function requestWithRelayRecovery<T>(
    request: () => Promise<T>,
    options?: WebRemoteControlRelayRequestRecoveryOptions,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!isRecoverableRelayRequestFailure(error, options)) {
        throw error;
      }
      await recoverRelayRequestPath();
      return request();
    }
  };
}
