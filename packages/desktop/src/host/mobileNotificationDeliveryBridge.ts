import { createHash, randomUUID } from "node:crypto";
import {
  mobileNotificationContextSchema,
  mobileNotificationResultSchema,
  type MobileNotificationPublish,
  type MobileNotificationReceipt,
} from "@zcode/shared";
import type { IMobileNotificationService } from "@zcode/services/mobile-notifications/node";

/** A Host outbox worker. Main only transports a request and its HTTP receipt. */
export function createMobileNotificationDeliveryBridge(options: {
  service: Pick<
    IMobileNotificationService,
    "claimOutbox" | "acknowledgeOutbox" | "failOutbox" | "onFeedChanged"
  >;
  send(message: MobileNotificationPublish): void;
  now?: () => number;
  onError?: (error: unknown) => void;
}) {
  const now = options.now ?? Date.now;
  const workerId = randomUUID();
  const listeners = new Set<() => void>();
  let backendId: string | undefined;
  let running = false;
  let disposed = false;
  let pending: { id: string; resolve: (receipt: MobileNotificationReceipt) => void } | undefined;
  const deliver = (message: MobileNotificationPublish) =>
    new Promise<MobileNotificationReceipt>((resolve) => {
      const timer = setTimeout(
        () => done({ status: "retryable", code: "transport-timeout" }),
        20_000,
      );
      const done = (receipt: MobileNotificationReceipt) => {
        clearTimeout(timer);
        pending = undefined;
        resolve(receipt);
      };
      pending = { id: message.requestId, resolve: done };
      try {
        options.send(message);
      } catch {
        done({ status: "retryable", code: "transport-error" });
      }
    });
  async function drain() {
    if (running || disposed || !backendId) return;
    running = true;
    try {
      for (;;) {
        if (disposed || !backendId) return;
        const claim = await options.service.claimOutbox({
          workerId,
          backendId,
          now: now(),
          leaseMs: 60_000,
        });
        if (!claim) return;
        const notification = claim.notification;
        const fence = {
          notificationId: notification.notificationId,
          leaseId: claim.leaseId,
          fencingToken: claim.fencingToken,
        };
        if (notification.target.backendId !== backendId) {
          // backend 在 claim 等待期间切换时保留原 outbox，不能把暂时不活跃的电脑通知永久丢弃。
          await options.service.failOutbox({ ...fence, failedAt: now(), retryable: true });
          continue;
        }
        const expiresAt =
          notification.occurredAt +
          (notification.kind === "permission" || notification.kind === "question"
            ? 3_600_000
            : 86_400_000);
        const targetKey = createHash("sha256")
          .update(
            JSON.stringify([
              backendId,
              notification.target.workspaceKey,
              notification.target.taskId,
            ]),
          )
          .digest("hex");
        const payload = {
          version: 1,
          targetKey,
          backendId,
          notificationId: notification.notificationId,
          kind: notification.kind,
          expiresAt,
          // 第二批 E4：仅 permission 通知携带脱敏按钮（feed 记录固化，非投递时实时取）；
          // 其他 kind 即使意外带 actions 也不透传，与 Android 端只渲染 permission 按钮一致。
          ...(notification.kind === "permission" && notification.actions?.length
            ? { actions: notification.actions }
            : {}),
        };
        const clickUrl = `zody://notification/v1?backendId=${encodeURIComponent(backendId)}&notificationId=${encodeURIComponent(notification.notificationId)}`;
        const receipt = await deliver({
          type: "mobile-notification-publish",
          requestId: randomUUID(),
          backendId,
          event: {
            name: `zody.task.${notification.kind}`,
            title: "Zody",
            body: JSON.stringify(payload),
            clickUrl,
          },
        });
        if (disposed) return;
        if (receipt.status === "accepted")
          await options.service.acknowledgeOutbox({ ...fence, acceptedAt: now() });
        else
          await options.service.failOutbox({
            ...fence,
            failedAt: now(),
            retryable: receipt.status === "retryable",
          });
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  }
  const subscription = options.service.onFeedChanged(() => {
    void drain();
  });
  // Retry deadlines live in SQLite. This timer only wakes eligible claims; it does not infer task state.
  const retryTimer = setInterval(() => {
    void drain();
  }, 5_000);
  retryTimer.unref?.();
  return {
    getBackendId: () => backendId,
    onContextChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    accept(message: unknown): boolean {
      const context = mobileNotificationContextSchema.safeParse(message);
      if (context.success) {
        const next = context.data.enabled ? context.data.backendId : undefined;
        const changed = next !== backendId;
        backendId = next;
        if (changed) {
          pending?.resolve({ status: "retryable", code: "context-changed" });
          for (const listener of listeners) listener();
        }
        void drain();
        return true;
      }
      const result = mobileNotificationResultSchema.safeParse(message);
      if (!result.success) return false;
      if (pending?.id === result.data.requestId) pending.resolve(result.data.receipt);
      return true;
    },
    dispose() {
      disposed = true;
      pending?.resolve({ status: "retryable", code: "disposed" });
      clearInterval(retryTimer);
      subscription.dispose();
      listeners.clear();
    },
  };
}
