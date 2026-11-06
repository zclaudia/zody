// @vitest-environment jsdom
/**
 * F27 任务重启 UI 侧测试（docs/task-restart-and-reload.md，来源 a60ba6a7）。
 * 覆盖：兄弟任务 running 判定、typed /reload 提交截获决策、useTaskRestart 单 flight
 * 与确认框 gating；services 契约（进程换代顺序等）由 packages/services 的
 * zodyLegacyTaskCompatTaskIndex.test.ts「F27 restartTask」组覆盖。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodyTaskMeta } from "@zody/shared";
import { useTaskRestart } from "@/hooks/useTaskRestart.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  findRecoveryReloadCommand,
  hasRunningSiblingTasks,
  resolveTypedReloadSubmission,
} from "@/lib/taskRestart.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { toast } from "@/components/ui/toast.js";

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const WORKSPACE_PATH = "/repo/task-restart";
const TASK_ID = "task-a";

function createTaskMeta(overrides: Partial<ZodyTaskMeta> = {}): ZodyTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "glm",
    taskId: TASK_ID,
    title: "任务 A",
    traceId: "trace-task-a",
    updatedAt: 1,
    workspacePath: WORKSPACE_PATH,
    ...overrides,
  };
}

function seedTask(meta: ZodyTaskMeta) {
  useTaskQueryCacheStore.getState().upsertTaskMeta(meta);
}

function createRestartResult(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    workspaceKey: WORKSPACE_PATH,
    provider: "glm",
    resumedFrom: "session",
    siblingResumePolicy: "cold-resume",
    meta: createTaskMeta(),
    ...overrides,
  };
}

function mountHook(options?: { restartTaskImpl?: (params: unknown) => Promise<unknown> }) {
  const restartTaskMock = vi.fn(options?.restartTaskImpl ?? (async () => createRestartResult()));
  const services = {
    zodyTaskService: { restartTask: restartTaskMock },
  } as never;
  const intl = {
    formatMessage: ({ id }: { id: string }) => id,
  };
  const view = renderHook(() => useTaskRestart({ intl }), {
    wrapper: ({ children }: { children: ReactNode }) => wrapWithServices(services, children),
  });
  return { restartTaskMock, ...view };
}

function wrapWithServices(services: unknown, children: ReactNode) {
  return createElement(ServiceProvider, { services: services as never }, children);
}

beforeEach(() => {
  useTaskQueryCacheStore.getState().clearAll();
  useConfirmDialogStore.getState().settleChoice("dismiss");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("hasRunningSiblingTasks（确认框触发判定）", () => {
  it("同 workspace 有 running 兄弟任务时为 true（资源无法安全释放）", () => {
    expect(
      hasRunningSiblingTasks({
        taskId: TASK_ID,
        tasks: [
          { taskId: TASK_ID, status: "running" },
          { taskId: "task-b", status: "running" },
        ],
      }),
    ).toBe(true);
  });

  it("目标任务自身 running 不算；兄弟 completed/error 不算", () => {
    expect(
      hasRunningSiblingTasks({
        taskId: TASK_ID,
        tasks: [
          { taskId: TASK_ID, status: "running" },
          { taskId: "task-b", status: "completed" },
          { taskId: "task-c", status: "error" },
        ],
      }),
    ).toBe(false);
  });
});

describe("resolveTypedReloadSubmission（typed /reload 提交截获）", () => {
  it("非 /reload 文本走普通发送路径", () => {
    for (const text of ["hello", "/reloadx", "/reloadabc", "re/load", "/side"]) {
      expect(resolveTypedReloadSubmission({ text, hasReloadCommand: true })).toEqual({
        kind: "not-reload",
      });
    }
  });

  it("恰好 /reload 且门禁满足 → execute", () => {
    expect(resolveTypedReloadSubmission({ text: "/reload", hasReloadCommand: true })).toEqual({
      kind: "execute",
    });
  });

  it("带参数、无本地命令、busy、带附件 → drop（不执行也不发送给模型）", () => {
    expect(resolveTypedReloadSubmission({ text: "/reload foo", hasReloadCommand: true })).toEqual({
      kind: "drop",
    });
    expect(resolveTypedReloadSubmission({ text: "/reload", hasReloadCommand: false })).toEqual({
      kind: "drop",
    });
    expect(
      resolveTypedReloadSubmission({ text: "/reload", hasReloadCommand: true, busy: true }),
    ).toEqual({ kind: "drop" });
    expect(
      resolveTypedReloadSubmission({
        text: "/reload",
        hasReloadCommand: true,
        hasAttachmentsOrContexts: true,
      }),
    ).toEqual({ kind: "drop" });
  });

  it("findRecoveryReloadCommand 只取 recovery 且 value=reload 的命令", () => {
    const reload = { value: "reload", recovery: true, description: "r", run: () => {} };
    expect(findRecoveryReloadCommand([reload, { value: "side", run: () => {} }])).toBe(reload);
    expect(findRecoveryReloadCommand([{ value: "reload", run: () => {} }])).toBeUndefined();
  });
});

describe("useTaskRestart（F27 单 flight + 确认框 gating）", () => {
  it("无 running 兄弟任务：不弹确认，直接调用 restartTask 并返回 true", async () => {
    seedTask(createTaskMeta({ status: "completed" }));
    seedTask(
      createTaskMeta({
        taskId: "task-b",
        title: "任务 B",
        traceId: "trace-b",
        status: "completed",
      }),
    );
    const { restartTaskMock, result } = mountHook();

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.restartTask({
        taskId: TASK_ID,
        workspacePath: WORKSPACE_PATH,
      });
    });

    expect(outcome).toBe(true);
    expect(restartTaskMock).toHaveBeenCalledTimes(1);
    expect(restartTaskMock).toHaveBeenCalledWith({
      taskId: TASK_ID,
      workspacePath: WORKSPACE_PATH,
    });
    expect(useConfirmDialogStore.getState().pendingRequest).toBeUndefined();
    expect(toast).not.toHaveBeenCalled();
  });

  it("同 workspace 有 running 兄弟任务：先弹确认；取消则完全不动作", async () => {
    seedTask(createTaskMeta({ status: "running" }));
    seedTask(
      createTaskMeta({
        taskId: "task-b",
        title: "任务 B",
        traceId: "trace-b",
        status: "running",
      }),
    );
    const { restartTaskMock, result } = mountHook();

    let outcomePromise: Promise<boolean> | undefined;
    await act(async () => {
      outcomePromise = result.current.restartTask({
        taskId: TASK_ID,
        workspacePath: WORKSPACE_PATH,
      });
      // 确认框已打开：workspace-restart-confirmation，带中断提示文案。
      await waitFor(() =>
        expect(useConfirmDialogStore.getState().pendingRequest?.presentation).toBe(
          "workspace-restart-confirmation",
        ),
      );
      expect(useConfirmDialogStore.getState().pendingRequest?.testId).toBe(
        "workspace-restart-confirmation",
      );
      expect(useConfirmDialogStore.getState().pendingRequest?.title).toBe(
        "taskList.recoverWorkspace",
      );
      act(() => {
        useConfirmDialogStore.getState().settleChoice("cancel");
      });
    });

    await expect(outcomePromise).resolves.toBe(false);
    expect(restartTaskMock).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("确认后仍走同一 restartTask 单入口", async () => {
    seedTask(createTaskMeta({ status: "completed" }));
    seedTask(
      createTaskMeta({
        taskId: "task-b",
        title: "任务 B",
        traceId: "trace-b",
        status: "running",
      }),
    );
    const { restartTaskMock, result } = mountHook();

    await act(async () => {
      const outcomePromise = result.current.restartTask({
        taskId: TASK_ID,
        workspacePath: WORKSPACE_PATH,
      });
      await waitFor(() => expect(useConfirmDialogStore.getState().pendingRequest).toBeDefined());
      act(() => {
        useConfirmDialogStore.getState().settleChoice("confirm");
      });
      await expect(outcomePromise).resolves.toBe(true);
    });

    expect(restartTaskMock).toHaveBeenCalledTimes(1);
  });

  it("失败时 toast 重启失败并返回 false（typed /reload 据此保留草稿）", async () => {
    seedTask(createTaskMeta({ status: "completed" }));
    const { result } = mountHook({
      restartTaskImpl: async () => {
        throw new Error("agent spawn failed");
      },
    });

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.restartTask({
        taskId: TASK_ID,
        workspacePath: WORKSPACE_PATH,
      });
    });

    expect(outcome).toBe(false);
    expect(toast).toHaveBeenCalledWith("taskList.restartFailed");
  });

  it("单 flight：同任务并发触发只调用一次 restartTask", async () => {
    seedTask(createTaskMeta({ status: "completed" }));
    let resolveService: (value: unknown) => void = () => {};
    const restartTaskMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveService = resolve;
        }),
    );
    const services = { zodyTaskService: { restartTask: restartTaskMock } } as never;
    const intl = { formatMessage: ({ id }: { id: string }) => id };
    const { result } = renderHook(() => useTaskRestart({ intl }), {
      wrapper: ({ children }: { children: ReactNode }) => wrapWithServices(services, children),
    });

    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    act(() => {
      first = result.current.restartTask({ taskId: TASK_ID, workspacePath: WORKSPACE_PATH });
      second = result.current.restartTask({ taskId: TASK_ID, workspacePath: WORKSPACE_PATH });
    });
    // 状态更新已 flush：pending 期间菜单项显示「正在重启任务…」。
    expect(result.current.isRestartPending(TASK_ID)).toBe(true);
    await act(async () => {
      resolveService(createRestartResult());
    });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(restartTaskMock).toHaveBeenCalledTimes(1);
    // flight 收口后 pending 复位，可再次发起。
    await waitFor(() => expect(result.current.isRestartPending(TASK_ID)).toBe(false));
  });
});
