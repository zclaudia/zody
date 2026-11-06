/* eslint-disable max-lines -- P2 单 tab 命令分派、dialog 生命周期与共享 Playwright 入口必须共享同一串行队列语义。 */
import { EXTENSION_BRIDGE_MAX_RESULT_BYTES } from "@zody/shared/browser-extension-transport";
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserPageState,
  BrowserPlaywrightAction,
} from "@zody/shared";
import {
  modifiersBitmask,
  dispatchKeyOnPage,
  dispatchKeyPressOnPage,
} from "../browser-core/playwright/input.js";
import { capturePlaywrightDomSnapshot } from "../browser-core/playwright/domSnapshot.js";
import {
  buildPlaywrightEvaluateExpression,
  evaluatePlaywrightExpression,
} from "../browser-core/playwright/evaluate.js";
import {
  executePlaywrightLocator,
  type PlaywrightLocatorLogger,
} from "../browser-core/playwright/locator.js";
import { normalizePlaywrightTimeout } from "../browser-core/playwright/timeout.js";
import { pasteTextIntoFocusedTargetOnPage } from "../browser-core/playwright/virtualClipboard.js";
import type { ExtensionCdpTransport } from "../browser-core/extensionCdpTransport.js";
import {
  ExtensionOperationError,
  type ExtensionBrowserBackendLogger,
  type ExtensionManagedTab,
} from "./extensionBrowserBackendTypes.js";
import type { ExtensionDialogManager } from "./extensionBrowserDialogs.js";
import { ExtensionPlaywrightPage } from "./extensionPlaywrightPage.js";
import type { ExtensionTransportClient } from "./extensionTransportClient.js";

const READY_POLL_INTERVAL_MS = 100;
const PLAYWRIGHT_POLL_INTERVAL_MS = 50;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;

/** 扩展 backend 没有坐标契约：这些方法不能靠截图/视口像素执行。 */
const COORDINATE_COMMANDS = new Set<string>([
  "click",
  "hover",
  "drag",
  "cuaDrag",
  "cuaScroll",
  "domCuaScroll",
  "elementInfo",
]);

const COORDINATE_PLAYWRIGHT_ACTIONS = new Set<string>([
  "elementInfo",
  "elementScreenshot",
  "waitForEvent",
  "downloadPath",
  "fileChooserSetFiles",
]);

export interface ExtensionCommandRunnerDeps {
  cdp: ExtensionCdpTransport;
  transport: ExtensionTransportClient;
  dialogs: ExtensionDialogManager;
  navigationTimeoutMs?: number;
  logger?: ExtensionBrowserBackendLogger;
  /** dialog accept:false 仍无法解除阻塞时 detach/revoke。 */
  onDialogUnresolved?: (tab: ExtensionManagedTab) => Promise<void>;
}

/** 当前命令的取消边界；由 backend request tracker 提供。 */
export interface ExtensionCommandRunContext {
  requestId: string;
  signal?: AbortSignal;
}

/**
 * 单 tab 的 P2 命令执行器。
 *
 * 只在该 tab 的串行队列内被调用；Playwright/locator/domSnapshot/evaluate 与 IAB 共用
 * browser-core/playwright 实现。失败抛 ExtensionOperationError，由 backend 统一补 meta。
 */
export class ExtensionBrowserCommandRunner {
  private readonly navigationTimeoutMs: number;
  private readonly dialogs: ExtensionDialogManager;
  private readonly logger: PlaywrightLocatorLogger | undefined;

  constructor(private readonly deps: ExtensionCommandRunnerDeps) {
    this.navigationTimeoutMs = deps.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    this.dialogs = deps.dialogs;
    this.logger = deps.logger;
  }

