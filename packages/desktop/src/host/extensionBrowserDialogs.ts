import type { BrowserDialog } from "@zody/shared";
import type { BrowserCdpTarget } from "../browser-core/cdpTransport.js";

export interface ExtensionDialogState {
  dialog: BrowserDialog;
  attachmentId: string;
  nativeTabId: number;
  targetId?: string;
}

export const EXTENSION_DIALOG_DEFAULT_DISMISS_MS = 25_000;
const DISMISS_VERIFY_TIMEOUT_MS = 2_000;

export interface ExtensionDialogEvent {
  attachmentId: string;
  nativeTabId: number;
  targetId?: string;
  method: string;
  params: Record<string, unknown>;
}

/**
 * JS dialog 状态按 tab 保存，但保留事件的 attachment/targetId，确保跨域 iframe 打出的
 * dialog 也发回正确 target。用户 tab 在命令预算耗尽前默认 accept:false，不默认接受提交。
 */
export class ExtensionDialogManager {
  private readonly states = new Map<string, ExtensionDialogState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly dismissTimeoutMs = EXTENSION_DIALOG_DEFAULT_DISMISS_MS) {}

  handleEvent(tabId: string, event: ExtensionDialogEvent): void {
    if (event.method === "Page.javascriptDialogOpening") {
      const params = event.params as {
        type?: unknown;
        message?: unknown;
        defaultPrompt?: unknown;
      };
      this.states.set(tabId, {
        dialog: {
          type: normalizeDialogType(params.type),
          message: typeof params.message === "string" ? params.message : "",
          ...(typeof params.defaultPrompt === "string"
            ? { defaultPrompt: params.defaultPrompt }
            : {}),
        },
        attachmentId: event.attachmentId,
        nativeTabId: event.nativeTabId,
        ...(event.targetId ? { targetId: event.targetId } : {}),
      });
      return;
    }
    if (event.method === "Page.javascriptDialogClosed") {
      this.states.delete(tabId);
    }
  }

  get(tabId: string): BrowserDialog | undefined {
    return this.states.get(tabId)?.dialog;
  }

  state(tabId: string): ExtensionDialogState | undefined {
    return this.states.get(tabId);
  }

  cdpTarget(state: ExtensionDialogState): BrowserCdpTarget {
    return {
      attachmentId: state.attachmentId,
      nativeTabId: state.nativeTabId,
      ...(state.targetId ? { targetId: state.targetId } : {}),
    };
  }

  clear(tabId: string): void {
    this.states.delete(tabId);
    const timer = this.timers.get(tabId);
    if (timer) clearTimeout(timer);
    this.timers.delete(tabId);
  }

  /**
   * 用户 tab 命令开始时计时；到点仍有 dialog 就发送 accept:false。
   * `dismiss` 返回 false 或超时表示仍无法解除阻塞，由调用方 detach/revoke。
   */
  beginUserCommand(
    tabId: string,
    dismiss: () => Promise<boolean>,
    onUnresolved: () => Promise<void>,
  ): void {
    this.endCommand(tabId);
    const timer = setTimeout(() => {
      this.timers.delete(tabId);
      void (async () => {
        const state = this.states.get(tabId);
        if (!state) return;
        const resolved = await withTimeout(dismiss(), DISMISS_VERIFY_TIMEOUT_MS).catch(() => false);
        if (resolved) {
          this.states.delete(tabId);
          return;
        }
        await onUnresolved().catch(() => undefined);
      })();
    }, this.dismissTimeoutMs);
    timer.unref?.();
    this.timers.set(tabId, timer);
  }

  endCommand(tabId: string): void {
    const timer = this.timers.get(tabId);
    if (timer) clearTimeout(timer);
    this.timers.delete(tabId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.states.clear();
  }
}

function normalizeDialogType(value: unknown): "alert" | "confirm" | "prompt" | "beforeunload" {
  if (value === "confirm" || value === "prompt" || value === "beforeunload") return value;
  return "alert";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | false> {
  return new Promise<T | false>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
