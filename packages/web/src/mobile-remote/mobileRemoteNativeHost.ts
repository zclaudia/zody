import {
  resolveMobileRemoteBridge,
  type MobileNotificationActionClick,
  type MobileNotificationClick,
  type PlatformAppLifecycleState,
} from "@zody/shared";
import {
  parseMobileNotificationAction,
  parseMobileNotificationClick,
} from "./mobileRemoteNotifications.js";

/**
 * Android 原生桥的事件方向（T6.2 / M2-T2）。
 *
 * Kotlin 的 `ZodyRemoteBridge`（`@JavascriptInterface`）只能由页面调用；宿主 → 页面的
 * 前后台、返回键和通知事件通过 `evaluateJavascript` 调用这里安装的
 * `ZcodeMobileBridgeHost`（M2-T5 `MobileBridgeEventDispatcher` 的固定对象名）。
 *
 * M2-T5 的 dispatcher 只传事件 payload（单参）。stale 隔离由原生
 * `MobileShellController` 的 generation/sessionId 校验，以及本模块按 session 安装宿主对象
 * 负责；页面不再接受带 `sessionId` 首参的旧调用格式。
 * - 返回键的同步 handler 必须返回 false，让宿主继续回退/退出。
 *
 * 页面其余部分只通过 `IPlatformService.onAppLifecycleChange` / `onBackPressed` /
 * `MobileNotificationPlatform` 消费，不直接访问宿主对象。
 */

export const MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY = "ZcodeMobileBridgeHost";

type LifecycleHandler = (state: PlatformAppLifecycleState) => void;
type BackHandler = () => boolean;

export interface MobileRemoteNativeHostBinding {
  onNotificationPermissionChanged(handler: (granted: boolean) => void): () => void;
  onNotificationClick(handler: (click: MobileNotificationClick) => void): () => void;
  /** 第二批 E4：通知按钮点击（backendId/notificationId/optionId）→ 快速路径。 */
  onNotificationAction(handler: (action: MobileNotificationActionClick) => void): () => void;
  onAppLifecycleChange(handler: LifecycleHandler): () => void;
  onBackPressed(handler: BackHandler): () => void;
}

export interface InstallMobileRemoteNativeHostOptions {
  /** 当前 Remote 文档的 sessionId；用于复用同一 session 的宿主绑定。 */
  sessionId: string;
  /** 注入点；默认 `globalThis`。 */
  target?: unknown;
  /** 注入点；默认从 target 上发现 `ZodyRemoteBridge`。 */
  bridge?: ReturnType<typeof resolveMobileRemoteBridge>;
}

interface InstalledHost {
  sessionId: string;
  binding: MobileRemoteNativeHostBinding;
}

// 同一页面只对应一个 Remote session；缓存只避免测试重复安装时丢失已有订阅。
const installedHosts = new WeakMap<object, InstalledHost>();

export function installMobileRemoteNativeHost(
  options: InstallMobileRemoteNativeHostOptions,
): MobileRemoteNativeHostBinding | undefined {
  const target = options.target ?? globalThis;
  if (!target || typeof target !== "object") {
    return undefined;
  }
  const existing = installedHosts.get(target);
  if (existing?.sessionId === options.sessionId) {
    return existing.binding;
  }
  const bridge = options.bridge ?? resolveMobileRemoteBridge(target);
  if (!bridge) {
    // 没有原生桥：不安装宿主对象，IPlatformService 也不提供这些能力。
    return undefined;
  }

  const sessionId = options.sessionId;
  const permissionHandlers = new Set<(granted: boolean) => void>();
  const notificationHandlers = new Set<(click: MobileNotificationClick) => void>();
  const actionHandlers = new Set<(action: MobileNotificationActionClick) => void>();
  const lifecycleHandlers = new Set<LifecycleHandler>();
  const backHandlers = new Set<BackHandler>();

  const host = {
    onNotificationPermissionChanged(value: unknown) {
      if (typeof value !== "boolean") return;
      for (const handler of permissionHandlers) {
        try {
          handler(value);
        } catch {
          /* Isolate page subscribers. */
        }
      }
    },
    onNotificationClick(value: unknown) {
      const click = parseMobileNotificationClick(value);
      if (click)
        for (const handler of notificationHandlers) {
          try {
            handler(click);
          } catch {
            /* Native pending click is retained for retry. */
          }
        }
    },
    onNotificationAction(value: unknown) {
      const action = parseMobileNotificationAction(value);
      if (action)
        for (const handler of actionHandlers) {
          try {
            handler(action);
          } catch {
            /* Native pending action is retained for retry. */
          }
        }
    },
    onAppLifecycle(value: unknown): void {
      if (value !== "foreground" && value !== "background") {
        return;
      }
      // 复制一份再遍历：handler 可能在回调里取消订阅，不能边遍历边改 Set。
      for (const handler of Array.from(lifecycleHandlers)) {
        try {
          handler(value);
        } catch {
          // 页面回调异常不能反噬宿主事件循环；下一个 handler 仍要收到事件。
        }
      }
    },
    onBackPressed(): boolean {
      // 逆序询问：后注册的 UI（聊天页/浮层）优先于启动流程。
      for (const handler of Array.from(backHandlers).reverse()) {
        try {
          if (handler()) {
            return true;
          }
        } catch {
          // 单个 handler 异常时继续询问，不影响宿主的回退/退出兜底。
        }
      }
      return false;
    },
  };

  (target as Record<string, unknown>)[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY] = host;
  const binding: MobileRemoteNativeHostBinding = {
    onNotificationPermissionChanged(handler) {
      permissionHandlers.add(handler);
      return () => permissionHandlers.delete(handler);
    },
    onNotificationClick(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onNotificationAction(handler) {
      actionHandlers.add(handler);
      return () => actionHandlers.delete(handler);
    },
    onAppLifecycleChange(handler) {
      lifecycleHandlers.add(handler);
      return () => {
        lifecycleHandlers.delete(handler);
      };
    },
    onBackPressed(handler) {
      backHandlers.add(handler);
      return () => {
        backHandlers.delete(handler);
      };
    },
  };
  installedHosts.set(target, { sessionId, binding });
  return binding;
}
