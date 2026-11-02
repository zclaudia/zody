/* eslint-disable max-lines -- 手机远控首页集中编排 workspace card、task row、加载态和交互态，行/卡已拆为 memo 子组件，后续筛选/搜索落地时再按文件边界拆分。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Clock3,
  Cloud,
  FolderOpen,
  LoaderIcon,
  MessageCircleCheck,
  MessageCirclePlus,
  Pin,
  Plus,
  RefreshCw,
  Settings2,
  Search,
} from "lucide-react";
import {
  TID_TASK_ITEM,
  resolveWebRemoteControlWorkspaceKey,
  testId,
  type WebRemoteControlRecentProjectsResult,
  type WebRemoteControlTaskDisplayStatus,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  buildWebRemoteControlTaskRowKey,
  useWebRemoteControlTaskOpen,
} from "@/hooks/useWebRemoteControlTaskOpen.js";
import { getErrorMessage } from "@/hooks/chatActionHelpers.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { getTaskTimelineGroupMessage, groupTaskTimelineItems } from "@/lib/taskTimelineGroups.js";
import {
  EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST,
  buildWebRemoteControlMobileTaskHomeModel,
  getWebRemoteControlTaskStatusClassName,
  getWorkspaceLatestUpdatedAt,
  hasWebRemoteControlMobileTaskHomeActiveTaskMatch,
  type WebRemoteControlMobileTaskHomePreferences,
} from "@/lib/webRemoteControlMobileTaskHome.js";
import type { WebRemoteControlWorkspaceTaskGroup } from "@/lib/webRemoteControlTaskIndex.js";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { WebRemoteControlRecentProjectsSection } from "@/WebRemoteControlRecentProjects.js";
import { WebRemoteControlMobileSettingsMenu } from "@/WebRemoteControlMobileSettingsMenu.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";

export { buildWebRemoteControlMobileTaskHomeModel } from "@/lib/webRemoteControlMobileTaskHome.js";
export {
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
  type WebRemoteControlMobileTaskHomePreferences,
} from "@/lib/webRemoteControlMobileTaskHome.js";

type MobileWorkspaceTarget = WebRemoteControlWorkspaceListResult["workspaces"][number];

function getStatusIcon(status: WebRemoteControlTaskDisplayStatus) {
  if (status === "running") {
    return <LoaderIcon className="size-3 animate-spin" />;
  }

  if (status === "completed") {
    return <CheckCircle2 className="size-3" />;
  }

  if (status === "error") {
    return <AlertCircle className="size-3" />;
  }

  return null;
}

/**
 * shell-4 修复：任务首页进入聊天页时会被 Shell（WebRemoteControlMobileShell.tsx 的
 * currentPage 条件渲染）整体卸载，组件内 useState 随之销毁；返回首页重挂载后，
 * 用户此前手动展开的其他 workspace 卡会被 useState 初始值重置回「仅展开 active workspace」。
 *
 * 状态归属：这里用模块级 store 作为 expandedWorkspaceKeys 的唯一所有者——
 * 生命周期与手机页面相同，跨卸载/重挂载保留；组件 state 只是它的镜像，
 * 任何变更都必须经过 writePersistedExpandedWorkspaceKeys 回写。页面刷新后
 * 内存 store 归零，仍回落到默认展开规则（仅 active workspace），与刷新语义一致。
 */
let persistedExpandedWorkspaceKeys: Set<string> | null = null;

function readPersistedExpandedWorkspaceKeys(): Set<string> | null {
  return persistedExpandedWorkspaceKeys;
}

function writePersistedExpandedWorkspaceKeys(next: Set<string>): void {
  persistedExpandedWorkspaceKeys = next;
}

/** 仅供单测复位模块级展开状态所有者（对齐 resetWorkflowRunSavedStoreForTests 先例）。 */
export function resetWebRemoteControlMobileTaskHomeExpandedWorkspaceKeysForTests(): void {
  persistedExpandedWorkspaceKeys = null;
}

function isDisconnectedRemoteWorkspaceTarget(workspace?: MobileWorkspaceTarget): boolean {
  return (
    workspace?.kind === "remote" &&
    (workspace.connectionState === "disconnected" || !workspace.remoteSessionId)
  );
}

interface MobileTaskRowProps {
  task: WebRemoteControlTaskTarget;
  /** pinned：Pin 图标 + 角标未读点；timeline/workspace：未读点或切换 spinner 互斥占位。 */
  variant: "pinned" | "timeline" | "workspace";
  selected: boolean;
  switching: boolean;
  /** 有任务正在切换时禁用整列行（原行为：Boolean(switchingTaskKey)）。 */
  disabled: boolean;
  /** 断连远程 workspace 的行不响应打开（原行为保留为点击守卫）。 */
  disconnected: boolean;
  /** workspace 分组的行只显示时间；pinned/timeline 行显示「所属 workspace · 时间」。 */
  workspaceLabel: string;
  timeField: "created" | "updated";
  onOpen: (task: WebRemoteControlTaskTarget) => void;
}

