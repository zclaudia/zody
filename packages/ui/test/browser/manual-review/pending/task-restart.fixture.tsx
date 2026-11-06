import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useTaskRestart } from "@/hooks/useTaskRestart.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import type { ZodyTaskMeta } from "@zody/shared";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
const strings =
  locale === "en-US"
    ? {
        "taskList.recoverWorkspace": "Restart agent process",
        "taskList.recoverWorkspaceDescription":
          "Task resources could not be released safely. Continuing interrupts other tasks in this workspace that share the agent process. Session history is preserved.",
        "taskList.restart": "Restart task",
        "taskList.restarting": "Restarting task…",
      }
    : {
        "taskList.recoverWorkspace": "重启 Agent 进程",
        "taskList.recoverWorkspaceDescription":
          "任务资源未能安全释放。继续会中断同工作区共用此 Agent 进程的其他任务。会话历史会保留。",
        "taskList.restart": "重启任务",
        "taskList.restarting": "正在重启任务…",
      };
document.documentElement.classList.add(
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark",
);

const WORKSPACE_PATH = "/repo/browser-restart";
const WORKSPACE_PATH_SIBLING = "/repo/browser-restart-sibling";
function taskMeta(
  taskId: string,
  status: ZodyTaskMeta["status"],
  workspacePath = WORKSPACE_PATH,
): ZodyTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "glm",
    taskId,
    title: `任务 ${taskId}`,
    traceId: `trace-${taskId}`,
    updatedAt: 1,
    workspacePath,
    status,
  };
}
// 独立 workspace：task-a 无 running 兄弟（直接重启）；task-c 的 workspace 有 running
// 兄弟 task-b（必须先确认）。两个场景分开，避免 task-b 同时成为 task-a 的兄弟。
useTaskQueryCacheStore.getState().upsertTaskMeta(taskMeta("task-a", "completed"));
useTaskQueryCacheStore
  .getState()
  .upsertTaskMeta(taskMeta("task-b", "running", WORKSPACE_PATH_SIBLING));
useTaskQueryCacheStore
  .getState()
  .upsertTaskMeta(taskMeta("task-c", "completed", WORKSPACE_PATH_SIBLING));

const restartCalls: string[] = [];
const services = {
  zodyTaskService: {
    restartTask: async (request: { taskId: string }) => {
      restartCalls.push(request.taskId);
      return {
        taskId: request.taskId,
        workspaceKey: WORKSPACE_PATH,
        provider: "glm",
        resumedFrom: "session",
        siblingResumePolicy: "cold-resume",
        meta: taskMeta(request.taskId, "completed"),
      };
    },
  },
} as never;

function PlainItem({
  children,
  disabled,
  onSelect,
  "data-testid": testId,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  "data-testid"?: string;
}) {
  return (
    <button type="button" data-testid={testId} disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  );
}

function Fixture() {
  const [log, setLog] = useState<string[]>([]);
  const { restartTask, isRestartPending } = useTaskRestart({
    intl: {
      formatMessage: ({ id }: { id: string }) => strings[id as keyof typeof strings] ?? id,
    },
  });
  const triggerRestart = (taskId: string, workspacePath: string) => {
    void restartTask({ taskId, workspacePath }).then(() => setLog([...restartCalls]));
  };
  return (
    <main className="min-h-screen bg-background text-foreground p-3">
      {/* 真实菜单组件：F27 重启项渲染与 pending 门禁。 */}
      <TaskActionMenuContent
        intl={
          {
            formatMessage: ({ id }: { id: string }) => strings[id as keyof typeof strings] ?? id,
          } as never
        }
        isPinned={false}
        fileManagerLabel="打开所在目录"
        taskSessionFile={{ loading: false, path: "/tmp/a.json", exists: true }}
        activeSessionId="task-a"
        taskNativeSessionLogFile={{ loading: false, path: "/tmp/a.log", exists: true }}
        providerConfigFile={{ loading: false, path: "/tmp/conf", exists: true }}
        Item={PlainItem}
        Separator={() => null}
        onTogglePinTask={() => {}}
        onStartRenameTask={() => {}}
        onArchiveTask={() => {}}
        onMarkTaskAsUnread={() => {}}
        onRestartTask={() => triggerRestart("task-a")}
        restartPending={isRestartPending("task-a")}
        onOpenTaskPathInFileManager={() => {}}
        onCopyWorkspacePath={() => {}}
        onCopyTaskPath={() => {}}
        onCopyTaskLogPath={() => {}}
        onOpenProviderConfig={() => {}}
      />
      <button
        type="button"
        data-testid="restart-with-sibling"
        className="mt-2 block"
        onClick={() => triggerRestart("task-c", WORKSPACE_PATH_SIBLING)}
      >
        restart task-c (sibling running)
      </button>
      <output data-testid="restart-log" className="mt-2 block">
        {log.join(",")}
      </output>
      <ConfirmDialogHost />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ZodyIntlProvider initialLocale={locale}>
    <ServiceProvider services={services}>
      <Fixture />
    </ServiceProvider>
  </ZodyIntlProvider>,
);