  async run(
    tab: ExtensionManagedTab,
    command: BrowserCommand,
    startedAt: number,
    context: ExtensionCommandRunContext,
  ): Promise<BrowserCommandResult> {
    assertNoCoordinateCommand(command);
    throwIfAborted(context.signal);
    const autoDismiss = tab.tabClass === "user" && !DIALOG_CONTROL_COMMANDS.has(command.method);
    if (autoDismiss) {
      this.dialogs.beginUserCommand(
        tab.tabId,
        async () => {
          this.logger?.debug("[extension-browser] dialog auto-dismiss start", tab.tabId);
          const resolved = await this.dismissDialog(tab);
          this.logger?.debug("[extension-browser] dialog auto-dismiss done", {
            tabId: tab.tabId,
            resolved,
          });
          return resolved;
        },
        async () => {
          this.logger?.debug("[extension-browser] dialog unresolved; revoking tab", tab.tabId);
          await this.deps.onDialogUnresolved?.(tab);
        },
      );
    }
    try {
      switch (command.method) {
        case "navigate":
          return {
            ok: true,
            state: await this.navigate(tab, command.url, context),
            elapsedMs: Date.now() - startedAt,
          };
        case "back":
        case "forward":
          return {
            ok: true,
            state: await this.historyStep(tab, command.method, context),
            elapsedMs: Date.now() - startedAt,
          };
        case "reload":
          return {
            ok: true,
            state: await this.reload(tab, context),
            elapsedMs: Date.now() - startedAt,
          };
        case "getState":
          return {
            ok: true,
            state: await this.readState(tab, context),
            elapsedMs: Date.now() - startedAt,
          };
        case "screenshot":
          return {
            ...(await this.screenshot(tab, context)),
            elapsedMs: Date.now() - startedAt,
          };
        case "playwright":
          return {
            ...(await this.runPlaywright(tab, command.action, context)),
            elapsedMs: Date.now() - startedAt,
          };
        case "press":
          return {
            ...(await this.press(tab, command, context)),
            elapsedMs: Date.now() - startedAt,
          };
        case "type":
          return {
            ...(await this.type(tab, command, context)),
            elapsedMs: Date.now() - startedAt,
          };
        case "cuaKeypress":
          return {
            ...(await this.cuaKeypress(tab, command.keys, context)),
            elapsedMs: Date.now() - startedAt,
          };
        case "evaluate":
          return {
            ...(await this.evaluate(tab, command.expression, context)),
            elapsedMs: Date.now() - startedAt,
          };
        case "getDialog":
          return {
            ok: true,
            dialog: this.dialogs.get(tab.tabId) ?? null,
            elapsedMs: Date.now() - startedAt,
          };
        case "handleDialog":
          return {
            ...(await this.handleDialog(tab, command.accept, command.promptText, context)),
            elapsedMs: Date.now() - startedAt,
          };
        default:
          throw new ExtensionOperationError(
            "capability_unsupported",
            `command ${command.method} is not supported by the Chrome extension backend`,
          );
      }
    } finally {
      if (autoDismiss) this.dialogs.endCommand(tab.tabId);
    }
  }