/**
 * perf-4：任务行抽取为 memo 组件。行 props 全部是原始值或来自 model 的稳定引用，
 * 任意 state（展开、最近项目、错误条）变化时未受影响的行直接跳过重渲染。
 */
const MobileTaskRow = memo(function MobileTaskRow({
  task,
  variant,
  selected,
  switching,
  disabled,
  disconnected,
  workspaceLabel,
  timeField,
  onOpen,
}: MobileTaskRowProps) {
  const { intl } = useZCodeIntl();
  const taskTitle = task.title || intl.formatMessage({ id: "taskList.untitled" });
  const displayStatus = task.displayStatus ?? "idle";

  return (
    <li>
      <button
        type="button"
        data-testid={testId(TID_TASK_ITEM, task.taskId)}
        data-state={selected ? "selected" : "idle"}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-lg py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-70",
          variant === "workspace"
            ? "min-h-12 px-2.5"
            : variant === "timeline"
              ? "min-h-14 border border-card-border bg-card px-3"
              : "min-h-12 border border-card-border bg-card px-3",
          selected ? "bg-selected text-foreground" : "hover:bg-surface-hover",
        )}
        disabled={disabled || disconnected}
        onClick={() => {
          if (!disconnected) {
            onOpen(task);
          }
        }}
        aria-label={
          variant === "pinned"
            ? intl.formatMessage({ id: "webRemoteControl.openTask" }, { title: taskTitle })
            : undefined
        }
      >
        <span
          className={cn(
            "relative flex size-4 shrink-0 items-center justify-center",
            variant === "pinned" && "text-foreground-subtle",
          )}
        >
          {switching ? (
            <LoaderIcon
              className={cn(
                "size-4 animate-spin",
                variant !== "pinned" && "text-foreground-subtle",
              )}
            />
          ) : variant === "pinned" ? (
            <Pin className="size-4" />
          ) : null}
          {/* design-7 修复：未读点改用语义 brand token。原先写死 bg-sky-500 dark:bg-sky-400，
            与主题 brand 映射（浅色 sky-400 / 深色 sky-500）正好反相，且未走 --color-brand。 */}
          {variant === "pinned" ? (
            !switching && task.unreadAt ? (
              <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-brand" />
            ) : null
          ) : !switching && task.unreadAt ? (
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-base text-foreground">{taskTitle}</span>
          {/* home-8 修复：任务行副行是路径/时间类元信息，从 14px 正文级降为 text-ui-sm，
            对齐最近项目行的信息密度；标题保持 text-ui-base。 */}
          {variant === "workspace" ? (
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
              <span className="truncate">
                {formatTaskRelativeTime(task.updatedAt, intl)}
              </span>
            </span>
          ) : (
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
              <span className="truncate">{workspaceLabel}</span>
              <span className="shrink-0">·</span>
              <span className="truncate">
                {formatTaskRelativeTime(
                  timeField === "created" ? task.createdAt : task.updatedAt,
                  intl,
                )}
              </span>
            </span>
          )}
          {task.workflowActivity ? (
            <TaskWorkflowRunLines
              activity={task.workflowActivity}
              isActive={selected}
              intl={intl}
              density="compact"
            />
          ) : null}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-xs leading-none",
            getWebRemoteControlTaskStatusClassName(displayStatus),
          )}
        >
          {getStatusIcon(displayStatus)}
          {intl.formatMessage({
            id: `webRemoteControl.taskStatus.${displayStatus}`,
          })}
        </span>
      </button>
    </li>
  );
});

interface MobileWorkspaceCardProps {
  group: WebRemoteControlWorkspaceTaskGroup;
  expanded: boolean;
  activeWorkspaceKey: string;
  activeTaskId: string | null;
  /** 当前切换中的任务行 key；null 表示没有切换（null 变化时卡片重渲染属于行为需要）。 */
  switchingTaskKey: string | null;
  /** 新建任务/重连/任一任务切换进行中时禁用卡片头部动作按钮（原行为一致）。 */
  anyActionInProgress: boolean;
  reconnecting: boolean;
  creating: boolean;
  reconnectAvailable: boolean;
  latestUpdatedAt: number | null;
  onToggle: (workspaceKey: string) => void;
  onOpenFiles?: (workspaceKey: string) => void;
  onReconnect: (workspace: MobileWorkspaceTarget) => void;
  onStartDraft: (workspace: MobileWorkspaceTarget) => void;
  onOpenTask: (task: WebRemoteControlTaskTarget) => void;
}

/**
 * perf-4：workspace 卡片抽取为 memo 组件；props 全部为原始值/稳定回调/来自 model 的
 * 稳定 group 引用，展开某张卡或切换任务时其它卡片整体跳过重渲染，仅受影响的 memo 行重渲染。
 */
