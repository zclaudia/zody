/**
 * useTaskRestart — F27 任务级重启 UI 单入口（docs/task-restart-and-reload.md，来源 a60ba6a7）。
 *
 * 任务菜单「重启任务」与 `/reload` 本地斜杠命令共用本 hook：
 * - 单 flight：同 workspaceKey+taskId 的重复触发复用既有 promise，不排队；
 * - 确认框只在「同 workspace 存在 running 兄弟任务」（资源无法安全释放）时出现，
 *   取消/Escape/遮罩 = 完全不动作；
 * - 重启执行唯一写路径是 IZodyTaskService.restartTask（services 切片，commit 45ae1981）；
 * - 返回 boolean：true=重启成功（typed /reload 路径据此清空输入），false=取消或失败。
 */
import { useCallback, useRef, useState } from "react";
import type { ZodyProvider } from "@zody/shared";
import { toast } from "@/components/ui/toast.js";
import { useZodyTaskService } from "@/hooks/useZodyTaskService.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { hasRunningSiblingTasks } from "@/lib/taskRestart.js";
import { logger } from "@/logger.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

type TaskRestartIntl = {
  formatMessage: (desc: { id: string }) => string;
};

export interface UseTaskRestartParams {
  intl: TaskRestartIntl;
  /** 重启目标 workspace；省略时用 useServices 的默认 task 服务（本地主服务）。 */
  workspacePath?: string;
  workspaceIdentity?: string | null;
  /** 重启远端 workspace 时按既有约定路由到对应 host。 */
  remoteSessionId?: string | null;
}

export function useTaskRestart(params: UseTaskRestartParams) {
  const { intl } = params;
  const zodyTaskService = useZodyTaskService(
    params.workspacePath,
    params.remoteSessionId ?? null,
    params.workspaceIdentity ?? null,
  );
  // flight 表按 workspaceKey+taskId 去重；pending 集合驱动菜单项禁用（taskList.restarting）。
  const flightsRef = useRef(new Map<string, Promise<boolean>>());
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(new Set());

  const restartTask = useCallback(
    (task: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZodyProvider;
    }): Promise<boolean> => {
      const flightKey = `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}\u0000${task.taskId}`;
      const existingFlight = flightsRef.current.get(flightKey);
      if (existingFlight) {
        // 单 flight：菜单连点/Enter 连按/两入口混用直接复用，不重复调用 restartTask。
        return existingFlight;
      }
      const flight = (async () => {
        // 确认判定只读 tasks-index 投影（taskQueryCache 实体缓存），不拉起进程。
        const siblingRunning = hasRunningSiblingTasks({
          tasks: Object.values(useTaskQueryCacheStore.getState().taskMetaByEntityKey).filter(
            (cached) =>
              buildTaskWorkspaceKey(cached.workspacePath, cached.workspaceIdentity) ===
              buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
          ),
          taskId: task.taskId,
        });
        if (siblingRunning) {
          const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
            presentation: "workspace-restart-confirmation",
            testId: "workspace-restart-confirmation",
            title: intl.formatMessage({ id: "taskList.recoverWorkspace" }),
            description: intl.formatMessage({ id: "taskList.recoverWorkspaceDescription" }),
            confirmLabel: intl.formatMessage({ id: "taskList.recoverWorkspace" }),
          });
          if (!confirmed) {
            // 取消/Escape/遮罩 = 不动作：不重启、不报错、不清输入。
            return false;
          }
        }
        try {
          const result = await zodyTaskService.restartTask({
            taskId: task.taskId,
            workspacePath: task.workspacePath,
            ...(task.workspaceIdentity?.trim()
              ? { workspaceIdentity: task.workspaceIdentity }
              : {}),
            ...(task.provider ? { provider: task.provider } : {}),
          });
          logger.info(
            `[task-restart] 任务级重启完成 taskId=${task.taskId} workspaceKey=${result.workspaceKey} resumedFrom=${result.resumedFrom}`,
          );
          return true;
        } catch (error) {
          logger.warn(
            `[task-restart] 任务级重启失败 taskId=${task.taskId}`,
            error instanceof Error ? { message: error.message } : { error: String(error) },
          );
          // 失败统一 toast；typed /reload 路径同时保留草稿（run 返回 false）。
          toast(intl.formatMessage({ id: "taskList.restartFailed" }));
          return false;
        }
      })();
      flightsRef.current.set(flightKey, flight);
      setPendingTaskIds((current) => new Set(current).add(task.taskId));
      void flight.finally(() => {
        // flight 完成后清理登记；同 key 的下一次触发可立即重新发起。
        if (flightsRef.current.get(flightKey) === flight) {
          flightsRef.current.delete(flightKey);
        }
        setPendingTaskIds((current) => {
          if (!current.has(task.taskId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(task.taskId);
          return next;
        });
      });
      return flight;
    },
    [intl, zodyTaskService],
  );

  const isRestartPending = useCallback(
    (taskId: string) => pendingTaskIds.has(taskId),
    [pendingTaskIds],
  );

  return { restartTask, isRestartPending };
}
