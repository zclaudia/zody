import { useCallback, useState } from "react";
import type { WebRemoteControlWorkspaceListResult } from "@zcode/shared";
import {
  WebRemoteControlMobileTaskHome,
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
  type WebRemoteControlMobileTaskHomePreferences,
} from "@/WebRemoteControlMobileTaskHome.js";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export function WebRemoteControlMobileHomePage({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  initialWorkspaceList,
  homeRefreshKey,
  switcher,
  onSelectTask,
  onStartDraftInWorkspace,
  onNavigateHome,
  onNavigateToChat,
  onSwitchingWorkspaceChange,
  onOpenSearch,
  onOpenFiles,
  onOpenNotifications,
  onOpenOtherProject,
}: {
  activeTaskId: string | null;
  activeWorkspaceIdentity?: string;
  activeWorkspacePath: string;
  initialWorkspaceList?: WebRemoteControlWorkspaceListResult;
  homeRefreshKey: number;
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onStartDraftInWorkspace?: (workspacePath: string, workspaceIdentity?: string) => void;
  onNavigateHome: () => void;
  onNavigateToChat: () => void;
  onSwitchingWorkspaceChange: (switching: boolean) => void;
  onOpenSearch?: () => void;
  onOpenFiles?: (workspaceKey: string) => void;
  onOpenNotifications?: () => void;
  onOpenOtherProject?: () => void;
}) {
  const [preferences, setPreferences] = useState<WebRemoteControlMobileTaskHomePreferences>(() =>
    readWebRemoteControlMobileTaskHomePreferences(),
  );
  const onPreferencesChange = useCallback((next: WebRemoteControlMobileTaskHomePreferences) => {
    persistWebRemoteControlMobileTaskHomePreferences(next);
    logger.debug("[WebRemoteControlMobileShell] 更新手机端任务首页偏好", next);
    setPreferences(next);
  }, []);

  return (
    <WebRemoteControlMobileTaskHome
      activeTaskId={activeTaskId}
      activeWorkspaceIdentity={activeWorkspaceIdentity}
      activeWorkspacePath={activeWorkspacePath}
      initialResult={initialWorkspaceList}
      onCrossWorkspaceSwitchingChange={onSwitchingWorkspaceChange}
      onNavigateHome={onNavigateHome}
      onNavigateToChat={onNavigateToChat}
      preferences={preferences}
      onPreferencesChange={onPreferencesChange}
      refreshKey={homeRefreshKey}
      onSelectTask={onSelectTask}
      onStartDraftInWorkspace={onStartDraftInWorkspace}
      switcher={switcher}
      onOpenSearch={onOpenSearch}
      onOpenFiles={onOpenFiles}
      onOpenNotifications={onOpenNotifications}
      onOpenOtherProject={onOpenOtherProject}
    />
  );
}
