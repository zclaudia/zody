import {
  MOBILE_UI_BRIDGE_SCHEMA_VERSION,
  MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY,
  parseMobileSessionContext,
  type MobileRemoteBridge,
} from "@zody/shared";
import {
  clearDevelopmentRemoteHandoff,
  readDevelopmentRemoteHandoff,
  type MobileRemoteDevelopmentStorage,
} from "./mobileRemoteDevelopmentHandoff.js";

/**
 * 浏览器开发模式的 `ZodyRemoteBridge` 模拟（M2-T2）。
 *
 * M2-T1 的 Shell 开发 `openRemote` 会导航到 `mobile.html`；生产页面只接受原生
 * `getSessionContext()`，因此开发构建需要把 Shell handoff 包装成同一份 bridge：
 * - `getSessionContext()` 返回 handoff 中的只读上下文（含 bridgeCapabilities）；
 * - `returnShell(reason, sessionId)` 清除 handoff 并回到 `mobile-shell.html`；
 * - `markRemoteReady(sessionId)` 成功 no-op（开发环境没有原生通知 intent 队列）。
 *
 * 该模块只在 `!import.meta.env.PROD` 的 Remote 入口动态加载；release 构建没有原生桥时
 * 仍由 `readMobileRemoteSessionContext` fail closed。handoff 缺失/损坏时不安装 bridge，
 * 页面显示“native bridge unavailable”，不会退回到 URL/localStorage 读取配置。
 */

export interface InstallDevelopmentMobileRemoteBridgeOptions {
  /** 注入点，默认 `globalThis`。 */
  target?: unknown;
  /** 与 Shell 开发配置客户端共享的同步存储。 */
  storage?: MobileRemoteDevelopmentStorage;
  /** 测试注入；缺省导航到同源 `mobile-shell.html`。 */
  navigate?: (url: string) => void;
}

function success(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
    ok: true,
    ...extra,
  });
}

function failure(code: string, message?: string): string {
  return JSON.stringify({
    schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION,
    ok: false,
    error: { code, ...(message ? { message } : {}) },
  });
}

function buildShellUrl(): string | undefined {
  const base = globalThis.location?.href;
  if (!base) {
    return undefined;
  }
  const url = new URL("mobile-shell.html", base);
  url.search = "";
  return url.toString();
}

/**
 * 读取 Shell handoff 并安装开发桥；没有 handoff 或已有原生桥时返回 undefined。
 * 调用方通过返回值或 `globalThis.ZodyRemoteBridge` 得到同一对象。
 */
export function installDevelopmentMobileRemoteBridge(
  options: InstallDevelopmentMobileRemoteBridgeOptions = {},
): MobileRemoteBridge | undefined {
  const target = options.target ?? globalThis;
  if (!target || typeof target !== "object") {
    return undefined;
  }
  const installed = (target as Record<string, unknown>)[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY];
  if (installed) {
    // 原生桥优先；开发模拟不得覆盖真实注入。
    return undefined;
  }

  const raw = readDevelopmentRemoteHandoff(options.storage);
  if (raw === undefined) {
    return undefined;
  }
  // 损坏 handoff 仍安装 bridge 并返回稳定错误码，让启动页显示 fail-closed 原因，
  // 而不是误报“没有原生桥”。
  const context = parseMobileSessionContext(raw, { allowInsecureTransport: true });

  const navigateToShell = () => {
    if (options.navigate) {
      options.navigate(buildShellUrl() ?? "mobile-shell.html");
      return;
    }
    const url = buildShellUrl();
    if (url) {
      globalThis.location.assign(url);
    }
  };

  const bridge: MobileRemoteBridge = {
    getSessionContext() {
      return context
        ? success({ context })
        : failure("session-context-invalid", "The development Remote handoff is invalid.");
    },
    markRemoteReady(sessionId: string) {
      return context && sessionId === context.sessionId ? success() : failure("stale-session");
    },
    returnShell(_reason: string, sessionId: string): void {
      if (!context || sessionId !== context.sessionId) {
        return;
      }
      clearDevelopmentRemoteHandoff(options.storage);
      delete (target as Record<string, unknown>)[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY];
      navigateToShell();
    },
  };

  (target as Record<string, unknown>)[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY] = bridge;
  return bridge;
}
