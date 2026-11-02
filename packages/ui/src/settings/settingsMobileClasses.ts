/**
 * 设置页触控/移动呈现共用 class。
 *
 * 触控命中区严格按 D1 的 `(hover: none) and (pointer: coarse)` 作用域补足；
 * 桌面与普通窄窗口不会命中，视觉密度保持原样（spec:
 * docs/web-remote-control/mobile-viewport-input-and-touch.md §1）。
 */
export const SETTINGS_TOUCH_MIN_H_11_CLASS = "[@media(hover:none)_and_(pointer:coarse)]:min-h-11";

/** 图标按钮需要同时补宽高，44×44px 才算完整命中区。 */
export const SETTINGS_TOUCH_MIN_SIZE_11_CLASS = "[@media(hover:none)_and_(pointer:coarse)]:size-11";

/** iOS Safari 聚焦小于 16px 的输入会缩放；只在触屏态套用固定兼容字号。 */
export const SETTINGS_MOBILE_INPUT_SAFE_CLASS =
  "[@media(hover:none)_and_(pointer:coarse)]:text-mobile-input-safe";
