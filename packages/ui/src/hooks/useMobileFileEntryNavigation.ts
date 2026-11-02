import { useCallback, useEffect, useRef } from "react";
import { resolveWebRemoteControlWorkspaceKey } from "@zody/shared";
import type { MobileFileBrowserOpenRequest } from "@/MobileWorkspaceFileBrowser.js";
import type { WebRemoteControlMobileFeaturePage } from "@/MobileFeatureOverlay.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { logger } from "@/logger.js";

export function useMobileFileEntryNavigation({
  switcher,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  fileTreeOpenRequest,
  fileBrowserEnabled,
  setFeaturePage,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  fileTreeOpenRequest?: MobileFileBrowserOpenRequest | null;
  fileBrowserEnabled: boolean;
  setFeaturePage: (page: WebRemoteControlMobileFeaturePage) => void;
}) {
  const lastOpenRequestSwitchIdRef = useRef<number | null>(null);
  const lastOpenedRequestIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !fileTreeOpenRequest ||
      !fileBrowserEnabled ||
      fileTreeOpenRequest.id === lastOpenedRequestIdRef.current
    )
      return;
    const requestedWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
      workspacePath: fileTreeOpenRequest.target.workspacePath,
      workspaceIdentity: fileTreeOpenRequest.target.workspaceIdentity,
    });
    const currentWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
    });
    if (requestedWorkspaceKey === currentWorkspaceKey) {
      lastOpenedRequestIdRef.current = fileTreeOpenRequest.id;
      setFeaturePage("files");
      return;
    }
    if (lastOpenRequestSwitchIdRef.current === fileTreeOpenRequest.id) return;
    lastOpenRequestSwitchIdRef.current = fileTreeOpenRequest.id;
    // Bugfix: 文件树 reveal 可能比 mobile route 的 active workspace 更新更早到达；
    // 先按 identity 切到请求目标，避免用 active path fallback 读取另一个 workspace。
    void switcher
      .switchWorkspace(requestedWorkspaceKey, { mobileNavigationIntent: "files" })
      .catch((error) => logger.warn("Mobile file reveal navigation failed", { error }));
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    fileBrowserEnabled,
    fileTreeOpenRequest,
    setFeaturePage,
    switcher,
  ]);

  return useCallback(
    (workspaceKey: string) => {
      const currentKey = resolveWebRemoteControlWorkspaceKey({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity,
      });
      if (workspaceKey === currentKey) {
        setFeaturePage("files");
        return;
      }
      void switcher
        .switchWorkspace(workspaceKey, { mobileNavigationIntent: "files" })
        .catch((error) => logger.warn("Mobile file navigation failed", { error }));
    },
    [activeWorkspaceIdentity, activeWorkspacePath, setFeaturePage, switcher],
  );
}
