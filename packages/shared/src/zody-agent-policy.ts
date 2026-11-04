import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { ZodyProvider } from "./zody-task-types-core.js";

export const ZODY_AGENT_PROVIDER = "glm" satisfies ZodyProvider;
export const ZODY_AGENT_PROVIDER_LABEL = "Zody Agent";
export const ZODY_COMMAND_AGENT_SOURCE = "zcodeAgent" satisfies CommandAgentSource;

/**
 * 解析持久化/relay 数据时的 provider 归一 schema：
 * 已移除的第三方 provider 历史值仅作为归一化输入保留，统一收敛为 glm；
 * 其它非法值保持拒绝，与收窄前的校验边界一致。
 */
export const legacyZodyProviderSchema = z
  .enum(["claude", "opencode", "gemini", "codex", "glm"])
  .transform((): typeof ZODY_AGENT_PROVIDER => ZODY_AGENT_PROVIDER);

export const ZODY_ENABLED_AGENT_PROVIDERS = [
  ZODY_AGENT_PROVIDER,
] as const satisfies readonly ZodyProvider[];

export const ZODY_COMMAND_AGENT_SOURCES = [
  ZODY_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToZodyAgent(
  _provider?: ZodyProvider | null,
): ZodyProvider {
  return ZODY_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToZodyAgent(
  _providers?: ReadonlyArray<ZodyProvider> | null,
): ZodyProvider[] {
  return [...ZODY_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToZodyAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return ZODY_COMMAND_AGENT_SOURCE;
}

export function isZodyAgentProvider(
  provider: ZodyProvider | null | undefined,
): provider is typeof ZODY_AGENT_PROVIDER {
  return provider === ZODY_AGENT_PROVIDER;
}
