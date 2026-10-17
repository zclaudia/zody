import { isDesktopAutoUpdateActive, type UpdateStatePayload } from "@zcode/shared";

// 更新入口只跟随唯一判定 isDesktopAutoUpdateActive()（fork spec「自动更新」规则 1/3）：
// production 安装身份且构建期启用自动更新才显示。Preview 身份与 fork 构建都直接隐藏入口，
// 不再按产品身份单独拼条件，也不能只依赖 main 进程点击后的 fail-closed 兜底。
export function shouldShowDesktopUpdateEntry(): boolean {
  return isDesktopAutoUpdateActive();
}

export function getUpdateMenuLabelId(state: UpdateStatePayload | null) {
  switch (state?.kind) {
    case "checking":
      return "desktopMenu.help.checkingForUpdates";
    case "update-available":
      return "desktopMenu.help.updateAvailableVersion";
    case "download-progress":
      return "desktopMenu.help.downloadingUpdateProgress";
    case "update-downloaded":
      return "desktopMenu.help.restartToUpdate";
    case "idle":
    default:
      return "titleBar.menu.help.checkForUpdates";
  }
}

export function getUpdateMenuLabelValues(
  state: UpdateStatePayload | null,
): Record<string, string> | undefined {
  switch (state?.kind) {
    case "update-available":
    case "update-downloaded":
      return { version: state.version };
    case "download-progress":
      return { progress: state.progress };
    default:
      return undefined;
  }
}
