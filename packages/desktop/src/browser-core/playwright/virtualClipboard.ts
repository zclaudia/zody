/**
 * Backend-neutral 虚拟剪贴板输入。
 *
 * 只依赖 PlaywrightPage：IAB 与 extension 共享同一套 focused-frame 解析、OOPIF attach
 * 和虚拟粘贴逻辑，不在扩展 backend 复制第二套输入算法。
 */
import { randomUUID } from "node:crypto";
import type { PlaywrightPage } from "./types.js";
import {
  BROWSER_INPUT_TARGET_TOKEN_PROPERTY,
  VIRTUAL_PASTE_PAGE_FUNCTION,
} from "./virtualClipboardPageScript.js";

export { BROWSER_INPUT_TARGET_TOKEN_PROPERTY } from "./virtualClipboardPageScript.js";

export interface BrowserInputExecutionTarget {
  contextId?: number;
  sessionId?: string;
}

interface RuntimeResult {
  objectId?: string;
  value?: unknown;
}

interface RuntimeResponse {
  exceptionDetails?: {
    exception?: { description?: string; value?: unknown };
    text?: string;
  };
  result?: RuntimeResult;
}

interface FocusedTargetResolution {
  attachedSessionIds: string[];
  target: BrowserInputExecutionTarget;
}

const OOPIF_TARGET_REGISTRATION_TIMEOUT_MS = 1_000;

const FOCUSED_FRAME_EXPRESSION = `(() => {
  const focusedFrameElementInRoot = (root) => {
    const active = root.activeElement;
    if (active == null) return null;
    const activeWindow = active.ownerDocument.defaultView ?? window;
    if (active instanceof activeWindow.HTMLElement && active.shadowRoot != null)
      return focusedFrameElementInRoot(active.shadowRoot);
    if (
      active instanceof activeWindow.HTMLIFrameElement ||
      active instanceof activeWindow.HTMLFrameElement
    ) {
      try {
        const frameDocument =
          active.contentDocument ?? active.contentWindow?.document ?? null;
        if (frameDocument != null)
          return focusedFrameElementInRoot(frameDocument);
      } catch {}
      return active;
    }
    return null;
  };
  return focusedFrameElementInRoot(document);
})()`;

function runtimeError(response: RuntimeResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null ? undefined : String(exception.exception.value)) ??
    exception.text ??
    "Browser Use virtual clipboard evaluation failed"
  );
}

function targetKey(target: BrowserInputExecutionTarget): string {
  return `${target.sessionId ?? "root"}:${target.contextId ?? "default"}`;
}

async function send(
  page: PlaywrightPage,
  target: BrowserInputExecutionTarget,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return page.send(method, params, target.sessionId);
}

async function detachAttachedSessions(
  page: PlaywrightPage,
  sessionIds: readonly string[],
): Promise<void> {
  await Promise.allSettled(sessionIds.map((sessionId) => page.detachFromTarget(sessionId)));
}

async function tryAttachFrameTarget(
  page: PlaywrightPage,
  frameId: string,
): Promise<string | undefined> {
  return page.attachToTarget(frameId).catch(() => undefined);
}

