import type { BrowserPlaywrightAction } from "@zcode/shared";
import {
  executePlaywrightLocator,
  type PlaywrightLocatorExecution,
} from "../../browser-core/playwright/locator.js";
import { logger } from "../logger.js";
import type { ControlledView } from "./browserCommandTypes.js";
import { createPlaywrightPageFromControlledView } from "./browserPlaywrightPageAdapter.js";

type LocatorAction = Extract<BrowserPlaywrightAction, { name: "locator" }>;

/** IAB 现有调用点使用的执行结果形状；算法来自 backend-neutral locator。 */
export type IabLocatorExecution = PlaywrightLocatorExecution;

/**
 * IAB locator 入口。实现与 extension backend 共用 browser-core/playwright/locator，
 * 避免两套 selector/actionability 算法漂移。
 */
export async function executeIabPlaywrightLocator(
  view: ControlledView,
  action: LocatorAction,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IabLocatorExecution> {
  return executePlaywrightLocator(
    createPlaywrightPageFromControlledView(view),
    action,
    timeoutMs,
    signal,
    logger,
  );
}
