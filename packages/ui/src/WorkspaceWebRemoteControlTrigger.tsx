import { useCallback } from "react";
import { Smartphone } from "lucide-react";
import type { RemoteAccessStatus } from "@zcode/shared";
import {
  buildWebRemoteControlEntryViewTelemetry,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useRemoteAccessStatus } from "@/hooks/useRemoteAccessStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

/**
 * 侧边栏入口是 App 级远程访问的纯状态按钮：开关已打开且 gateway 为 online 时高亮，
 * 其余（关闭、连接中、配置不完整、出错）一律置灰。具体原因只放在 tooltip，
 * 配置和排障都在设置页「远程访问」完成，这里不读窗口级 runtime 状态，
 * 避免多窗口时同一条远控链路显示成互相矛盾的状态。
 */
export function getRemoteAccessTriggerPresentation(
  status: RemoteAccessStatus | null,
  formatMessage: FormatMessage,
): { iconClassName: string; tooltip: string } {
  const dim = "text-foreground-subtle";
  if (!status?.enabled) {
    return {
      iconClassName: dim,
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
    };
  }

  switch (status.gateway.state) {
    case "online":
      return {
        iconClassName: "text-success",
        tooltip: formatMessage({
          id: status.status.mobileConnected
            ? "webRemoteControl.triggerStatus.connected"
            : "webRemoteControl.triggerStatus.waiting",
        }),
      };
    case "connecting":
      return {
        iconClassName: dim,
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.starting" }),
      };
    case "error":
      return {
        iconClassName: dim,
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.error" }),
      };
    case "disabled":
      return {
        iconClassName: dim,
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
      };
  }
}

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  compact?: boolean;
  className?: string;
}) {
  const enabled = useWebRemoteControlFeatureEnabled();

  // Bugfix: 生产默认隐藏时如果继续执行远程 session 解析 hook，会依赖 TabStoreProvider 并导致静态渲染提前抛错。
  // 这里先读无 store 依赖的 feature provider，再决定是否进入真正的入口内容。
  if (!enabled) {
    return null;
  }

  return (
    <WorkspaceWebRemoteControlTriggerContent
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      compact={compact}
      className={className}
    />
  );
}

function WorkspaceWebRemoteControlTriggerContent({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const mappedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // 仅用于入口埋点的 local/remote 维度：tab 上的 remoteSessionId 可能在断线重连期间失效，
  // 只采用 resolver 按 identity 校验后的 live session。
  const currentRemoteSessionId = mappedRemoteSessionId ?? undefined;
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const remoteAccessStatusRead = useRemoteAccessStatus();
  const triggerPresentation = getRemoteAccessTriggerPresentation(
    remoteAccessStatusRead.status,
    intl.formatMessage,
  );

  const handleClick = useCallback(() => {
    if (platform) {
      void reportAppTelemetryEvent(
        platform,
        buildWebRemoteControlEntryViewTelemetry({
          workspaceKind: workspaceIdentity?.trim() || currentRemoteSessionId ? "remote" : "local",
          remoteKind: workspaceIdentity
            ? parseRemoteWorkspaceIdentity(workspaceIdentity)?.kind
            : undefined,
        }),
        "web-remote-control-entry",
      );
    }
    logger.info("[WorkspaceWebRemoteControlTrigger] 跳转设置页远程访问分区", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
    // 与 WorkspaceHookPendingBanner 相同的两步：先写分区 intent，再打开（或激活）设置标签页。
    setPendingSettingsSectionIntent("remoteAccess");
    openSettingsTab?.();
  }, [currentRemoteSessionId, openSettingsTab, platform, workspaceIdentity, workspacePath]);

  return (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
      description={triggerPresentation.tooltip}
      side="top"
      align="center"
      triggerClassName={compact ? undefined : "w-full"}
    >
      <Button
        variant="ghost"
        onClick={handleClick}
        size={compact ? "icon-lg" : "lg"}
        aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        className={cn(
          compact
            ? "text-foreground hover:bg-surface-hover hover:text-foreground"
            : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        {/* Bugfix: 触发入口以前只显示固定手机图标，用户无法从桌面端判断手机是否已连上。
            这里复用远控状态轮询结果，用语义色表达连接状态，并把入口名称和状态文案合进同一个 tooltip，
            避免桌面端 footer 外层和按钮内层同时弹出两份提示。 */}
        <Smartphone className={cn("size-4", triggerPresentation.iconClassName)} />
        {compact ? (
          <span className="sr-only">{intl.formatMessage({ id: "webRemoteControl.trigger" })}</span>
        ) : (
          intl.formatMessage({ id: "webRemoteControl.trigger" })
        )}
      </Button>
    </ControlHintTooltip>
  );
}
