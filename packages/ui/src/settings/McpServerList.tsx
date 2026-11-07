import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_MCP_SERVER_ROW,
  TID_MCP_WORKSPACE_REVOKE_BUTTON,
  TID_MCP_WORKSPACE_TRUST_BUTTON,
  TID_MCP_WORKSPACE_TRUST_SUMMARY,
  testId,
  type McpServerStatus,
  type ZodyMcpServer,
} from "@zody/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@/settings/McpFailurePresentation.js";
import { SettingsResourceList } from "@/settings/SettingsResourceGroup.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { CircleIcon, Cable, Loader2Icon, ExternalLink, Plus } from "lucide-react";

export function McpStatusDot({
  status,
  attention = false,
  disabled = false,
  reason,
}: {
  status?: McpServerStatus;
  attention?: boolean;
  disabled?: boolean;
  reason: string;
}) {
  const color = disabled
    ? "text-foreground-subtlest"
    : status === "connected"
      ? "text-green-500"
      : status === "connecting"
        ? "text-yellow-500"
        : status === "error"
          ? "text-red-500"
          : attention
            ? "text-yellow-500"
            : "text-foreground-subtlest";

  const icon =
    !disabled && status === "connecting" ? (
      <Loader2Icon className={`size-3 shrink-0 animate-spin ${color}`} aria-hidden="true" />
    ) : (
      <CircleIcon className={`size-2.5 shrink-0 fill-current ${color}`} aria-hidden="true" />
    );

  return (
    <ControlHintTooltip title={reason} className="max-w-64">
      <span className="inline-flex cursor-help items-center">{icon}</span>
    </ControlHintTooltip>
  );
}

function ScopeBadge({ scope }: { scope?: string }) {
  const normalizedScope = scope === "workspace" ? "workspace" : "user";
  return <SettingsScopeBadge scope={normalizedScope} includeMcpTestAttribute />;
}

