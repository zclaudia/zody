import type { PlatformAppLifecycleState } from "@zcode/shared";
import { resolveMobileRemoteNativeBridge } from "./mobileRemoteSecureStore.js";

/**
 * Android 原生桥的事件方向（T6.2）。
 *
 * Kotlin 的 `ZcodeMobileBridge`（`@JavascriptInterface`）只能由页面调用；宿主 → 页面的
 * 前后台与返回键事件通过 `evaluateJavascript` 调用这里安装的 `ZcodeMobileBridgeHost`。
 * 只有检测到原生桥时才安装，普通浏览器（`pnpm dev:mobile-remote`）不会得到这些能力。
 *
 * 页面其余部分只通过 `IPlatformService.onAppLifecycleChange` / `onBackPressed` 消费，
 * 不直接访问 `window.ZcodeMobileBridgeHost`。
 */

export const MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY = "ZcodeMobileBridgeHost";

type LifecycleHandler = (state: PlatformAppLifecycleState) => void;
type BackHandler = () => boolean;

export interface MobileRemoteNativeHostBinding {
  onAppLifecycleChange(handler: LifecycleHandler): () => void;
  onBackPressed(handler: BackHandler): () => void;
}

export interface InstallMobileRemoteNativeHostOptions {
  /** 注入点；默认 `globalThis`。 */
  target?: unknown;
  /** 注入点；默认从 target 上发现 `ZcodeMobileBridge`。 */
  bridge?: ReturnType<typeof resolveMobileRemoteNativeBridge>;
}

// 同一页面可能多次启动 bootstrap（重开设置不会，但测试会）；宿主对象只安装一次，避免旧订阅失联。
const installedHosts = new WeakMap<object, MobileRemoteNativeHostBinding>();

export function installMobileRemoteNativeHost(
  options: InstallMobileRemoteNativeHostOptions = {},
): MobileRemoteNativeHostBinding | undefined {
  const target = options.target ?? globalThis;
  if (!target || typeof target !== "object") {
    return undefined;
  }
  const existing = installedHosts.get(target);
  if (existing) {
    return existing;
  }
  const bridge = options.bridge ?? resolveMobileRemoteNativeBridge(target);
  if (!bridge) {
    // 没有原生桥：不安装宿主对象，IPlatformService 也不提供这两个能力。
    return undefined;
  }

  const lifecycleHandlers = new Set<LifecycleHandler>();
  const backHandlers = new Set<BackHandler>();
  const host = {
    onAppLifecycle(state: unknown): void {
      if (state !== "foreground" && state !== "background") {
        return;
      }
      // 复制一份再遍历：handler 可能在回调里取消订阅，不能边遍历边改 Set。
      for (const handler of Array.from(lifecycleHandlers)) {
        try {
          handler(state);
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
  installedHosts.set(target, binding);
  return binding;
}
