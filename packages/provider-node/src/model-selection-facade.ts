import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/**
 * Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。
 *
 * fork（F4.11）：官方账号 Provider（account-plan）与闲时（account-offpeak）分类已随
 * 账号/闲时链路删除，Facade 不再接收 provider 分类器，只保留 legacy reasoning level 解析。
 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(source, resolveLegacyReasoningLevel);
}