function McpServerItem({
  server,
  onEdit,
  onToggle,
  onOpenAuthorization,
  onWorkspaceTrust,
  hideMetadata,
}: {
  server: ZodyMcpServer;
  onEdit: (server: ZodyMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZodyMcpServer) => void;
  /**
   * fork（F23，上游 a60ba6a7）：workspace 声明的信任/撤销回调（spec §8.2）。
   * 注入方负责调用 workspace/mcp/trust 并刷新；未注入（wiring 未落地）时不渲染
   * 动作按钮，仅展示审核状态与脱敏摘要。
   */
  onWorkspaceTrust?: (server: ZodyMcpServer, trusted: boolean) => void | Promise<void>;
  hideMetadata: boolean;
}) {
  const { intl } = useZodyIntl();
  const [trustBusy, setTrustBusy] = useState(false);
  const typeLabel = server.config.command
    ? "stdio"
    : (server.config.type ?? (server.config.url ? "http" : "?"));
  const canEdit = !server.location || server.location.source === "zcode";
  const canOpenAuthorization = Boolean(server.authorization?.authorizationUrl);
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });
  const workspaceTrust = server.workspaceTrust;
  const pendingWorkspaceTrust = Boolean(workspaceTrust && !workspaceTrust.trusted);
  const statusReason = intl.formatMessage({
    id:
      pendingWorkspaceTrust && server.status !== "connected"
        ? // 待信任是明确的安全状态文案，优先于 unknown 兜底（spec §8.2 warning 呈现）。
          "settings.mcp.trust.pendingReason"
        : server.status === "error"
          ? resolveMcpFailureMessageId(server.failureKind)
          : server.status === "connected"
            ? "settings.mcp.status.connectedReason"
            : server.status === "connecting"
              ? "settings.mcp.status.connectingReason"
              : server.status === "disconnected"
                ? "settings.mcp.status.disconnectedReason"
                : "settings.mcp.status.unknownReason",
  });

  const handleWorkspaceTrust = async (trusted: boolean) => {
    if (trustBusy || !onWorkspaceTrust) return;
    setTrustBusy(true);
    try {
      await onWorkspaceTrust(server, trusted);
    } finally {
      setTrustBusy(false);
    }
  };

  const description = server.config.url
    ? `${typeLabel} · ${server.config.url}`
    : server.config.command
      ? `${typeLabel} · ${server.config.command} ${(server.config.args ?? []).join(" ")}`
      : typeLabel;

  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors ${canEdit ? "hover:bg-hover" : ""}`}
      {...settingsResourceRowInteraction(canEdit ? () => onEdit(server) : undefined)}
      data-mcp-status={server.status ?? ""}
      data-mcp-tool-count={server.toolCount}
      data-testid={testId(TID_MCP_SERVER_ROW, server.name)}
    >
      <div
        className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
        data-mcp-status-dot-placement="icon-corner"
      >
        <Cable className="size-4" aria-hidden="true" />
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
          <McpStatusDot
            status={server.status}
            attention={pendingWorkspaceTrust}
            reason={statusReason}
          />
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{server.name}</span>
          {!hideMetadata ? <ScopeBadge scope={server.scope} /> : null}
          {!hideMetadata && typeof server.toolCount === "number" && (
            <span className="inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
              {intl.formatMessage(
                { id: "settings.mcp.status.toolCount" },
                { count: String(server.toolCount) },
              )}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-ui-sm text-foreground-subtle">{description}</div>
        {workspaceTrust ? (
          <div className="mt-1" data-testid={testId(TID_MCP_WORKSPACE_TRUST_SUMMARY, server.name)}>
            <div
              className="whitespace-pre-wrap break-all rounded-md bg-surface px-2 py-1 text-ui-sm text-foreground-subtle ring-1 ring-border"
              title={workspaceTrust.display}
            >
              {workspaceTrust.display}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {!workspaceTrust.trusted ? (
                <span className="text-ui-sm text-yellow-600 dark:text-yellow-400">
                  {intl.formatMessage({ id: "settings.mcp.trust.pendingLabel" })}
                </span>
              ) : (
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.mcp.trust.revokeBoundary" })}
                </span>
              )}
            </div>
          </div>
        ) : null}
        {server.status === "error" ? (
          <McpFailurePresentation error={server.error} failureKind={server.failureKind} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {workspaceTrust && onWorkspaceTrust ? (
          !workspaceTrust.trusted ? (
            <Button
              variant="outline"
              size="sm"
              disabled={trustBusy}
              data-testid={testId(TID_MCP_WORKSPACE_TRUST_BUTTON, server.name)}
              title={intl.formatMessage({ id: "settings.mcp.trust.trustAction" })}
              onClick={() => void handleWorkspaceTrust(true)}
            >
              {intl.formatMessage({ id: "settings.mcp.trust.trustAction" })}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={trustBusy}
              data-testid={testId(TID_MCP_WORKSPACE_REVOKE_BUTTON, server.name)}
              title={intl.formatMessage({ id: "settings.mcp.trust.revokeBoundary" })}
              onClick={() => void handleWorkspaceTrust(false)}
            >
              {intl.formatMessage({ id: "settings.mcp.trust.revokeAction" })}
            </Button>
          )
        ) : null}
        {canOpenAuthorization && (
          <Button
            variant="link"
            size="sm"
            className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
            aria-label={openAuthorizationLabel}
            data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, server.name)}
            title={openAuthorizationLabel}
            onClick={() =>
              runUserAction({
                input: { featureId: "extension.mcp", action: "authorize", trigger: "button" },
                operation: () => onOpenAuthorization?.(server),
                completed: { resultSource: "platform_result" },
                failureStage: "mcp_authorize",
              })
            }
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{openAuthorizationLabel}</span>
          </Button>
        )}
        <Switch checked={server.enabled} onCheckedChange={(v) => onToggle(server.id, v)} />
      </div>
    </div>
  );
}

export function McpServerList({
  servers,
  onCreate,
  onEdit,
  onToggle,
  onOpenAuthorization,
  onWorkspaceTrust,
  emptyTitle,
  emptyDescription,
  hideMetadata = false,
}: {
  servers: ZodyMcpServer[];
  onCreate: () => void;
  onEdit: (server: ZodyMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZodyMcpServer) => void;
  onWorkspaceTrust?: (server: ZodyMcpServer, trusted: boolean) => void | Promise<void>;
  emptyTitle: string;
  emptyDescription: string;
  hideMetadata?: boolean;
}) {
  const { intl } = useZodyIntl();

  if (servers.length === 0) {
    return (
      <div className="overflow-hidden rounded-xl border border-dashed border-border">
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">{emptyTitle}</div>
            <div className="text-ui-base text-foreground-subtle">{emptyDescription}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus className="size-4" />
            <span>{intl.formatMessage({ id: "settings.mcp.create.open" })}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SettingsResourceList
      items={servers}
      getKey={(server) => server.id}
      renderItem={(server) => (
        <McpServerItem
          server={server}
          onEdit={onEdit}
          onToggle={onToggle}
          onOpenAuthorization={onOpenAuthorization}
          onWorkspaceTrust={onWorkspaceTrust}
          hideMetadata={hideMetadata}
        />
      )}
    />
  );
}
