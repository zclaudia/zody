import type { BrowserControlMainBridge } from "./browserControlMainBridge.js";
import type { BrowserControlBackend } from "./browserControlRouter.js";

/** 旧 IAB bridge 的 router 适配：identity 仍由 bridge 自行校验 generation。 */
export function createIabBrowserControlBackend(
  bridge: BrowserControlMainBridge,
): BrowserControlBackend {
  return {
    owns(browserId) {
      return browserId === "legacy-iab" || browserId.startsWith("iab:");
    },
    list() {
      return bridge.list();
    },
    execute(context, command) {
      return bridge.execute({
        ...context,
        browserId: context.browserId,
        browserGeneration: context.browserGeneration,
        command,
      });
    },
  };
}
