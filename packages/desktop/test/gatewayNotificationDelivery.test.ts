import { describe, expect, it, vi } from "vitest";
import { requestGatewayNotification } from "../src/main/remote-access/gatewayNotificationDelivery.js";

describe("gateway push receipt", () => {
  const event = { name: "zody.turn.completed", title: "Task update", body: "Open Zody to view." };
  it("correlates receipts and removes listener after acceptance", async () => {
    let callback: (message: Record<string, unknown>) => void = () => {};
    const off = vi.fn();
    const sdk = {
      onMessage: (fn: typeof callback) => {
        callback = fn;
        return off;
      },
      send: (message: Record<string, unknown>) => {
        callback({
          type: "push_notification_result",
          version: 1,
          requestId: "stale",
          status: "terminal",
        });
        callback({
          type: "push_notification_result",
          version: 1,
          requestId: message.requestId,
          status: "accepted",
        });
      },
    };
    expect(await requestGatewayNotification(sdk, event)).toEqual({ status: "accepted" });
    expect(off).toHaveBeenCalledOnce();
  });
  it("does not call a timeout delivered and reports old gateway as unsupported", async () => {
    vi.useFakeTimers();
    const off = vi.fn();
    const promise = requestGatewayNotification({ onMessage: () => off, send: () => {} }, event, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toEqual({ status: "retryable", code: "receipt-timeout" });
    expect(off).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("reports an SDK without send as terminal unsupported-sdk (MN11)", async () => {
    await expect(
      requestGatewayNotification({ onMessage: () => () => {} }, event),
    ).resolves.toEqual({ status: "terminal", code: "unsupported-sdk" });
  });
});
