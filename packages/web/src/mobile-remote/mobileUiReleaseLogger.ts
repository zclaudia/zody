import { logger as uiLogger } from "@zody/ui/logger";
import type { MobileUiReleaseLogger } from "./mobileUiReleaseControllerContracts.js";

/**
 * M3-T2 release controller 日志适配。
 *
 * 必须复用 `@zody/ui/logger` 的公开子入口（`@zody/ui/logger`）：
 * - 统一 `[ui]` 前缀、生产构建 no-op 门控和桌面桥转发；
 * - 不在 `packages/web` 新增 console 路径，也不从相对路径深入 UI 实现；
 * - 只转发 controller 提供的诊断字段；session、credential、URL 由 controller 保证不传入。
 */
const MOBILE_UI_RELEASE_LOG_SCOPE = "[mobile-ui-release]";

export function createMobileUiReleaseLogger(): MobileUiReleaseLogger {
  return {
    debug: (message, context) =>
      uiLogger.debug(MOBILE_UI_RELEASE_LOG_SCOPE, message, context ?? {}),
    info: (message, context) => uiLogger.info(MOBILE_UI_RELEASE_LOG_SCOPE, message, context ?? {}),
    warn: (message, context) => uiLogger.warn(MOBILE_UI_RELEASE_LOG_SCOPE, message, context ?? {}),
    error: (message, context) =>
      uiLogger.error(MOBILE_UI_RELEASE_LOG_SCOPE, message, context ?? {}),
  };
}
