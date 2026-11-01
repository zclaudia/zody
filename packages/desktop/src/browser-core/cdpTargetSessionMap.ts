import { randomUUID } from "node:crypto";

/**
 * Host 内部的 CDP sessionId ↔ chrome.debugger 子 targetId 映射。
 *
 * - 扩展 wire 永远只携带 targetId；sessionId 只在 Host 进程内使用。
 * - 同一个 (attachmentId, targetId) 复用稳定 sessionId，跨请求不漂移。
 * - target detach 或 attachment 失效时只删除对应条目；迟到事件不能命中新 target。
 */
export class CdpTargetSessionMap {
  private readonly sessionByTarget = new Map<string, string>();
  private readonly targetBySession = new Map<string, string>();

  constructor(private readonly createSessionId: () => string = () => `extcdp:${randomUUID()}`) {}

  /** 为子 target 分配或复用 Host sessionId。 */
  resolveSessionId(attachmentId: string, targetId: string): string {
    const key = this.key(attachmentId, targetId);
    const existing = this.sessionByTarget.get(key);
    if (existing) return existing;
    const sessionId = this.createSessionId();
    this.sessionByTarget.set(key, sessionId);
    this.targetBySession.set(sessionId, targetId);
    return sessionId;
  }

  /** 命令路径：Host sessionId → 扩展 wire 的 targetId。 */
  resolveTargetId(sessionId: string, attachmentId?: string): string | undefined {
    const targetId = this.targetBySession.get(sessionId);
    if (targetId === undefined) return undefined;
    if (attachmentId && this.sessionByTarget.get(this.key(attachmentId, targetId)) === undefined) {
      return undefined;
    }
    return targetId;
  }

  /** 子 target detach 只清理自己的映射，不影响 attachment/主页面。 */
  removeTarget(attachmentId: string, targetId: string): void {
    const key = this.key(attachmentId, targetId);
    const sessionId = this.sessionByTarget.get(key);
    if (!sessionId) return;
    this.sessionByTarget.delete(key);
    this.targetBySession.delete(sessionId);
  }

  /** attachment 失效时清理它名下的全部子 target。 */
  removeAttachment(attachmentId: string): void {
    for (const [key, sessionId] of this.sessionByTarget) {
      if (!key.startsWith(`${attachmentId}\u0000`)) continue;
      this.sessionByTarget.delete(key);
      this.targetBySession.delete(sessionId);
    }
  }

  get size(): number {
    return this.sessionByTarget.size;
  }

  private key(attachmentId: string, targetId: string): string {
    return `${attachmentId}\u0000${targetId}`;
  }
}
