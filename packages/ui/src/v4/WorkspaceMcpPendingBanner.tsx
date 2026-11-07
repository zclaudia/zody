import { memo, useCallback, useState } from "react";
import {
  TID_V4_WORKSPACE_MCP_PENDING_BANNER,
  TID_V4_WORKSPACE_MCP_PENDING_DISMISS,
  TID_V4_WORKSPACE_MCP_PENDING_REVIEW,
} from "@zody/shared";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

/**
 * fork（F23，上游 a60ba6a7）：workspace MCP 信任门横幅 A——会话内待信任摘要。
 *
 * 软门禁 dismiss store：轻量模块级 Map。幂等 key = sessionId + bundleDigest；
 * bundle 变化后提示条重新出现。不落盘——刷新或重载后重新提示，符合「用户应该
 * 知道」的产品语义（与 WorkspaceHookPendingBanner 同族先例）。
 */
class WorkspaceMcpPendingDismissStore {
  private dismissed = new Set<string>();

  /** 标记某个 session+bundle 组合已 dismiss */
  dismiss(sessionId: string, bundleDigest: string): void {
    this.dismissed.add(this.key(sessionId, bundleDigest));
  }

  /** 查询是否已 dismiss */
  isDismissed(sessionId: string, bundleDigest: string): boolean {
    return this.dismissed.has(this.key(sessionId, bundleDigest));
  }

  /** 清空全部 dismiss 记录（测试用） */
  clear(): void {
    this.dismissed.clear();
  }

  private key(sessionId: string, bundleDigest: string): string {
    return `${sessionId}:${bundleDigest}`;
  }
}

export const workspaceMcpPendingDismissStore = new WorkspaceMcpPendingDismissStore();

export interface WorkspaceMcpAdmissionInfo {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export interface WorkspaceMcpPendingBannerProps {
  sessionId: string;
  admission: WorkspaceMcpAdmissionInfo | null;
}

/**
 * workspace MCP 待信任常驻提示条（spec docs/specs/workspace-mcp-trust.md §8.1）。
 *
 * 当 snapshot.workspaceMcpAdmission.pendingCount > 0 时显示，提供 [去设置] 与 [忽略]：
 * - [去设置]：打开设置页 MCP 分区。授权决策在设置页行级完成（横幅 B）；横幅本身
 *   不携带任何声明细节（脱敏摘要只在设置页展示），手机远控只读展示同一提示。
 * - [忽略]：renderer 本地 dismiss，幂等 key = sessionId + bundleDigest。
 */
export const WorkspaceMcpPendingBanner = memo(function WorkspaceMcpPendingBanner({
  sessionId,
  admission,
}: WorkspaceMcpPendingBannerProps) {
  const { intl } = useZodyIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const [, setDismissRevision] = useState(0);

  const handleReview = useCallback(() => {
    // 两行式打开设置页：设置 intent 再 open tab（同 WorkspaceHookPendingBanner 先例）。
    setPendingSettingsSectionIntent("mcp");
    openSettingsTab?.();
  }, [openSettingsTab]);

  const handleDismiss = useCallback(() => {
    if (!admission) return;
    runUserAction({
      input: {
        featureId: "conversation.blocking.mcp_trust",
        action: "dismiss",
        trigger: "button",
      },
      operation: () => {
        workspaceMcpPendingDismissStore.dismiss(sessionId, admission.bundleDigest);
        // 模块级 Set 的写入不属于 React 状态，memo 组件不会重渲染（hook 横幅同因）。
        setDismissRevision((revision) => revision + 1);
      },
      completed: { resultSource: "local_commit" },
      failureStage: "mcp_pending_dismiss",
    });
  }, [admission, sessionId]);

  if (!admission || admission.pendingCount <= 0) {
    return null;
  }

  // 幂等 dismiss 检查：同 bundle 已 dismiss 则隐藏
  if (workspaceMcpPendingDismissStore.isDismissed(sessionId, admission.bundleDigest)) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid={TID_V4_WORKSPACE_MCP_PENDING_BANNER}
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage(
          { id: "chat.workspaceMcpPending.message" },
          { count: admission.pendingCount },
        )}
      </p>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_MCP_PENDING_REVIEW}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={handleReview}
      >
        {intl.formatMessage({ id: "chat.workspaceMcpPending.goToSettings" })}
      </button>
      <button
        type="button"
        data-testid={TID_V4_WORKSPACE_MCP_PENDING_DISMISS}
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={handleDismiss}
      >
        {intl.formatMessage({ id: "chat.workspaceMcpPending.dismiss" })}
      </button>
    </div>
  );
});
