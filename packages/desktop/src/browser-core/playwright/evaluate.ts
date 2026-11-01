/**
 * Backend-neutral Playwright evaluate。
 *
 * IAB 在 Electron debugger 上执行；extension 在 chrome.debugger attachment 上执行。
 * 两者共享同一表达式构造、异常归一化和取消语义。
 */
import type { BrowserPlaywrightAction } from "@zcode/shared";
import type { PlaywrightPage } from "./types.js";

type EvaluateAction = Extract<BrowserPlaywrightAction, { name: "evaluate" }>;

export function buildPlaywrightEvaluateExpression(action: EvaluateAction): string {
  const arg = JSON.stringify(action.arg);
  return action.expressionKind === "function"
    ? `(${action.expression})(${arg})`
    : `(() => { const arg = ${arg}; return (${action.expression}); })()`;
}

export async function evaluatePlaywrightExpression(
  page: PlaywrightPage,
  expression: string,
  timeoutMs: number,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<unknown> {
  const terminate = () => {
    void page.send("Runtime.terminateExecution", undefined, sessionId).catch(() => undefined);
  };
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    const raw = (await page.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
      },
      sessionId,
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (raw.exceptionDetails) {
      throw new Error(
        `playwright.evaluate failed: ${
          raw.exceptionDetails.exception?.description ??
          raw.exceptionDetails.text ??
          "Playwright evaluate failed"
        }`,
      );
    }
    return raw.result?.value;
  } finally {
    signal?.removeEventListener("abort", terminate);
  }
}

export async function evaluatePlaywrightAction(
  page: PlaywrightPage,
  action: EvaluateAction,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return evaluatePlaywrightExpression(
    page,
    buildPlaywrightEvaluateExpression(action),
    timeoutMs,
    signal,
  );
}
