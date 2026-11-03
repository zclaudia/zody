import {
  createMobileUiReleaseControllerState,
  type MobileUiReleaseController,
  type MobileUiReleaseControllerOptions,
} from "./mobileUiReleaseControllerContracts.js";
import { createMobileUiReleaseRuntime } from "./mobileUiReleaseControllerRuntime.js";
import { createMobileUiRefreshGuardRegistry } from "./mobileUiRefreshGuards.js";

/**
 * 手机 Remote 发布检测与安全刷新控制器（M3-T1 公开入口）。
 *
 * 产品规则与事件顺序见 spec 第 9.3、10、11 M3 节。实现按职责拆分：
 * - `mobileUiReleaseControllerContracts.ts`：公开类型、常量、可注入适配器；
 * - `mobileUiReleaseControllerRuntime.ts`：轮询、前后台/网络生命周期、二次确认、手动入口；
 * - `mobileUiReleaseControllerApply.ts`：guard → 重新请求 → native veto → reload 决策；
 * - `mobileUiReleaseDto.ts`：HTTP/DOM 到严格 manifest observation 的 DTO 适配；
 * - `mobileUiRefreshGuards.ts`：草稿/文件/弹层等状态所有者的只读 guard 注册表。
 */
export * from "./mobileUiReleaseControllerContracts.js";

export function createMobileUiReleaseController(
  options: MobileUiReleaseControllerOptions,
): MobileUiReleaseController {
  const guards = options.guards ?? createMobileUiRefreshGuardRegistry();
  const state = createMobileUiReleaseControllerState();
  return createMobileUiReleaseRuntime(options, state, guards);
}
