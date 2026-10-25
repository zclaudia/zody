import type {
  MobileNotificationActionClick,
  MobileNotificationClick,
  MobileNotificationPlatform,
  MobileNotificationPushStatus,
} from "@zcode/shared";

type NativeNotifications = {
  notificationSyncSubscription(config: string): string;
  notificationGetPendingClick(): string | null;
  notificationAcknowledgeClick(id: string): void;
  notificationSetActiveTarget?(targetKey: string | null): void;
  notificationGetStatus(): string;
  notificationRequestPermission(): void;
  notificationShow?(payload: string): void;
  /** 第二批 E4：旧壳没有这三个方法；能力探测后按可选接入。 */
  notificationGetPendingAction?(): string | null;
  notificationAcknowledgeAction?(id: string): void;
  notificationCancel?(id: string): void;
};
function parseStatus(raw: string): MobileNotificationPushStatus {
  try {
    const result = JSON.parse(raw);
    if (["ready", "unavailable", "permission-denied", "error", "disabled"].includes(result?.status))
      return { status: result.status };
  } catch {
    /* Native failures must become explicit capability state. */
  }
  return { status: "error" };
}
export function parseMobileNotificationClick(value: unknown): MobileNotificationClick | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const validId = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 256;
  return validId(input.backendId) && validId(input.notificationId)
    ? { backendId: input.backendId, notificationId: input.notificationId }
    : null;
}

/** 第二批 E4：通知按钮点击解析；optionId 与其它 id 同样按 opaque id 边界校验。 */
export function parseMobileNotificationAction(
  value: unknown,
): MobileNotificationActionClick | null {
  const click = parseMobileNotificationClick(value);
  if (!click) return null;
  const input = value as Record<string, unknown>;
  const validId = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 256;
  if (!validId(input.optionId)) return null;
  const optionKind = input.optionKind;
  if (optionKind !== "allowOnce" && optionKind !== "allowAlways" && optionKind !== "deny") {
    return null;
  }
  return { ...click, optionId: input.optionId, optionKind };
}
export function createMobileNotificationPlatform(
  target: unknown = globalThis,
  subscribePermission?: (listener: (granted: boolean) => void) => () => void,
): MobileNotificationPlatform | undefined {
  const native = (target as { ZcodeMobileBridge?: NativeNotifications })?.ZcodeMobileBridge;
  if (
    !native ||
    typeof native.notificationSyncSubscription !== "function" ||
    typeof native.notificationGetPendingClick !== "function"
  )
    return undefined;
  return {
    ...(subscribePermission
      ? { onStatusChanged: (listener: () => void) => subscribePermission(() => listener()) }
      : {}),
    syncSubscription: async (config) =>
      parseStatus(await native.notificationSyncSubscription(JSON.stringify(config))),
    setActiveTarget: async (key) => {
      await native.notificationSetActiveTarget?.(key);
    },
    getStatus: async () => parseStatus(await native.notificationGetStatus()),
    getPendingClick: async () => {
      try {
        return parseMobileNotificationClick(
          JSON.parse((await native.notificationGetPendingClick()) ?? "null"),
        );
      } catch {
        return null;
      }
    },
    acknowledgeClick: async (id) => {
      await native.notificationAcknowledgeClick(id);
    },
    // 第二批 E4：只有新壳提供；方法缺失时不暴露能力（快速路径在缺省时提示升级）。
    ...(typeof native.notificationGetPendingAction === "function" &&
    typeof native.notificationAcknowledgeAction === "function"
      ? {
          getPendingAction: async (): Promise<MobileNotificationActionClick | null> => {
            try {
              return parseMobileNotificationAction(
                JSON.parse((await native.notificationGetPendingAction?.()) ?? "null"),
              );
            } catch {
              return null;
            }
          },
          acknowledgeAction: async (id) => {
            await native.notificationAcknowledgeAction?.(id);
          },
        }
      : {}),
    ...(typeof native.notificationCancel === "function"
      ? {
          cancel: async (id) => {
            await native.notificationCancel?.(id);
          },
        }
      : {}),
    requestPermission: async () => {
      await native.notificationRequestPermission();
    },
    show: async (payload) => {
      await native.notificationShow?.(JSON.stringify(payload));
    },
  };
}

export async function syncGatewayNotificationSubscription(options: {
  gatewayUrl: string;
  backendId: string;
  credential: string;
  platform: MobileNotificationPlatform;
  fetcher?: typeof fetch;
  isCurrent?: () => boolean;
}): Promise<MobileNotificationPushStatus> {
  const base = options.gatewayUrl
    .replace(/\/$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");
  const response = await (options.fetcher ?? fetch)(
    `${base}/api/notifications/subscription/${encodeURIComponent(options.backendId)}`,
    {
      headers: { Authorization: `Bearer ${options.credential}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  // 切换电脑后旧请求仍可能返回，不能用旧配置或旧鉴权失败修改新订阅。
  if (options.isCurrent && !options.isCurrent()) return { status: "unavailable" };
  if (!response.ok) {
    // 认证失败或当前 backend 已不在 scope 时，只清理本请求对应的 backend；
    // `isCurrent` 已在上方校验，迟到的旧 backend 响应不能触碰新订阅。
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      await options.platform.syncSubscription({
        enabled: false,
        backendId: options.backendId,
        ntfyUrl: base,
        topic: `push-${options.backendId}`,
        authToken: "",
      });
    }
    return { status: response.status === 404 ? "unavailable" : "error" };
  }
  const result = await response.json();
  if (options.isCurrent && !options.isCurrent()) return { status: "unavailable" };
  const dto = result?.data;
  if (
    !result?.success ||
    dto?.version !== 1 ||
    dto.transportBasePath !== "" ||
    dto.topic !== `push-${options.backendId}` ||
    dto.authMode !== "bearer" ||
    typeof dto.enabled !== "boolean"
  )
    return { status: "unavailable" };
  return options.platform.syncSubscription({
    enabled: dto.enabled,
    backendId: options.backendId,
    ntfyUrl: base,
    topic: dto.topic,
    authToken: options.credential,
  });
}

/** Remove only the active backend subscription after an auth-terminal failure. */
export async function disableGatewayNotificationSubscription(options: {
  gatewayUrl: string;
  backendId: string;
  platform: MobileNotificationPlatform;
}): Promise<MobileNotificationPushStatus> {
  const base = options.gatewayUrl
    .replace(/\/$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");
  return options.platform.syncSubscription({
    enabled: false,
    backendId: options.backendId,
    ntfyUrl: base,
    topic: `push-${options.backendId}`,
    authToken: "",
  });
}

/** Matches Host SHA-256; carries no workspace path through the notification transport. */
export async function mobileNotificationTargetKey(
  backendId: string,
  workspaceKey: string,
  taskId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([backendId, workspaceKey, taskId]));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sendGatewayTestNotification(options: {
  gatewayUrl: string;
  backendId: string;
  credential: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  const base = options.gatewayUrl
    .replace(/\/$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");
  const response = await (options.fetcher ?? fetch)(
    `${base}/api/notifications/test/${encodeURIComponent(options.backendId)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${options.credential}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error("notification-test-unavailable");
  const result = await response.json();
  if (!result?.success || result.data?.status !== "accepted")
    throw new Error("notification-test-not-accepted");
}
