import type { MobileNotificationRecordInput } from "./contract.js";

export const mobileNotificationExample: MobileNotificationRecordInput = {
  target: {
    backendId: "backend-id",
    workspaceKey: "workspace-identity-or-path",
    workspacePath: "/workspace",
    taskId: "task-id",
    sessionId: "session-id",
  },
  sourceEventId: "raw-v4-event-id",
  sourceKind: "turn.completed",
  turnId: "turn-id",
  occurredAt: 1_800_000_000_000,
  kind: "completed",
  title: "Task completed",
};
