import type { IMobileNotificationReader, MobileNotificationPrincipal } from "../contract.js";
import type { IMobileNotificationService } from "../internal/serviceContract.js";

/** Bind a trusted Host-attachment identity; the reader API exposes no principal parameter. */
export function bindMobileNotificationReader(
  service: IMobileNotificationService,
  principal: MobileNotificationPrincipal,
): IMobileNotificationReader {
  if (!principal.backendId || !principal.deviceSubject || !principal.clientInstanceId) {
    throw new Error("mobile notification reader requires an authenticated installation identity");
  }
  const assertInput = (input: unknown): void => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("mobile notification reader input must be an object");
    }
  };
  const requireId = (value: unknown): string => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
      throw new TypeError("notificationId must be a non-empty string");
    }
    return value;
  };
  return {
    listFeed: (input) => {
      assertInput(input);
      const before = input.before;
      if (
        before !== undefined &&
        (!before ||
          typeof before !== "object" ||
          !Number.isFinite(before.occurredAt) ||
          typeof before.notificationId !== "string" ||
          !before.notificationId.trim() ||
          before.notificationId.length > 256)
      ) {
        throw new TypeError("before must be a valid notification cursor");
      }
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
      ) {
        throw new TypeError("limit must be an integer between 1 and 50");
      }
      return service.listFeedForPrincipal({
        principal,
        ...(before !== undefined ? { before } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
    },
    getNotification: (input) => {
      assertInput(input);
      return service.getNotificationForPrincipal({
        principal,
        notificationId: requireId(input.notificationId),
      });
    },
    markRead: (input) => {
      assertInput(input);
      return service.markReadForPrincipal({
        principal,
        notificationId: requireId(input.notificationId),
      });
    },
    markAllRead: (input) => {
      assertInput(input);
      const through = input.through;
      if (
        !through ||
        typeof through !== "object" ||
        typeof through.occurredAt !== "number" ||
        !Number.isFinite(through.occurredAt)
      ) {
        throw new TypeError("through must be a valid notification cursor");
      }
      return service.markAllReadForPrincipal({
        principal,
        through: {
          occurredAt: through.occurredAt,
          notificationId: requireId(through.notificationId),
        },
      });
    },
    onFeedChanged: service.onFeedChanged,
  };
}
