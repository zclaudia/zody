import type { Theme } from "@zcode/ui";
import {
  WEB_REMOTE_CONTROL_DEFAULT_THEME,
  resolveWebRemoteControlInitialTheme,
} from "./webRemoteControlThemeSeed.js";

/**
 * Web 端主题偏好（T1.2 迁出 `main.tsx`）。
 * 桌面 Web 客户端与手机入口（mobile.html）共用：先解析存储偏好，再在业务 bundle 挂载前
 * 把主题写到 html 根上，避免首屏主题闪烁。挂载后由 useTheme hook 接管。
 */

export function resolveWebThemePreference(
  defaultTheme: Theme = WEB_REMOTE_CONTROL_DEFAULT_THEME,
): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({ storedTheme: saved, defaultTheme });
}

export function applyWebThemePreference(defaultTheme?: Theme): void {
  const saved = resolveWebThemePreference(defaultTheme);
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}
