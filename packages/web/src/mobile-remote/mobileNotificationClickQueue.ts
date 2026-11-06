import type { MobileNotificationActionClick, MobileNotificationClick } from "@zody/shared";

/** 同一个 pending 意图只执行一次；成功后保留最近的 key，避免队列无限增长。 */
const MAX_COMPLETED_INTENTS = 64;

/**
 * Keep the newest intent while a bridge is being replaced; never drop a native intent on busy.
 *
 * At-most-once 说明：同一 notificationId（按钮动作再加入 optionId/optionKind）可能从两条路径
 * 到达页面——Remote ready 时 Android 派发的内存队列事件，以及页面读取的 durable pending 槽。
 * 两条路径都成功后才写 ack；因此页面必须按意图 key 去重，否则快速双击或恢复重读会重复执行
 * 权限决策。失败不记入 completed，显式重试和恢复重读仍然允许。
 */
function createMobileNotificationSerialQueue<T>(options: {
  readPending(): Promise<T | null | undefined>;
  open(intent: T): Promise<void>;
  onError(error: unknown, intent: T): void;
  /** Stable at-most-once key; omit to preserve the legacy serialize-only behavior. */
  identity?: (intent: T) => string;
}) {
  let queued: T | null | undefined;
  let running: Promise<void> | undefined;
  let disposed = false;
  let inFlightKey: string | undefined;
  const completedKeys = new Set<string>();
  function rememberCompleted(key: string): void {
    completedKeys.add(key);
    if (completedKeys.size > MAX_COMPLETED_INTENTS) {
      const oldest = completedKeys.values().next().value;
      if (oldest !== undefined) completedKeys.delete(oldest);
    }
  }
  async function drain() {
    while (!disposed && queued !== undefined) {
      const next = queued;
      queued = undefined;
      const intent = next ?? (await options.readPending());
      if (!intent || disposed) continue;
      const key = options.identity?.(intent);
      // 同一条意图仍在执行或已成功：不再打开。失败不在 completed 中，允许正常重试。
      if (key !== undefined && (key === inFlightKey || completedKeys.has(key))) continue;
      inFlightKey = key;
      try {
        await options.open(intent);
        if (key !== undefined) rememberCompleted(key);
      } catch (error) {
        if (!disposed) options.onError(error, intent);
      } finally {
        if (key !== undefined && inFlightKey === key) inFlightKey = undefined;
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
  return createMobileNotificationSerialQueue({
    ...options,
    identity: (click) => `${click.backendId}\u0000${click.notificationId}`,
  });
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
  return createMobileNotificationSerialQueue({
    ...options,
    // 同一通知的不同 optionId/optionKind 是两个用户决策，不能互相吞掉；完全相同的动作只提交一次。
    identity: (action) =>
      `${action.backendId}\u0000${action.notificationId}\u0000${action.optionId}\u0000${action.optionKind}`,
  });
}
