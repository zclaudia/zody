import { randomUUID } from "node:crypto";
import type {
  ExtensionBridgeClientMessage,
  ExtensionCdpResultMessage,
  ExtensionTargetRef,
} from "@zcode/shared/browser-extension-transport";
import type { BrowserCdpEvent, BrowserCdpTarget, BrowserCdpTransport } from "./cdpTransport.js";

export interface ExtensionCdpRequestPort {
  request(message: {
    type: "cdp.request";
    requestId: string;
    targetRef: ExtensionTargetRef;
    method: string;
    params: Record<string, unknown>;
    targetId?: string;
  }): Promise<ExtensionBridgeClientMessage>;
  /** Host 命令取消：通知扩展尽力终止 evaluate/callFunctionOn。 */
  cancel?(requestId: string, profileInstanceId: string): void;
}

export interface ExtensionCdpSendOptions {
  /** Host 命令 requestId；用于 tracker 的 dispatched/cancel 关联。 */
  commandRequestId?: string;
  signal?: AbortSignal;
}

export interface ExtensionCdpTransportHooks {
  onRequestStart?(commandRequestId: string, wireRequestId: string, method: string): void;
  onRequestSettled?(commandRequestId: string, wireRequestId: string): void;
}

interface InFlightWireRequest {
  profileInstanceId: string;
}

/**
 * 扩展 CDP adapter：wire 上只出现 nativeTabId / targetId。
 * Host sessionId 不进入这个文件；调用方只传 attachment 身份。
 *
 * 每个 wire 请求都登记 requestId → profile，cancel 只影响目标请求。
 * 迟到的 cdp.result 由 Host 命令 requestId 的 compare-and-delete 保护；
 * 事件只有在 attachment 仍注册时才派发，旧 attachment 不能命中新 binding。
 */
export class ExtensionCdpTransport implements BrowserCdpTransport {
  private readonly targets = new Map<string, ExtensionTargetRef>();
  private readonly listeners = new Set<(event: BrowserCdpEvent) => void>();
  private readonly inFlight = new Map<string, InFlightWireRequest>();
  private hooks: ExtensionCdpTransportHooks = {};

  constructor(private readonly port: ExtensionCdpRequestPort) {}

  setHooks(hooks: ExtensionCdpTransportHooks): void {
    this.hooks = hooks;
  }

  registerTarget(target: ExtensionTargetRef): void {
    this.targets.set(target.attachmentId, target);
  }

  unregisterAttachment(attachmentId: string): void {
    this.targets.delete(attachmentId);
  }

  unregisterProfile(profileInstanceId: string): void {
    for (const [attachmentId, target] of this.targets) {
      if (target.browserId === `extension:${profileInstanceId}`) {
        this.targets.delete(attachmentId);
      }
    }
  }

  isRegistered(attachmentId: string): boolean {
    return this.targets.has(attachmentId);
  }

  dispatchEvent(event: BrowserCdpEvent): void {
    // 旧 connection 的迟到事件不能进入当前 binding。
    if (!this.targets.has(event.attachmentId)) return;
    for (const listener of this.listeners) listener(event);
  }

  async send(
    method: string,
    params: Record<string, unknown>,
    target: BrowserCdpTarget,
    options: ExtensionCdpSendOptions = {},
  ): Promise<unknown> {
    const targetRef = this.targets.get(target.attachmentId);
    if (!targetRef || targetRef.nativeTabId !== target.nativeTabId) {
      throw new Error("CDP attachment is not registered in this extension backend");
    }
    if (options.signal?.aborted) throw abortReason(options.signal);
    const requestId = randomUUID();
    this.inFlight.set(requestId, { profileInstanceId: profileFromBrowserId(targetRef.browserId) });
    if (options.commandRequestId) {
      this.hooks.onRequestStart?.(options.commandRequestId, requestId, method);
    }
    try {
      const response = await raceAbort(
        this.port.request({
          type: "cdp.request",
          requestId,
          targetRef,
          method,
          params,
          ...(target.targetId ? { targetId: target.targetId } : {}),
        }),
        options.signal,
      );
      if (response.type !== "cdp.result") {
        throw new Error(`unexpected extension result: ${response.type}`);
      }
      return assertCdpResult(response, method);
    } finally {
      this.inFlight.delete(requestId);
      if (options.commandRequestId) {
        this.hooks.onRequestSettled?.(options.commandRequestId, requestId);
      }
    }
  }

  /** 尽力取消指定的 wire 请求；不等待扩展响应，也不改变 Host pending 事实。 */
  cancelRequests(requestIds: Iterable<string>): void {
    if (!this.port.cancel) return;
    for (const requestId of requestIds) {
      const entry = this.inFlight.get(requestId);
      if (!entry) continue;
      this.port.cancel(requestId, entry.profileInstanceId);
    }
  }

  subscribe(listener: (event: BrowserCdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function profileFromBrowserId(browserId: string): string {
  return browserId.startsWith("extension:") ? browserId.slice("extension:".length) : browserId;
}

/** Host cancel/timeout 只结束当前等待；底层扩展请求仍由 wire request.cancel 尽力收口。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("browser request aborted"), {
        code: "cancelled",
        sideEffect: "none",
      });
}

function assertCdpResult(message: ExtensionCdpResultMessage, method: string): unknown {
  if (message.ok) return message.result;
  if (message.failure) {
    throw Object.assign(new Error(message.failure.message), {
      code: message.failure.code,
      sideEffect: "none",
    });
  }
  const error = message.error;
  // 收到 CDP 结构化错误说明命令已落地但被拒绝，副作用结果已知为 none；
  // 只有超时/断连才由 Host 标 uncertain。
  throw Object.assign(new Error(error?.message ?? `CDP command failed: ${method}`), {
    method,
    sideEffect: "none",
    ...(error?.code === undefined ? {} : { cdpCode: error.code }),
  });
}
