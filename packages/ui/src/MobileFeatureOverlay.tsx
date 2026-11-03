import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { MobileTargetRef, WebRemoteControlWorkspaceListResult } from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import { WebRemoteControlMobileSearch } from "@/WebRemoteControlMobileSearch.js";
import {
  MobileWorkspaceFileBrowser,
  type MobileFileBrowserOpenRequest,
} from "@/MobileWorkspaceFileBrowser.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMobileRemoteRefreshGuard } from "@/mobileRemoteRefreshGuards.js";

export type WebRemoteControlMobileFeaturePage = "search" | "files" | "notifications";

export function MobileFeatureOverlay({
  featurePage,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  workspaceRemoteSessionId,
  workspaces,
  connection,
  switcher,
  fileTreeOpenRequest,
  notificationsContent,
  onClose,
  onSwitchingWorkspaceChange,
}: {
  featurePage: WebRemoteControlMobileFeaturePage;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  workspaces: WebRemoteControlWorkspaceListResult["workspaces"];
  connection?: { backendId: string; connectionGeneration: number };
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  fileTreeOpenRequest?: MobileFileBrowserOpenRequest | null;
  notificationsContent?: ReactNode;
  onClose: () => void;
  onSwitchingWorkspaceChange: (switching: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 文件/搜索/通知全屏弹层在卸载时才解除，避免 reload 丢失当前浏览上下文。
  useMobileRemoteRefreshGuard("mobile-feature-overlay", () => "active-overlay");
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstControl = containerRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
    );
    (firstControl ?? containerRef.current)?.focus();
    return () => {
      if (!containerRef.current?.isConnected) previousFocus?.focus();
    };
  }, [featurePage]);

  const fileBrowserTarget: MobileTargetRef | undefined = connection
    ? {
        backendId: connection.backendId,
        workspaceKey: resolveWebRemoteControlWorkspaceKey({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
        }),
        workspacePath: activeWorkspacePath,
        ...(activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : {}),
        ...(activeWorkspaceIdentity && workspaceRemoteSessionId
          ? { remoteSessionId: workspaceRemoteSessionId }
          : {}),
      }
    : undefined;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-50 bg-background"
      data-mobile-feature-overlay={featurePage}
      role="dialog"
      aria-modal="true"
      aria-label={intl.formatMessage({
        id:
          featurePage === "files"
            ? "mobileFileBrowser.title"
            : featurePage === "search"
              ? "mobileSearch.title"
              : "mobileNotifications.title",
      })}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
        );
        const first = focusable?.item(0);
        const last = focusable?.item((focusable.length || 1) - 1);
        if (!first || !last) {
          event.preventDefault();
          containerRef.current?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {featurePage === "files" ? (
        <MobileWorkspaceFileBrowser
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          target={fileBrowserTarget}
          openRequest={fileTreeOpenRequest}
          onClose={onClose}
        />
      ) : featurePage === "search" && connection && switcher.searchMobileHistory ? (
        <WebRemoteControlMobileSearch
          workspaces={workspaces}
          connection={connection}
          send={switcher.searchMobileHistory}
          createRequestId={() => crypto.randomUUID()}
          onBack={onClose}
          onSelectTask={(target) => {
            onSwitchingWorkspaceChange(true);
            onClose();
            void switcher
              .switchWorkspace(target.workspaceKey, {
                taskId: target.taskId,
                mobileNavigationIntent: "chat",
                searchHighlight: target.search,
              })
              .catch((error) => {
                onSwitchingWorkspaceChange(false);
                logger.warn("Mobile search navigation failed", { error });
              });
          }}
        />
      ) : featurePage === "notifications" ? (
        (notificationsContent ?? null)
      ) : null}
    </div>
  );
}