const MobileWorkspaceCard = memo(function MobileWorkspaceCard({
  group,
  expanded,
  activeWorkspaceKey,
  activeTaskId,
  switchingTaskKey,
  anyActionInProgress,
  reconnecting,
  creating,
  reconnectAvailable,
  latestUpdatedAt,
  onToggle,
  onOpenFiles,
  onReconnect,
  onStartDraft,
  onOpenTask,
}: MobileWorkspaceCardProps) {
  const { intl } = useZCodeIntl();
  const disconnected = isDisconnectedRemoteWorkspaceTarget(group.workspace);

  return (
    <li className="rounded-lg border border-card-border bg-card">
      {/* touch-1/shell-2/design-2/home-1 修复：卡片头不再允许 button 嵌套。
        外层展开按钮只覆盖标题区（含角标、计数与折叠箭头），「打开文件」作为唯一一个
        兄弟按钮放在标题区之外——原先标题行内还嵌着一个相同图标按钮，点击会冒泡同时触发
        onOpenFiles 和展开/收起，且一行内渲染出两个一样的文件夹按钮。 */}
      <div className="flex min-w-0 items-center gap-1 px-2 py-2">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left"
          aria-expanded={expanded}
          onClick={() => onToggle(group.workspaceKey)}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
            {group.workspace.workspacePurpose === "conversation" ? (
              <MessageCirclePlus className="size-4" />
            ) : group.workspace.kind === "remote" ? (
              <Cloud className="size-4" />
            ) : (
              <FolderOpen className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground">
                {group.workspace.workspacePurpose === "conversation"
                  ? intl.formatMessage({
                      id: "workspaceSidebar.conversationsSection",
                    })
                  : group.workspace.label}
              </span>
              <span className="shrink-0 rounded-full border border-border bg-surface px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtle">
                {intl.formatMessage({
                  id:
                    group.workspace.workspacePurpose === "conversation"
                      ? "webRemoteControl.mobileHome.workspaceKind.conversation"
                      : group.workspace.kind === "remote"
                        ? "webRemoteControl.mobileHome.workspaceKind.remote"
                        : "webRemoteControl.mobileHome.workspaceKind.local",
                })}
              </span>
              {disconnected ? (
                <span className="shrink-0 rounded-full border border-destructive/40 bg-card px-1.5 py-0.5 text-ui-xs leading-none text-destructive">
                  {intl.formatMessage({
                    id: "webRemoteControl.mobileHome.disconnected",
                  })}
                </span>
              ) : null}
            </span>
            {/* home-8 修复：路径/连接错误/更新时间属于元信息，从 text-ui-base 降为 text-ui-sm
              并保留 truncate，对齐最近项目行的密度，避免 390px 下卡片头部膨胀到 3-4 行。 */}
            <span className="mt-1 block truncate font-mono text-ui-sm text-foreground-subtlest">
              {group.workspace.workspacePath}
            </span>
            {group.workspace.lastConnectionError ? (
              <span className="mt-1 block truncate text-ui-sm text-destructive">
                {group.workspace.lastConnectionError}
              </span>
            ) : null}
            {latestUpdatedAt ? (
              <span className="mt-1 block truncate text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "webRemoteControl.mobileHome.updatedAt" },
                  {
                    time: formatTaskRelativeTime(latestUpdatedAt, intl),
                  },
                )}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2 text-ui-sm text-foreground-subtle">
            {!expanded && group.hasUnread ? (
              <span
                aria-hidden="true"
                data-workspace-unread-indicator="true"
                className="h-1.5 w-1.5 rounded-full bg-brand"
              />
            ) : null}
            {intl.formatMessage(
              { id: "webRemoteControl.mobileHome.taskCount" },
              { count: String(group.tasks.length) },
            )}
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </span>
        </button>
        {onOpenFiles && !disconnected ? (
          <Button
            variant="ghost"
            size="icon-sm"
            /* home-3/home-6：手机端命中区统一扩到 44px（本组件仅手机远控壳渲染，不影响桌面）。 */
            className="size-11"
            aria-label={intl.formatMessage({ id: "mobileFileBrowser.title" })}
            onClick={() => onOpenFiles(group.workspaceKey)}
          >
            <FolderOpen className="size-4" />
          </Button>
        ) : null}
        {disconnected ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            /* home-3/touch-5：重连按钮恢复可访问名称（原先只剩图标 + sr-only）并扩命中区到 44px。 */
            className="size-11"
            aria-label={intl.formatMessage({
              id: reconnecting
                ? "webRemoteControl.mobileHome.reconnecting"
                : "webRemoteControl.mobileHome.reconnect",
            })}
            disabled={!reconnectAvailable || anyActionInProgress}
            onClick={() => onReconnect(group.workspace)}
          >
            {reconnecting ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            /* design-3/home-3/touch-5：新建任务按钮恢复可访问名称（可见文案原先被注释掉
              又没有 aria-label，成为无名按钮），同时把 24px 命中区扩到 44px。 */
            className="size-11"
            aria-label={intl.formatMessage({ id: "sidebar.newTask" })}
            disabled={anyActionInProgress}
            onClick={() => onStartDraft(group.workspace)}
          >
            {creating ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
          </Button>
        )}
      </div>

      {expanded ? (
        <ul className="border-t border-card-border px-2 py-2">
          {group.tasks.length === 0 ? (
            <li className="px-2 py-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({
                id: "webRemoteControl.mobileHome.workspaceEmpty",
              })}
            </li>
          ) : null}
          {group.tasks.map((task) => {
            const rowKey = buildWebRemoteControlTaskRowKey(task);
            const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);

            return (
              <MobileTaskRow
                key={rowKey}
                task={task}
                variant="workspace"
                selected={
                  taskWorkspaceKey === activeWorkspaceKey && task.taskId === activeTaskId
                }
                switching={switchingTaskKey === rowKey}
                disabled={Boolean(switchingTaskKey)}
                disconnected={disconnected}
                workspaceLabel=""
                timeField="updated"
                onOpen={onOpenTask}
              />
            );
          })}
        </ul>
      ) : null}
    </li>
  );
});

