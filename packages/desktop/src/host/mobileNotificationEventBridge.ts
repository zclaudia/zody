import type { IZodyAgentService, IZodyTaskService } from "@zody/services";
import type { IMobileNotificationService } from "@zody/services/mobile-notifications/node";
import type { ZodyTaskMeta } from "@zody/shared";
import type { SessionSummary } from "@zody/shared/zody-protocol-v4";
import { extractMobileNotificationPushActions, resolveWorkspaceKey } from "@zody/shared";

export type WindowHostControllerSourceScope =
  | { kind: "local"; workspacePath: string; workspaceIdentity?: string }
  | { kind: "remote"; remoteSessionId: string; workspacePath: string; workspaceIdentity: string };

type MobileNotificationCaptureDiagnostic =
  | { kind: "task-snapshot"; taskCount: number; sessionSubscriptionCount: number }
  | { kind: "session-attached"; sessionSubscriptionCount: number }
  | { kind: "workspace-event" }
  | { kind: "session-message"; messageKind: string };

type CapturableSessionSummary = Pick<SessionSummary, "sessionId" | "title" | "lastActivityAt">;
type CapturableTask = Pick<ZodyTaskMeta, "taskId" | "title" | "updatedAt"> &
  Pick<ZodyTaskMeta, "pendingInteraction">;

const MAX_QUEUED_TERMINALS = 256;
const MAX_CACHED_PERMISSION_ACTIONS = 256;

