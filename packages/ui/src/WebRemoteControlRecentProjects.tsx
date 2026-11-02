import { memo, useCallback, useState } from "react";
import { FolderOpen, FolderPlus, LoaderCircle, MonitorUp, Plus, Settings } from "lucide-react";
import type {
  WebRemoteControlDesktopWindowState,
  WebRemoteControlRecentProjectTarget,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MobileWorkspacePicker } from "@/MobileWorkspacePicker.js";
import { useWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";
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
  /** 第二批 E1：打开任意已存在本地目录的入口；能力不足（appProtocol < 4）时缺省隐藏。 */
  onOpenOtherProject?(): void;
  /**
   * home-9 修复：打开最近项目失败的错误文案；与 `failedProjectId` 同时提供时
   * 渲染在对应行的行内（用户点击的位置附近），而不是列表上方的全局位置。
   */
  error?: string | null;
  /** home-9 修复：打开失败的项目 id；匹配到当前列表行时错误改为行内反馈。 */
  failedProjectId?: string | null;
  /**
   * home-7 修复：gateway 断连/重连期间禁用打开动作，避免点击后空转 12–15 秒才报超时。
   * 由调用方按真实连接态传入（StartPage 读 transport 状态）。
   */
  actionsDisabled?: boolean;
  className?: string;
}

/**
 * perf-4：最近项目区在任务首页以 memo 组件渲染；TaskHome 传入的回调都是稳定引用，
 * 首页其它局部 state 变化（展开、错误条、切换任务）不再连带重渲染整个列表。
 */
export const WebRemoteControlRecentProjectsSection = memo(
  function WebRemoteControlRecentProjectsSection({
    recentProjects,
    desktopWindowState,
    openingProjectId,
    openingWindow = false,
    onOpenRecentProject,
    onOpenDesktopWindow,
    onOpenOtherProject,
    error,
    failedProjectId,
    actionsDisabled = false,
    className,
  }: WebRemoteControlRecentProjectsSectionProps) {
    const { intl } = useZCodeIntl();
    const busy = Boolean(openingProjectId) || openingWindow || actionsDisabled;

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
          <>
            <p className="mt-2 px-1 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.mobileHome.recentProjectsEmpty" })}
            </p>
            {onOpenOtherProject ? (
              <button
                type="button"
                data-mobile-remote-open-other-project="true"
                className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-70"
                disabled={busy}
                onClick={onOpenOtherProject}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                  <FolderPlus className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                  {intl.formatMessage({ id: "webRemoteControl.mobileHome.openOtherProject" })}
                </span>
              </button>
            ) : null}
          </>
        ) : (
          <ul className="mt-2 space-y-1">
            {recentProjects.map((project) => {
              const opening = openingProjectId === project.id;
              // home-9 修复：失败反馈跟在用户点击的那一行里，滚动位置不变也能看到。
              const inlineError =
                error && failedProjectId === project.id ? error : null;

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
                      {inlineError ? (
                        <span role="alert" className="mt-1 block text-ui-sm text-destructive">
                          {inlineError}
                        </span>
                      ) : null}
                    </span>
                    <Plus className="size-4 shrink-0 text-foreground-subtle" />
                  </button>
                </li>
              );
            })}
            {onOpenOtherProject ? (
              <li>
                <button
                  type="button"
                  data-mobile-remote-open-other-project="true"
                  className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-70"
                  disabled={busy}
                  onClick={onOpenOtherProject}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                    <FolderPlus className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                    {intl.formatMessage({ id: "webRemoteControl.mobileHome.openOtherProject" })}
                  </span>
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </section>
    );
  },
);

