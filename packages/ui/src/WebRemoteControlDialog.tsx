import { memo, useEffect, useMemo, useState } from "react";
import type { RemoteAccessStatus, WebRemoteControlFailure } from "@zcode/shared";
import { LoaderCircle, MonitorSmartphone, Smartphone, Unplug, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteAccessStatus } from "@/hooks/useRemoteAccessStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getGatewayStatusDotClassName, getGatewayStatusLabelId } from "@/remoteAccessStatusUi.js";
import { WebRemoteControlBotsEntry } from "@/WebRemoteControlBotsEntry.js";

function getFailureDescription(
  failure: WebRemoteControlFailure | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string | null {
  if (!failure) {
    return null;
  }

  switch (failure.reason) {
    case "gateway-unreachable":
      return formatMessage({ id: "webRemoteControl.failure.gatewayUnreachable" });
    case "gateway-credential-invalid":
      return formatMessage({
        id: "webRemoteControl.failure.gatewayCredentialInvalid",
      });
    case "session-conflict":
      if (failure.message?.toLowerCase().includes("kicked")) {
        return formatMessage({ id: "webRemoteControl.failure.kicked" });
      }
      return formatMessage({ id: "webRemoteControl.failure.sessionConflict" });
    case "workspace-closed":
      return formatMessage({ id: "webRemoteControl.failure.workspaceClosed" });
    case "desktop-disconnected":
      return formatMessage({
        id: "webRemoteControl.failure.desktopDisconnected",
      });
    case "incompatible-version":
      return formatMessage({ id: "webRemoteControl.failure.incompatibleVersion" });
    case "desktop-bootstrap-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.desktopBootstrapTimeout",
      });
    case "connection-recovery-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.connectionRecoveryTimeout",
      });
    case "backend-unsupported":
      return formatMessage({ id: "webRemoteControl.failure.backendUnsupported" });
    case "unsupported-action":
      return formatMessage({
        id: "webRemoteControl.failure.unsupportedAction",
      });
    case "unexpected-error":
      return formatMessage({ id: "webRemoteControl.failure.unexpectedError" });
  }
}

