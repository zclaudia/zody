export { normalizeBrowserDomSnapshot } from "../../browser-core/playwright/domSnapshot.js";
import { capturePlaywrightDomSnapshot } from "../../browser-core/playwright/domSnapshot.js";
import type { ControlledView } from "./browserCommandTypes.js";
import { createPlaywrightPageFromControlledView } from "./browserPlaywrightPageAdapter.js";

/** IAB DOM snapshot 入口；算法与 extension backend 共用 browser-core/playwright/domSnapshot。 */
export async function captureBrowserDomSnapshot(
  view: ControlledView,
  signal?: AbortSignal,
): Promise<string> {
  return capturePlaywrightDomSnapshot(createPlaywrightPageFromControlledView(view), signal);
}
