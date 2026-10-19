// 缩放档位与倍率规则统一由 @zcode/shared 提供，侧栏偏好面板的百分比与 main 进程共用同一事实源
// （spec: docs/desktop/sidebar-zoom-menu.md）。
export {
  DESKTOP_ZOOM_MAX_LEVEL,
  DESKTOP_ZOOM_MIN_LEVEL,
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "@zcode/shared";
