import { useEffect } from "react";
import type { WebRemoteControlMobileFeaturePage } from "@/MobileFeatureOverlay.js";
import {
  isWebRemoteControlMobileChatHistoryState,
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
}) {
  useEffect(() => {
    if (!platform?.onBackPressed) return;
    return platform.onBackPressed(() => {
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
      const nextPage = isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home";
      setCurrentPage(nextPage);
      if (nextPage === "home") setHomeRefreshKey((key) => key + 1);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setCurrentPage, setHomeRefreshKey]);
}
