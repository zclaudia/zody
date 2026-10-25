import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { Event } from "@zcode/rpc";
import type {
  MobileNotification,
  MobileNotificationOutboxClaim,
  MobileNotificationPrincipal,
} from "../contract.js";
import type { IMobileNotificationService } from "../internal/serviceContract.js";
import {
  INTERACTION_TTL_MS,
  MAX_ATTEMPTS,
  MAX_ROWS,
  PAGE_MAX,
  RETENTION_MS,
  encodeNotificationActions,
  readNotificationRow,
  initializeMobileNotificationDatabase,
  type NotificationRow,
  TERMINAL_TTL_MS,
} from "../internal/database.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
export async function createMobileNotificationService(options: {
  databasePath: string;
  createId?: () => string;
  now?: () => number;
  dataVersionPollMs?: number;
}): Promise<IMobileNotificationService> {
  await mkdir(dirname(options.databasePath), { recursive: true });
  const db = new DatabaseSync(options.databasePath);
  initializeMobileNotificationDatabase(db);

  const changed = new Emitter<void>();
  // PRAGMA data_version reports commits made through other SQLite connections, so
  // each window Host can refresh its own phone feed without treating DB state as task state.
  let observedDataVersion = Number(
    (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
  );
  const pollMs = Math.max(5, options.dataVersionPollMs ?? 1_000);
  const dataVersionTimer = setInterval(() => {
    try {
      const version = Number(
        (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
      );
      if (version !== observedDataVersion) {
        observedDataVersion = version;
        changed.fire();
      }
    } catch {
      // A disposed/closing connection must not produce an unhandled timer error.
    }
  }, pollMs);
  dataVersionTimer.unref?.();
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  const selectRow = db.prepare("SELECT * FROM mobile_notification WHERE notification_id = ?");

  const getRead = (principal: MobileNotificationPrincipal, notificationId: string): boolean =>
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM mobile_notification_read WHERE backend_id = ? AND device_subject = ? AND client_instance_id = ? AND notification_id = ?`,
        )
        .get(
          principal.backendId,
          principal.deviceSubject,
          principal.clientInstanceId,
          notificationId,
        ),
    );

  const toNotification = (
    notificationId: string,
    principal?: MobileNotificationPrincipal,
  ): MobileNotification | null => {
    const row = selectRow.get(notificationId) as NotificationRow | undefined;
    return row
      ? readNotificationRow(row, principal ? getRead(principal, notificationId) : false)
      : null;
  };

  const prune = (at: number): void => {
    db.prepare("DELETE FROM mobile_notification WHERE occurred_at < ?").run(at - RETENTION_MS);
    db.prepare(`DELETE FROM mobile_notification WHERE notification_id IN (
      SELECT notification_id FROM (
        SELECT notification_id, ROW_NUMBER() OVER (PARTITION BY backend_id ORDER BY occurred_at DESC, notification_id DESC) AS rank
        FROM mobile_notification
      ) WHERE rank > ?
    )`).run(MAX_ROWS);
  };

  const service: IMobileNotificationService = {
    async record(input) {
      if (
        input.target.workspaceKey !==
        (input.target.workspaceIdentity?.trim() || input.target.workspacePath)
      ) {
        throw new Error("workspaceKey must follow workspace identity fallback");
      }
      if (!input.sourceEventId.trim() || !input.target.sessionId.trim())
        throw new Error("notification source identifiers are required");
      const notificationId = createId();
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted = db
          .prepare(`INSERT INTO mobile_notification (
          notification_id, backend_id, workspace_key, workspace_path, workspace_identity, remote_session_id,
          task_id, session_id, source_event_id, source_kind, interaction_id, turn_id, occurred_at, kind, title, recovered, actions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(backend_id, workspace_key, session_id, source_event_id) DO NOTHING`)
          .run(
            notificationId,
            input.target.backendId,
            input.target.workspaceKey,
            input.target.workspacePath,
            input.target.workspaceIdentity ?? null,
            input.target.remoteSessionId ?? null,
            input.target.taskId,
            input.target.sessionId,
            input.sourceEventId,
            input.sourceKind,
            input.interactionId ?? null,
            input.turnId ?? null,
            input.occurredAt,
            input.kind,
            input.title,
            input.recovered ? 1 : 0,
            encodeNotificationActions(input.actions),
          );
        const row = db
          .prepare(`SELECT notification_id, delivery_state FROM mobile_notification
          WHERE backend_id = ? AND workspace_key = ? AND session_id = ? AND source_event_id = ?`)
          .get(
            input.target.backendId,
            input.target.workspaceKey,
            input.target.sessionId,
            input.sourceEventId,
          ) as { notification_id: string; delivery_state: string } | undefined;
        if (!row) throw new Error("notification insert did not produce a row");
        if (Number(inserted.changes) === 1 && !input.recovered) {
          db.prepare(
            "INSERT INTO mobile_notification_outbox(notification_id, next_attempt_at) VALUES (?, ?)",
          ).run(notificationId, input.occurredAt);
        }
        prune(now());
        db.exec("COMMIT");
        changed.fire();
        const notification = toNotification(row.notification_id);
        if (!notification) throw new Error("notification row disappeared during insert");
        return notification;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* Preserve the operation error. */
        }
        throw error;
      }
    },
    async resolveInteraction(input) {
      const result = db
        .prepare(
          `UPDATE mobile_notification SET resolved = 1 WHERE backend_id = ? AND workspace_key = ? AND session_id = ? AND interaction_id = ? AND resolved = 0`,
        )
        .run(input.backendId, input.workspaceKey, input.sessionId, input.interactionId);
      if (Number(result.changes) > 0) changed.fire();
    },
    async listFeedForPrincipal(input) {
      // 读取也推进保留期清理，避免长期静默的 backend 把过期记录留在库中。
      prune(now());
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > PAGE_MAX)
      ) {
        throw new TypeError(`limit must be an integer between 1 and ${PAGE_MAX}`);
      }
      if (
        input.before &&
        (!Number.isFinite(input.before.occurredAt) ||
          typeof input.before.notificationId !== "string" ||
          !input.before.notificationId.trim() ||
          input.before.notificationId.length > 256)
      ) {
        throw new TypeError("before must be a valid notification cursor");
      }
      const limit = input.limit ?? PAGE_MAX;
      const rows = (
        input.before
          ? db
              .prepare(`SELECT n.*, EXISTS(SELECT 1 FROM mobile_notification_read r WHERE r.backend_id = n.backend_id AND r.device_subject = ? AND r.client_instance_id = ? AND r.notification_id = n.notification_id) AS is_read
            FROM mobile_notification n WHERE n.backend_id = ? AND (n.occurred_at < ? OR (n.occurred_at = ? AND n.notification_id < ?))
            ORDER BY n.occurred_at DESC, n.notification_id DESC LIMIT ?`)
              .all(
                input.principal.deviceSubject,
                input.principal.clientInstanceId,
                input.principal.backendId,
                input.before.occurredAt,
                input.before.occurredAt,
                input.before.notificationId,
                limit + 1,
              )
          : db
              .prepare(`SELECT n.*, EXISTS(SELECT 1 FROM mobile_notification_read r WHERE r.backend_id = n.backend_id AND r.device_subject = ? AND r.client_instance_id = ? AND r.notification_id = n.notification_id) AS is_read
            FROM mobile_notification n WHERE n.backend_id = ? ORDER BY n.occurred_at DESC, n.notification_id DESC LIMIT ?`)
              .all(
                input.principal.deviceSubject,
                input.principal.clientInstanceId,
                input.principal.backendId,
                limit + 1,
              )
      ) as (NotificationRow & { is_read: number })[];
      const unreadCount = Number(
        (
          db
            .prepare(`SELECT COUNT(*) AS count FROM mobile_notification n WHERE n.backend_id = ? AND NOT EXISTS (
        SELECT 1 FROM mobile_notification_read r WHERE r.backend_id = n.backend_id AND r.device_subject = ? AND r.client_instance_id = ? AND r.notification_id = n.notification_id
      )`)
            .get(
              input.principal.backendId,
              input.principal.deviceSubject,
              input.principal.clientInstanceId,
            ) as { count: number }
        ).count,
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => readNotificationRow(row, row.is_read === 1));
      const last = items.at(-1);
      return {
        items,
        ...(hasMore && last
          ? { nextCursor: { occurredAt: last.occurredAt, notificationId: last.notificationId } }
          : {}),
        unreadCount,
      };
    },
    async getNotificationForPrincipal(input) {
      // 点击引用可能是进程恢复后的首次访问；先统一清理过期行及其关联状态。
      prune(now());
      const row = db
        .prepare("SELECT * FROM mobile_notification WHERE notification_id = ? AND backend_id = ?")
        .get(input.notificationId, input.principal.backendId) as NotificationRow | undefined;
      if (!row) return null;
      const ttl =
        row.kind === "permission" || row.kind === "question" ? INTERACTION_TTL_MS : TERMINAL_TTL_MS;
      if (row.occurred_at + ttl <= now()) return null;
      return readNotificationRow(row, getRead(input.principal, input.notificationId));
    },
    async markReadForPrincipal(input) {
      db.prepare(`INSERT INTO mobile_notification_read(backend_id, device_subject, client_instance_id, notification_id, read_at)
        SELECT n.backend_id, ?, ?, n.notification_id, ? FROM mobile_notification n WHERE n.notification_id = ? AND n.backend_id = ?
        ON CONFLICT(backend_id, device_subject, client_instance_id, notification_id) DO NOTHING`).run(
        input.principal.deviceSubject,
        input.principal.clientInstanceId,
        now(),
        input.notificationId,
        input.principal.backendId,
      );
      changed.fire();
    },
    async markAllReadForPrincipal(input) {
      db.prepare(`INSERT INTO mobile_notification_read(backend_id, device_subject, client_instance_id, notification_id, read_at)
        SELECT n.backend_id, ?, ?, n.notification_id, ? FROM mobile_notification n WHERE n.backend_id = ? AND
          (n.occurred_at < ? OR (n.occurred_at = ? AND n.notification_id <= ?))
        ON CONFLICT(backend_id, device_subject, client_instance_id, notification_id) DO NOTHING`).run(
        input.principal.deviceSubject,
        input.principal.clientInstanceId,
        now(),
        input.principal.backendId,
        input.through.occurredAt,
        input.through.occurredAt,
        input.through.notificationId,
      );
      changed.fire();
    },
    async claimOutbox(input): Promise<MobileNotificationOutboxClaim | null> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(`SELECT o.notification_id, o.attempts, o.fencing_token, n.occurred_at
          FROM mobile_notification_outbox o JOIN mobile_notification n USING(notification_id)
          WHERE o.state IN ('pending', 'claimed') AND o.attempts < ? AND o.next_attempt_at <= ?
            AND (o.lease_until IS NULL OR o.lease_until <= ?)
            AND n.backend_id = ?
            AND ((n.kind IN ('permission', 'question') AND n.occurred_at >= ?) OR
              (n.kind IN ('completed', 'failed') AND n.occurred_at >= ?))
            AND (n.kind NOT IN ('permission', 'question') OR n.resolved = 0)
          ORDER BY o.next_attempt_at ASC, n.occurred_at ASC LIMIT 1`)
          .get(
            MAX_ATTEMPTS,
            input.now,
            input.now,
            input.backendId,
            input.now - INTERACTION_TTL_MS,
            input.now - TERMINAL_TTL_MS,
          ) as { notification_id: string; attempts: number; fencing_token: number } | undefined;
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        const leaseId = createId();
        const fencingToken = Number(row.fencing_token) + 1;
        const leaseUntil = input.now + input.leaseMs;
        db.prepare(
          `UPDATE mobile_notification_outbox SET state = 'claimed', attempts = attempts + 1, lease_id = ?, lease_owner = ?, lease_until = ?, fencing_token = ? WHERE notification_id = ?`,
        ).run(leaseId, input.workerId, leaseUntil, fencingToken, row.notification_id);
        const notification = toNotification(row.notification_id);
        if (!notification) throw new Error("claimed notification missing");
        db.exec("COMMIT");
        return {
          notification,
          leaseId,
          fencingToken,
          attempt: Number(row.attempts) + 1,
          leaseUntil,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* Preserve the operation error. */
        }
        throw error;
      }
    },
    async acknowledgeOutbox(input) {
      const result = db
        .prepare(`UPDATE mobile_notification_outbox SET state = 'accepted', lease_id = NULL, lease_owner = NULL, lease_until = NULL
        WHERE notification_id = ? AND state = 'claimed' AND lease_id = ? AND fencing_token = ?`)
        .run(input.notificationId, input.leaseId, input.fencingToken);
      if (Number(result.changes) === 1) {
        db.prepare(
          "UPDATE mobile_notification SET delivery_state = 'accepted' WHERE notification_id = ?",
        ).run(input.notificationId);
        changed.fire();
        return true;
      }
      return false;
    },
    async failOutbox(input) {
      const row = db
        .prepare(
          `SELECT attempts FROM mobile_notification_outbox WHERE notification_id = ? AND state = 'claimed' AND lease_id = ? AND fencing_token = ?`,
        )
        .get(input.notificationId, input.leaseId, input.fencingToken) as
        | { attempts: number }
        | undefined;
      if (!row) return false;
      const terminal = !input.retryable || row.attempts >= MAX_ATTEMPTS;
      const backoff = Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.max(0, row.attempts - 1));
      db.prepare(`UPDATE mobile_notification_outbox SET state = ?, next_attempt_at = ?, lease_id = NULL, lease_owner = NULL, lease_until = NULL
        WHERE notification_id = ? AND fencing_token = ?`).run(
        terminal ? "failed" : "pending",
        input.failedAt + backoff,
        input.notificationId,
        input.fencingToken,
      );
      db.prepare("UPDATE mobile_notification SET delivery_state = ? WHERE notification_id = ?").run(
        terminal ? "failed" : "submitted",
        input.notificationId,
      );
      changed.fire();
      return true;
    },
    onFeedChanged: changed.event as Event<void>,
    dispose() {
      clearInterval(dataVersionTimer);
      changed.dispose();
      db.close();
    },
  };
  return service;
}