function getRemoteAccessStatusSummary(
  status: RemoteAccessStatus | null,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  if (!status?.enabled) {
    return formatMessage({ id: "webRemoteControl.remoteAccess.offDetail" });
  }
  switch (status.gateway.state) {
    case "online":
      return status.status.mobileConnected
        ? formatMessage({ id: "webRemoteControl.remoteAccess.phoneConnectedDetail" })
        : formatMessage({ id: "webRemoteControl.remoteAccess.waitingPhoneDetail" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.remoteAccess.connectingDetail" });
    case "error":
      return formatMessage({ id: "webRemoteControl.remoteAccess.errorDetail" });
    case "disabled":
      return formatMessage({ id: "webRemoteControl.remoteAccess.offDetail" });
  }
}

/**
 * 远控弹层（T4.1）。
 *
 * 只展示 App 级远程访问状态并提供快捷开关：gateway 地址、namespace 和 backend 凭证都在
 * 设置页配置，这里不再生成二维码，也不会在打开弹层时自动启动远控。Bot Channel 入口保留。
 */
export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 保留旧入口参数以兼容调用方；远控目标已由 App 级 runtime 自行聚合。 */
  remoteSessionId?: string;
  initialTaskId?: string;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const remoteAccessStatusRead = useRemoteAccessStatus({ enabled: open });
  const remoteAccessStatus = remoteAccessStatusRead.status;
  const [pendingAction, setPendingAction] = useState<"toggle" | "disconnect" | null>(null);

  const enabled = remoteAccessStatus?.enabled === true;
  const gateway = remoteAccessStatus?.gateway ?? { state: "disabled" as const };
  const mobileConnected = remoteAccessStatus?.status.mobileConnected === true;
  const mobileDeviceName =
    remoteAccessStatus?.status.mobileDeviceInfo?.name?.trim() ||
    remoteAccessStatus?.status.mobileDeviceInfo?.browserPlatform?.trim() ||
    intl.formatMessage({ id: "settings.remoteAccess.phone.unknownDevice" });
  const gatewayStatusLabelId = getGatewayStatusLabelId(gateway);
  const gatewayStatusDotClassName = getGatewayStatusDotClassName(gateway);
  const statusSummary = useMemo(
    () => getRemoteAccessStatusSummary(remoteAccessStatus, intl.formatMessage),
    [intl.formatMessage, remoteAccessStatus],
  );
  const failureDescription = useMemo(
    () => getFailureDescription(remoteAccessStatus?.status.failure, intl.formatMessage),
    [intl.formatMessage, remoteAccessStatus?.status.failure],
  );
  const busy = pendingAction !== null;

  useEffect(() => {
    if (!open) {
      return;
    }
    logger.info("[WebRemoteControlDialog] 打开远控状态弹层", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      enabled,
      gateway: gateway.state,
      mobileConnected,
    });
  }, [enabled, gateway.state, mobileConnected, open, workspaceIdentity, workspacePath]);

  const handleToggle = async (nextEnabled: boolean) => {
    const setEnabled = platform.setRemoteAccessEnabled;
    if (!setEnabled) {
      return;
    }
    setPendingAction("toggle");
    try {
      await setEnabled.call(platform, nextEnabled);
      await remoteAccessStatusRead.refresh();
      toast(
        intl.formatMessage({
          id: nextEnabled
            ? "webRemoteControl.remoteAccess.enabledToast"
            : "webRemoteControl.remoteAccess.disabledToast",
        }),
      );
      logger.info("[WebRemoteControlDialog] 切换远程访问开关", {
        workspacePath,
        enabled: nextEnabled,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(
        intl.formatMessage(
          { id: "webRemoteControl.remoteAccess.toggleFailed" },
          { error: message },
        ),
      );
      logger.error("[WebRemoteControlDialog] 切换远程访问开关失败", {
        workspacePath,
        error: message,
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleDisconnect = async () => {
    const disconnect = platform.disconnectRemoteClient;
    if (!disconnect) {
      return;
    }
    setPendingAction("disconnect");
    try {
      await disconnect.call(platform);
      await remoteAccessStatusRead.refresh();
      toast(intl.formatMessage({ id: "webRemoteControl.remoteAccess.disconnectSuccess" }));
      logger.info("[WebRemoteControlDialog] 已断开手机", { workspacePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(
        intl.formatMessage(
          { id: "webRemoteControl.remoteAccess.disconnectFailed" },
          { error: message },
        ),
      );
      logger.error("[WebRemoteControlDialog] 断开手机失败", { workspacePath, error: message });
    } finally {
      setPendingAction(null);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    logger.info("[WebRemoteControlDialog] 弹层开关状态变化", {
      workspacePath,
      nextOpen,
    });
    onOpenChange(nextOpen);
  };

  const handleDismiss = () => {
    handleDialogOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
          onClick={handleDismiss}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
        <div
          data-testid="web-remote-control-dialog-scroll"
          className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5"
        >
          <DialogHeader className="space-y-2 pr-8">
            <div className="flex items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                <MonitorSmartphone className="size-5" />
              </div>
              <div className="space-y-1">
                <DialogTitle>{intl.formatMessage({ id: "webRemoteControl.title" })}</DialogTitle>
                <DialogDescription>
                  {intl.formatMessage({ id: "webRemoteControl.description" })}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div
            data-testid="web-remote-control-main-grid"
            className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]"
          >
            <section
              data-testid="web-remote-control-status-card"
              className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({ id: "webRemoteControl.remoteAccess.title" })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">{statusSummary}</p>
                  </div>
                </div>
                {pendingAction === "toggle" ? (
                  <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
                ) : (
                  <Switch
                    aria-label={intl.formatMessage({
                      id: "webRemoteControl.remoteAccess.title",
                    })}
                    data-testid="web-remote-control-remote-access-switch"
                    checked={enabled}
                    disabled={busy || typeof platform.setRemoteAccessEnabled !== "function"}
                    onCheckedChange={(checked) => void handleToggle(checked)}
                  />
                )}
              </div>

              <div className="mt-4 space-y-2">
                <div
                  data-testid="web-remote-control-gateway-status"
                  data-state={gateway.state}
                  data-reason={gateway.state === "error" ? gateway.reason : undefined}
                  className="flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${gatewayStatusDotClassName}`} />
                    <span className="truncate text-ui-base text-foreground">
                      {intl.formatMessage({ id: "settings.remoteAccess.gateway.label" })}
                    </span>
                  </div>
                  <span className="shrink-0 text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: gatewayStatusLabelId })}
                  </span>
                </div>

                <div
                  data-testid="web-remote-control-mobile-status"
                  data-connected={mobileConnected ? "true" : "false"}
                  className="flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Smartphone className="size-4 shrink-0 text-foreground-subtle" />
                    <span className="truncate text-ui-base text-foreground">
                      {mobileConnected
                        ? mobileDeviceName
                        : intl.formatMessage({ id: "settings.remoteAccess.phone.waiting" })}
                    </span>
                  </div>
                  {mobileConnected ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      data-testid="web-remote-control-disconnect-client"
                      className="shrink-0 gap-2 enabled:cursor-pointer"
                      disabled={busy}
                      onClick={() => void handleDisconnect()}
                    >
                      {pendingAction === "disconnect" ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Unplug className="size-3.5" />
                      )}
                      {intl.formatMessage({ id: "settings.remoteAccess.phone.disconnect" })}
                    </Button>
                  ) : null}
                </div>
              </div>

              {failureDescription ? (
                <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-ui-base/relaxed text-destructive">
                  <p>{failureDescription}</p>
                  {remoteAccessStatus?.status.failure?.message &&
                  remoteAccessStatus.status.failure.message !== failureDescription ? (
                    <p className="mt-1 text-ui-xs/relaxed opacity-80">
                      {remoteAccessStatus.status.failure.message}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {!enabled || gateway.state === "error" ? (
                <p
                  data-testid="web-remote-control-settings-hint"
                  className="mt-3 rounded-lg border border-border bg-background-alt px-3 py-2 text-ui-base/relaxed text-foreground-subtle"
                >
                  {intl.formatMessage({ id: "webRemoteControl.remoteAccess.settingsHint" })}
                </p>
              ) : null}

              <div className="mt-auto pt-4 text-ui-xs/relaxed text-foreground-subtlest">
                {intl.formatMessage({ id: "webRemoteControl.remoteAccess.managedInSettings" })}
              </div>
            </section>

            <WebRemoteControlBotsEntry
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