async function waitForOopifTarget(
  page: PlaywrightPage,
  frameId: string,
): Promise<string | undefined> {
  const deadline = Date.now() + OOPIF_TARGET_REGISTRATION_TIMEOUT_MS;
  for (;;) {
    const targets = (await page.send("Target.getTargets").catch(() => undefined)) as
      | { targetInfos?: Array<{ targetId?: string; type?: string }> }
      | undefined;
    if (
      targets?.targetInfos?.some(
        (target) => target.targetId === frameId && target.type === "iframe",
      )
    ) {
      const sessionId = await tryAttachFrameTarget(page, frameId);
      if (sessionId) return sessionId;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
}

async function resolveFocusedTarget(
  page: PlaywrightPage,
  initialTarget: BrowserInputExecutionTarget = {},
): Promise<FocusedTargetResolution> {
  let target = initialTarget;
  const attachedSessionIds: string[] = [];
  const visited = new Set<string>();
  try {
    for (;;) {
      const key = targetKey(target);
      if (visited.has(key)) throw new Error("Browser Use encountered a focused frame cycle");
      visited.add(key);
      const response = (await send(page, target, "Runtime.evaluate", {
        ...(target.contextId == null ? {} : { contextId: target.contextId }),
        expression: FOCUSED_FRAME_EXPRESSION,
        returnByValue: false,
      })) as RuntimeResponse;
      if (runtimeError(response))
        throw new Error("Browser Use could not inspect the focused frame");
      const objectId = response.result?.objectId;
      if (!objectId) return { attachedSessionIds, target };
      let frameId: string | undefined;
      try {
        const described = (await send(page, target, "DOM.describeNode", {
          objectId,
        })) as {
          node?: { frameId?: string };
        };
        frameId = described.node?.frameId;
      } finally {
        await send(page, target, "Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
      if (!frameId) return { attachedSessionIds, target };

      // 同进程 iframe 与 OOPIF 不能共享顶层 execution context。先按 Chromium 的
      // OOPIF targetId=frameId 尝试 attach；失败才在当前 target 为同进程 frame 建 isolated world。
      const attachedSessionId = await tryAttachFrameTarget(page, frameId);
      if (attachedSessionId) {
        attachedSessionIds.push(attachedSessionId);
        target = { sessionId: attachedSessionId };
        await Promise.all([
          send(page, target, "Page.enable"),
          send(page, target, "Runtime.enable"),
          send(page, target, "DOM.enable"),
        ]);
        continue;
      }
      const world = (await send(page, target, "Page.createIsolatedWorld", {
        frameId,
        grantUniveralAccess: false,
        worldName: "browser-use-virtual-clipboard",
      }).catch(() => undefined)) as { executionContextId?: number } | undefined;
      if (world?.executionContextId) {
        target = { ...target, contextId: world.executionContextId };
        continue;
      }

      // OOPIF navigation 时 DOM node 的 frameId 可能先于 Target registry 可见。
      // 用有界 getTargets 轮询等待目标可用，禁止错误回落到顶层输入。
      const delayedSessionId = await waitForOopifTarget(page, frameId);
      if (!delayedSessionId)
        throw new Error(`Browser Use could not resolve an input target for frame ${frameId}`);
      attachedSessionIds.push(delayedSessionId);
      target = { sessionId: delayedSessionId };
      await Promise.all([
        send(page, target, "Page.enable"),
        send(page, target, "Runtime.enable"),
        send(page, target, "DOM.enable"),
      ]);
    }
  } catch (error) {
    await detachAttachedSessions(page, attachedSessionIds);
    throw error;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r\n", "<br>")
    .replaceAll(/[\r\n\u2028\u2029]/gu, "<br>");
}

function clipboardItems(text: string, includeRichText: boolean) {
  const entries = [{ mime_type: "text/plain", text }];
  if (includeRichText) entries.push({ mime_type: "text/html", text: escapeHtml(text) });
  return [{ entries, presentation_style: "unspecified" }];
}

function shouldIncludeRichText(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.host !== "docs.google.com") return true;
    return parsed.pathname.split("/").filter(Boolean)[0] !== "spreadsheets";
  } catch {
    return true;
  }
}

export function createInputTargetToken(): string {
  return randomUUID();
}

export async function assertFocusedInputTargetOnPage(
  page: PlaywrightPage,
  target: BrowserInputExecutionTarget,
  inputTargetToken: string,
): Promise<void> {
  const response = (await send(page, target, "Runtime.evaluate", {
    ...(target.contextId == null ? {} : { contextId: target.contextId }),
    expression: `(() => {
      const deepestActiveElement = (root) => {
        const active = root.activeElement;
        if (active == null) return null;
        const view = active.ownerDocument.defaultView ?? window;
        if (active instanceof view.HTMLElement && active.shadowRoot != null)
          return deepestActiveElement(active.shadowRoot) ?? active;
        return active;
      };
      return deepestActiveElement(document)?.${BROWSER_INPUT_TARGET_TOKEN_PROPERTY} === ${JSON.stringify(inputTargetToken)};
    })()`,
    returnByValue: true,
  })) as RuntimeResponse;
  const error = runtimeError(response);
  if (error) throw new Error(`Browser Use could not verify the focused input target: ${error}`);
  if (response.result?.value !== true)
    throw new Error("Active element is no longer the expected input target");
}

export async function pasteTextIntoFocusedTargetOnPage(
  page: PlaywrightPage,
  text: string,
  options: {
    includeRichText?: boolean;
    initialTarget?: BrowserInputExecutionTarget;
    inputTargetToken?: string;
    replaceInputValue?: boolean;
  } = {},
): Promise<void> {
  const resolution = await resolveFocusedTarget(page, options.initialTarget);
  try {
    const includeRichText = options.includeRichText ?? shouldIncludeRichText(page.pageUrl());
    const args = {
      clipboardItems: clipboardItems(text, includeRichText),
      ...(options.inputTargetToken == null ? {} : { inputTargetToken: options.inputTargetToken }),
      replaceInputValue: options.replaceInputValue === true,
      richTextFallback: includeRichText,
    };
    const response = (await send(page, resolution.target, "Runtime.evaluate", {
      ...(resolution.target.contextId == null ? {} : { contextId: resolution.target.contextId }),
      expression: `(async () => {
        try {
          const pageFunction = ${VIRTUAL_PASTE_PAGE_FUNCTION};
          const data = await pageFunction(${JSON.stringify(args)});
          return { ok: true, data };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as RuntimeResponse;
    const error = runtimeError(response);
    if (error)
      throw new Error(
        `Browser Use encountered an error interacting with this webpage's clipboard: ${error}`,
      );
    const value = response.result?.value;
    if (!value || typeof value !== "object" || !("ok" in value))
      throw new Error(
        "Browser Use encountered an error interacting with this webpage's clipboard: type returned an invalid result",
      );
    if ((value as { ok?: unknown }).ok !== true) {
      const message =
        "error" in value && typeof (value as { error?: unknown }).error === "string"
          ? (value as { error: string }).error
          : "type failed";
      throw new Error(
        `Browser Use encountered an error interacting with this webpage's clipboard: ${message}`,
      );
    }
  } finally {
    await detachAttachedSessions(page, resolution.attachedSessionIds);
  }
}
