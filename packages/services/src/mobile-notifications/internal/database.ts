import type { MobileNotificationPushAction } from "@zcode/shared";
import type { MobileNotification, MobileNotificationRecordInput } from "../contract.js";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ROWS = 1_000;
export const MAX_ATTEMPTS = 8;
export const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
export const INTERACTION_TTL_MS = 60 * 60 * 1000;
export const PAGE_MAX = 50;

export type NotificationRow = {
  notification_id: string;
  backend_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  remote_session_id: string | null;
  task_id: string;
  session_id: string;
  source_event_id: string;
  source_kind: MobileNotificationRecordInput["sourceKind"];
  interaction_id: string | null;
  turn_id: string | null;
  occurred_at: number;
  kind: MobileNotification["kind"];
  title: string;
  recovered: number;
  resolved: number;
  delivery_state: MobileNotification["deliveryState"];
  /** 第二批 E4：actions 的 JSON 序列化（optionId/optionKind，脱敏）；空为 null。 */
  actions: string | null;
};

export function encodeNotificationActions(
  actions: MobileNotificationRecordInput["actions"],
): string | null {
  if (!actions || actions.length === 0) return null;
  return JSON.stringify(actions);
}

export function decodeNotificationActions(
  raw: string | null,
): MobileNotificationPushAction[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const actions = parsed.filter(
      (item): item is MobileNotificationPushAction =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { optionId?: unknown }).optionId === "string" &&
        (item as { optionId?: unknown }).optionId !== "" &&
        ["allowOnce", "allowAlways", "deny"].includes(
          String((item as { optionKind?: unknown }).optionKind),
        ),
    );
    return actions.length > 0 ? actions.slice(0, 3) : undefined;
  } catch {
    // 损坏的 JSON 不让整条 feed 读不出来；actions 丢失只影响通知按钮，不影响事实记录。
    return undefined;
  }
}

export function readNotificationRow(row: NotificationRow, read: boolean): MobileNotification {
  return {
    notificationId: row.notification_id,
    target: {
      backendId: row.backend_id,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
      ...(row.remote_session_id ? { remoteSessionId: row.remote_session_id } : {}),
      taskId: row.task_id,
      sessionId: row.session_id,
    },
    sourceEventId: row.source_event_id,
    sourceKind: row.source_kind,
    ...(row.interaction_id ? { interactionId: row.interaction_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    occurredAt: row.occurred_at,
    kind: row.kind,
    title: row.title,
    recovered: row.recovered === 1,
    resolved: row.resolved === 1,
    read,
    deliveryState: row.delivery_state,
    ...(row.actions
      ? { actions: decodeNotificationActions(row.actions) }
      : {}),
  };
}

export function initializeMobileNotificationDatabase(db: { exec(sql: string): void }): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_notification (
      notification_id TEXT PRIMARY KEY,
      backend_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_identity TEXT,
      remote_session_id TEXT,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      interaction_id TEXT,
      turn_id TEXT,
      occurred_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      recovered INTEGER NOT NULL DEFAULT 0,
      resolved INTEGER NOT NULL DEFAULT 0,
      delivery_state TEXT NOT NULL DEFAULT 'recorded',
      actions TEXT,
      UNIQUE (backend_id, workspace_key, session_id, source_event_id)
    );`);
  // 第二批 E4：既有库补列。SQLite 没有ADD COLUMN IF NOT EXISTS，重复执行抛错时忽略。
  try {
    db.exec("ALTER TABLE mobile_notification ADD COLUMN actions TEXT");
  } catch {
    /* column already exists */
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS mobile_notification_feed_order
      ON mobile_notification(backend_id, occurred_at DESC, notification_id DESC);
    CREATE TABLE IF NOT EXISTS mobile_notification_read (
      backend_id TEXT NOT NULL,
      device_subject TEXT NOT NULL,
      client_instance_id TEXT NOT NULL,
      notification_id TEXT NOT NULL REFERENCES mobile_notification(notification_id) ON DELETE CASCADE,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (backend_id, device_subject, client_instance_id, notification_id)
    );
    CREATE TABLE IF NOT EXISTS mobile_notification_outbox (
      notification_id TEXT PRIMARY KEY REFERENCES mobile_notification(notification_id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_id TEXT,
      lease_owner TEXT,
      lease_until INTEGER,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
}
