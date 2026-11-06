export const HELPER_APP_NAME = "Zody Computer Use.app";
export const DEV_HELPER_APP_NAME = "Zody Computer Use Dev.app";
export const HELPER_DISPLAY_NAME = "Zody Computer Use";
export const HELPER_BUNDLE_ID = "dev.zcode.cua-helper";
export const DEV_CUA_HELPER_BUNDLE_ID = "dev.zcode.cua-helper.dev";
// 上游 v3.17.1（a60ba6a7）：Windows 产品链 fork argv 末位恒开 ghost cursor overlay，
// 漏传时 helper 侧 OverlayEnabled() 恒 false、agent 光标完全不渲染。
export const HELPER_GHOST_CURSOR_OVERLAY_ARG = "--ghost-cursor-overlay";
