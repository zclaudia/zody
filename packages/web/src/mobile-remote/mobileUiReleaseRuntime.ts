import {
  parseMobileRemotePrepareReloadResult,
  type MobileRemoteBridge,
  type MobileRemotePrepareReloadResult,
  type MobileSessionContext,
} from "@zcode/shared";
import { installMobileRemoteRefreshGuardRegistry } from "@zcode/ui";
import { hasActiveMobileRemoteFileOperation } from "./mobileRemoteFileBridge.js";
import {
  createMobileUiReleaseController,
  type MobileUiReleaseController,
  type MobileUiReleaseControllerOptions,
  type MobileUiReleaseLogger,
} from "./mobileUiReleaseController.js";
import { fetchMobileUiReleaseObservation } from "./mobileUiReleaseDto.js";
import { createMobileUiReleaseLogger } from "./mobileUiReleaseLogger.js";
import {
  createMobileUiRefreshGuardRegistry,
  type MobileUiRefreshGuardRegistry,
} from "./mobileUiRefreshGuards.js";

/**
 * 手机 Remote 的 release controller 装配与生命周期（M3-T2）。
 *
 * 唯一所有者：
 * - guard 注册表在本模块创建一次，并安装给 UI 组件查询既有状态；
 * - controller 由 bootstrap 在业务 ready 后调用 `start()`，本模块保证只启动一次并立即检查；
 * - beforeunload/会话销毁统一调用 `dispose()`：reload/轮询停止、guard 清空、UI 注册表卸载。
 *
 * prepareReload 复用 `@zcode/shared` 的严格解析：方法缺失、抛错或未知返回值都按
 * `unsupported` 处理，页面不自行放行。reload 固定为 `window.location.reload()`。
 */

export interface CreateMobileRemoteReleaseRuntimeOptions {
  session: MobileSessionContext;
  bridge?: MobileRemoteBridge;
  isProduction: boolean;
  fetcher?: typeof fetch;
  /** 测试注入；缺省新建注册表。 */
  guards?: MobileUiRefreshGuardRegistry;
  /** 测试注入 controller 工厂；缺省使用 M3-T1 实现。 */
  createController?: (options: MobileUiReleaseControllerOptions) => MobileUiReleaseController;
  /** 生产固定 `window.location.reload()`；测试可注入。 */
  reload?: () => void;
  logger?: MobileUiReleaseLogger;
}

export interface MobileRemoteReleaseRuntime {
  controller: MobileUiReleaseController;
  guards: MobileUiRefreshGuardRegistry;
  /** 业务 ready 后调用；幂等。会立即执行一次发布检查。 */
  start(): void;
  /** 业务 Channel 重连后调用；启动前调用为 no-op。 */
  notifyBusinessReconnect(): void;
  dispose(): void;
}

export function createMobileRemoteReleaseRuntime(
  options: CreateMobileRemoteReleaseRuntimeOptions,
): MobileRemoteReleaseRuntime {
  const guards = options.guards ?? createMobileUiRefreshGuardRegistry();
  const uninstallRegistry = installMobileRemoteRefreshGuardRegistry(guards);

  // 文件保存/下载是页面内状态，由文件桥模块的进行中计数提供事实；不复制到 controller。
  guards.register({
    id: "mobile-file-operation",
    getBlockReason: () => (hasActiveMobileRemoteFileOperation() ? "file-operation" : null),
  });

  const prepareReload = (sessionId: string, releaseId: string): MobileRemotePrepareReloadResult => {
    const bridge = options.bridge;
    const prepare = bridge?.prepareReload;
    if (!bridge || typeof prepare !== "function") {
      return { kind: "unsupported" };
    }
    try {
      return parseMobileRemotePrepareReloadResult(prepare.call(bridge, sessionId, releaseId));
    } catch {
      return { kind: "unsupported" };
    }
  };

  const fetchRelease = () =>
    fetchMobileUiReleaseObservation({
      context: options.session,
      isProduction: options.isProduction,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });

  const reload = options.reload ?? (() => window.location.reload());
  const controller = (options.createController ?? createMobileUiReleaseController)({
    sessionId: options.session.sessionId,
    bridgeVersion: options.session.bridgeCapabilities.bridgeVersion,
    fetchRelease,
    prepareReload,
    reload,
    guards,
    logger: options.logger ?? createMobileUiReleaseLogger(),
  });

  let started = false;
  let disposed = false;

  return {
    controller,
    guards,
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      controller.start();
      // controller.start() 只订阅环境并安排轮询；业务 ready 时立即补一次检查。
      void controller.checkNow("visible");
    },
    notifyBusinessReconnect() {
      if (!started || disposed) {
        return;
      }
      controller.notifyBusinessReconnect();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      uninstallRegistry();
      controller.dispose();
      guards.clear();
    },
  };
}
