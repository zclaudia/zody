import type { BrowserCommand } from "@zody/shared";
import type { ExtensionExecutionContext } from "./extensionBrowserBackendTypes.js";

/** 普通命令沿用 Host 桥 30 秒预算；claimTab 有自己的 TTL，不进入这条预算。 */
export const EXTENSION_COMMAND_TIMEOUT_MS = 30_000;

export type ExtensionAbortReason =
  | "cancelled"
  | "timeout"
  | "turn_ended"
  | "session_closed"
  | "target_unavailable"
  | "backend_unavailable";

export interface ExtensionTrackedRequest {
  requestId: string;
  command: BrowserCommand["method"];
  tabId?: string;
  profileInstanceId: string;
  owner: {
    sessionId: string;
    workspaceKey: string;
    remoteSessionId?: string;
  };
  turnId?: string;
  controller: AbortController;
  state: "pending" | "dispatched" | "cancelled";
  dispatchedSideEffect: boolean;
  wireRequestIds: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExtensionRequestTrackerDeps {
  /** 发送 wire request.cancel；由 backend 注入 cdp transport。 */
  cancelWire?(requestIds: string[]): void;
  timeoutMs?: number;
}

/**
 * Host 侧命令 cancel/timeout/dispatch 的唯一 owner。
 *
 * - 每个命令 requestId 只有一条 entry；重复 ID 在 begin 时失败，不覆盖旧 entry。
 * - cancel/timeout 只 abort 目标 entry；后续同 key 的新命令必须等旧 entry finally 删除。
 * - 副作用判定只看“是否已把副作用 CDP 方法交给 transport”，未下发为 none。
 * - wireRequestIds 用于发送 request.cancel；结果仍由各请求自己的 compare-and-delete 清理。
 */
export class ExtensionRequestTracker {
  private readonly requests = new Map<string, ExtensionTrackedRequest>();
  private readonly timeoutMs: number;
  private cancelledWireTargets = 0;

  constructor(private readonly deps: ExtensionRequestTrackerDeps = {}) {
    this.timeoutMs = deps.timeoutMs ?? EXTENSION_COMMAND_TIMEOUT_MS;
  }

  begin(input: {
    requestId: string;
    command: BrowserCommand["method"];
    browserId: string;
    context: ExtensionExecutionContext;
    tabId?: string;
  }): ExtensionTrackedRequest | undefined {
    if (this.requests.has(input.requestId)) return undefined;
    const controller = new AbortController();
    const entry: ExtensionTrackedRequest = {
      requestId: input.requestId,
      command: input.command,
      profileInstanceId: input.browserId.startsWith("extension:")
        ? input.browserId.slice("extension:".length)
        : input.browserId,
      ...(input.tabId ? { tabId: input.tabId } : {}),
      owner: {
        sessionId: input.context.sessionId,
        workspaceKey: input.context.workspaceKey,
        ...(input.context.remoteSessionId
          ? { remoteSessionId: input.context.remoteSessionId }
          : {}),
      },
      ...(input.context.turnId ? { turnId: input.context.turnId } : {}),
      controller,
      state: "pending",
      dispatchedSideEffect: false,
      wireRequestIds: new Set(),
      timer: setTimeout(() => {
        if (this.requests.get(input.requestId) !== entry) return;
        this.abort(entry, "timeout");
      }, this.timeoutMs),
    };
    entry.timer.unref?.();
    this.requests.set(input.requestId, entry);
    return entry;
  }

  get(requestId: string): ExtensionTrackedRequest | undefined {
    return this.requests.get(requestId);
  }

  signal(requestId: string): AbortSignal | undefined {
    return this.requests.get(requestId)?.controller.signal;
  }

  dispatchedSideEffectFor(requestId: string): boolean {
    return this.requests.get(requestId)?.dispatchedSideEffect ?? false;
  }

  /** 命令把 CDP 方法交给 transport 前登记；用于 cancel wire 和副作用判定。 */
  markDispatched(commandRequestId: string, wireRequestId: string, method: string): void {
    const entry = this.requests.get(commandRequestId);
    if (!entry || entry.state === "cancelled") return;
    entry.state = "dispatched";
    entry.wireRequestIds.add(wireRequestId);
    if (cdpMethodHasSideEffect(method)) entry.dispatchedSideEffect = true;
  }

  markSettled(commandRequestId: string, wireRequestId: string): void {
    this.requests.get(commandRequestId)?.wireRequestIds.delete(wireRequestId);
  }

