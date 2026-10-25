import { describe, expect, it, vi } from "vitest";
import { Event } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

function meta(params: { taskId: string; workspacePath?: string }): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: params.workspacePath ?? "/work/local",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
  };
}

function localTaskService(tasks: ZCodeTaskMeta[]): IZCodeTaskService {
  return {
    listTasks: vi.fn(async () => tasks),
    listPinnedTasks: vi.fn(async () => []),
    listArchivedTasks: vi.fn(async () => []),
    listTaskList: vi.fn(async () => ({ items: [], total: 0, hasMore: false })),
  } as unknown as IZCodeTaskService;
}

/** 与 Host 本地 services 就绪时持有的 sessions-index 观察器依赖一致的最小 agent。 */
function localAgentService(): IZCodeAgentService {
  return {
    onDynamicSessionsIndexFrame: vi.fn(() => Event.None),
    onAgentRuntimeRestarted: vi.fn(() => ({ dispose: vi.fn() })),
    subscribeSessionsIndexV4: vi.fn(async () => ({ ack: { subscriptionId: "sessions-sub" } })),
    unsubscribeSessionsIndexV4: vi.fn(async () => undefined),
    resyncSessionsIndexV4: vi.fn(async () => undefined),
  } as unknown as IZCodeAgentService;
}

describe("WindowHostController local capture source (MN01)", () => {
  it("Host 本地 workspace 就绪后 ensureSource 主动注册 local capture source，无需任何 Controller 查询", async () => {
    const tasks = localTaskService([meta({ taskId: "session-local" })]);
    const agent = localAgentService();
    const captureSubscription = { dispose: vi.fn() };
    const onWorkspaceSourceAvailable = vi.fn(() => captureSubscription);
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable,
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: tasks,
        agentService: agent,
        sourceAvailability: "online" as const,
      }),
    });

    try {
      // Host init 修复路径：本地服务就绪后直接 ensureSource，不经过任何手机/Controller 查询。
      await expect(
        runtime.ensureSource({ kind: "local", workspacePath: "/work/local" }),
      ).resolves.toBe(true);
      expect(onWorkspaceSourceAvailable).toHaveBeenCalledTimes(1);
      expect(onWorkspaceSourceAvailable).toHaveBeenCalledWith(
        { kind: "local", workspacePath: "/work/local" },
        agent,
        tasks,
      );
      // 注册即建立 sessions-index 观察，不等待 listTaskList/searchMobileHistory 首次触发。
      expect(agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(tasks.listTaskList).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
    }
  });

  it("重复 ensureSource 幂等，不重复注册 capture source", async () => {
    const tasks = localTaskService([]);
    const agent = localAgentService();
    const captureSubscription = { dispose: vi.fn() };
    const onWorkspaceSourceAvailable = vi.fn(() => captureSubscription);
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable,
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: tasks,
        agentService: agent,
        sourceAvailability: "online" as const,
      }),
    });

    try {
      await expect(
        runtime.ensureSource({ kind: "local", workspacePath: "/work/local" }),
      ).resolves.toBe(true);
      await expect(
        runtime.ensureSource({ kind: "local", workspacePath: "/work/local" }),
      ).resolves.toBe(true);
      // 后续 Controller 查询复用同一注册，不得重复进入通知捕获生命周期。
      await runtime.service.searchMobileHistory({
        workspaceScope: { workspacePath: "/work/local" },
        query: "needle",
        includeArchived: false,
        limit: 50,
      });
      expect(onWorkspaceSourceAvailable).toHaveBeenCalledTimes(1);
      expect(agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    } finally {
      runtime.dispose();
    }
  });

  it("断开与 dispose 沿既有路径释放 local capture source", async () => {
    const tasks = localTaskService([]);
    const agent = localAgentService();
    const captureSubscription = { dispose: vi.fn() };
    const onWorkspaceSourceAvailable = vi.fn(() => captureSubscription);
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable,
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: tasks,
        agentService: agent,
        sourceAvailability: "online" as const,
      }),
    });

    await expect(
      runtime.ensureSource({ kind: "local", workspacePath: "/work/local" }),
    ).resolves.toBe(true);
    runtime.disconnectSource({ kind: "local", workspacePath: "/work/local" });
    expect(captureSubscription.dispose).toHaveBeenCalledTimes(1);
    runtime.dispose();
    // disconnect 后 dispose 不再重复释放同一订阅。
    expect(captureSubscription.dispose).toHaveBeenCalledTimes(1);
  });
});
