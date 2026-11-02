import { DesktopSessionBuildError } from "./cua-desktop-session-config.mjs";

export function stopBuildError(code, message, details) {
  return new DesktopSessionBuildError(`stop-visual-${code}`, message, details);
}
