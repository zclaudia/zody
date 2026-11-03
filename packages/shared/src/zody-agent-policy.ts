import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { ZodyProvider } from "./zody-task-types-core.js";

export const ZCODE_AGENT_PROVIDER = "glm" satisfies ZodyProvider;
export const ZCODE_AGENT_PROVIDER_LABEL = "Zody Agent";
export const ZCODE_COMMAND_AGENT_SOURCE = "zcodeAgent" satisfies CommandAgentSource;

/**
 * 解析持久化/relay 数据时的 provider 归一 schema：
 * 已移除的第三方 provider 历史值仅作为归一化输入保留，统一收敛为 glm；
 * 其它非法值保持拒绝，与收窄前的校验边界一致。
 */
export const legacyZodyProviderSchema = z
  .enum(["claude", "opencode", "gemini", "codex", "glm"])
  .transform((): typeof ZCODE_AGENT_PROVIDER => ZCODE_AGENT_PROVIDER);

export const ZCODE_ENABLED_AGENT_PROVIDERS = [
  ZCODE_AGENT_PROVIDER,
] as const satisfies readonly ZodyProvider[];

export const ZCODE_COMMAND_AGENT_SOURCES = [
  ZCODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToZodyAgent(
  _provider?: ZodyProvider | null,
): ZodyProvider {
  return ZCODE_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToZodyAgent(
  _providers?: ReadonlyArray<ZodyProvider> | null,
): ZodyProvider[] {
  return [...ZCODE_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToZodyAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return ZCODE_COMMAND_AGENT_SOURCE;
}

export function isZodyAgentProvider(
  provider: ZodyProvider | null | undefined,
): provider is typeof ZCODE_AGENT_PROVIDER {
  return provider === ZCODE_AGENT_PROVIDER;
}