  /** cancelRequest 只结束目标 requestId；不删除后续同 key 或其它 tab 的 entry。 */
  cancel(requestId: string, context: ExtensionExecutionContext): boolean {
    const entry = this.requests.get(requestId);
    if (!entry || !sameOwner(entry.owner, context)) return false;
    if (entry.controller.signal.aborted) return false;
    this.abort(entry, "cancelled");
    return true;
  }

  /** turnEnded/closeSession 按 scope（和可选 turn）结束在途命令。 */
  cancelScope(context: ExtensionExecutionContext, turnId?: string): number {
    let count = 0;
    for (const entry of this.requests.values()) {
      if (!sameOwner(entry.owner, context)) continue;
      if (turnId !== undefined && entry.turnId !== turnId) continue;
      if (entry.controller.signal.aborted) continue;
      this.abort(entry, turnId === undefined ? "session_closed" : "turn_ended");
      count += 1;
    }
    return count;
  }

  /** attachment/tab 失效：只 abort 该 tab 的在途命令，并返回 target_unavailable。 */
  cancelTab(tabId: string): number {
    let count = 0;
    for (const entry of this.requests.values()) {
      if (entry.tabId !== tabId || entry.controller.signal.aborted) continue;
      this.abort(entry, "target_unavailable");
      count += 1;
    }
    return count;
  }

  /** 连接失效：所有旧命令立即 settle，不再等待 transport timeout。 */
  cancelProfile(profileInstanceId: string): number {
    let count = 0;
    for (const entry of this.requests.values()) {
      if (entry.profileInstanceId !== profileInstanceId) continue;
      if (entry.controller.signal.aborted) continue;
      this.abort(entry, "backend_unavailable");
      count += 1;
    }
    return count;
  }

  complete(requestId: string): void {
    const entry = this.requests.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (this.requests.get(requestId) === entry) this.requests.delete(requestId);
  }

  dispose(): void {
    for (const entry of this.requests.values()) {
      clearTimeout(entry.timer);
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(
          cancellationError("cancelled", entry.dispatchedSideEffect ? "uncertain" : "none"),
        );
      }
    }
    this.requests.clear();
    this.cancelledWireTargets = 0;
  }

  /** wire 请求被取消的次数；用于测试确认 target-only 语义。 */
  get cancelledWireRequestCount(): number {
    return this.cancelledWireTargets;
  }

  private abort(entry: ExtensionTrackedRequest, reason: ExtensionAbortReason): void {
    if (entry.controller.signal.aborted) return;
    entry.state = "cancelled";
    clearTimeout(entry.timer);
    const sideEffect = entry.dispatchedSideEffect ? "uncertain" : "none";
    const wireIds = [...entry.wireRequestIds];
    entry.wireRequestIds.clear();
    this.cancelledWireTargets += wireIds.length;
    if (wireIds.length > 0) this.deps.cancelWire?.(wireIds);
    entry.controller.abort(cancellationError(reason, sideEffect));
  }
}

/** 与 IAB 的 abort/turnEnded/closeSession 保持一致：取消使用 cancelled；超时保留 timeout。 */
export function cancellationError(
  reason: ExtensionAbortReason,
  sideEffect: "none" | "uncertain",
): Error {
  const code =
    reason === "timeout"
      ? "timeout"
      : reason === "target_unavailable"
        ? "target_unavailable"
        : reason === "backend_unavailable"
          ? "backend_unavailable"
          : "cancelled";
  const message =
    reason === "timeout"
      ? "browser request timed out before the backend settled"
      : reason === "target_unavailable"
        ? "browser tab or attachment became unavailable"
        : reason === "backend_unavailable"
          ? "extension connection was lost before the request settled"
          : reason === "turn_ended"
            ? "browser request cancelled because the turn ended"
            : reason === "session_closed"
              ? "browser request cancelled because the session closed"
              : sideEffect === "uncertain"
                ? "browser request cancelled after dispatch; side effects may have occurred"
                : "browser request cancelled before dispatch";
  return Object.assign(new Error(message), { code, sideEffect });
}

/** 只有这些 CDP 方法会改变页面/浏览器状态；纯读取/截图不标 uncertain。 */
export function cdpMethodHasSideEffect(method: string): boolean {
  if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") return true;
  if (method === "Page.navigate" || method === "Page.navigateToHistoryEntry") return true;
  if (method === "Page.reload" || method === "Page.handleJavaScriptDialog") return true;
  return method.startsWith("Input.");
}

function sameOwner(
  owner: ExtensionTrackedRequest["owner"],
  context: ExtensionExecutionContext,
): boolean {
  return (
    owner.sessionId === context.sessionId &&
    owner.workspaceKey === context.workspaceKey &&
    (owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "")
  );
}