  private pageFor(
    tab: ExtensionManagedTab,
    context: ExtensionCommandRunContext,
  ): ExtensionPlaywrightPage {
    return new ExtensionPlaywrightPage({
      transport: this.deps.transport,
      cdp: this.deps.cdp,
      profileInstanceId: tab.profileInstanceId,
      browserId: tab.browserId,
      generation: tab.browserGeneration,
      connectionId: tab.connectionId,
      attachmentId: tab.attachmentId,
      nativeTabId: tab.nativeTabId,
      tabClass: tab.tabClass,
      pageUrl: () => tab.url,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      commandRequestId: context.requestId,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  }

  private async runPlaywright(
    tab: ExtensionManagedTab,
    action: BrowserPlaywrightAction,
    context: ExtensionCommandRunContext,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    if (COORDINATE_PLAYWRIGHT_ACTIONS.has(action.name)) {
      throw new ExtensionOperationError(
        "capability_unsupported",
        `playwright.${action.name} is not supported by the Chrome extension backend`,
      );
    }
    const page = this.pageFor(tab, context);
    try {
      switch (action.name) {
        case "domSnapshot":
          return {
            ok: true,
            value: await capturePlaywrightDomSnapshot(page, context.signal),
          };
        case "evaluate":
          return {
            ok: true,
            value: await evaluatePlaywrightExpression(
              page,
              buildPlaywrightEvaluateExpression(action),
              normalizePlaywrightTimeout(action.timeoutMs),
              context.signal,
            ),
          };
        case "locator": {
          if (action.operation === "downloadMedia") {
            throw new ExtensionOperationError(
              "capability_unsupported",
              "locator.downloadMedia is not supported by the Chrome extension backend",
            );
          }
          const execution = await executePlaywrightLocator(
            page,
            action,
            normalizePlaywrightTimeout(action.timeoutMs),
            context.signal,
            this.logger,
          );
          if (execution.kind === "cancelled") {
            // 取消可能发生在 locator 已 dispatch 输入之后；沿用 tracker 写入的
            // sideEffect，不能固定报 none。
            throw context.signal?.reason instanceof Error
              ? context.signal.reason
              : new ExtensionOperationError("cancelled", "browser request cancelled");
          }
          if (execution.kind === "timeout") {
            throw new ExtensionOperationError(
              "timeout",
              `Timeout waiting for ${execution.reason}. Do not retry the same locator. ` +
                "Take a fresh domSnapshot(), rebuild from snapshot-proven facts, and check count()/isVisible() before the next action.",
            );
          }
          return { ok: true, value: execution.value };
        }
        case "waitForLoadState":
          return { ok: true, value: await this.waitForLoadState(tab, action, context) };
        case "waitForURL":
          return { ok: true, value: await this.waitForUrl(tab, action, context) };
        default:
          throw new ExtensionOperationError(
            "capability_unsupported",
            `playwright.${action.name} is not supported by the Chrome extension backend`,
          );
      }
    } finally {
      await page.dispose();
    }
  }

  private async press(
    tab: ExtensionManagedTab,
    command: Extract<BrowserCommand, { method: "press" }>,
    context: ExtensionCommandRunContext,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    if (command.ref) {
      throw new ExtensionOperationError(
        "capability_unsupported",
        "press with a snapshot ref requires the IAB backend; use locator.press on the Chrome extension backend",
      );
    }
    const page = this.pageFor(tab, context);
    try {
      await dispatchKeyOnPage(page, command.key, modifiersBitmask(command.modifiers));
      return { ok: true };
    } finally {
      await page.dispose();
    }
  }

  private async type(
    tab: ExtensionManagedTab,
    command: Extract<BrowserCommand, { method: "type" }>,
    context: ExtensionCommandRunContext,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    if (command.ref) {
      throw new ExtensionOperationError(
        "capability_unsupported",
        "type with a snapshot ref requires the IAB backend; use locator.fill on the Chrome extension backend",
      );
    }
    const page = this.pageFor(tab, context);
    try {
      await pasteTextIntoFocusedTargetOnPage(page, command.text, { includeRichText: false });
      return { ok: true };
    } finally {
      await page.dispose();
    }
  }

  private async cuaKeypress(
    tab: ExtensionManagedTab,
    keys: readonly string[],
    context: ExtensionCommandRunContext,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    const page = this.pageFor(tab, context);
    try {
      await dispatchKeyPressOnPage(page, keys);
      return { ok: true };
    } finally {
      await page.dispose();
    }
  }

  private async evaluate(
    tab: ExtensionManagedTab,
    expression: string,
    context: ExtensionCommandRunContext,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    const value = await this.send(
      tab,
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      context,
    );
    const raw = value as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (raw?.exceptionDetails) {
      throw new ExtensionOperationError(
        "execution_error",
        raw.exceptionDetails.exception?.description ??
          raw.exceptionDetails.text ??
          "evaluate failed",
      );
    }
    return { ok: true, value: raw?.result?.value };
  }

  private async handleDialog(
    tab: ExtensionManagedTab,
    accept: boolean,
    promptText: string | undefined,
    context: ExtensionCommandRunContext,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    const state = this.dialogs.state(tab.tabId);
    if (!state) {
      throw new ExtensionOperationError("execution_error", "no JavaScript dialog is open");
    }
    await this.deps.cdp.send(
      "Page.handleJavaScriptDialog",
      {
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      },
      this.dialogs.cdpTarget(state),
      {
        commandRequestId: context.requestId,
        ...(context.signal ? { signal: context.signal } : {}),
      },
    );
    this.dialogs.clear(tab.tabId);
    return { ok: true };
  }

  private async dismissDialog(tab: ExtensionManagedTab): Promise<boolean> {
    const state = this.dialogs.state(tab.tabId);
    if (!state) return true;
    await this.deps.cdp.send(
      "Page.handleJavaScriptDialog",
      { accept: false },
      this.dialogs.cdpTarget(state),
    );
    this.dialogs.clear(tab.tabId);
    return true;
  }

  private async waitForLoadState(
    tab: ExtensionManagedTab,
    action: Extract<BrowserPlaywrightAction, { name: "waitForLoadState" }>,
    context: ExtensionCommandRunContext,
  ): Promise<string> {
    const state = action.state ?? "load";
    if (state === "networkidle") {
      throw new ExtensionOperationError(
        "capability_unsupported",
        "playwright.waitForLoadState does not support networkidle",
      );
    }
    const deadline = Date.now() + normalizePlaywrightTimeout(action.timeoutMs);
    for (;;) {
      throwIfAborted(context.signal);
      const readyState = await this.readReadyState(tab, context);
      const ready =
        state === "domcontentloaded" ? readyState !== "loading" : readyState === "complete";
      if (ready) return "";
      if (Date.now() >= deadline) {
        throw new ExtensionOperationError("timeout", `Timeout waiting for load state ${state}`);
      }
      await delay(PLAYWRIGHT_POLL_INTERVAL_MS);
    }
  }

  private async waitForUrl(
    tab: ExtensionManagedTab,
    action: Extract<BrowserPlaywrightAction, { name: "waitForURL" }>,
    context: ExtensionCommandRunContext,
  ): Promise<string> {
    const deadline = Date.now() + normalizePlaywrightTimeout(action.timeoutMs);
    for (;;) {
      throwIfAborted(context.signal);
      const url = await this.readUrl(tab, context);
      if (urlMatches(action.url, url)) {
        if ((action.waitUntil ?? "load") !== "commit") {
          await this.waitForLoadState(
            tab,
            {
              name: "waitForLoadState",
              state: action.waitUntil === "domcontentloaded" ? "domcontentloaded" : "load",
              timeoutMs: Math.max(1, deadline - Date.now()),
            },
            context,
          );
        }
        return url;
      }
      if (Date.now() >= deadline) {
        throw new ExtensionOperationError("timeout", `Timeout waiting for URL ${action.url}`);
      }
      await delay(PLAYWRIGHT_POLL_INTERVAL_MS);
    }
  }

  private async readReadyState(
    tab: ExtensionManagedTab,
    context: ExtensionCommandRunContext,
  ): Promise<string> {
    const value = (await this.send(
      tab,
      "Runtime.evaluate",
      {
        expression: "document.readyState",
        returnByValue: true,
      },
      context,
    )) as { result?: { value?: unknown } };
    return typeof value?.result?.value === "string" ? value.result.value : "loading";
  }

  private async readUrl(
    tab: ExtensionManagedTab,
    context: ExtensionCommandRunContext,
  ): Promise<string> {
    const value = (await this.send(
      tab,
      "Runtime.evaluate",
      {
        expression: "location.href",
        returnByValue: true,
      },
      context,
    )) as { result?: { value?: unknown } };
    const url = typeof value?.result?.value === "string" ? value.result.value : tab.url;
    tab.url = url;
    return url;
  }

  private async navigate(
    tab: ExtensionManagedTab,
    url: string,
    context: ExtensionCommandRunContext,
  ): Promise<BrowserPageState> {
    if (!isAllowedUrl(url)) {
      throw new ExtensionOperationError(
        "navigation_blocked",
        `navigation to ${url} is not allowed`,
      );
    }
    const response = (await this.send(tab, "Page.navigate", { url }, context)) as {
      errorText?: string;
    };
    if (response?.errorText) {
      throw new ExtensionOperationError(
        "navigation_blocked",
        `navigation failed: ${response.errorText}`,
        "uncertain",
      );
    }
    await this.waitForDocumentReady(tab, context);
    return await this.readState(tab, context);
  }

  private async historyStep(
    tab: ExtensionManagedTab,
    direction: "back" | "forward",
    context: ExtensionCommandRunContext,
  ): Promise<BrowserPageState> {
    const history = (await this.send(tab, "Page.getNavigationHistory", {}, context)) as {
      currentIndex?: number;
      entries?: Array<{ id: number }>;
    };
    const index = history.currentIndex ?? 0;
    const targetIndex = direction === "back" ? index - 1 : index + 1;
    const entry = history.entries?.[targetIndex];
    if (!entry) throw new ExtensionOperationError("navigation_blocked", `cannot go ${direction}`);
    await this.send(tab, "Page.navigateToHistoryEntry", { entryId: entry.id }, context);
    await this.waitForDocumentReady(tab, context);
    return await this.readState(tab, context);
  }

  private async reload(
    tab: ExtensionManagedTab,
    context: ExtensionCommandRunContext,
  ): Promise<BrowserPageState> {
    await this.send(tab, "Page.reload", {}, context);
    await this.waitForDocumentReady(tab, context);
    return await this.readState(tab, context);
  }

  private async screenshot(
    tab: ExtensionManagedTab,
    context: ExtensionCommandRunContext,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    const result = (await this.send(
      tab,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      },
      context,
    )) as { data?: unknown };
    if (typeof result?.data !== "string" || result.data.length === 0) {
      throw new ExtensionOperationError("execution_error", "screenshot returned no data");
    }
    if (Math.ceil((result.data.length * 3) / 4) > EXTENSION_BRIDGE_MAX_RESULT_BYTES) {
      throw new ExtensionOperationError("execution_error", "screenshot exceeds the 4 MiB limit");
    }
    return { ok: true, image: { base64: result.data, mimeType: "image/png" } };
  }

  private async readState(
    tab: ExtensionManagedTab,
    context: ExtensionCommandRunContext,
  ): Promise<BrowserPageState> {
    const value = (await this.send(
      tab,
      "Runtime.evaluate",
      {
        expression:
          "({ url: location.href, title: document.title, scrollX: window.scrollX, scrollY: window.scrollY, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight })",
        returnByValue: true,
      },
      context,
    )) as {
      result?: {
        value?: {
          url?: unknown;
          title?: unknown;
          scrollX?: unknown;
          scrollY?: unknown;
          viewportWidth?: unknown;
          viewportHeight?: unknown;
        };
      };
    };
    const state = value?.result?.value;
    if (!state) throw new ExtensionOperationError("execution_error", "getState returned no value");
    tab.url = typeof state.url === "string" ? state.url : tab.url;
    tab.title = typeof state.title === "string" ? state.title : tab.title;
    const width = Number(state.viewportWidth);
    const height = Number(state.viewportHeight);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      tab.viewport = { width: Math.round(width), height: Math.round(height) };
    }
    let canGoBack = false;
    let canGoForward = false;
    try {
      const history = (await this.send(tab, "Page.getNavigationHistory", {}, context)) as {
        currentIndex?: number;
        entries?: unknown[];
      };
      const index = history.currentIndex ?? 0;
      canGoBack = index > 0;
      canGoForward = index + 1 < (history.entries?.length ?? 0);
    } catch {
      // 个别受限页面不提供 history；保留 false，不阻断 getState。
    }
    return {
      url: tab.url,
      title: tab.title,
      canGoBack,
      canGoForward,
      scrollX: typeof state.scrollX === "number" ? state.scrollX : undefined,
      scrollY: typeof state.scrollY === "number" ? state.scrollY : undefined,
      viewportWidth: tab.viewport.width,
      viewportHeight: tab.viewport.height,
    };
  }

