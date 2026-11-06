/* eslint-disable max-lines -- 手机远控壳集中持有页面/浮层导航状态、history 返回桥和
   mobileViewState 同步；首页、能力浮层、目录选择器、通知与返回处理已各自拆出独立文件，
   剩余部分是聊天表面与全局浮层的 JSX，其状态与回调都在本组件，强拆只会增加跨文件透传成本
   （对齐 WebRemoteControlMobileTaskHome.tsx 的同规则豁免先例）。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bell, LoaderIcon, Search, FolderOpen } from "lucide-react";
import {
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlMobileNavigationIntent,
  type WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { MobileNotificationsFeature } from "@/MobileNotificationsFeature.js";
import { MobileWorkspacePicker } from "@/MobileWorkspacePicker.js";
import { WebRemoteControlMobileHomePage } from "@/WebRemoteControlMobileHomePage.js";
import { WebRemoteControlMobileSettingsButton } from "@/WebRemoteControlMobileSettingsButton.js";
import type { MobileFileBrowserOpenRequest } from "@/MobileWorkspaceFileBrowser.js";
import {
  MobileFeatureOverlay,
  type WebRemoteControlMobileFeaturePage,
} from "@/MobileFeatureOverlay.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useMobileFileEntryNavigation } from "@/hooks/useMobileFileEntryNavigation.js";
import { useMobileFeatureWorkspaceDirectory } from "@/hooks/useMobileFeatureWorkspaceDirectory.js";
import { useWebRemoteControlMobileShellBack } from "@/hooks/useWebRemoteControlMobileShellBack.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  backOutOfWebRemoteControlMobileOverlayHistory,
  clearWebRemoteControlMobileOverlayHistoryState,
  isWebRemoteControlMobileChatHistoryState,
  pushWebRemoteControlMobileChatHistory,
  pushWebRemoteControlMobileOverlayHistory,
  resolveInitialWebRemoteControlMobilePage,
  type WebRemoteControlMobileOverlayHistoryEntry,
  type WebRemoteControlMobilePage,
} from "@/mobileNavigationHistory.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { useWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";

export { isWebRemoteControlMobileChatHistoryState } from "@/mobileNavigationHistory.js";

export function WebRemoteControlMobileShell({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  workspaceRemoteSessionId,
  fileTreeOpenRequest,
  chatContent,
  chatOverlay,
  initialNavigationIntent,
  initialWorkspaceList,
  isSidePaneOpen = false,
  onCloseSidePane,
  onOpenAppSettings,
  onSelectTask,
  onStartDraftInWorkspace,
  renderChatHeader,
  sidePaneContent,
  switcher,
  webRemoteControlTerminalTransportState,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  workspaceRemoteSessionId?: string;
  fileTreeOpenRequest?: MobileFileBrowserOpenRequest | null;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  initialWorkspaceList?: WebRemoteControlWorkspaceListResult;
  isSidePaneOpen?: boolean;
  onCloseSidePane?: () => void;
  onOpenAppSettings?: () => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace?: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  renderChatHeader: (options: { onBackHome: () => void }) => ReactNode;
  chatContent: ReactNode;
  chatOverlay?: ReactNode;
  sidePaneContent?: ReactNode;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
}) {
  const { intl } = useZCodeIntl();
  const [featurePage, setFeaturePage] = useState<WebRemoteControlMobileFeaturePage | null>(
    initialNavigationIntent === "files" ? "files" : null,
  );
  // 第二批 E1：目录选择器 overlay 与 feature overlay 同层；能力不足（appProtocol < 4）时不出现入口。
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const canOpenOtherProject =
    switcher.canOpenArbitraryWorkspace?.() === true &&
    Boolean(switcher.listMobileDirectory && switcher.openWorkspacePath);
  const directory = useMobileFeatureWorkspaceDirectory(switcher, initialWorkspaceList);
  const capabilities = switcher.getMobileCapabilities?.();
  const connection = switcher.getMobileConnection?.();
  const canOpenNotifications =
    capabilities?.notificationFeed === 1 &&
    Boolean(switcher.getNotificationReader && switcher.openNotification);
  // 走查 shell-1：浮层打开压入 overlay history 条目（iOS Safari 无返回桥，系统返回靠条目先关浮层）；
  // 统一关闭入口把 React 状态与 history 条目一起回收（UI 返回键/Android 返回桥共用，popstate 回写幂等不成环）。
  const openFeature = useCallback((page: WebRemoteControlMobileFeaturePage) => {
    setFeaturePage(page);
    pushWebRemoteControlMobileOverlayHistory(page);
  }, []);
  const openWorkspacePicker = useCallback(() => {
    setWorkspacePickerOpen(true);
    pushWebRemoteControlMobileOverlayHistory("workspacePicker");
  }, []);
  const closeFeature = useCallback(() => {
    setFeaturePage(null);
    backOutOfWebRemoteControlMobileOverlayHistory();
  }, []);
  const closeWorkspacePicker = useCallback(() => {
    setWorkspacePickerOpen(false);
    backOutOfWebRemoteControlMobileOverlayHistory();
  }, []);
  // 走查 shell-1：刷新会保留 history state，但浮层 React 状态已丢。挂载时剥掉残留的
  // overlay 标识（保留宿主页面标识），避免下一次开浮层叠在废条目上、系统返回时复活旧浮层。
  useEffect(() => {
    clearWebRemoteControlMobileOverlayHistoryState();
  }, []);
  useEffect(() => {
    if (initialNavigationIntent === "files") openFeature("files");
  }, [initialNavigationIntent, openFeature]);
  const openFiles = useMobileFileEntryNavigation({
    switcher,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    fileTreeOpenRequest,
    fileBrowserEnabled: capabilities?.fileBrowser === 1,
    setFeaturePage: openFeature,
  });
  const [currentPage, setCurrentPage] = useState<WebRemoteControlMobilePage>(() =>
    resolveInitialWebRemoteControlMobilePage(initialNavigationIntent),
  );
  useEffect(() => {
    switcher.onNavigationMounted?.({
      workspaceKey: activeWorkspaceIdentity?.trim() || activeWorkspacePath,
      taskId: currentPage === "chat" ? (activeTaskId ?? undefined) : undefined,
    });
  }, [switcher, activeWorkspaceIdentity, activeWorkspacePath, activeTaskId, currentPage]);
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const terminalTransportState = useWebRemoteControlTerminalTransportState(
    webRemoteControlTerminalTransportState,
  );
  const syncedMobileViewStateRef = useRef<string | null>(null);
  const shouldInertChatSurface = Boolean(sidePaneContent) && isSidePaneOpen;

  const navigateToChat = useCallback(() => {
    setCurrentPage("chat");
    pushWebRemoteControlMobileChatHistory();
  }, []);

  const navigateHome = useCallback(() => {
    setHomeRefreshKey((key) => key + 1);
    if (
      typeof window !== "undefined" &&
      isWebRemoteControlMobileChatHistoryState(window.history.state)
    ) {
      window.history.back();
      return;
    }

    setCurrentPage("home");
  }, []);

  // T6.2：Android 返回键经 IPlatformService 分发到页面。页面比 WebView 历史更清楚当前 UI：
  // 浮层打开时先关浮层，聊天页先回首页；首页返回 false，由宿主做历史回退/退出。
  const platform = useOptionalPlatform();
  // 走查 shell-1：popstate 落在 overlay 条目（前进/层间返回）时按条目回写浮层状态；
  // 与打开入口走同一套能力闸门，避免复活能力已关闭的浮层。只改 React 状态，不再动 history。
  const applyOverlayFromHistory = useCallback(
    (overlay: WebRemoteControlMobileOverlayHistoryEntry) => {
      if (overlay === "workspacePicker") {
        setFeaturePage(null);
        if (canOpenOtherProject) {
          setWorkspacePickerOpen(true);
        }
        return;
      }
      setWorkspacePickerOpen(false);
      if (overlay === "files" && capabilities?.fileBrowser !== 1) {
        return;
      }
      if (overlay === "search" && capabilities?.historySearch !== 1) {
        return;
      }
      if (overlay === "notifications" && !canOpenNotifications) {
        return;
      }
      setFeaturePage(overlay);
    },
    [canOpenNotifications, canOpenOtherProject, capabilities],
  );
  // popstate 落回基础条目时清掉全部浮层；统一关闭路径已回收状态时是幂等空操作（不形成回环）。
  const clearOverlayFromHistory = useCallback(() => {
    setFeaturePage(null);
    setWorkspacePickerOpen(false);
  }, []);
  useWebRemoteControlMobileShellBack({
    platform: platform ?? undefined,
    currentPage,
    setCurrentPage,
    featurePage,
    closeFeature,
    isSidePaneOpen,
    onCloseSidePane,
    navigateHome,
    setHomeRefreshKey,
    workspacePickerOpen,
    closeWorkspacePicker,
    applyOverlayFromHistory,
    clearOverlayFromHistory,
  });

  useEffect(() => {
    if (initialNavigationIntent !== "chat") {
      return;
    }

    navigateToChat();
  }, [initialNavigationIntent, navigateToChat]);

  useEffect(() => {
    if (!switcher.updateMobileViewState) {
      return;
    }
    const workspaceKey = resolveWebRemoteControlWorkspaceKey({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
    });
    const dedupeKey = `${workspaceKey}:${activeTaskId ?? ""}`;
    if (syncedMobileViewStateRef.current === dedupeKey) {
      return;
    }
    syncedMobileViewStateRef.current = dedupeKey;

    // Bugfix: 手机端“新建任务/分叉”会自动切到新 task，但之前只有点任务列表项才会上报 mobileViewState。
    // 这样桌面端会继续认为手机还在旧 task，导致新 task 列表刷新滞后。
    // 这里在 activeTaskId 变化时立即同步，确保跨端选中态和任务列表收敛一致。
    void switcher.updateMobileViewState(workspaceKey, activeTaskId ?? undefined).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[WebRemoteControlMobileShell] 同步 mobileViewState 失败", {
        error: message,
        workspaceKey,
        taskId: activeTaskId ?? null,
      });
    });
  }, [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, switcher]);

  // Bugfix: 移动端聊天/侧栏都是 flex 子树，默认 min-width:auto 会按长消息的
  // min-content 宽度撑开抽屉；窄屏随后从左侧裁掉正文。沿整条宽度链显式允许收缩，
  // 让 subagent 输出、进程面板和正文在抽屉内换行。
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-hidden={featurePage || workspacePickerOpen ? true : undefined}
        inert={featurePage || workspacePickerOpen ? true : undefined}
      >
        {currentPage === "home" ? (
          <WebRemoteControlMobileHomePage
            activeTaskId={activeTaskId}
            activeWorkspaceIdentity={activeWorkspaceIdentity}
            activeWorkspacePath={activeWorkspacePath}
            initialWorkspaceList={initialWorkspaceList}
            homeRefreshKey={homeRefreshKey}
            switcher={switcher}
            onSelectTask={onSelectTask}
            onStartDraftInWorkspace={onStartDraftInWorkspace}
            onNavigateHome={navigateHome}
            onNavigateToChat={navigateToChat}
            onSwitchingWorkspaceChange={setSwitchingWorkspace}
            onOpenAppSettings={onOpenAppSettings}
            onOpenSearch={
              capabilities?.historySearch === 1 ? () => openFeature("search") : undefined
            }
            onOpenFiles={capabilities?.fileBrowser === 1 ? openFiles : undefined}
            onOpenNotifications={
              canOpenNotifications ? () => openFeature("notifications") : undefined
            }
            onOpenOtherProject={canOpenOtherProject ? openWorkspacePicker : undefined}
          />
        ) : (
          <section
            className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
            data-mobile-page="chat"
          >
            {/* 走查 touch-9：viewport-fit=cover 时外层消费 .zcode-safe-area-top 压到刘海之下
                （env 为 0 的环境不变）；内层保持 h-11 原栏高。 */}
            <div className="zcode-safe-area-top shrink-0 border-b border-border bg-header">
              <div className="flex h-11 items-center gap-1 px-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-11"
                  aria-label={intl.formatMessage({
                    id: "webRemoteControl.mobileShell.backHome",
                  })}
                  onClick={navigateHome}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
                  {intl.formatMessage({ id: "webRemoteControl.mobileShell.chatTitle" })}
                </span>
                {capabilities?.fileBrowser === 1 ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="size-11"
                    aria-label={intl.formatMessage({ id: "mobileFileBrowser.title" })}
                    onClick={() => openFeature("files")}
                  >
                    <FolderOpen className="size-4" />
                  </Button>
                ) : null}
                {capabilities?.historySearch === 1 ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="size-11"
                    aria-label={intl.formatMessage({ id: "mobileSearch.title" })}
                    onClick={() => openFeature("search")}
                  >
                    <Search className="size-4" />
                  </Button>
                ) : null}
                {canOpenNotifications ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="size-11"
                    aria-label={intl.formatMessage({ id: "mobileNotifications.title" })}
                    onClick={() => openFeature("notifications")}
                  >
                    <Bell className="size-4" />
                  </Button>
                ) : null}
                <WebRemoteControlMobileSettingsButton onOpenAppSettings={onOpenAppSettings} />
                {/* 走查 shell-3/touch-3：size-11 经 ThemeMenu 的 className 透传到触发钮
                    （icon-sm 视觉不变），补齐顶栏第 5 个 44px 命中区。 */}
                <WebRemoteControlThemeMenu className="size-11" />
              </div>
            </div>
            {renderChatHeader({ onBackHome: navigateHome })}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <main
                className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                aria-hidden={shouldInertChatSurface ? true : undefined}
                data-mobile-chat-surface={shouldInertChatSurface ? "inert" : undefined}
                inert={shouldInertChatSurface ? true : undefined}
              >
                {/* Bugfix: 手机侧栏打开时底部 composer 会被抽屉覆盖。
                  如果聊天区仍留在交互树里，模型选择等控件会被遮挡但仍可被浏览器命中，
                  造成“按钮不可点”的误导。这里把被覆盖的聊天表面设为 inert，
                  让右侧抽屉成为唯一可交互区域。 */}
                {chatContent}
              </main>
              {sidePaneContent ? (
                <div
                  className={[
                    "absolute inset-0 z-30 transition-opacity duration-200 ease-out",
                    isSidePaneOpen ? "opacity-100" : "pointer-events-none opacity-0",
                  ].join(" ")}
                  aria-hidden={!isSidePaneOpen}
                  data-mobile-side-pane-overlay="true"
                >
                  <button
                    type="button"
                    className="absolute inset-0 bg-background/60 backdrop-blur-[1px]"
                    aria-label={intl.formatMessage({ id: "sidePane.collapse" })}
                    onClick={onCloseSidePane}
                  />
                  <div
                    className={[
                      "absolute top-0 right-0 h-full w-[min(88vw,28rem)] max-w-full border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out",
                      isSidePaneOpen ? "translate-x-0" : "translate-x-full",
                    ].join(" ")}
                  >
                    {/* Bugfix: 手机远控之前把 side pane 作为底部纵向面板渲染，
                      会挤压聊天区且不像桌面右侧栏。这里改成右侧覆盖抽屉，
                      只覆盖手机聊天区，不改变桌面端分栏布局。 */}
                    {sidePaneContent}
                  </div>
                </div>
              ) : null}
              {chatOverlay ? (
                <div
                  className="pointer-events-none absolute inset-0 z-40"
                  data-mobile-chat-overlay="true"
                >
                  {/* Bugfix: 查找框属于聊天视觉区域，但不能成为 inert 聊天表面的后代。
                    独立 overlay 保留抽屉隔离，同时让文件变更查找仍可聚焦、切换和关闭。 */}
                  <div className="pointer-events-auto">{chatOverlay}</div>
                </div>
              ) : null}
            </div>
          </section>
        )}
      </div>
      {featurePage ? (
        <MobileFeatureOverlay
          featurePage={featurePage}
          activeWorkspacePath={activeWorkspacePath}
          activeWorkspaceIdentity={activeWorkspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          workspaces={directory.workspaces}
          connection={connection}
          switcher={switcher}
          fileTreeOpenRequest={fileTreeOpenRequest}
          notificationsContent={
            canOpenNotifications ? (
              <MobileNotificationsFeature switcher={switcher} onBack={closeFeature} />
            ) : null
          }
          onClose={closeFeature}
          onSwitchingWorkspaceChange={setSwitchingWorkspace}
        />
      ) : null}
      {workspacePickerOpen && switcher.listMobileDirectory && switcher.openWorkspacePath ? (
        <MobileWorkspacePicker
          listDirectory={switcher.listMobileDirectory}
          openWorkspacePath={switcher.openWorkspacePath}
          onClose={closeWorkspacePicker}
          onOpened={async (workspaceKey) => {
            closeWorkspacePicker();
            // 与「最近项目」同一条切换路径：bootstrap 打开 bridge 并进入聊天页草稿态。
            await switcher.switchWorkspace(workspaceKey);
          }}
        />
      ) : null}
      {switchingWorkspace ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        </div>
      ) : null}
      {terminalTransportState === "reconnecting" ? (
        <div
          className="zcode-safe-area-top pointer-events-none absolute top-3 left-1/2 z-50 flex -translate-x-1/2 justify-center px-3"
          aria-live="polite"
          aria-busy="true"
          data-web-remote-control-reconnect-notice="true"
        >
          {/* 走查 viewport-3：消费 .zcode-safe-area-top 让提示落到状态栏/刘海之下（env 为 0 时位置不变）。 */}
          <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-lg border border-border bg-toast px-3 py-2 text-ui-base text-foreground shadow-lg">
            <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
            <span className="min-w-0 whitespace-nowrap">
              {intl.formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