/** Captures raw session event envelopes before task-list projection discards eventId. */
export function createMobileNotificationEventBridge(params: {
  scope: WindowHostControllerSourceScope;
  agentService: Pick<IZodyAgentService, "onDynamicSessionEvent">;
  taskService: Pick<IZodyTaskService, "listTasks" | "onDynamicWorkspaceEvent">;
  notificationService: Pick<IMobileNotificationService, "record" | "resolveInteraction">;
  getBackendId(): string | undefined;
  onTerminalCaptureResult?: (sourceKind: "turn.completed" | "turn.failed", result: "accepted" | "failed") => void;
  onDiagnostic?: (diagnostic: MobileNotificationCaptureDiagnostic) => void;
  logError?: (error: unknown) => void;
}) {
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: params.scope.workspacePath,
    ...(params.scope.workspaceIdentity
      ? { workspaceIdentity: params.scope.workspaceIdentity }
      : {}),
  });
  const subscriptions = new Map<string, { dispose(): void }>();
  const queuedTerminals = new Map<string, { sessionId: string; event: CapturedTerminalEvent }>();
  const knownPendingInteractions = new Map<
    string,
    { taskId: string; backendId: string; sessionId: string; interactionId: string }
  >();
  // 第二批 E4：permission 请求的脱敏按钮。agentService 的 permission.request 事件携带完整
  // options（optionId 同 V4 interactionId 空间，UI 适配层同源映射）；task-index 的
  // pendingInteraction 是轻量投影拿不到 options，所以在这里按 requestId 缓存、record 时查。
  const permissionRequestActions = new Map<
    string,
    import("@zody/shared").MobileNotificationPushAction[]
  >();
  const resolvedInteractionIds = new Set<string>();
  let tasksBySessionId = new Map<string, CapturableTask>();
  let indexedTasksBySessionId = new Map<string, ZodyTaskMeta>();
  let sessionSummariesById = new Map<string, CapturableSessionSummary>();
  let disposed = false;
  let initialTaskSnapshot = true;
  let refreshGeneration = 0;
  let lastTaskCount: number | undefined;
  const reportedMessageKinds = new Set<string>();

  type ZodySessionTerminalEvent = Extract<
    import("@zody/shared").ZodySessionEvent,
    { type: "turn.completed" | "turn.failed" }
  >;
  type CapturedTerminalEvent = ZodySessionTerminalEvent & { recovered?: boolean };

  const currentBackendId = () => params.getBackendId();
  const rebuildCaptureTasks = () => {
    const nextTasks = new Map<string, CapturableTask>(indexedTasksBySessionId);
    for (const summary of sessionSummariesById.values()) {
      if (nextTasks.has(summary.sessionId)) continue;
      nextTasks.set(summary.sessionId, {
        taskId: summary.sessionId,
        title: summary.title,
        updatedAt: summary.lastActivityAt,
        pendingInteraction: undefined,
      });
    }
    tasksBySessionId = nextTasks;
    flushQueuedTerminals();
  };
  const targetFor = (task: CapturableTask, sessionId: string) => {
    const backendId = currentBackendId();
    if (!backendId) return null;
    return {
      backendId,
      workspaceKey,
      workspacePath: params.scope.workspacePath,
      ...(params.scope.workspaceIdentity
        ? { workspaceIdentity: params.scope.workspaceIdentity }
        : {}),
      ...(params.scope.kind === "remote" ? { remoteSessionId: params.scope.remoteSessionId } : {}),
      taskId: task.taskId,
      sessionId,
    };
  };

  const recordTerminal = (event: CapturedTerminalEvent, task: CapturableTask) => {
    if (
      event.type === "turn.completed" &&
      (event.payload as { resultType?: unknown } | undefined)?.resultType === "cancelled"
    )
      return;
    const target = targetFor(task, event.sessionId);
    if (!target) return;
    void params.notificationService
      .record({
        target,
        sourceEventId: event.eventId,
        sourceKind: event.type,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        occurredAt: event.timestamp,
        kind: event.type === "turn.completed" ? "completed" : "failed",
        // Feed只返回给通过 Gateway 身份绑定的设备 reader；push payload仍由 delivery bridge
        // 固定成泛化文案，避免把本地任务标题发给推送供应商。
        title: task.title,
        recovered: event.recovered === true,
      })
      .then(() => params.onTerminalCaptureResult?.(event.type, "accepted"))
      .catch((error) => {
        params.onTerminalCaptureResult?.(event.type, "failed");
        params.logError?.(error);
      });
  };

  const flushQueuedTerminals = () => {
    for (const [eventId, queued] of queuedTerminals) {
      const task = tasksBySessionId.get(queued.sessionId);
      if (!task) continue;
      queuedTerminals.delete(eventId);
      recordTerminal(queued.event, task);
    }
  };

  const reconcileSessions = async (recoveredSnapshot = false): Promise<void> => {
    const generation = ++refreshGeneration;
    try {
      const tasks = await params.taskService.listTasks({
        workspacePath: params.scope.workspacePath,
        ...(params.scope.workspaceIdentity
          ? { workspaceIdentity: params.scope.workspaceIdentity }
          : {}),
      });
      if (disposed || generation !== refreshGeneration) return;
      const nextTasksBySessionId = new Map<string, ZodyTaskMeta>();
      for (const task of tasks) {
        // ZCodeTaskMeta explicitly defines taskId as the ZCode sessionId; the adapter builds it
        // from snapshot.session.sessionId. Keep the lookup explicit so a future divergent mapping
        // cannot route a terminal event to a guessed task.
        const sessionId = task.taskId;
        nextTasksBySessionId.set(sessionId, task);
        if (!subscriptions.has(sessionId)) attachSession(sessionId);

        const current = task.pendingInteraction;
        const previousForTask = Array.from(knownPendingInteractions.entries()).filter(
          ([, previous]) => previous.taskId === task.taskId,
        );
        for (const [key, previous] of previousForTask) {
          if (previous.interactionId === current?.interactionId) continue;
          knownPendingInteractions.delete(key);
          void params.notificationService
            .resolveInteraction({
              backendId: previous.backendId,
              workspaceKey,
              sessionId: previous.sessionId,
              interactionId: previous.interactionId,
            })
            .catch((error) => params.logError?.(error));
          resolvedInteractionIds.add(previous.interactionId);
          permissionRequestActions.delete(previous.interactionId);
        }
        const backendId = currentBackendId();
        const interactionKey = backendId ? `${backendId}\0${task.taskId}` : undefined;
        if (
          current &&
          backendId &&
          interactionKey &&
          !resolvedInteractionIds.has(current.interactionId) &&
          knownPendingInteractions.get(interactionKey)?.interactionId !== current.interactionId
        ) {
          knownPendingInteractions.set(interactionKey, {
            taskId: task.taskId,
            backendId,
            sessionId,
            interactionId: current.interactionId,
          });
          const target = targetFor(task, sessionId);
          if (target) {
            const question = current.kind === "userInput";
            void params.notificationService
              .record({
                target,
                sourceEventId: `interaction:${current.interactionId}`,
                sourceKind: "interaction.pending",
                interactionId: current.interactionId,
                occurredAt: task.updatedAt,
                kind: question ? "question" : "permission",
                title: task.title,
                recovered: recoveredSnapshot || initialTaskSnapshot,
                // 第二批 E4：仅 permission 通知固化脱敏按钮（optionId + optionKind），
                // 取自 permission.request 事件缓存（与 interactionId 同源 requestId）。
                ...(question
                  ? {}
                  : {
                      actions:
                        permissionRequestActions.get(current.interactionId) ?? undefined,
                    }),
              })
              .catch((error) => params.logError?.(error));
          }
        }
      }
      if (lastTaskCount !== tasks.length) {
        lastTaskCount = tasks.length;
        params.onDiagnostic?.({
          kind: "task-snapshot",
          taskCount: tasks.length,
          sessionSubscriptionCount: subscriptions.size,
        });
      }
      indexedTasksBySessionId = nextTasksBySessionId;
      rebuildCaptureTasks();
      initialTaskSnapshot = false;
    } catch (error) {
      params.logError?.(error);
    }
  };

  function attachSession(sessionId: string): void {
    if (disposed || subscriptions.has(sessionId)) return;
    const subscription = params.agentService.onDynamicSessionEvent({
      workspacePath: params.scope.workspacePath,
      ...(params.scope.workspaceIdentity
        ? { workspaceIdentity: params.scope.workspaceIdentity }
        : {}),
      sessionId,
      deliveryKind: "web-remote-replayable",
      includeSnapshot: true,
      runtimePolicy: "existing-only",
    })((message) => {
      if (disposed) return;
      const messageKind =
        message.type === "session.event" ? `session.event:${message.event.type}` : message.type;
      const terminal =
        message.type === "session.event" &&
        (message.event.type === "turn.completed" || message.event.type === "turn.failed");
      if (terminal || !reportedMessageKinds.has(messageKind)) {
        reportedMessageKinds.add(messageKind);
        params.onDiagnostic?.({ kind: "session-message", messageKind });
      }
      if (message.type === "permission.request") {
        const actions = extractMobileNotificationPushActions({
          options: message.request.options.map((option) => ({
            optionId: option.optionId,
            kind: option.kind,
          })),
        });
        if (actions) {
          permissionRequestActions.set(message.request.requestId, actions);
          // 缓存只服务即将产生的 interaction 通知；有界防泄漏。
          while (permissionRequestActions.size > MAX_CACHED_PERMISSION_ACTIONS) {
            const oldest = permissionRequestActions.keys().next().value;
            if (oldest) permissionRequestActions.delete(oldest);
            else break;
          }
        }
        void reconcileSessions();
        return;
      }
      if (message.type !== "session.event") return;
      const event = message.event;
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        const task = tasksBySessionId.get(event.sessionId);
        if (task) {
          recordTerminal({ ...event, recovered: message.recovered === true }, task);
        } else {
          queuedTerminals.set(event.eventId, {
            sessionId: event.sessionId,
            event: { ...event, recovered: message.recovered === true },
          });
          while (queuedTerminals.size > MAX_QUEUED_TERMINALS) {
            const oldest = queuedTerminals.keys().next().value;
            if (oldest) queuedTerminals.delete(oldest);
            else break;
          }
        }
      } else if (
        event.type === "permission.requested" ||
        event.type === "userInput.requested" ||
        event.type === "permission.resolved" ||
        event.type === "userInput.resolved"
      ) {
        // The event's payload.requestId is a legacy transport id. The indexed task snapshot carries
        // the normalized V4 interactionId used as the durable notification key.
        void reconcileSessions();
      }
    });
    subscriptions.set(sessionId, subscription);
    params.onDiagnostic?.({
      kind: "session-attached",
      sessionSubscriptionCount: subscriptions.size,
    });
  }

  const workspaceEvents = params.taskService.onDynamicWorkspaceEvent({
    workspacePath: params.scope.workspacePath,
    ...(params.scope.workspaceIdentity
      ? { workspaceIdentity: params.scope.workspaceIdentity }
      : {}),
  })(() => {
    params.onDiagnostic?.({ kind: "workspace-event" });
    void reconcileSessions();
  });
  void reconcileSessions();

  return {
    acceptSessions(sessions: readonly CapturableSessionSummary[]) {
      if (disposed) return;
      sessionSummariesById = new Map(sessions.map((session) => [session.sessionId, session]));
      for (const session of sessions) attachSession(session.sessionId);
      rebuildCaptureTasks();
    },
    refresh(recoveredSnapshot = false) {
      void reconcileSessions(recoveredSnapshot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      refreshGeneration += 1;
      workspaceEvents.dispose();
      for (const subscription of subscriptions.values()) subscription.dispose();
      subscriptions.clear();
      indexedTasksBySessionId.clear();
      sessionSummariesById.clear();
      tasksBySessionId.clear();
      queuedTerminals.clear();
      knownPendingInteractions.clear();
    },
  };
}
