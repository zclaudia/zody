import type { GatewayPushNotificationEvent } from "@zclaudia/gateway-protocol/notifications";

export type GatewayNotificationReceipt = {
  status: "accepted" | "filtered" | "retryable" | "terminal";
  code?: string;
};
export function requestGatewayNotification(
  sdk: {
    send?(message: Record<string, unknown>): void;
    onMessage(handler: (message: Record<string, unknown>) => void): () => void;
  },
  event: GatewayPushNotificationEvent,
  timeoutMs = 15_000,
): Promise<GatewayNotificationReceipt> {
  if (!sdk.send) return Promise.resolve({ status: "terminal", code: "unsupported-sdk" });
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let off = () => {};
    const finish = (result: GatewayNotificationReceipt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ status: "retryable", code: "receipt-timeout" }),
      timeoutMs,
    );
    off = sdk.onMessage((message) => {
      if (
        message.type !== "push_notification_result" ||
        message.version !== 1 ||
        message.requestId !== requestId
      )
        return;
      const status = message.status;
      if (
        status !== "accepted" &&
        status !== "filtered" &&
        status !== "retryable" &&
        status !== "terminal"
      )
        return;
      finish({ status, ...(typeof message.code === "string" ? { code: message.code } : {}) });
    });
    try {
      sdk.send!({ type: "push_notification_request", requestId, event });
    } catch {
      finish({ status: "retryable", code: "disconnected" });
    }
  });
}
