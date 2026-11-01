/**
 * IAB 兼容入口：实现已迁移到 browser-core/playwright/virtualClipboard，
 * 与 extension backend 共用同一套 focused-frame / OOPIF / 虚拟粘贴算法。
 */
import {
  assertFocusedInputTargetOnPage,
  BROWSER_INPUT_TARGET_TOKEN_PROPERTY,
  createInputTargetToken,
  pasteTextIntoFocusedTargetOnPage,
  type BrowserInputExecutionTarget,
} from "../../browser-core/playwright/virtualClipboard.js";
import type { ControlledView } from "./browserCommandTypes.js";
import { createPlaywrightPageFromControlledView } from "./browserPlaywrightPageAdapter.js";

export type { BrowserInputExecutionTarget } from "../../browser-core/playwright/virtualClipboard.js";
export { createInputTargetToken } from "../../browser-core/playwright/virtualClipboard.js";

/** 保持原导出名，避免 IAB 调用点与页面脚本的 token 属性漂移。 */
export const IAB_INPUT_TARGET_TOKEN_PROPERTY = BROWSER_INPUT_TARGET_TOKEN_PROPERTY;

export async function assertFocusedInputTarget(
  view: ControlledView,
  target: BrowserInputExecutionTarget,
  inputTargetToken: string,
): Promise<void> {
  await assertFocusedInputTargetOnPage(
    createPlaywrightPageFromControlledView(view),
    target,
    inputTargetToken,
  );
}

export async function pasteTextIntoFocusedTarget(
  view: ControlledView,
  text: string,
  options: {
    includeRichText?: boolean;
    initialTarget?: BrowserInputExecutionTarget;
    inputTargetToken?: string;
    replaceInputValue?: boolean;
  } = {},
): Promise<void> {
  await pasteTextIntoFocusedTargetOnPage(
    createPlaywrightPageFromControlledView(view),
    text,
    options,
  );
}
