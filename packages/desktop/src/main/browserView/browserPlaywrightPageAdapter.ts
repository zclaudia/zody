import type { PlaywrightPage } from "../../browser-core/playwright/types.js";
import type { ControlledView } from "./browserCommandTypes.js";

/**
 * 把 IAB 的 ControlledView 适配到 backend-neutral PlaywrightPage。
 *
 * Host 内部 sessionId 仍是 Electron debugger 的 sessionId；extension adapter 会把同一个
 * opaque sessionId 映射到 targetId。Playwright 算法本身不再直接依赖 ControlledView。
 */
export function createPlaywrightPageFromControlledView(view: ControlledView): PlaywrightPage {
  return {
    // 保持 IAB 既有调用形状：主页面没有 sessionId 时只传两个参数，
    // 避免给 Electron debugger 适配器和既有测试注入无意义的 undefined。
    send: (method, params, sessionId) =>
      sessionId == null ? view.cdp.send(method, params) : view.cdp.send(method, params, sessionId),
    attachToTarget: async (targetId) => {
      const attached = (await view.cdp.send("Target.attachToTarget", {
        flatten: true,
        targetId,
      })) as { sessionId?: string } | undefined;
      return attached?.sessionId;
    },
    detachFromTarget: async (sessionId) => {
      await view.cdp.send("Target.detachFromTarget", { sessionId });
    },
    pageUrl: () => {
      try {
        return view.webContents.getURL();
      } catch {
        return "";
      }
    },
    platform: process.platform,
  };
}