  private async waitForDocumentReady(
    tab: ExtensionManagedTab,
    context: ExtensionCommandRunContext,
  ): Promise<void> {
    const deadline = Date.now() + this.navigationTimeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(context.signal);
      if (tab.closed) {
        throw new ExtensionOperationError("target_unavailable", "tab was closed during navigation");
      }
      try {
        if ((await this.readReadyState(tab, context)) === "complete") return;
      } catch (error) {
        if (isUnavailable(error) || isAbort(error)) throw error;
        // 导航中 execution context 会被销毁；只继续等待真实页面状态。
      }
      await delay(READY_POLL_INTERVAL_MS);
    }
    throw new ExtensionOperationError(
      "timeout",
      `page did not reach readyState=complete within ${this.navigationTimeoutMs}ms`,
      "uncertain",
    );
  }

  private async send(
    tab: ExtensionManagedTab,
    method: string,
    params: Record<string, unknown> = {},
    context?: ExtensionCommandRunContext,
  ): Promise<unknown> {
    if (tab.closed) {
      throw new ExtensionOperationError("target_unavailable", "browser tab was closed");
    }
    if (context?.signal?.aborted) throw context.signal.reason;
    const result = await this.deps.cdp.send(
      method,
      params,
      {
        attachmentId: tab.attachmentId,
        nativeTabId: tab.nativeTabId,
      },
      {
        ...(context ? { commandRequestId: context.requestId } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      },
    );
    // 命令在途时用户可能已 Cancel 或关闭 tab；迟到结果不得被当作当前 binding 的有效结果。
    if (tab.closed) {
      throw new ExtensionOperationError("target_unavailable", "browser tab was closed");
    }
    return result;
  }
}

const DIALOG_CONTROL_COMMANDS = new Set<BrowserCommand["method"]>(["getDialog", "handleDialog"]);

function assertNoCoordinateCommand(command: BrowserCommand): void {
  if (COORDINATE_COMMANDS.has(command.method)) {
    throw new ExtensionOperationError(
      "capability_unsupported",
      `command ${command.method} requires coordinates and is not supported by the Chrome extension backend`,
    );
  }
  if (command.method === "screenshot") {
    if (command.fullPage === true) {
      throw new ExtensionOperationError(
        "capability_unsupported",
        "fullPage screenshots are not supported by the Chrome extension backend",
      );
    }
    if (command.ref || command.clip) {
      throw new ExtensionOperationError(
        "capability_unsupported",
        "ref/clip screenshots are not supported by the Chrome extension backend",
      );
    }
  }
}

export function isAllowedUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank") return true;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function urlMatches(pattern: string, url: string): boolean {
  if (!pattern.includes("*")) return url === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

function isUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["target_unavailable", "backend_unavailable"].includes(
      String((error as { code?: unknown }).code),
    )
  );
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["cancelled", "timeout"].includes(String((error as { code?: unknown }).code))
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("browser request aborted");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
