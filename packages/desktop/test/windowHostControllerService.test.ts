import { describe, expect, it, vi } from "vitest";
import { ChannelClient, ChannelServer, createQueuePair, Emitter, Event, ProxyChannel } from "@zcode/rpc";
import { IWindowControllerService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  IZCodeAgentService,
  IZCodeTaskService,
  WindowHostControllerFrame,
} from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  type SessionsIndexTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

function meta(params: {
  taskId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  createdAt?: number;
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: params.workspacePath ?? "/work/demo",
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    createdAt: params.createdAt ?? 1,
    updatedAt: params.createdAt ?? 1,
    mode: "default",
  };
}

function taskService(params: {
  active?: ZCodeTaskMeta[];
  pinned?: ZCodeTaskMeta[];
  archived?: ZCodeTaskMeta[];
  search?: ZCodeTaskMeta[];
}) {
  return {
    listTasks: vi.fn(async () => params.active ?? []),
    listPinnedTasks: vi.fn(async () => params.pinned ?? []),
    listArchivedTasks: vi.fn(async () => params.archived ?? []),
    listTaskList: vi.fn(async () => ({
      items: params.search ?? [],
      total: params.search?.length ?? 0,
      hasMore: false,
    })),
    setTaskPinned: vi.fn(async ({ pinned }: { pinned: boolean }) =>
      meta({ taskId: pinned ? "pinned" : "unpinned" }),
    ),
    archiveTask: vi.fn(async () => meta({ taskId: "archived" })),
    unarchiveTask: vi.fn(async () => meta({ taskId: "unarchived" })),
    deleteTask: vi.fn(async () => undefined),
    setTaskUnread: vi.fn(async () => meta({ taskId: "unread" })),
  } as unknown as IZCodeTaskService;
}

const remoteIdentity = "remote:ssh:dev:22:user:/work/demo";

