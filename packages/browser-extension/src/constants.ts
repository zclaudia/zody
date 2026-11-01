/** manifest.json 的 package version；offscreen 文档不保证暴露 runtime.getManifest()。 */
export const EXTENSION_VERSION = "0.1.0";

/** 由 manifest 固定 `key` 推导；作为 runtime.id 不可用时的稳定 fallback。 */
export { EXTENSION_BRIDGE_EXTENSION_ID as EXTENSION_ID } from "@zcode/shared/browser-extension-transport";
