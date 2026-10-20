import { useEffect } from "react";
import { SettingsPage } from "@/SettingsPage.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { WorkspaceSettingsLayerProps } from "@/root/types.js";

export function WorkspaceSettingsLayer({
  workspaceScopedServices,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  allowOpenWorkspace,
  // fork（F4.1b）：onLogin/onLogout/user 透传摘除——SettingsPage 的账号入口已下线，
  // 本层不再承接（类型字段随 UserInfo 链路清理一并删除）。
}: WorkspaceSettingsLayerProps) {
  useEffect(() => {
    logger.info("[Root] settings layer mounted");
    return () => {
      logger.info("[Root] settings layer unmounted");
    };
  }, []);

  return (
    <div className="absolute inset-0 z-10">
      {workspaceScopedServices ? (
        <ServiceProvider services={workspaceScopedServices}>
          <SettingsPage
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            isWebRemoteControl={isWebRemoteControl}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={captionWorkspacePath}
            onBack={onBack}
            onCreateTask={onCreateTask}
            onOpenWorkspace={onOpenWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
          />
        </ServiceProvider>
      ) : (
        <SettingsPage
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          isWebRemoteControl={isWebRemoteControl}
          windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
          captionWorkspacePath={captionWorkspacePath}
          onBack={onBack}
          onCreateTask={onCreateTask}
          onOpenWorkspace={onOpenWorkspace}
          allowOpenWorkspace={allowOpenWorkspace}
        />
      )}
    </div>
  );
}
