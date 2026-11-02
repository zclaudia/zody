import { useEffect } from "react";
import type { WebRemoteControlMobileFeaturePage } from "@/MobileFeatureOverlay.js";
import {
  isWebRemoteControlMobileChatHistoryState,
  isWebRemoteControlMobileExternalNavigationHistoryState,
  isWebRemoteControlMobileOverlayHistoryState,
  type WebRemoteControlMobileOverlayHistoryEntry,
  type WebRemoteControlMobilePage,
} from "@/mobileNavigationHistory.js";

export function useWebRemoteControlMobileShellBack({
  platform,
  currentPage,
  setCurrentPage,
  featurePage,
  closeFeature,
  isSidePaneOpen,
  onCloseSidePane,
  navigateHome,
  setHomeRefreshKey,
  workspacePickerOpen,
  closeWorkspacePicker,
  applyOverlayFromHistory,
  clearOverlayFromHistory,
}: {
  platform?: { onBackPressed?: (listener: () => boolean) => () => void };
  currentPage: WebRemoteControlMobilePage;
  setCurrentPage: (page: WebRemoteControlMobilePage) => void;
  featurePage: WebRemoteControlMobileFeaturePage | null;
  closeFeature: () => void;
  isSidePaneOpen: boolean;
  onCloseSidePane?: () => void;
  navigateHome: () => void;
  setHomeRefreshKey: (update: (current: number) => number) => void;
  /** 第二批 E1：目录选择器打开时 Android 返回先关选择器。 */
  workspacePickerOpen?: boolean;
  closeWorkspacePicker?: () => void;
  /** popstate 落在 overlay 条目（前进/层间返回）时按条目回写浮层；实现只改 React 状态，不得再动 history。 */
  applyOverlayFromHistory: (overlay: WebRemoteControlMobileOverlayHistoryEntry) => void;
  /** popstate 落回基础条目时清浮层；须幂等，不得再动 history（统一关闭路径已回收时是空操作）。 */
  clearOverlayFromHistory: () => void;
}) {
  useEffect(() => {
    if (!platform?.onBackPressed) return;
    return platform.onBackPressed(() => {
      // 应用设置/连接设置由后注册且更靠近顶层的处理器负责；Shell 返回 false 让出本次返回，
      // 不能抢先 navigateHome 或关闭下层浮层。
      if (
        typeof window !== "undefined" &&
        isWebRemoteControlMobileExternalNavigationHistoryState(window.history.state)
      ) {
        return false;
      }
      if (featurePage === "files") return false;
      if (featurePage) {
        closeFeature();
        return true;
      }
      if (workspacePickerOpen && closeWorkspacePicker) {
        closeWorkspacePicker();
        return true;
      }
      if (isSidePaneOpen && onCloseSidePane) {
        onCloseSidePane();
        return true;
      }
      if (currentPage === "chat") {
        navigateHome();
        return true;
      }
      return false;
    });
  }, [
    closeFeature,
    closeWorkspacePicker,
    currentPage,
    featurePage,
    isSidePaneOpen,
    navigateHome,
    onCloseSidePane,
    platform,
    workspacePickerOpen,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = (event: PopStateEvent) => {
      if (isWebRemoteControlMobileExternalNavigationHistoryState(event.state)) {
        return;
      }
      // 走查 shell-1：功能浮层打开时 history 里已有 overlay 条目，系统返回手势（iOS Safari
      // 等无 Android 原生返回桥的环境）弹掉的就是这条。这里按弹到的 state 回写 React：
      // 仍落在 overlay 条目（前进/层间返回）→ 恢复对应浮层。
      if (isWebRemoteControlMobileOverlayHistoryState(event.state)) {
        applyOverlayFromHistory(event.state.zcodeMobileOverlay);
        setCurrentPage(isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home");
        return;
      }
      // 落回基础条目：浮层必须关闭。统一关闭路径（UI 返回键/Android 桥）已先改 React 状态
      // 再 history.back()，此处回写是幂等空操作，不会形成回环。
      clearOverlayFromHistory();
      const nextPage = isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home";
      // 仅在真正发生 chat→home 迁移时刷新任务列表；关闭浮层落回原页面不触发无意义刷新。
      if (currentPage === "chat" && nextPage === "home") {
        setHomeRefreshKey((key) => key + 1);
      }
      setCurrentPage(nextPage);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [
    applyOverlayFromHistory,
    clearOverlayFromHistory,
    currentPage,
    setCurrentPage,
    setHomeRefreshKey,
  ]);
}
