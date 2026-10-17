import { FolderOpen, LoaderCircle, MonitorUp, Plus, Settings } from "lucide-react";
import type {
  WebRemoteControlDesktopWindowState,
  WebRemoteControlRecentProjectTarget,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";

/**
 * 手机首页的「最近项目」区与无窗口空态（T4.2）。
 *
 * 最近项目来自桌面下发的 `recentProjects`（只含未打开的项目）和不透明 id；手机只能回传 id，
 * 不能构造路径。`desktopWindowState === "none"` 时额外提供「在电脑上打开窗口」按钮。
 * 所有可点击行不低于 44px（`min-h-11`/`min-h-14`），满足手机触控目标要求。
 */

export interface WebRemoteControlRecentProjectsSectionProps {
  recentProjects: WebRemoteControlRecentProjectTarget[];
  desktopWindowState: WebRemoteControlDesktopWindowState;
  openingProjectId?: string | null;
  openingWindow?: boolean;
  onOpenRecentProject(projectId: string): void;
  onOpenDesktopWindow?(): void;
  className?: string;
}

export function WebRemoteControlRecentProjectsSection({
  recentProjects,
  desktopWindowState,
  openingProjectId,
  openingWindow = false,
  onOpenRecentProject,
  onOpenDesktopWindow,
  className,
}: WebRemoteControlRecentProjectsSectionProps) {
  const { intl } = useZCodeIntl();
  const busy = Boolean(openingProjectId) || openingWindow;

  return (
    <section className={cn("min-w-0", className)} data-mobile-remote-recent-projects="true">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="min-w-0 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "webRemoteControl.mobileHome.recentProjects" })}
        </h2>
        <span className="shrink-0 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.mobileHome.recentProjectsHint" })}
        </span>
      </div>

      {desktopWindowState === "none" && onOpenDesktopWindow ? (
        <div className="mt-2 rounded-lg border border-card-border bg-card p-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
              <MonitorUp className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "webRemoteControl.mobileStart.noWindowTitle" })}
              </div>
              <p className="mt-1 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "webRemoteControl.mobileStart.noWindowDescription" })}
              </p>
            </div>
          </div>
          <Button
            type="button"
            className="mt-3 h-11 w-full"
            onClick={onOpenDesktopWindow}
            disabled={busy}
            data-mobile-remote-open-window="true"
          >
            {openingWindow ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
            {intl.formatMessage({
              id: openingWindow
                ? "webRemoteControl.mobileStart.openingWindow"
                : "webRemoteControl.mobileStart.openWindow",
            })}
          </Button>
        </div>
      ) : null}

      {recentProjects.length === 0 ? (
        <p className="mt-2 px-1 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.mobileHome.recentProjectsEmpty" })}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {recentProjects.map((project) => {
            const opening = openingProjectId === project.id;
            return (
              <li key={project.id}>
                <button
                  type="button"
                  data-mobile-remote-recent-project={project.id}
                  className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-70"
                  disabled={busy}
                  onClick={() => onOpenRecentProject(project.id)}
                  aria-label={intl.formatMessage(
                    { id: "webRemoteControl.mobileHome.openRecentProject" },
                    { name: project.label },
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                    {opening ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <FolderOpen className="size-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-base text-foreground">
                      {project.label}
                    </span>
                    <span className="mt-1 block truncate font-mono text-ui-xs text-foreground-subtle">
                      {project.location}
                    </span>
                  </span>
                  <Plus className="size-4 shrink-0 text-foreground-subtle" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface WebRemoteControlMobileStartPageProps {
  desktopWindowState: WebRemoteControlDesktopWindowState;
  recentProjects: WebRemoteControlRecentProjectTarget[];
  openingProjectId?: string | null;
  openingWindow?: boolean;
  error?: string | null;
  onOpenRecentProject(projectId: string): void;
  onOpenDesktopWindow(): void;
  onOpenSettings(): void;
}

/**
 * 桌面没有打开任何 workspace 时的手机首页。
 *
 * 方案「产品规则 · 手机」：桌面没有窗口时显示空态和「在电脑上打开窗口」按钮；
 * 打开最近项目后由调用方重新 bootstrap 并进入正常的任务首页。
 */
export function WebRemoteControlMobileStartPage({
  desktopWindowState,
  recentProjects,
  openingProjectId,
  openingWindow,
  error,
  onOpenRecentProject,
  onOpenDesktopWindow,
  onOpenSettings,
}: WebRemoteControlMobileStartPageProps) {
  const { intl } = useZCodeIntl();
  const noWindow = desktopWindowState === "none";

  return (
    <section
      className="flex min-h-screen flex-col bg-background text-foreground"
      data-mobile-remote-page="start"
    >
      <header className="shrink-0 border-b border-border bg-header px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-ui-lg font-medium">
              {intl.formatMessage({ id: "webRemoteControl.mobileStart.title" })}
            </h1>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.mobileStart.connected" })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <WebRemoteControlThemeMenu />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={intl.formatMessage({ id: "webRemoteControl.mobileStart.settings" })}
              onClick={onOpenSettings}
            >
              <Settings className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!noWindow ? (
          <div className="rounded-lg border border-card-border bg-card p-4">
            <h2 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "webRemoteControl.mobileStart.noWorkspaceTitle" })}
            </h2>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.mobileStart.noWorkspaceDescription" })}
            </p>
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-ui-base text-destructive"
          >
            {error}
          </p>
        ) : null}

        <WebRemoteControlRecentProjectsSection
          className="mt-4"
          recentProjects={recentProjects}
          desktopWindowState={desktopWindowState}
          openingProjectId={openingProjectId}
          openingWindow={openingWindow}
          onOpenRecentProject={onOpenRecentProject}
          onOpenDesktopWindow={onOpenDesktopWindow}
        />
      </div>
    </section>
  );
}
