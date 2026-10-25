import type { MobileNotificationActionClick, MobileNotificationClick } from "@zcode/shared";

/** Keep the newest intent while a bridge is being replaced; never drop a native intent on busy. */
function createMobileNotificationSerialQueue<T>(options: {
  readPending(): Promise<T | null | undefined>;
  open(intent: T): Promise<void>;
  onError(error: unknown, intent: T): void;
}) {
  let queued: T | null | undefined;
  let running: Promise<void> | undefined;
  let disposed = false;
  async function drain() {
    while (!disposed && queued !== undefined) {
      const next = queued;
      queued = undefined;
      const intent = next ?? (await options.readPending());
      if (!intent || disposed) continue;
      try {
        await options.open(intent);
      } catch (error) {
        if (!disposed) options.onError(error, intent);
      }
    }
  }
  function enqueue(intent?: T): Promise<void> {
    if (disposed) return Promise.resolve();
    queued = intent ?? null;
    running ??= drain().finally(() => {
      running = undefined;
    });
    return running;
  }
  return {
    enqueue,
    /** Re-read the durable native slot after a successful connection recovery. */
    retryPending: () => enqueue(),
    dispose() {
      disposed = true;
      queued = undefined;
    },
  };
}

export function createMobileNotificationClickQueue(options: {
  readPending(): Promise<MobileNotificationClick | null | undefined>;
  open(click: MobileNotificationClick): Promise<void>;
  onError(error: unknown, click: MobileNotificationClick): void;
}) {
  return createMobileNotificationSerialQueue(options);
}

/**
 * 第二批 E4：通知按钮的串行队列。与 click 队列同一实现（at-most-once 消费、
 * 冷启动 retryPending），intent 换成 {backendId, notificationId, optionId}。
 */
export function createMobileNotificationActionQueue(options: {
  readPending(): Promise<MobileNotificationActionClick | null | undefined>;
  open(action: MobileNotificationActionClick): Promise<void>;
  onError(error: unknown, action: MobileNotificationActionClick): void;
}) {
  return createMobileNotificationSerialQueue(options);
}
