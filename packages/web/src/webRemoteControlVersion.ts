import type { WebRemoteControlWindowBootstrapResult } from "@zcode/shared";

interface WebRemoteControlVersionGuardOptions {
  requestBootstrap(): Promise<WebRemoteControlWindowBootstrapResult>;
  isPageReady(): boolean;
  /**
   * 已挂载页面观察到桌面版本变化时的通知（T4.2）。
   *
   * 手机页面打进 APK 后不再有「按版本换 URL」的托管资源，因此这里只做非阻塞提示：
   * 真正的协议不兼容由 channel 的 appProtocol 协商处理，不能靠导航到另一个 URL 解决。
   */
  onVersionChanged?(desktopVersion: string): void;
}

/**
 * 观察桌面版本变化（T4.2 去掉 URL 依赖）。
 *
 * 旧实现把 `app_version` 写回 URL 并导航到同一条托管路由；APK 内置页面没有可导航的版本化
 * 资源，所以这里只记录首次读到的版本作为基线，之后版本变化时回调一次。`check()` 始终返回
 * bootstrap 结果，调用方不再被「版本不匹配」阻塞，业务是否可继续由 appProtocol 协商决定。
 */
export function createWebRemoteControlVersionGuard(options: WebRemoteControlVersionGuardOptions) {
  let generation = 0;
  let disposed = false;
  let baselineVersion: string | undefined;
  let lastNotifiedVersion: string | undefined;
  let inFlight: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;

  const invalidate = () => {
    generation += 1;
    inFlight = undefined;
  };

  return {
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
    check(): Promise<WebRemoteControlWindowBootstrapResult | undefined> {
      if (disposed) {
        return Promise.resolve(undefined);
      }
      if (inFlight) {
        return inFlight;
      }
      const requestGeneration = generation;
      const request = Promise.resolve()
        .then(() => options.requestBootstrap())
        .then((result) => {
          // 重连可能让旧响应晚于新连接返回；旧连接不能覆盖新连接的版本基线。
          if (disposed || requestGeneration !== generation) {
            return undefined;
          }
          const version = result.desktopAppVersion?.trim();
          if (!version) {
            return result;
          }
          if (baselineVersion === undefined) {
            baselineVersion = version;
            return result;
          }
          if (
            version !== baselineVersion &&
            options.isPageReady() &&
            lastNotifiedVersion !== version
          ) {
            lastNotifiedVersion = version;
            options.onVersionChanged?.(version);
          }
          baselineVersion = version;
          return result;
        })
        .catch((error: unknown) => {
          if (disposed || requestGeneration !== generation) {
            return undefined;
          }
          throw error;
        })
        .finally(() => {
          if (inFlight === request) inFlight = undefined;
        });
      inFlight = request;
      return request;
    },
  };
}
