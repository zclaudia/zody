import {
  mobileTargetRefSchema,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import type { connectViaProtocol } from "@zcode/client";

type Services = Awaited<ReturnType<typeof connectViaProtocol>>;
type Reader = NonNullable<Services["mobileNotificationReaderService"]>;

/** Re-resolve opaque native clicks through the authenticated feed and current directory. */
export async function resolveMobileNotificationNavigation(options: {
  backendId: string;
  notificationId: string;
  reader: Reader;
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
}) {
  const notification = await options.reader.getNotification({
    notificationId: options.notificationId,
  });
  if (!notification) throw new Error("notification-unavailable");
  const target = mobileTargetRefSchema.parse(notification.target);
  if (target.backendId !== options.backendId || !target.taskId || !target.sessionId)
    throw new Error("notification-target-mismatch");
  const directory = await options.listWorkspaces();
  const workspace = directory.workspaces.find(
    (item) => resolveWebRemoteControlWorkspaceKey(item) === target.workspaceKey,
  );
  if (
    !workspace ||
    workspace.workspacePath !== target.workspacePath ||
    workspace.workspaceIdentity !== target.workspaceIdentity ||
    (workspace.kind === "remote" && !workspace.remoteSessionId)
  )
    throw new Error("notification-workspace-unavailable");
  // 通知保留逻辑身份；远端重连后必须使用目录提供的新 attachment，不能沿用旧路由。
  return workspace.kind === "remote"
    ? {
        ...notification,
        target: { ...notification.target, remoteSessionId: workspace.remoteSessionId },
      }
    : notification;
}

export async function validateMobileNotificationTask(
  services: Services,
  target: { taskId: string; workspacePath: string; workspaceIdentity?: string },
) {
  const meta = await services.zcodeTaskService.getTaskMeta(target);
  if (
    !meta ||
    meta.taskId !== target.taskId ||
    meta.workspacePath !== target.workspacePath ||
    (meta.workspaceIdentity?.trim() || meta.workspacePath) !==
      (target.workspaceIdentity?.trim() || target.workspacePath)
  )
    throw new Error("notification-task-unavailable");
}
