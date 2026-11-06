import { useZodySessionStore } from "@/store/zodySessionStore.js";
import {
  resolvePendingOptimisticOverlayBlockReason,
  useMobileRemoteRefreshGuard,
} from "@/mobileRemoteRefreshGuards.js";

/**
 * 跨 Root 的全局 refresh guard 桥（M3-T2）。
 *
 * 这些状态由现有 store 持有；组件只订阅派生布尔值并交给已安装的 guard 注册表。
 * 普通桌面 Web/未安装 controller 时 hook 不注册任何 guard。
 */
export function MobileRemoteRefreshGuardHost() {
  const pendingOptimisticOverlay = useZodySessionStore(
    (state) =>
      resolvePendingOptimisticOverlayBlockReason(
        state.workspaces as Record<string, { optimisticTaskListByTaskId: Record<string, unknown> }>,
      ) !== null,
  );

  useMobileRemoteRefreshGuard("pending-optimistic-overlay", () =>
    pendingOptimisticOverlay ? "pending-optimistic-overlay" : null,
  );

  return null;
}
