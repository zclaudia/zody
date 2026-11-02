import {
  MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY,
  type MobileNotificationActionClick,
  type MobileNotificationClick,
  type MobileNotificationPlatform,
  type MobileNotificationPushStatus,
} from "@zcode/shared";

/**
 * Android `ZodyRemoteBridge` 的通知方法面。
 *
 * 除只读会话上下文外，所有会改变原生状态的通知调用都把当前 sessionId 作为第一个参数；
 * 原生按 MobileShellController 的当前代次校验，旧 session 的 pending 点击/按钮动作、
 * ack 和订阅变更一律拒绝。页面只透传，不缓存第二份 pending 状态。
 */
type NativeNotifications = {
  notificationSyncSubscription(sessionId: string, config: string): string;
  notificationGetPendingClick(sessionId: string): string | null;
  notificationAcknowledgeClick(sessionId: string, id: string): void;
  notificationSetActiveTarget?(sessionId: string, targetKey: string | null): void;
  notificationGetStatus(sessionId: string): string;
  notificationRequestPermission(sessionId: string): void;
  notificationShow?(sessionId: string, payload: string): void;
  /** 第二批 E4：旧壳没有这三个方法；能力探测后按可选接入。 */
  notificationGetPendingAction?(sessionId: string): string | null;
  notificationAcknowledgeAction?(sessionId: string, id: string): void;
  notificationCancel?(sessionId: string, id: string): void;
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
export interface CreateMobileNotificationPlatformOptions {
  /** 当前 Remote 文档的 sessionId；原生据此拒绝 stale 调用。 */
  sessionId: string;
  /** 宿主 → 页面的权限变化订阅（已由 native host 按 sessionId 过滤）。 */
  subscribePermission?: (listener: (granted: boolean) => void) => () => void;
}

export function createMobileNotificationPlatform(
  target: unknown = globalThis,
  options: CreateMobileNotificationPlatformOptions,
): MobileNotificationPlatform | undefined {
  const native = (target as Record<string, unknown>)[
    MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY
  ] as NativeNotifications | undefined;
  const { sessionId, subscribePermission } = options;
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
      parseStatus(await native.notificationSyncSubscription(sessionId, JSON.stringify(config))),
    setActiveTarget: async (key) => {
      await native.notificationSetActiveTarget?.(sessionId, key);
    },
    getStatus: async () => parseStatus(await native.notificationGetStatus(sessionId)),
    getPendingClick: async () => {
      try {
        return parseMobileNotificationClick(
          JSON.parse((await native.notificationGetPendingClick(sessionId)) ?? "null"),
        );
      } catch {
        return null;
      }
    },
    acknowledgeClick: async (id) => {
      await native.notificationAcknowledgeClick(sessionId, id);
    },
    // 第二批 E4：只有新壳提供；方法缺失时不暴露能力（快速路径在缺省时提示升级）。
    ...(typeof native.notificationGetPendingAction === "function" &&
    typeof native.notificationAcknowledgeAction === "function"
      ? {
          getPendingAction: async (): Promise<MobileNotificationActionClick | null> => {
            try {
              return parseMobileNotificationAction(
                JSON.parse(
                  (await native.notificationGetPendingAction?.(sessionId)) ?? "null",
                ),
              );
            } catch {
              return null;
            }
          },
          acknowledgeAction: async (id) => {
            await native.notificationAcknowledgeAction?.(sessionId, id);
          },
        }
      : {}),
    ...(typeof native.notificationCancel === "function"
      ? {
          cancel: async (id) => {
            await native.notificationCancel?.(sessionId, id);
          },
        }
      : {}),
    requestPermission: async () => {
      await native.notificationRequestPermission(sessionId);
    },
    show: async (payload) => {
      await native.notificationShow?.(sessionId, JSON.stringify(payload));
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
