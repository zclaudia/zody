import type { RevokedProjection } from "./cua-submission-types.js";

/**
 * runtime scope 只订阅 owner 撤销事实。通知必须在 authority 提交撤销后同步发生，
 * 单个观察者异常不能阻断其它观察者，也不能回滚已提交的撤销。
 */
export class CuaSubmissionRevocationHub {
  readonly #listeners = new Set<(projection: RevokedProjection) => void>();

  subscribe(listener: (projection: RevokedProjection) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  notify(projection: RevokedProjection): void {
    const listeners = Array.from(this.#listeners);
    for (const listener of listeners) {
      try {
        listener(projection);
      } catch {
        // 失效事实已经提交，观察者异常不得回滚或阻断撤销传播。
      }
    }
  }
}
