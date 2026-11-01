import type { BrowserClientMode } from "@zcode/shared";

/**
 * 窗口默认 backend 只对 desktop-continuous 生效。手机 replay 首版不返回 extension
 * discovery，也不能继承桌面窗口选择的外部 Chrome 默认。
 */
export function resolveExtensionDefaultBrowserId(
  windowDefaultBrowserId: string | undefined,
  clientMode: BrowserClientMode,
): string | undefined {
  return clientMode === "web-remote-replayable" ? undefined : windowDefaultBrowserId;
}