function noopSelectTask() {}

export function WebRemoteControlMobileTaskHome({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  initialResult,
  onNavigateHome,
  onNavigateToChat,
  onOpenTask,
  onOpenAppSettings,
  onOpenSearch,
  onOpenFiles,
  onOpenNotifications,
  onOpenOtherProject,
  preferences,
  onPreferencesChange,
  onSelectTask = noopSelectTask,
  onStartDraftInWorkspace,
  refreshKey,
  onCrossWorkspaceSwitchingChange,
  switcher,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  initialResult?: WebRemoteControlWorkspaceListResult;
  onSelectTask?: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace?: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onNavigateHome?: () => void;
  onNavigateToChat?: () => void;
  onOpenTask?: (task: WebRemoteControlTaskTarget) => void;
  onOpenAppSettings?: () => void;
  onOpenSearch?: () => void;
  onOpenFiles?: (workspaceKey: string) => void;
  onOpenNotifications?: () => void;
  /** 第二批 E1：打开「其他项目」目录选择器（由 Shell 持有 overlay）；能力不足时调用方不传。 */
  onOpenOtherProject?: () => void;
  preferences: WebRemoteControlMobileTaskHomePreferences;
  onPreferencesChange: (preferences: WebRemoteControlMobileTaskHomePreferences) => void;
  refreshKey?: number;
  onCrossWorkspaceSwitchingChange?: (switching: boolean) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [result, setResult] = useState<WebRemoteControlWorkspaceListResult>(
    initialResult ?? EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST,
  );
  const [loading, setLoading] = useState(!initialResult);
  const [loadError, setLoadError] = useState<string | null>(null);
  const taskOrganizeBy = preferences.organizeBy;
  const taskSortBy = preferences.sortBy;
  const initialExpansionModel = useMemo(
    () =>
      buildWebRemoteControlMobileTaskHomeModel({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        sortBy: taskSortBy,
        result: initialResult ?? EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST,
      }),
    [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, initialResult, taskSortBy],
  );
  const [expandedWorkspaceKeysState, setExpandedWorkspaceKeysState] = useState<Set<string>>(() => {
    // shell-4 修复：重挂载时优先恢复模块级所有者里的展开状态；
    // 首次挂载（所有者为空）回落到默认展开规则。
    return readPersistedExpandedWorkspaceKeys() ?? new Set(initialExpansionModel.defaultExpandedWorkspaceKeys);
  });
  // shell-4 修复：组件 state 是模块级所有者的镜像；所有写入都同步回写所有者，
  // 保证进入聊天页（组件卸载）后展开状态不丢。
  const setExpandedWorkspaceKeys = useCallback(
    (next: Set<string> | ((current: Set<string>) => Set<string>)) => {
      setExpandedWorkspaceKeysState((current) => {
        const value = typeof next === "function" ? next(current) : next;
        writePersistedExpandedWorkspaceKeys(value);
        return value;
      });
    },
    [],
  );
  const didInitializeLoadedExpansionRef = useRef(Boolean(initialResult));
  const model = useMemo(
    () =>
      buildWebRemoteControlMobileTaskHomeModel({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        sortBy: taskSortBy,
        result,
      }),
    [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, result, taskSortBy],
  );
  const defaultExpandedWorkspaceKeySignature = useMemo(
    () => [...model.defaultExpandedWorkspaceKeys].join("\0"),
    [model.defaultExpandedWorkspaceKeys],
  );
  const workspaceByKey = useMemo(
    () => new Map(model.groups.map((group) => [group.workspaceKey, group.workspace])),
    [model.groups],
  );
  const timelineGroups = useMemo(
    () =>
      // Bugfix: 手机时间线之前只平铺已排序 task，缺少桌面端“今天/上月”等分组文案。
      // 这里复用桌面时间线分组工具，保证排序字段、locale 周起始日和文案 key 都保持一致。
      groupTaskTimelineItems(model.timelineTasks, {
        sortBy: taskSortBy,
        now: Date.now(),
        locale,
      }),
    [locale, model.timelineTasks, taskSortBy],
  );
  const {
    error: taskOpenError,
    openTask,
    switchingTaskKey,
  } = useWebRemoteControlTaskOpen({
    activeTaskId: model.activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    markTaskReadOnOpen: true,
    mobileNavigationIntent: "chat",
    onNavigateHome,
    onNavigateToChat,
    onSelectTask,
    onSwitchingChange: onCrossWorkspaceSwitchingChange,
    switcher,
  });
  const error = loadError ?? taskOpenError;

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setResult(await switcher.listWorkspaces());
    } catch (err) {
      // Bugfix: 远控请求失败时可能抛普通对象，直接 String 会把真实原因吞成 [object Object]。
      const message = getErrorMessage(err);
      logger.error("[WebRemoteControlMobileTaskHome] 加载远控首页失败", {
        error: message,
      });
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [switcher]);

  useEffect(() => {
    if (initialResult) {
      return;
    }

    // Bugfix: 手机端任务首页之前每 3 秒轮询 listWorkspaces，导致 relay 持续产生任务列表请求。
    // 这里只保留首次无 initialResult 时加载；从聊天页返回首页由 WebRemoteControlMobileShell 显式 refreshKey 触发一次刷新。
    void loadWorkspaces();
  }, [initialResult, loadWorkspaces]);

  useEffect(() => {
    if (!refreshKey) {
      return;
    }

    // Bugfix: 取消 3 秒轮询后，用户从 task 页返回任务列表时仍需要看到刚发送消息后的最新状态。
    // 这里把“返回列表”作为一次明确刷新事件，避免持续请求，同时保证 loading / 选中态及时更新。
    void loadWorkspaces();
  }, [loadWorkspaces, refreshKey]);

  useEffect(() => {
    return switcher.onWorkspaceListUpdated?.((nextResult) => {
      // Bugfix: 桌面端或宽屏远控变更 task membership 后，手机首页需要采用推送的最新索引。
      // 继续只在明确事件上刷新，避免恢复到旧的定时轮询。
      setResult(nextResult);
      setLoadError(null);
      setLoading(false);
    });
  }, [switcher]);

  useEffect(() => {
    if (didInitializeLoadedExpansionRef.current || loading) {
      return;
    }

    didInitializeLoadedExpansionRef.current = true;
    setExpandedWorkspaceKeys(new Set(model.defaultExpandedWorkspaceKeys));
  }, [defaultExpandedWorkspaceKeySignature, loading, model.defaultExpandedWorkspaceKeys, setExpandedWorkspaceKeys]);

  useEffect(() => {
    if (loading || result.workspaces.length === 0) {
      return;
    }

    const activeGroup = model.groups.find(
      (group) => group.workspaceKey === model.activeWorkspaceKey,
    );
    if (!activeGroup) {
      logger.warn("[WebRemoteControlMobileTaskHome] 初始 workspace 未匹配", {
        workspaceKey: model.activeWorkspaceKey,
      });
      return;
    }

    if (!hasWebRemoteControlMobileTaskHomeActiveTaskMatch(model)) {
      logger.warn("[WebRemoteControlMobileTaskHome] 初始 task 未匹配", {
        taskId: model.activeTaskId,
        workspaceKey: model.activeWorkspaceKey,
      });
    }
  }, [
    loading,
    model.activeTaskId,
    model.activeWorkspaceKey,
    model.groups,
    result.workspaces.length,
  ]);

  const toggleWorkspace = useCallback(
    (workspaceKey: string) => {
      setExpandedWorkspaceKeys((current) => {
        const next = new Set(current);
        if (next.has(workspaceKey)) {
          next.delete(workspaceKey);
        } else {
          next.add(workspaceKey);
        }
        return next;
      });
    },
    [setExpandedWorkspaceKeys],
  );

  const collapseAllWorkspaces = useCallback(() => {
    setExpandedWorkspaceKeys(new Set());
  }, [setExpandedWorkspaceKeys]);

  const handleOpenTask = useCallback(
    (task: WebRemoteControlTaskTarget) => {
      if (onOpenTask) {
        onOpenTask(task);
        return;
      }

      openTask(task);
    },
    [onOpenTask, openTask],
  );
  const [creatingWorkspaceKey, setCreatingWorkspaceKey] = useState<string | null>(null);
  const [reconnectingWorkspaceKey, setReconnectingWorkspaceKey] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<WebRemoteControlRecentProjectsResult>({
    desktopWindowState: "open",
    recentProjects: [],
  });
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingDesktopWindow, setOpeningDesktopWindow] = useState(false);
  const [recentProjectsError, setRecentProjectsError] = useState<string | null>(null);
  // home-9 修复：记录打开失败的项目 id，让错误反馈渲染在对应行内，
  // 而不是只在列表上方/下方的全局错误条里（点列表中部行时全局条可能在视口外）。
  const [failedRecentProjectId, setFailedRecentProjectId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const apply = (result: WebRemoteControlRecentProjectsResult) => {
      if (!disposed) {
        setRecentProjects(result);
      }
    };
    void switcher
      .getRecentProjects?.()
      .then(apply)
      .catch((err) => {
        // 最近项目是首页的补充入口；读取失败不能遮住已打开的 workspace 和任务。
        logger.warn("[WebRemoteControlMobileTaskHome] 读取最近项目失败", {
          error: getErrorMessage(err),
        });
      });
    const unsubscribe = switcher.onRecentProjectsUpdated?.(apply);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [switcher]);

  const handleOpenRecentProject = useCallback(
    async (projectId: string) => {
      if (!switcher.openRecentProject) {
        return;
      }
      setRecentProjectsError(null);
      setFailedRecentProjectId(null);
      setOpeningProjectId(projectId);
      try {
        const workspaceKey = await switcher.openRecentProject(projectId);
        // 桌面打开新标签页后聚合列表会推送；这里先按响应里的 key 切过去，避免用户再点一次。
        await loadWorkspaces();
        await switcher.switchWorkspace(workspaceKey);
      } catch (err) {
        setRecentProjectsError(getErrorMessage(err));
        setFailedRecentProjectId(projectId);
      } finally {
        setOpeningProjectId(null);
      }
    },
    [loadWorkspaces, switcher],
  );

  const handleOpenDesktopWindow = useCallback(async () => {
    if (!switcher.openDesktopWindow) {
      return;
    }
    setRecentProjectsError(null);
    setFailedRecentProjectId(null);
    setOpeningDesktopWindow(true);
    try {
      await switcher.openDesktopWindow();
      await loadWorkspaces();
    } catch (err) {
      setRecentProjectsError(getErrorMessage(err));
    } finally {
      setOpeningDesktopWindow(false);
    }
  }, [loadWorkspaces, switcher]);

  const handleReconnectWorkspace = useCallback(
    async (workspace: MobileWorkspaceTarget) => {
      const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
      if (!switcher.reconnectWorkspace) {
        return;
      }

      setLoadError(null);
      setReconnectingWorkspaceKey(workspaceKey);
      try {
        // Bugfix: 手机端列表现在会展示已断开的 SSH 工作区，不能再误走 bridge。
        // 重连请求必须交回桌面 renderer 复用原有 SSH 恢复流程，再刷新列表拿最新连接态。
        await switcher.reconnectWorkspace(workspaceKey);
        await loadWorkspaces();
      } catch (err) {
        const message = getErrorMessage(err);
        logger.error("[WebRemoteControlMobileTaskHome] 手机端重连远程工作区失败", {
          error: message,
          workspaceKey,
        });
        setLoadError(message);
      } finally {
        setReconnectingWorkspaceKey(null);
      }
    },
    [loadWorkspaces, switcher],
  );
  const handleStartDraft = useCallback(
    async (workspace: MobileWorkspaceTarget) => {
      const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
      const isCrossWorkspace = workspaceKey !== model.activeWorkspaceKey;
      setLoadError(null);
      setCreatingWorkspaceKey(workspaceKey);
      onCrossWorkspaceSwitchingChange?.(true);
      try {
        // Bugfix: 手机端“新建任务”如果只切 workspace 不清空 activeTask，
        // 远控会继续带着旧 taskId 进入聊天页，看起来像按钮无效。
        // 这里统一走 startDraft（可选）或 switchWorkspace(不带 taskId)，确保进入草稿态。
        if (switcher.startDraft) {
          await switcher.startDraft(workspaceKey, { mobileNavigationIntent: "chat" });
        } else {
          await switcher.switchWorkspace(workspaceKey, { mobileNavigationIntent: "chat" });
          await switcher.updateMobileViewState?.(workspaceKey);
        }
        if (!isCrossWorkspace) {
          onStartDraftInWorkspace?.(workspace.workspacePath, workspace.workspaceIdentity);
          onNavigateToChat?.();
        }
      } catch (err) {
        const message = getErrorMessage(err);
        logger.error("[WebRemoteControlMobileTaskHome] 手机端新建任务失败", {
          error: message,
          workspaceKey,
        });
        setLoadError(message);
      } finally {
        setCreatingWorkspaceKey(null);
        onCrossWorkspaceSwitchingChange?.(false);
      }
    },
    [
      model.activeWorkspaceKey,
      onCrossWorkspaceSwitchingChange,
      onNavigateToChat,
      onStartDraftInWorkspace,
      switcher,
    ],
  );

  // home-9 修复：失败项目 id 仍命中当前列表时改为行内反馈，全局错误条只承担
  // 打开窗口等非行内失败，避免同一错误重复出现在两处。
  const inlineRecentProjectError =
    recentProjectsError &&
    failedRecentProjectId &&
    recentProjects.recentProjects.some((project) => project.id === failedRecentProjectId)
      ? recentProjectsError
      : null;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border bg-header px-4 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-ui-lg font-medium">
              {intl.formatMessage({ id: "webRemoteControl.mobileHome.title" })}
            </div>
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "webRemoteControl.mobileHome.connected",
              })}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <WebRemoteControlMobileSettingsMenu onOpenAppSettings={onOpenAppSettings} />
            {onOpenSearch ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-11"
                aria-label={intl.formatMessage({ id: "mobileSearch.title" })}
                onClick={onOpenSearch}
              >
                <Search className="size-4" />
              </Button>
            ) : null}
            {onOpenNotifications ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-11"
                aria-label={intl.formatMessage({ id: "mobileNotifications.title" })}
                onClick={onOpenNotifications}
              >
                <Bell className="size-4" />
              </Button>
            ) : null}
            {/* home-6：主题菜单触发器与相邻 44px 设置/搜索/通知按钮对齐命中区。 */}
            <WebRemoteControlThemeMenu className="size-11" />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="rounded-lg border border-card-border bg-card p-3 text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.mobileHome.notice" })}
        </div>

        <WebRemoteControlRecentProjectsSection
          className="mt-4"
          recentProjects={recentProjects.recentProjects}
          desktopWindowState={recentProjects.desktopWindowState}
          openingProjectId={openingProjectId}
          openingWindow={openingDesktopWindow}
          error={inlineRecentProjectError}
          failedProjectId={failedRecentProjectId}
          onOpenRecentProject={handleOpenRecentProject}
          onOpenDesktopWindow={handleOpenDesktopWindow}
          onOpenOtherProject={
            onOpenOtherProject && switcher.canOpenArbitraryWorkspace?.() === true
              ? onOpenOtherProject
              : undefined
          }
        />

        {recentProjectsError && !inlineRecentProjectError ? (
          <p role="alert" className="mt-2 px-1 text-ui-base text-destructive">
            {recentProjectsError}
          </p>
        ) : null}

        <div className="mt-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-ui-base font-medium">
              {intl.formatMessage({
                id: "webRemoteControl.mobileHome.sectionTitle",
              })}
            </h1>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "webRemoteControl.mobileHome.summary" },
                {
                  taskCount: String(model.totalTaskCount),
                  workspaceCount: String(model.totalWorkspaceCount),
                },
              )}
            </p>
          </div>
          {/* home-6/touch-4：工具行三个 24px 按钮统一扩到 44px 命中区；
            44px 按钮 + gap-1 后相邻按钮中心距 ≥48px，消除原 28px 中心距的误触高发区。 */}
          <div className="flex shrink-0 items-center gap-1">
            {taskOrganizeBy === "workspace" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-11"
                aria-label={intl.formatMessage({
                  id: "webRemoteControl.mobileHome.collapseAll",
                })}
                onClick={collapseAllWorkspaces}
              >
                <ChevronsUp className="size-4" />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-11"
                  aria-label={intl.formatMessage({
                    id: "webRemoteControl.mobileHome.organize",
                  })}
                >
                  <Settings2 className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 min-w-52">
                <DropdownMenuLabel>
                  {intl.formatMessage({
                    id: "webRemoteControl.mobileHome.organize",
                  })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={taskOrganizeBy}
                  onValueChange={(value) => {
                    if (value === "workspace" || value === "timeline") {
                      // Bugfix: 手机远控首页会在进入 task 后卸载，排序/分组偏好不能留在本组件本地 state。
                      // 这里把用户选择回写到 shell 级状态，返回任务列表时继续沿用上一次设置。
                      onPreferencesChange({ ...preferences, organizeBy: value });
                    }
                  }}
                >
                  {/* settings-2：本菜单只在手机远控壳渲染，选项行直接抬到 44px 触屏高度。 */}
                  <DropdownMenuRadioItem value="workspace" className="min-h-11">
                    <FolderOpen className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.organizeByWorkspace",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="timeline" className="min-h-11">
                    <Clock3 className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.organizeByTimeline",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>
                  {intl.formatMessage({
                    id: "webRemoteControl.mobileHome.sortBy",
                  })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={taskSortBy}
                  onValueChange={(value) => {
                    if (value === "created" || value === "updated") {
                      onPreferencesChange({ ...preferences, sortBy: value });
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="created" className="min-h-11">
                    <MessageCirclePlus className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.sortByCreated",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="updated" className="min-h-11">
                    <MessageCircleCheck className="size-4" />
                    {intl.formatMessage({
                      id: "webRemoteControl.mobileHome.sortByUpdated",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-11"
              aria-label={intl.formatMessage({
                id: "webRemoteControl.mobileHome.refresh",
              })}
              onClick={() => {
                void loadWorkspaces();
              }}
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-ui-base text-destructive">
            {error}
          </div>
        ) : null}

        {loading && model.totalWorkspaceCount === 0 ? (
          <div className="mt-3 flex items-center gap-2 px-1 py-2 text-ui-base text-foreground-subtle">
            <LoaderIcon className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : null}

        {!loading && !error && model.totalWorkspaceCount === 0 ? (
          <div className="mt-3 px-1 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.noTasks" })}
          </div>
        ) : null}

        {model.pinnedTasks.length > 0 ? (
          <section className="mt-3">
            <h2 className="px-1 py-1 text-ui-base font-medium text-foreground-subtlest">
              {intl.formatMessage({ id: "taskList.pinnedSection" })}
            </h2>
            <ul className="space-y-1">
              {model.pinnedTasks.map((task) => {
                const rowKey = buildWebRemoteControlTaskRowKey(task);
                const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                const taskWorkspace = workspaceByKey.get(taskWorkspaceKey);
                const workspaceLabel =
                  taskWorkspace?.workspacePurpose === "conversation"
                    ? intl.formatMessage({
                        id: "workspaceSidebar.conversationsSection",
                      })
                    : task.workspaceLabel || taskWorkspace?.label || task.workspacePath;

                return (
                  <MobileTaskRow
                    key={rowKey}
                    task={task}
                    variant="pinned"
                    selected={
                      taskWorkspaceKey === model.activeWorkspaceKey &&
                      task.taskId === model.activeTaskId
                    }
                    switching={switchingTaskKey === rowKey}
                    disabled={Boolean(switchingTaskKey)}
                    disconnected={isDisconnectedRemoteWorkspaceTarget(taskWorkspace)}
                    workspaceLabel={workspaceLabel}
                    timeField={taskSortBy}
                    onOpen={handleOpenTask}
                  />
                );
              })}
            </ul>
          </section>
        ) : null}

        {taskOrganizeBy === "timeline" ? (
          <ul className="mt-3 space-y-2">
            {model.totalTaskCount === 0 && model.totalWorkspaceCount > 0 ? (
              <li className="px-1 py-2 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "webRemoteControl.noTasks" })}
              </li>
            ) : null}
            {timelineGroups.map((group) => {
              const labelMessage = getTaskTimelineGroupMessage(group.label);

              return (
                <li key={group.key} className="space-y-1">
                  <div className="px-1 py-1 text-ui-base font-medium text-foreground-subtle">
                    {intl.formatMessage({ id: labelMessage.id }, labelMessage.values)}
                  </div>
                  <ul className="space-y-1">
                    {group.items.map((task) => {
                      const rowKey = buildWebRemoteControlTaskRowKey(task);
                      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
                      const taskWorkspace = workspaceByKey.get(taskWorkspaceKey);
                      const workspaceLabel =
                        taskWorkspace?.workspacePurpose === "conversation"
                          ? intl.formatMessage({
                              id: "workspaceSidebar.conversationsSection",
                            })
                          : task.workspaceLabel || taskWorkspace?.label || task.workspacePath;

                      return (
                        <MobileTaskRow
                          key={rowKey}
                          task={task}
                          variant="timeline"
                          selected={
                            taskWorkspaceKey === model.activeWorkspaceKey &&
                            task.taskId === model.activeTaskId
                          }
                          switching={switchingTaskKey === rowKey}
                          disabled={Boolean(switchingTaskKey)}
                          disconnected={isDisconnectedRemoteWorkspaceTarget(taskWorkspace)}
                          workspaceLabel={workspaceLabel}
                          timeField={taskSortBy}
                          onOpen={handleOpenTask}
                        />
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="mt-3 space-y-2">
            {model.groups.map((group) => (
              <MobileWorkspaceCard
                key={group.workspaceKey}
                group={group}
                expanded={expandedWorkspaceKeysState.has(group.workspaceKey)}
                activeWorkspaceKey={model.activeWorkspaceKey}
                activeTaskId={model.activeTaskId}
                switchingTaskKey={switchingTaskKey}
                anyActionInProgress={Boolean(
                  switchingTaskKey || creatingWorkspaceKey || reconnectingWorkspaceKey,
                )}
                reconnecting={reconnectingWorkspaceKey === group.workspaceKey}
                creating={creatingWorkspaceKey === group.workspaceKey}
                reconnectAvailable={Boolean(switcher.reconnectWorkspace)}
                latestUpdatedAt={getWorkspaceLatestUpdatedAt(group.tasks)}
                onToggle={toggleWorkspace}
                onOpenFiles={onOpenFiles}
                onReconnect={handleReconnectWorkspace}
                onStartDraft={handleStartDraft}
                onOpenTask={handleOpenTask}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
