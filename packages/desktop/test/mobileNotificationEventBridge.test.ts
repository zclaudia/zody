import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Event } from "@zody/rpc";
import type { ZCodeTaskMeta } from "@zody/shared";
import type { IZCodeAgentService, IZCodeTaskService } from "@zody/services";
import { createMobileNotificationEventBridge } from "../src/host/mobileNotificationEventBridge.js";
import { createMobileNotificationDeliveryBridge } from "../src/host/mobileNotificationDeliveryBridge.js";
import {
  createMobileNotificationService,
  type IMobileNotificationService,
} from "@zody/services/mobile-notifications/node";
import type { MobileNotificationRecordInput } from "@zody/services/mobile-notifications";

describe("MobileNotificationEventBridge", () => {
  it("从 sessions-index 发现 task-index 暂未返回的 runtime session 并捕获终态", async () => {
    let sessionListener: ((event: unknown) => void) | undefined;
    const notificationService = {
      record: vi.fn(async (input: MobileNotificationRecordInput) => input),
      resolveInteraction: vi.fn(async () => {}),
    };
    const bridge = createMobileNotificationEventBridge({
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-index",
        workspacePath: "/remote/project",
        workspaceIdentity: "remote:ssh:host:/remote/project",
      },
      agentService: {
        onDynamicSessionEvent: vi.fn(() => (listener: (event: unknown) => void) => {
          sessionListener = listener;
          return { dispose: vi.fn() };
        }),
      } as unknown as Pick<IZCodeAgentService, "onDynamicSessionEvent">,
      taskService: {
        listTasks: vi.fn(async () => []),
        onDynamicWorkspaceEvent: vi.fn(() => () => ({ dispose: vi.fn() })),
      } as unknown as Pick<IZCodeTaskService, "listTasks" | "onDynamicWorkspaceEvent">,
      notificationService: notificationService as unknown as Pick<
        IMobileNotificationService,
        "record" | "resolveInteraction"
      >,
      getBackendId: () => "backend-index",
    });

    try {
      bridge.acceptSessions([
        { sessionId: "runtime-session", title: "runtime task", lastActivityAt: 20 },
      ]);
      await vi.waitFor(() => expect(sessionListener).toBeTypeOf("function"));
      sessionListener?.({
        type: "session.event",
        event: {
          type: "turn.completed",
          eventId: "runtime-terminal",
          sessionId: "runtime-session",
          turnId: "turn-runtime",
          seq: 4,
          timestamp: 30,
          payload: { resultType: "success" },
        },
      });
      await vi.waitFor(() => expect(notificationService.record).toHaveBeenCalledTimes(1));
      expect(notificationService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceEventId: "runtime-terminal",
          title: "runtime task",
          target: expect.objectContaining({
            taskId: "runtime-session",
            sessionId: "runtime-session",
            remoteSessionId: "remote-session-index",
          }),
        }),
      );
    } finally {
      bridge.dispose();
    }
  });

  it("captures replayable raw event IDs, normalized pending interactions, and remote source identity", async () => {
    const task: ZCodeTaskMeta = {
      taskId: "session-1",
      traceId: "trace-1",
      title: "task",
      workspacePath: "/remote/project",
      workspaceIdentity: "remote:ssh:host:/remote/project",
      createdAt: 1,
      updatedAt: 10,
      mode: "default",
      pendingInteraction: {
        interactionId: "normalized-interaction",
        kind: "userInput",
      },
    };
    let tasks = [task];
    let workspaceListener: (() => void) | undefined;
    let sessionListener: ((event: unknown) => void) | undefined;
    const subscriptionParams: unknown[] = [];
    const taskService = {
      listTasks: vi.fn(async () => tasks),
      onDynamicWorkspaceEvent: vi.fn(() => (listener: () => void) => {
        workspaceListener = listener;
        return { dispose: vi.fn() };
      }),
    };
    const agentService = {
      onDynamicSessionEvent: vi.fn((params: unknown) => {
        subscriptionParams.push(params);
        return (listener: (event: unknown) => void) => {
          sessionListener = listener;
          return { dispose: vi.fn() };
        };
      }),
    };
    const notificationService = {
      record: vi.fn(async (input: MobileNotificationRecordInput) => input),
      resolveInteraction: vi.fn(async () => {}),
    };
    const diagnostics: unknown[] = [];
    const bridge = createMobileNotificationEventBridge({
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-9",
        workspacePath: task.workspacePath,
        workspaceIdentity: task.workspaceIdentity!,
      },
      agentService: agentService as unknown as Pick<IZCodeAgentService, "onDynamicSessionEvent">,
      taskService: taskService as unknown as Pick<
        IZCodeTaskService,
        "listTasks" | "onDynamicWorkspaceEvent"
      >,
      notificationService: notificationService as unknown as Pick<
        IMobileNotificationService,
        "record" | "resolveInteraction"
      >,
      getBackendId: () => "backend-9",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    try {
      await vi.waitFor(() => expect(notificationService.record).toHaveBeenCalledTimes(1));
      expect(diagnostics).toContainEqual({
        kind: "task-snapshot",
        taskCount: 1,
        sessionSubscriptionCount: 1,
      });
      expect(diagnostics).toContainEqual({
        kind: "session-attached",
        sessionSubscriptionCount: 1,
      });
      expect(subscriptionParams).toEqual([
        expect.objectContaining({
          sessionId: "session-1",
          deliveryKind: "web-remote-replayable",
          includeSnapshot: true,
          runtimePolicy: "existing-only",
        }),
      ]);
      expect(notificationService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          target: {
            backendId: "backend-9",
            workspaceKey: task.workspaceIdentity,
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            remoteSessionId: "remote-session-9",
            taskId: "session-1",
            sessionId: "session-1",
          },
          sourceEventId: "interaction:normalized-interaction",
          interactionId: "normalized-interaction",
          sourceKind: "interaction.pending",
          kind: "question",
          title: "task",
          recovered: true,
        }),
      );

      sessionListener?.({
        type: "session.event",
        event: {
          type: "turn.completed",
          eventId: "stable-event-id",
          sessionId: "session-1",
          turnId: "turn-1",
          seq: 22,
          timestamp: 20,
          payload: { resultType: "success" },
        },
        recovered: true,
      });
      await vi.waitFor(() => expect(notificationService.record).toHaveBeenCalledTimes(2));
      expect(diagnostics).toContainEqual({
        kind: "session-message",
        messageKind: "session.event:turn.completed",
      });
      expect(notificationService.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceEventId: "stable-event-id",
          sourceKind: "turn.completed",
          title: "task",
          turnId: "turn-1",
          recovered: true,
          target: expect.objectContaining({
            remoteSessionId: "remote-session-9",
            taskId: "session-1",
          }),
        }),
      );

      sessionListener?.({
        type: "session.event",
        event: {
          type: "permission.requested",
          eventId: "permission-event",
          sessionId: "session-1",
          seq: 23,
          timestamp: 21,
          payload: { requestId: "legacy-request-id" },
        },
      });
      await vi.waitFor(() => expect(taskService.listTasks).toHaveBeenCalledTimes(2));
      expect(notificationService.record).toHaveBeenCalledTimes(2);

      tasks = [{ ...task, pendingInteraction: undefined, updatedAt: 30 }];
      workspaceListener?.();
      await vi.waitFor(() =>
        expect(notificationService.resolveInteraction).toHaveBeenCalledWith({
          backendId: "backend-9",
          workspaceKey: task.workspaceIdentity,
          sessionId: "session-1",
          interactionId: "normalized-interaction",
        }),
      );
    } finally {
      bridge.dispose();
    }
  });

  it("permission.request 的脱敏按钮随 permission 通知固化；question 通知不带按钮（第二批 E4）", async () => {
    const task: ZCodeTaskMeta = {
      taskId: "session-perm",
      traceId: "trace-perm",
      title: "task",
      workspacePath: "/local/project",
      createdAt: 1,
      updatedAt: 10,
      mode: "default",
      pendingInteraction: {
        interactionId: "interaction-perm",
        kind: "permission",
      },
    };
    let sessionListener: ((event: unknown) => void) | undefined;
    const taskService = {
      listTasks: vi.fn(async () => [task]),
      onDynamicWorkspaceEvent: vi.fn(() => () => ({ dispose: vi.fn() })),
    };
    const agentService = {
      onDynamicSessionEvent: vi.fn(
        () => (listener: (event: unknown) => void) => {
          sessionListener = listener;
          return { dispose: vi.fn() };
        },
      ),
    };
    const notificationService = {
      record: vi.fn(async (input: MobileNotificationRecordInput) => input),
      resolveInteraction: vi.fn(async () => {}),
    };
    // 首次扫描时 backend 上下文尚未就绪（初始 reconcile 不 record）；permission.request
    // 到达并缓存按钮后注入 backend，确保 record 发生在按钮已缓存之后。
    let backendId: string | undefined;
    const bridge = createMobileNotificationEventBridge({
      scope: { kind: "local", workspacePath: "/local/project" },
      agentService: agentService as unknown as Pick<IZCodeAgentService, "onDynamicSessionEvent">,
      taskService: taskService as unknown as Pick<
        IZCodeTaskService,
        "listTasks" | "onDynamicWorkspaceEvent"
      >,
      notificationService: notificationService as unknown as Pick<
        IMobileNotificationService,
        "record" | "resolveInteraction"
      >,
      getBackendId: () => backendId,
    });

    try {
      await vi.waitFor(() => expect(taskService.listTasks).toHaveBeenCalled());
      // 先投递带完整 options 的 permission.request（agentService 请求面，requestId 与
      // task snapshot 的 interactionId 同源），再让 reconcile 固化通知。
      backendId = "backend-actions";
      sessionListener?.({
        type: "permission.request",
        request: {
          requestId: "interaction-perm",
          sessionId: "session-perm",
          toolCallId: "call-1",
          toolName: "Bash",
          reason: "run command",
          riskLevel: "medium",
          input: {},
          options: [
            { optionId: "opt-once", kind: "allowOnce", name: "Allow once" },
            { optionId: "opt-always", kind: "allowAlways", name: "Always allow" },
            { optionId: "opt-custom", kind: "custom", name: "Edit command" },
            { optionId: "opt-deny", kind: "deny", name: "Deny" },
          ],
        },
      });
      await vi.waitFor(() => expect(notificationService.record).toHaveBeenCalled());
      expect(notificationService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "permission",
          interactionId: "interaction-perm",
          // custom 不映射为通知按钮；只保留三类固定 kind，按原顺序取前 3。
          actions: [
            { optionId: "opt-once", optionKind: "allowOnce" },
            { optionId: "opt-always", optionKind: "allowAlways" },
            { optionId: "opt-deny", optionKind: "deny" },
          ],
        }),
      );

      // question 通知不带按钮：换成 userInput interaction 后 record 无 actions 字段。
      notificationService.record.mockClear();
      (task as { pendingInteraction: unknown }).pendingInteraction = {
        interactionId: "interaction-question",
        kind: "userInput",
      };
      sessionListener?.({
        type: "session.event",
        event: {
          type: "userInput.requested",
          eventId: "question-event",
          sessionId: "session-perm",
          seq: 30,
          timestamp: 25,
          payload: { requestId: "legacy" },
        },
      });
      await vi.waitFor(() => expect(notificationService.record).toHaveBeenCalled());
      expect(notificationService.record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "question" }),
      );
      const lastRecord = notificationService.record.mock.lastCall?.[0] as
        | MobileNotificationRecordInput
        | undefined;
      expect(lastRecord?.actions).toBeUndefined();
    } finally {
      bridge.dispose();
    }
  });

  it("已 resolve 的 interactionId 在后续陈旧 snapshot 再次出现时不再 record", async () => {
    const task: ZCodeTaskMeta = {
      taskId: "session-stale",
      traceId: "trace-stale",
      title: "task",
      workspacePath: "/local/project",
      createdAt: 1,
      updatedAt: 10,
      mode: "default",
      pendingInteraction: {
        interactionId: "stale-interaction",
        kind: "permission",
      },
    };
    let tasks = [task];
    let workspaceListener: (() => void) | undefined;
    const taskService = {
      listTasks: vi.fn(async () => tasks),
      onDynamicWorkspaceEvent: vi.fn(() => (listener: () => void) => {
        workspaceListener = listener;
        return { dispose: vi.fn() };
      }),
    };
    const notificationService = {
      record: vi.fn(async (input: MobileNotificationRecordInput) => input),
      resolveInteraction: vi.fn(async () => {}),
    };
    const bridge = createMobileNotificationEventBridge({
      scope: { kind: "local", workspacePath: task.workspacePath },
      agentService: {
        onDynamicSessionEvent: vi.fn(() => () => ({ dispose: vi.fn() })),
      } as unknown as Pick<IZCodeAgentService, "onDynamicSessionEvent">,
      taskService: taskService as unknown as Pick<
        IZCodeTaskService,
        "listTasks" | "onDynamicWorkspaceEvent"
      >,
      notificationService: notificationService as unknown as Pick<
        IMobileNotificationService,
        "record" | "resolveInteraction"
      >,
      getBackendId: () => "backend-stale",
    });

    try {
      // 首个 snapshot 记录 interaction:stale-interaction 一次。
      await vi.waitFor(() => expect(notificationService.record).toHaveBeenCalledTimes(1));
      // interaction 消失：标记 resolved 并停止跟踪。
      tasks = [{ ...task, pendingInteraction: undefined, updatedAt: 20 }];
      workspaceListener?.();
      await vi.waitFor(() =>
        expect(notificationService.resolveInteraction).toHaveBeenCalledWith({
          backendId: "backend-stale",
          workspaceKey: "/local/project",
          sessionId: "session-stale",
          interactionId: "stale-interaction",
        }),
      );
      // 陈旧 snapshot 再次携带同一 interactionId（resolvedInteractionIds 路径）不得重开记录。
      tasks = [{ ...task, updatedAt: 30 }];
      workspaceListener?.();
      await vi.waitFor(() =>
        expect(taskService.listTasks).toHaveBeenCalledTimes(3),
      );
      expect(notificationService.record).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });

  it("does not persist terminal events when authenticated backend context is unavailable", async () => {
    const task: ZCodeTaskMeta = {
      taskId: "session-2",
      traceId: "trace-2",
      title: "task",
      workspacePath: "/local/project",
      createdAt: 1,
      updatedAt: 2,
      mode: "default",
    };
    const notificationService = {
      record: vi.fn(),
      resolveInteraction: vi.fn(),
    };
    let listener: ((event: unknown) => void) | undefined;
    const bridge = createMobileNotificationEventBridge({
      scope: { kind: "local", workspacePath: task.workspacePath },
      agentService: {
        onDynamicSessionEvent: () => (next: (event: unknown) => void) => {
          listener = next;
          return { dispose: () => {} };
        },
      } as unknown as Pick<IZCodeAgentService, "onDynamicSessionEvent">,
      taskService: {
        listTasks: async () => [task],
        onDynamicWorkspaceEvent: () => Event.None,
      } as unknown as Pick<IZCodeTaskService, "listTasks" | "onDynamicWorkspaceEvent">,
      notificationService: notificationService as unknown as Pick<
        IMobileNotificationService,
        "record" | "resolveInteraction"
      >,
      getBackendId: () => undefined,
    });
    await vi.waitFor(() => expect(listener).toBeTypeOf("function"));
    listener?.({
      type: "session.event",
      event: {
        type: "turn.completed",
        eventId: "no-backend",
        sessionId: "session-2",
        seq: 1,
        timestamp: 3,
      },
    });
    await Promise.resolve();
    expect(notificationService.record).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("recovers a pending interaction when trusted backend context arrives after the first scan", async () => {
    const task: ZCodeTaskMeta = {
      taskId: "session-late",
      traceId: "trace-late",
      title: "task",
      workspacePath: "/local/project",
      createdAt: 1,
      updatedAt: 2,
      mode: "default",
      pendingInteraction: {
        interactionId: "normalized-late",
        kind: "permission",
      },
    };
    let backendId: string | undefined;
    const notificationService = {
      record: vi.fn(async () => ({})),
      resolveInteraction: vi.fn(async () => {}),
    };
    const bridge = createMobileNotificationEventBridge({
      scope: { kind: "local", workspacePath: task.workspacePath },
      agentService: {
        onDynamicSessionEvent: () => () => ({ dispose: () => {} }),
      } as unknown as Pick<IZCodeAgentService, "onDynamicSessionEvent">,
      taskService: {
        listTasks: async () => [task],
        onDynamicWorkspaceEvent: () => Event.None,
      } as unknown as Pick<IZCodeTaskService, "listTasks" | "onDynamicWorkspaceEvent">,
      notificationService: notificationService as unknown as Pick<
        IMobileNotificationService,
        "record" | "resolveInteraction"
      >,
      getBackendId: () => backendId,
    });
    try {
      await vi.waitFor(() => expect(notificationService.record).not.toHaveBeenCalled());
      backendId = "backend-late";
      bridge.refresh(true);
      await vi.waitFor(() => expect(notificationService.record).toHaveBeenCalledTimes(1));
      expect(notificationService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceEventId: "interaction:normalized-late",
          recovered: true,
          target: expect.objectContaining({ backendId: "backend-late" }),
        }),
      );
    } finally {
      bridge.dispose();
    }
  });

  it("persists a raw terminal event in SQLite and acknowledges its push receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mobile-notification-host-e2e-"));
    const service = await createMobileNotificationService({
      databasePath: join(directory, "feed.sqlite"),
    });
    const recordSpy = vi.spyOn(service, "record");
    const task: ZCodeTaskMeta = {
      taskId: "session-e2e",
      traceId: "trace-e2e",
      title: "task",
      workspacePath: "/work/e2e",
      createdAt: 1,
      updatedAt: 2,
      mode: "default",
    };
    let sessionListener: ((event: unknown) => void) | undefined;
    let worker: ReturnType<typeof createMobileNotificationDeliveryBridge> | undefined;
    const published: unknown[] = [];
    worker = createMobileNotificationDeliveryBridge({
      service,
      send(message) {
        published.push(message);
        worker?.accept({
          type: "mobile-notification-result",
          requestId: message.requestId,
          receipt: { status: "accepted" },
        });
      },
    });
    const capture = createMobileNotificationEventBridge({
      scope: { kind: "local", workspacePath: task.workspacePath },
      agentService: {
        onDynamicSessionEvent: () => (listener: (event: unknown) => void) => {
          sessionListener = listener;
          return { dispose: () => {} };
        },
      } as unknown as Pick<IZCodeAgentService, "onDynamicSessionEvent">,
      taskService: {
        listTasks: async () => [task],
        onDynamicWorkspaceEvent: () => Event.None,
      } as unknown as Pick<IZCodeTaskService, "listTasks" | "onDynamicWorkspaceEvent">,
      notificationService: service,
      getBackendId: () => worker?.getBackendId(),
    });
    try {
      worker.accept({
        type: "mobile-notification-context",
        enabled: true,
        backendId: "backend-e2e",
      });
      await vi.waitFor(() => expect(sessionListener).toBeTypeOf("function"));
      sessionListener?.({
        type: "session.event",
        event: {
          type: "turn.completed",
          eventId: "stable-e2e-event",
          sessionId: task.taskId,
          turnId: "turn-e2e",
          seq: 8,
          timestamp: Date.now(),
          payload: { resultType: "success" },
        },
      });
      await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => {
        const page = await service.listFeedForPrincipal({
          principal: {
            backendId: "backend-e2e",
            deviceSubject: "device-e2e",
            clientInstanceId: "client-e2e",
          },
        });
        expect(page.items[0]).toMatchObject({
          sourceEventId: "stable-e2e-event",
          target: expect.objectContaining({
            backendId: "backend-e2e",
            taskId: task.taskId,
          }),
          deliveryState: "accepted",
        });
      });
      expect(published).toHaveLength(1);
    } finally {
      capture.dispose();
      worker.dispose();
      service.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
