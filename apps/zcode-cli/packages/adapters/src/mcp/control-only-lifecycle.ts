import type { ChildProcess } from "node:child_process";
import type { ControlChannelCloseCode } from "@zcode/zcode-cua/control-channel";
import {
  ControlOnlyLauncherError,
  type ControlOnlyLauncherCloseReason,
  type ControlOnlyLauncherClosedEvent,
  type ControlOnlyLauncherInvalidatedEvent,
} from "./control-only-contract.js";

interface ControlOnlyInvalidationState {
  closed: boolean;
  closeReason: ControlOnlyLauncherCloseReason | null;
  invalidatedEmitted: boolean;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ChildTerminatorOptions {
  readonly getChild: () => ChildProcess | null;
  readonly getExit: () => ExitInfo | null;
  readonly waitForExit: (timeoutMs: number) => Promise<ExitInfo | null>;
  readonly closeTimeoutMs: number;
}

export function createChildTerminator(
  options: ChildTerminatorOptions,
): (graceful: boolean) => Promise<ExitInfo | null> {
  return async (graceful) => {
    const child = options.getChild();
    const currentExit = options.getExit();
    if (!child || currentExit || child.pid === undefined) return currentExit;
    if (graceful) {
      // 正常 close 先销毁私有写端，让 child 在 EOF 后自行 owner.close() 并退出；
      // 只有等待真实 exit 超时才升级信号，不能用固定 sleep 代替退出证据。
      const naturalExit = await options.waitForExit(options.closeTimeoutMs);
      if (naturalExit) return naturalExit;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ESRCH or platform refusal falls through to the bounded wait.
    }
    const afterTerm = await options.waitForExit(options.closeTimeoutMs);
    if (afterTerm) return afterTerm;
    try {
      child.kill("SIGKILL");
    } catch {
      // The final bounded wait is the only success evidence.
    }
    const afterKill = await options.waitForExit(options.closeTimeoutMs);
    if (!afterKill) {
      throw new ControlOnlyLauncherError(
        "close_timeout",
        "control-only launcher child did not exit",
      );
    }
    return afterKill;
  };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function destroyStdio(child: ChildProcess | null): void {
  if (!child) return;
  for (const index of [3, 4, 5, 6]) {
    const stream = child.stdio[index];
    if (stream && !stream.destroyed) {
      try {
        stream.destroy();
      } catch {
        // Cleanup continues with the remaining private fds.
      }
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    if (stream && !stream.destroyed) {
      try {
        stream.destroy();
      } catch {
        // Diagnostic pipes are best effort once the child is closing.
      }
    }
  }
}

export function mapChannelClose(code: ControlChannelCloseCode): ControlOnlyLauncherCloseReason {
  switch (code) {
    case "disposed":
    case "local_close":
    case "peer_eof":
    case "transport_closed":
      return code;
    case "transport_error":
      return "transport_error";
    case "protocol_error":
    case "frame_too_large":
    case "outbound_overflow":
    case "incoming_overflow":
    case "handler_error":
      return "protocol_error";
    case "request_timeout":
      return "request_timeout";
    case "request_aborted":
      return "transport_closed";
  }
}

export function normalizeStartupError(error: unknown): ControlOnlyLauncherError {
  if (error instanceof ControlOnlyLauncherError) return error;
  return new ControlOnlyLauncherError("startup_failed", "control-only launcher startup failed", {
    cause: error,
  });
}

export function startupEvent(
  error: ControlOnlyLauncherError,
  exit: ExitInfo | null,
): ControlOnlyLauncherClosedEvent {
  return Object.freeze({
    cause: error,
    exitCode: exit?.code ?? null,
    message: "control-only launcher startup failed",
    pendingRequests: 0,
    reason: "startup_failed" as const,
    signal: exit?.signal ?? null,
  });
}

export function createControlOnlyInvalidationEmitter(
  state: ControlOnlyInvalidationState,
  onInvalidated: ((event: ControlOnlyLauncherInvalidatedEvent) => void | Promise<void>) | undefined,
): (reason: ControlOnlyLauncherCloseReason, cause: Error | null, message: string) => void {
  return (reason, cause, message) => {
    if (state.invalidatedEmitted) return;
    // 首个失效必须先同步锁存 closed/closeReason，再通知外部；ready 续体可能在
    // child.error 之后才检查状态，不能让它返回一个已通知失效但仍标记为 open 的 launcher。
    state.invalidatedEmitted = true;
    state.closed = true;
    state.closeReason ??= reason;
    const event: ControlOnlyLauncherInvalidatedEvent = Object.freeze({
      cause,
      message,
      reason: state.closeReason,
    });
    try {
      const result = onInvalidated?.(event);
      if (result && typeof result.then === "function") result.then(undefined, () => undefined);
    } catch {
      // A trusted observer cannot reopen the first-close latch.
    }
  };
}