export interface WebRemoteControlMobileStartPageProps {
  desktopWindowState: WebRemoteControlDesktopWindowState;
  recentProjects: WebRemoteControlRecentProjectTarget[];
  openingProjectId?: string | null;
  openingWindow?: boolean;
  error?: string | null;
  /**
   * home-9 修复：与 `error` 搭配使用，标记打开失败的项目 id；
   * 命中列表行时错误渲染在行内，否则回落到列表下方的全局提示。
   */
  failedProjectId?: string | null;
  /**
   * home-7 修复：断连期间手动重试入口的宿主回调（如 bootstrap 的 recoverVisibleSession）。
   * 未提供时退化为整页重载——空态页没有本地草稿，重载即重新走 bootstrap。
   */
  onRetryConnection?: () => void;
  onOpenRecentProject(projectId: string): void;
  onOpenDesktopWindow(): void;
  onOpenSettings(): void;
  /**
   * 第二批 E1：提供时显示「打开其他项目」入口并托管目录选择器 overlay；
   * 宿主按协商版本决定是否提供（appProtocol < 4 的桌面不提供）。
   */
  openOtherProject?: {
    listDirectory(
      path?: string,
    ): Promise<import("@zcode/shared").WebRemoteControlMobileDirectoryListResult>;
    openWorkspacePath(workspacePath: string): Promise<string>;
    onOpened(workspaceKey: string): void | Promise<void>;
  };
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
  failedProjectId,
  onRetryConnection,
  onOpenRecentProject,
  onOpenDesktopWindow,
  onOpenSettings,
  openOtherProject,
}: WebRemoteControlMobileStartPageProps) {
  const { intl } = useZCodeIntl();
  const [otherProjectOpen, setOtherProjectOpen] = useState(false);
  // home-7 修复：副标题之前固定渲染「已连接到 gateway」，与真实连接态无关；
  // 弱网/桌面断线期间（可恢复失败且页面已 ready）页面不做任何提示。
  // bootstrap 在每次 transport 状态变化时都会写模块级 store（setWebRemoteControlTerminalTransportState），
  // 这里直接订阅真实连接态：仅 paired 视为已连接，其余状态展示自动重连提示并禁用打开动作。
  const terminalTransportState = useWebRemoteControlTerminalTransportState();
  const connected = terminalTransportState === "paired";
  const noWindow = desktopWindowState === "none";

  const handleRetryConnection = useCallback(() => {
    if (onRetryConnection) {
      onRetryConnection();
      return;
    }
    // 未接线宿主回调时退化为整页重载：空态页没有草稿等本地状态，
    // 重载会重新走 bootstrap，立即重试建连而不是等待自动重连周期。
    window.location.reload();
  }, [onRetryConnection]);

  // home-9 修复：失败项目 id 仍命中当前列表时改为行内反馈；否则保留全局提示，
  // 但移到列表下方（用户点击后视线停留在列表区域，原位置在列表上方很可能已在视口外）。
  const inlineRecentProjectError =
    error &&
    failedProjectId &&
    recentProjects.some((project) => project.id === failedProjectId)
      ? error
      : null;

  return (
    <section
      className="relative flex min-h-dvh flex-col bg-background text-foreground"
      data-mobile-remote-page="start"
      aria-hidden={otherProjectOpen ? true : undefined}
    >
      <header className="shrink-0 border-b border-border bg-header px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-ui-lg font-medium">
              {intl.formatMessage({ id: "webRemoteControl.mobileStart.title" })}
            </h1>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: connected
                  ? "webRemoteControl.mobileStart.connected"
                  : "webRemoteControl.mobileShell.reconnecting",
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <WebRemoteControlThemeMenu className="size-11" />
            {!connected ? (
              /* home-7 修复：可恢复失败期间给手动重试入口；transport 仍会自动重连，
                这里只是让用户可以立即重试而不是干等。 */
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 px-3"
                aria-label={intl.formatMessage({ id: "common.retry" })}
                onClick={handleRetryConnection}
              >
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            ) : null}
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

        <WebRemoteControlRecentProjectsSection
          className="mt-4"
          recentProjects={recentProjects}
          desktopWindowState={desktopWindowState}
          openingProjectId={openingProjectId}
          openingWindow={openingWindow}
          error={inlineRecentProjectError}
          failedProjectId={failedProjectId}
          actionsDisabled={!connected}
          onOpenRecentProject={onOpenRecentProject}
          onOpenDesktopWindow={onOpenDesktopWindow}
          onOpenOtherProject={
            openOtherProject ? () => setOtherProjectOpen(true) : undefined
          }
        />

        {error && !inlineRecentProjectError ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-ui-base text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
      {otherProjectOpen && openOtherProject ? (
        <MobileWorkspacePicker
          listDirectory={openOtherProject.listDirectory}
          openWorkspacePath={openOtherProject.openWorkspacePath}
          onClose={() => setOtherProjectOpen(false)}
          onOpened={openOtherProject.onOpened}
        />
      ) : null}
    </section>
  );
}
