import {
  installDocumentHiddenMotionPause,
  installMobileKeyboardInsetTracker,
} from "@zody/ui/mobile-shell";
import "@zody/ui/styles.css";
import { applyWebThemePreference } from "../webThemePreference.js";
import { bootstrapMobileShell } from "./bootstrap.js";

/**
 * Shell 入口（`mobile-shell.html`，M2-T1）。
 *
 * 只初始化轻壳页面需要的主题、安全区和键盘避让，不初始化 Gateway transport、流式
 * clientId 或 Remote 工作台。配置、discovery 与 openRemote 由 `bootstrapMobileShell`
 * 通过原生 `ZodyShellBridge` 完成。
 */

installDocumentHiddenMotionPause();
installMobileKeyboardInsetTracker();
applyWebThemePreference();

void bootstrapMobileShell(new URLSearchParams(window.location.search));
