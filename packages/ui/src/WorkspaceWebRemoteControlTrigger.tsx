import { useState } from "react";
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
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

/**
 * 侧边栏入口展示 App 级远程访问状态：开关、gateway 连接和手机连接共同决定图标颜色。
 * 这里不读窗口级 runtime 状态，避免多窗口时同一条远控链路显示成互相矛盾的状态。
 */
export function getRemoteAccessTriggerPresentation(
  status: RemoteAccessStatus | null,
  formatMessage: FormatMessage,
): { iconClassName: string; tooltip: string } {
  if (!status?.enabled) {
    return {
      iconClassName: "text-foreground-subtle",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
    };
  }

  if (status.gateway.state === "error") {
    return {
      iconClassName: "text-destructive",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.error" }),
    };
  }

  if (status.gateway.state === "connecting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.starting" }),
    };
  }

  if (status.status.mobileConnected) {
    return {
      iconClassName: "text-success",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.connected" }),
    };
  }

  if (status.gateway.state === "online") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.waiting" }),
    };
  }

  return {
    iconClassName: "text-foreground-subtle",
    tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
  };
}

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
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
      initialTaskId={initialTaskId}
      compact={compact}
      className={className}
    />
  );
}

function WorkspaceWebRemoteControlTriggerContent({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
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
  // 修复原因：tab 上的 remoteSessionId 可能在断线重连期间失效；远控链路同时携带
  // identity 与 session，若继续透传未注册的旧值会组合成错误 endpoint。这里只采用
  // resolver 按 identity 校验后的 live session，未恢复时让弹层保持 remote-waiting。
  const currentRemoteSessionId = mappedRemoteSessionId ?? undefined;
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  const remoteAccessStatusRead = useRemoteAccessStatus({
    enabled: !webRemoteControlOpen,
  });
  const triggerPresentation = getRemoteAccessTriggerPresentation(
    remoteAccessStatusRead.status,
    intl.formatMessage,
  );

  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        description={triggerPresentation.tooltip}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            if (platform) {
              void reportAppTelemetryEvent(
                platform,
                buildWebRemoteControlEntryViewTelemetry({
                  workspaceKind:
                    workspaceIdentity?.trim() || currentRemoteSessionId ? "remote" : "local",
                  remoteKind: workspaceIdentity
                    ? parseRemoteWorkspaceIdentity(workspaceIdentity)?.kind
                    : undefined,
                }),
                "web-remote-control-entry",
              );
            }
            logger.info("[WorkspaceWebRemoteControlTrigger] 打开 Web 远程控制弹层", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
              remoteSessionId: currentRemoteSessionId ?? "none",
              initialTaskId: initialTaskId ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
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
            <span className="sr-only">
              {intl.formatMessage({ id: "webRemoteControl.trigger" })}
            </span>
          ) : (
            intl.formatMessage({ id: "webRemoteControl.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={currentRemoteSessionId}
        initialTaskId={initialTaskId}
      />
    </>
  );
}
