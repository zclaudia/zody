/**
 * Backend-neutral CDP transport contract.
 *
 * 该文件不依赖 Electron。IAB adapter 把 Host 内部 sessionId 传给 Electron debugger；
 * extension adapter 只把 nativeTabId / targetId 放到扩展 wire 上。调用方不应关心底层
 * attachment 的建立方式。
 */

/** 一次 CDP 命令的目标：attachment 是 Host 的权威绑定，targetId 表示子 target。 */
export interface BrowserCdpTarget {
  attachmentId: string;
  nativeTabId: number;
  /** chrome.debugger 子 target；缺省表示主页面。 */
  targetId?: string;
}

export interface BrowserCdpEvent {
  attachmentId: string;
  nativeTabId: number;
  targetId?: string;
  method: string;
  params: Record<string, unknown>;
}

export interface BrowserCdpTransport {
  /** 发送命令；params 必须是可 JSON 序列化对象。 */
  send(method: string, params: Record<string, unknown>, target: BrowserCdpTarget): Promise<unknown>;
  /** 订阅所有 attachment 的事件；返回取消订阅函数。 */
  subscribe(listener: (event: BrowserCdpEvent) => void): () => void;
}

/** 供 executor 使用的窄接口，便于测试注入不依赖网络/扩展。 */
export interface BrowserCdpExecutor {
  send(method: string, params?: Record<string, unknown>, targetId?: string): Promise<unknown>;
}
