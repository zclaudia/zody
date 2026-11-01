/**
 * Backend-neutral Playwright 执行端口。
 *
 * IAB adapter 把 Host 内部 sessionId 直接传给 Electron debugger；extension adapter 把
 * 同一个 sessionId 映射到 chrome.debugger targetId。Playwright 算法只依赖这里，
 * 不感知 attachment 的建立方式，也不把 CDP sessionId 暴露到扩展 wire。
 */
export interface PlaywrightPage {
  /** 发送 CDP 命令；sessionId 由 backend adapter 解释。 */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  /** 附加到子 target；返回 opaque sessionId，供后续 send 使用。 */
  attachToTarget(targetId: string): Promise<string | undefined>;
  /** 释放子 target attachment；幂等。 */
  detachFromTarget(sessionId: string): Promise<void>;
  /** 页面 URL；仅用于虚拟剪贴板的富文本启发式。读取失败返回空串。 */
  pageUrl(): string;
  platform: NodeJS.Platform;
}

export interface PlaywrightPointer {
  x: number;
  y: number;
}