describe("WindowHostControllerService", () => {
  it("通过各自 Host RPC attachment 隔离同路径不同 identity 的手机搜索", async () => {
    const workspacePath = "/repo";
    const scopeA = {
      kind: "remote" as const,
      workspacePath,
      workspaceIdentity: "identity-alpha",
      remoteSessionId: "session-alpha",
    };
    const scopeB = {
      kind: "remote" as const,
      workspacePath,
      workspaceIdentity: "identity-beta",
      remoteSessionId: "session-beta",
    };
    const tasksA = taskService({ search: [meta({ taskId: "same-task", workspacePath })] });
    const tasksB = taskService({ search: [meta({ taskId: "same-task", workspacePath })] });
    const createHost = (ownScope: typeof scopeA, tasks: IZCodeTaskService) => {
      const runtime = createWindowHostControllerRuntime({
        createId: () => "id",
        resolveSource: (requested) =>
          requested.workspacePath === ownScope.workspacePath &&
          requested.workspaceIdentity === ownScope.workspaceIdentity
            ? {
                scope: ownScope,
                taskService: tasks,
                sourceAvailability: "online" as const,
              }
            : undefined,
      });
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "mobile-controller");
      const client = new ChannelClient(clientProtocol);
      server.registerChannel(
        IWindowControllerService.channelName,
        ProxyChannel.fromService(runtime.service),
      );
      const controller = ProxyChannel.toService<IWindowControllerService>(
        client.getChannel(IWindowControllerService.channelName),
      );
      return { runtime, server, client, controller };
    };
    const hostA = createHost(scopeA, tasksA);
    const hostB = createHost(scopeB, tasksB);
    const search = (workspaceScope: typeof scopeA) => ({
      workspaceScope,
      query: "identity-marker",
      includeArchived: false,
      limit: 50 as const,
    });
    try {
      await expect(hostA.controller.searchMobileHistory(search(scopeA))).resolves.toMatchObject({
        status: "ok",
        items: [
          {
            workspacePath,
            workspaceIdentity: scopeA.workspaceIdentity,
            remoteSessionId: scopeA.remoteSessionId,
          },
        ],
      });
      await expect(hostB.controller.searchMobileHistory(search(scopeB))).resolves.toMatchObject({
        status: "ok",
        items: [
          {
            workspacePath,
            workspaceIdentity: scopeB.workspaceIdentity,
            remoteSessionId: scopeB.remoteSessionId,
          },
        ],
      });
      // 恶意/陈旧客户端将 Host A 的 path 与 Host B identity 拼接，A 的 scope resolver 必须拒绝。
      await expect(
        hostA.controller.searchMobileHistory(
          search({ ...scopeA, workspaceIdentity: scopeB.workspaceIdentity }),
        ),
      ).resolves.toEqual({ status: "closed" });
      expect(tasksA.listTaskList).toHaveBeenCalledTimes(2);
      expect(tasksB.listTaskList).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(tasksA.listTaskList).mock.calls) {
        expect(call[0].workspaceScopes).toEqual([scopeA]);
      }
      for (const call of vi.mocked(tasksB.listTaskList).mock.calls) {
        expect(call[0].workspaceScopes).toEqual([scopeB]);
      }
    } finally {
      for (const host of [hostA, hostB]) {
        host.client.dispose();
        host.server.dispose();
        host.runtime.dispose();
      }
    }
  });

  it("scope source 生命周期通知只注册一次并在断开和dispose时释放", async () => {
    const local = taskService({});
    const agent = {} as IZCodeAgentService;
    const listener = { dispose: vi.fn() };
    const onWorkspaceSourceAvailable = vi.fn(() => listener);
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable,
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: local,
        agentService: agent,
        sourceAvailability: "online" as const,
      }),
    });
    const workspaceScope = { workspacePath: "/work/demo" };
    await runtime.service.searchMobileHistory({
      workspaceScope,
      query: "needle",
      includeArchived: false,
      limit: 50,
    });
    await runtime.service.searchMobileHistory({
      workspaceScope,
      query: "another",
      includeArchived: false,
      limit: 50,
    });
    expect(onWorkspaceSourceAvailable).toHaveBeenCalledTimes(1);
    expect(onWorkspaceSourceAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/work/demo" }),
      agent,
      local,
    );
    runtime.disconnectSource({ kind: "local", workspacePath: "/work/demo" });
    expect(listener.dispose).toHaveBeenCalledTimes(1);
    runtime.dispose();
    expect(listener.dispose).toHaveBeenCalledTimes(1);
  });

  it("remote workspace 就绪时可主动进入现有 source 生命周期而无需先查询手机列表", async () => {
    const tasks = taskService({});
    const agent = {
      onDynamicSessionsIndexFrame: vi.fn(() => Event.None),
      onAgentRuntimeRestarted: vi.fn(() => ({ dispose: vi.fn() })),
      subscribeSessionsIndexV4: vi.fn(async () => ({ ack: { subscriptionId: "sessions-sub" } })),
      unsubscribeSessionsIndexV4: vi.fn(async () => undefined),
      resyncSessionsIndexV4: vi.fn(),
    } as unknown as IZCodeAgentService;
    const captureSubscription = { dispose: vi.fn() };
    const onWorkspaceSourceAvailable = vi.fn(() => captureSubscription);
    const scope = {
      kind: "remote" as const,
      remoteSessionId: "remote-ready-1",
      workspacePath: "/work/remote",
      workspaceIdentity: "remote:ssh:host:/work/remote",
    };
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable,
      resolveSource: () => ({
        scope,
        taskService: tasks,
        agentService: agent,
        sourceAvailability: "online",
      }),
    });

    try {
      await expect(runtime.ensureSource(scope)).resolves.toBe(true);
      await expect(runtime.ensureSource(scope)).resolves.toBe(true);
      expect(onWorkspaceSourceAvailable).toHaveBeenCalledTimes(1);
      expect(onWorkspaceSourceAvailable).toHaveBeenCalledWith(scope, agent, tasks);
      expect(agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      runtime.disconnectSource(scope);
      expect(captureSubscription.dispose).toHaveBeenCalledTimes(1);
    } finally {
      runtime.dispose();
    }
  });

  it("分别捕获多个已打开 workspace source，offline scope 不创建订阅并在释放时清理", async () => {
    const localTasks = taskService({});
    const remoteTasks = taskService({});
    const localAgent = {} as IZCodeAgentService;
    const remoteAgent = {} as IZCodeAgentService;
    const localSubscription = { dispose: vi.fn() };
    const remoteSubscription = { dispose: vi.fn() };
    const callback = vi.fn((scope) =>
      scope.kind === "local" ? localSubscription : remoteSubscription,
    );
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable: callback,
      resolveSource: (scope) =>
        scope.workspacePath === "/work/remote"
          ? {
              scope: { kind: "remote" as const, remoteSessionId: "remote-1", ...scope },
              taskService: remoteTasks,
              agentService: remoteAgent,
              sourceAvailability: "online" as const,
            }
          : {
              scope: { kind: "local" as const, ...scope },
              taskService: localTasks,
              agentService: localAgent,
              sourceAvailability:
                scope.workspacePath === "/work/offline"
                  ? ("offline" as const)
                  : ("online" as const),
            },
    });

    for (const workspaceScope of [
      { workspacePath: "/work/local" },
      { workspacePath: "/work/remote", workspaceIdentity: remoteIdentity },
      { workspacePath: "/work/offline" },
    ]) {
      await runtime.service.searchMobileHistory({
        workspaceScope,
        query: "needle",
        includeArchived: false,
        limit: 50,
      });
    }

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local", workspacePath: "/work/local" }),
      localAgent,
      localTasks,
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "remote",
        remoteSessionId: "remote-1",
        workspacePath: "/work/remote",
      }),
      remoteAgent,
      remoteTasks,
    );
    runtime.disconnectSource({
      kind: "remote",
      remoteSessionId: "remote-1",
      workspacePath: "/work/remote",
      workspaceIdentity: remoteIdentity,
    });
    expect(remoteSubscription.dispose).toHaveBeenCalledTimes(1);
    runtime.dispose();
    expect(localSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(remoteSubscription.dispose).toHaveBeenCalledTimes(1);
  });

  it("source services 被替换时先释放旧通知捕获订阅", async () => {
    let currentTasks = taskService({});
    let currentAgent = {} as IZCodeAgentService;
    const oldSubscription = { dispose: vi.fn() };
    const newSubscription = { dispose: vi.fn() };
    const callback = vi
      .fn()
      .mockReturnValueOnce(oldSubscription)
      .mockReturnValueOnce(newSubscription);
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable: callback,
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: currentTasks,
        agentService: currentAgent,
        sourceAvailability: "online" as const,
      }),
    });
    const query = {
      workspaceScope: { workspacePath: "/work/replaced" },
      query: "needle",
      includeArchived: false,
      limit: 50 as const,
    };
    await runtime.service.searchMobileHistory(query);
    currentTasks = taskService({});
    currentAgent = {} as IZCodeAgentService;
    await runtime.service.searchMobileHistory(query);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(oldSubscription.dispose).toHaveBeenCalledTimes(1);
    runtime.dispose();
    expect(newSubscription.dispose).toHaveBeenCalledTimes(1);
  });

  it("手机搜索为每个 membership 显式限量并返回合并排序结果", async () => {
    const first = meta({ taskId: "newer", createdAt: 4 });
    const older = meta({ taskId: "older", createdAt: 2 });
    const local = taskService({ search: [first, older] });
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: local,
        sourceAvailability: "online" as const,
      }),
    });

    const result = await runtime.service.searchMobileHistory({
      workspaceScope: { workspacePath: "/work/demo" },
      query: "needle",
      includeArchived: true,
      limit: 50,
    });

    expect(result).toMatchObject({
      status: "ok",
      items: [{ taskId: "newer" }, { taskId: "older" }],
    });
    expect(local.listTaskList).toHaveBeenCalledTimes(3);
    expect(local.listTaskList).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "active", search: "needle", limit: 50 }),
    );
    expect(local.listTaskList).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "pinned", search: "needle", limit: 50 }),
    );
    expect(local.listTaskList).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ kind: "archived", search: "needle", limit: 50 }),
    );
    runtime.dispose();
  });

  it("手机搜索将 offline source 与 source 查询异常分别暴露", async () => {
    const offlineRuntime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        sourceAvailability: "offline" as const,
      }),
    });
    await expect(
      offlineRuntime.service.searchMobileHistory({
        workspaceScope: { workspacePath: "/work/demo" },
        query: "needle",
        includeArchived: false,
        limit: 50,
      }),
    ).resolves.toEqual({ status: "offline" });
    offlineRuntime.dispose();

    const failing = taskService({});
    vi.mocked(failing.listTaskList).mockRejectedValue(new Error("index unavailable"));
    const errorRuntime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: failing,
        sourceAvailability: "online" as const,
      }),
    });
    await expect(
      errorRuntime.service.searchMobileHistory({
        workspaceScope: { workspacePath: "/work/demo" },
        query: "needle",
        includeArchived: false,
        limit: 50,
      }),
    ).resolves.toEqual({ status: "error", errorCode: "search-source-failed" });
    errorRuntime.dispose();
  });

  it("从 source Agent 的 existing-only sessions-index 读取 live activity", async () => {
    const frames = new Emitter<SessionsIndexTopicWireCandidate>();
    const runtimeLifecycle = new Emitter<{
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      state: "available" | "unavailable";
      runtimeIdentity: { workspaceKey: string; generation: number };
    }>();
    const agentService = {
      onDynamicSessionsIndexFrame: vi.fn(() => frames.event),
      onAgentRuntimeLifecycle: runtimeLifecycle.event,
      onAgentRuntimeRestarted: vi.fn(() => ({ dispose: vi.fn() })),
      subscribeSessionsIndexV4: vi.fn(async () => {
        frames.fire({
          wireVersion: 3,
          kind: "complete",
          deliveryKind: "initial",
          logicalFrameId: "initial-1",
          logicalFrameOrdinal: 1,
          topic: "sessions-index//work/demo",
          subscriptionId: "sessions-sub-1",
          frame: {
            topic: "sessions-index//work/demo",
            subscriptionId: "sessions-sub-1",
            fromSeq: 0,
            toSeq: 1,
            sentAt: 1,
            payload: {
              kind: "snapshot",
              snapshot: {
                protocolVersion: 1,
                workspaceId: "/work/demo",
                logEpoch: "sessions-epoch-1",
                sessions: [
                  {
                    sessionId: "live",
                    workspaceId: "/work/demo",
                    title: "正在运行",
                    phase: "running",
                    sessionEnded: false,
                    hasBackgroundWork: true,
                    workflowActivity: {
                      runs: [
                        {
                          runId: "run-1",
                          toolCallId: "tool-1",
                          name: "Deep research",
                          status: "running",
                          phases: [{ name: "Research", status: "running" }],
                          currentPhase: "Research",
                          agentsWorking: 1,
                        },
                      ],
                    },
                    pendingInteraction: {
                      interactionId: "ask-1",
                      kind: "userInput",
                      toolName: "AskUserQuestion",
                    },
                    pendingInteractionSummary: {
                      permissionCount: 0,
                      userInputCount: 1,
                    },
                    lastActivityAt: 20,
                    createdAt: 1,
                  },
                ],
              },
            },
          },
        });
        return {
          ack: { subscriptionId: "sessions-sub-1", mode: "snapshot", logEpoch: "sessions-epoch-1" },
        };
      }),
      resyncSessionsIndexV4: vi.fn(),
      unsubscribeSessionsIndexV4: vi.fn(async () => undefined),
    } as unknown as IZCodeAgentService;
    const local = taskService({ active: [meta({ taskId: "live" })] });
    const onCaptureSessionsChange = vi.fn();
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onWorkspaceSourceAvailable: () => ({
        dispose: vi.fn(),
        onSessionsChange: onCaptureSessionsChange,
      }),
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: local,
        agentService,
        sourceAvailability: "online" as const,
      }),
    });

    const result = await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: "/work/demo" }],
      sortBy: "updated",
    });

    expect(agentService.subscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/work/demo",
        subscriberScope: "window-controller",
        runtimePolicy: "existing-only",
      }),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        taskId: "live",
        title: "正在运行",
        updatedAt: 20,
        liveStatus: "waiting",
        pendingInteraction: expect.objectContaining({ interactionId: "ask-1" }),
        activity: {
          phase: "running",
          lastActivityAt: 20,
          hasBackgroundWork: true,
          workflowActivity: {
            runs: [
              {
                runId: "run-1",
                toolCallId: "tool-1",
                name: "Deep research",
                status: "running",
                phases: [{ name: "Research", status: "running" }],
                currentPhase: "Research",
                agentsWorking: 1,
              },
            ],
          },
          pendingInteractions: { permissionCount: 0, userInputCount: 1 },
        },
      }),
    ]);
    expect(onCaptureSessionsChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ sessionId: "live", title: "正在运行" })]),
    );
    frames.fire({
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "delta-2",
      logicalFrameOrdinal: 2,
      topic: "sessions-index//work/demo",
      subscriptionId: "sessions-sub-1",
      frame: {
        topic: "sessions-index//work/demo",
        subscriptionId: "sessions-sub-1",
        fromSeq: 1,
        toSeq: 2,
        sentAt: 2,
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "session.upserted",
              session: {
                sessionId: "live",
                workspaceId: "/work/demo",
                title: "已经完成",
                phase: "completedSuccess",
                sessionEnded: true,
                hasBackgroundWork: false,
                lastActivityAt: 30,
                createdAt: 1,
              },
            },
          ],
        },
      },
    });
    const completed = await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: "/work/demo" }],
      sortBy: "updated",
    });
    expect(completed.items[0]).toMatchObject({
      liveStatus: "completed",
      activity: { phase: "completedSuccess", lastActivityAt: 30 },
    });
    expect(local.listTasks).toHaveBeenCalledTimes(1);
    expect(local.listPinnedTasks).toHaveBeenCalledTimes(1);
    expect(local.listArchivedTasks).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("在 Host 内聚合 local 与 remote task rows，并为结果附加 source 地址", async () => {
    const local = taskService({ active: [meta({ taskId: "local", createdAt: 1 })] });
    const remote = taskService({
      pinned: [meta({ taskId: "remote", workspaceIdentity: remoteIdentity, createdAt: 2 })],
    });
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) =>
        scope.workspaceIdentity
          ? {
              scope: {
                kind: "remote" as const,
                remoteSessionId: "remote-1",
                ...scope,
                workspaceIdentity: scope.workspaceIdentity,
              },
              taskService: remote,
              sourceAvailability: "online" as const,
            }
          : {
              scope: { kind: "local" as const, ...scope },
              taskService: local,
              sourceAvailability: "online" as const,
            },
    });

    const result = await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [
        { workspacePath: "/work/demo" },
        { workspacePath: "/work/demo", workspaceIdentity: remoteIdentity },
      ],
      sortBy: "created",
    });

    expect(result.items.map((item) => item.taskId)).toEqual(["remote", "local"]);
    expect(result.items[0]).toMatchObject({
      remoteSessionId: "remote-1",
      sourceAvailability: "online",
    });
  });

  it("同一 source 的并发列表查询共享一次 task-index refresh", async () => {
    const local = taskService({ active: [meta({ taskId: "local" })] });
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: { kind: "local" as const, ...scope },
        taskService: local,
        sourceAvailability: "online" as const,
      }),
    });

    await Promise.all([
      runtime.service.listTaskList({
        kind: "active",
        workspaceScopes: [{ workspacePath: "/work/demo" }],
        sortBy: "updated",
      }),
      runtime.service.listTaskList({
        kind: "timeline",
        workspaceScopes: [{ workspacePath: "/work/demo" }],
        sortBy: "updated",
      }),
    ]);

    expect(local.listTasks).toHaveBeenCalledTimes(1);
    expect(local.listPinnedTasks).toHaveBeenCalledTimes(1);
    expect(local.listArchivedTasks).toHaveBeenCalledTimes(1);
  });

  it("断连后保留最后可信投影，非搜索可读但写入 fail-closed", async () => {
    const remote = taskService({
      active: [meta({ taskId: "remote", workspaceIdentity: remoteIdentity })],
    });
    let online = true;
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: {
          kind: "remote" as const,
          remoteSessionId: "remote-1",
          ...scope,
          workspaceIdentity: scope.workspaceIdentity!,
        },
        taskService: online ? remote : undefined,
        sourceAvailability: online ? "online" : "offline",
      }),
    });
    const query = {
      kind: "active" as const,
      workspaceScopes: [{ workspacePath: "/work/demo", workspaceIdentity: remoteIdentity }],
      sortBy: "updated" as const,
    };
    await runtime.service.listTaskList(query);
    online = false;
    runtime.disconnectSource({
      kind: "remote",
      remoteSessionId: "remote-1",
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
    });

    const offline = await runtime.service.listTaskList(query);
    expect(offline.items).toEqual([
      expect.objectContaining({ taskId: "remote", sourceAvailability: "offline" }),
    ]);
    await expect(
      runtime.service.mutateTask({
        address: {
          remoteSessionId: "remote-1",
          workspacePath: "/work/demo",
          workspaceIdentity: remoteIdentity,
          taskId: "remote",
        },
        mutation: { kind: "delete" },
      }),
    ).rejects.toThrow("远程 source 当前离线");
    expect(remote.deleteTask).not.toHaveBeenCalled();
  });

  it("全文搜索只查询在线 source，不用离线摘要伪造结果", async () => {
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: {
          kind: "remote" as const,
          remoteSessionId: "remote-1",
          ...scope,
          workspaceIdentity: scope.workspaceIdentity!,
        },
        sourceAvailability: "offline" as const,
      }),
    });

    const result = await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: "/work/demo", workspaceIdentity: remoteIdentity }],
      sortBy: "updated",
      search: "needle",
    });

    expect(result).toEqual({ items: [], total: 0, hasMore: false });
  });

  it("列表 mutation 按完整 task address 路由到唯一 task service", async () => {
    const remote = taskService({
      active: [meta({ taskId: "remote", workspaceIdentity: remoteIdentity })],
    });
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: {
          kind: "remote" as const,
          remoteSessionId: "remote-1",
          ...scope,
          workspaceIdentity: scope.workspaceIdentity!,
        },
        taskService: remote,
        sourceAvailability: "online" as const,
      }),
    });
    await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: "/work/demo", workspaceIdentity: remoteIdentity }],
      sortBy: "updated",
    });

    await runtime.service.mutateTask({
      address: {
        remoteSessionId: "remote-1",
        workspacePath: "/work/demo",
        workspaceIdentity: remoteIdentity,
        taskId: "remote",
      },
      mutation: { kind: "pin", pinned: true },
    });

    expect(remote.setTaskPinned).toHaveBeenCalledWith({
      taskId: "remote",
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
      pinned: true,
    });
  });

  it("归档条件删除保留 remote 地址与跳过结果，离线 source 禁止写入", async () => {
    const remote = taskService({
      archived: [meta({ taskId: "remote", workspaceIdentity: remoteIdentity })],
    });
    remote.deleteArchivedTask = vi.fn(async () => false);
    let online = true;
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: {
          kind: "remote" as const,
          remoteSessionId: "remote-1",
          ...scope,
          workspaceIdentity: scope.workspaceIdentity!,
        },
        taskService: remote,
        sourceAvailability: online ? "online" : "offline",
      }),
    });
    const address = await runtime.resolveTaskAddress({
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
      taskId: "remote",
    });
    expect(await runtime.service.deleteArchivedTask({ address })).toBe(false);
    expect(remote.deleteArchivedTask).toHaveBeenCalledWith({
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
      taskId: "remote",
    });
    online = false;
    await expect(runtime.service.deleteArchivedTask({ address })).rejects.toThrow("离线");
    expect(remote.deleteArchivedTask).toHaveBeenCalledTimes(1);
  });

  it("remote attachment 首次列表写入会先建立 Controller source", async () => {
    const remote = taskService({
      active: [meta({ taskId: "remote", workspaceIdentity: remoteIdentity })],
    });
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: {
          kind: "remote" as const,
          remoteSessionId: "remote-1",
          ...scope,
          workspaceIdentity: scope.workspaceIdentity!,
        },
        taskService: remote,
        sourceAvailability: "online" as const,
      }),
    });

    const address = await runtime.resolveTaskAddress({
      taskId: "remote",
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
      attachmentScope: {
        kind: "remote",
        remoteSessionId: "remote-1",
        workspacePath: "/work/demo",
        workspaceIdentity: remoteIdentity,
      },
    });
    await runtime.service.mutateTask({
      address,
      mutation: { kind: "mark-unread" },
    });

    expect(remote.setTaskUnread).toHaveBeenCalledWith({
      taskId: "remote",
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
      unread: true,
    });
  });

  it("remote attachment 已过期时不刷新或写入当前同 workspace source", async () => {
    const remote = taskService({
      active: [meta({ taskId: "remote", workspaceIdentity: remoteIdentity })],
    });
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: {
          kind: "remote" as const,
          remoteSessionId: "remote-current",
          ...scope,
          workspaceIdentity: scope.workspaceIdentity!,
        },
        taskService: remote,
        sourceAvailability: "online" as const,
      }),
    });

    await expect(
      runtime.resolveTaskAddress({
        taskId: "remote",
        workspacePath: "/work/demo",
        workspaceIdentity: remoteIdentity,
        attachmentScope: {
          kind: "remote",
          remoteSessionId: "remote-stale",
          workspacePath: "/work/demo",
          workspaceIdentity: remoteIdentity,
        },
      }),
    ).rejects.toThrow("列表 mutation 与 remote attachment source 不匹配");
    expect(remote.listTasks).not.toHaveBeenCalled();
    expect(remote.setTaskUnread).not.toHaveBeenCalled();
  });

  it("单个 remote source 读取失败不影响 local 与其他 source 列表", async () => {
    const local = taskService({ active: [meta({ taskId: "local" })] });
    const brokenRemote = taskService({});
    brokenRemote.listTasks = vi.fn(async () => {
      throw new Error("remote unavailable");
    });
    const sourceErrors = vi.fn();
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      onSourceError: sourceErrors,
      resolveSource: (scope) =>
        scope.workspaceIdentity
          ? {
              scope: {
                kind: "remote" as const,
                remoteSessionId: "remote-1",
                ...scope,
                workspaceIdentity: scope.workspaceIdentity,
              },
              taskService: brokenRemote,
              sourceAvailability: "online" as const,
            }
          : {
              scope: { kind: "local" as const, ...scope },
              taskService: local,
              sourceAvailability: "online" as const,
            },
    });

    const result = await runtime.service.listTaskList({
      kind: "active",
      workspaceScopes: [
        { workspacePath: "/work/demo" },
        { workspacePath: "/work/demo", workspaceIdentity: remoteIdentity },
      ],
      sortBy: "updated",
    });

    expect(result.items.map((item) => item.taskId)).toEqual(["local"]);
    expect(sourceErrors).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "remote" }),
      "refresh",
      expect.any(Error),
    );
  });

  it("重连 snapshot 读取失败时保留旧离线投影，后续成功后再原子替换", async () => {
    const oldService = taskService({
      active: [meta({ taskId: "old", workspaceIdentity: remoteIdentity })],
    });
    const nextService = taskService({
      active: [meta({ taskId: "new", workspaceIdentity: remoteIdentity })],
    });
    let sessionId = "remote-old";
    let service: IZCodeTaskService = oldService;
    const runtime = createWindowHostControllerRuntime({
      createId: () => "id",
      resolveSource: (scope) => ({
        scope: {
          kind: "remote" as const,
          remoteSessionId: sessionId,
          ...scope,
          workspaceIdentity: scope.workspaceIdentity!,
        },
        taskService: service,
        sourceAvailability: "online" as const,
      }),
    });
    const query = {
      kind: "active" as const,
      workspaceScopes: [{ workspacePath: "/work/demo", workspaceIdentity: remoteIdentity }],
      sortBy: "updated" as const,
    };
    await runtime.service.listTaskList(query);
    runtime.disconnectSource({
      kind: "remote",
      remoteSessionId: "remote-old",
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
    });
    sessionId = "remote-new";
    service = nextService;
    nextService.listTasks = vi.fn(async () => {
      throw new Error("snapshot unavailable");
    });

    await expect(
      runtime.replaceDisconnectedSource(
        {
          kind: "remote",
          remoteSessionId: "remote-old",
          workspacePath: "/work/demo",
          workspaceIdentity: remoteIdentity,
        },
        {
          scope: {
            kind: "remote",
            remoteSessionId: "remote-new",
            workspacePath: "/work/demo",
            workspaceIdentity: remoteIdentity,
          },
          taskService: nextService,
          sourceAvailability: "online",
        },
      ),
    ).rejects.toThrow("snapshot unavailable");
    expect(await runtime.service.listTaskList(query)).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            taskId: "old",
            remoteSessionId: "remote-old",
            sourceAvailability: "offline",
          }),
        ],
      }),
    );

    runtime.disconnectSource({
      kind: "remote",
      remoteSessionId: "remote-new",
      workspacePath: "/work/demo",
      workspaceIdentity: remoteIdentity,
    });
    const finalService = taskService({
      active: [meta({ taskId: "new", workspaceIdentity: remoteIdentity })],
    });
    sessionId = "remote-final";
    service = finalService;
    await runtime.replaceDisconnectedSource(
      {
        kind: "remote",
        remoteSessionId: "remote-new",
        workspacePath: "/work/demo",
        workspaceIdentity: remoteIdentity,
      },
      {
        scope: {
          kind: "remote",
          remoteSessionId: "remote-final",
          workspacePath: "/work/demo",
          workspaceIdentity: remoteIdentity,
        },
        taskService: finalService,
        sourceAvailability: "online",
      },
    );
    const replaced = await runtime.service.listTaskList(query);
    expect(replaced.items).toEqual([
      expect.objectContaining({
        taskId: "new",
        remoteSessionId: "remote-final",
        sourceAvailability: "online",
      }),
    ]);

    const snapshots: WindowHostControllerFrame[] = [];
    const frameSubscription = runtime.service.onDynamicControllerFrame()((frame) => {
      snapshots.push(frame);
    });
    await runtime.service.subscribeControllerV4({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      visibility: "foreground",
    });
    const snapshot = snapshots.at(-1);
    expect(snapshot?.topic).toBe(CONTROLLER_TASKS_INDEX_TOPIC);
    expect(
      snapshot?.topic === CONTROLLER_TASKS_INDEX_TOPIC && snapshot.payload.kind === "snapshot"
        ? snapshot.payload.snapshot.tasks.map((task) => task.address.remoteSessionId)
        : [],
    ).toEqual(["remote-final"]);
    frameSubscription.dispose();
  });
});
