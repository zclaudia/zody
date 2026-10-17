import { resolveLocalHelpAppConfig, type Locale } from "@zcode/shared";
import localDefaultAppConfig from "../../../config/default.json" with { type: "json" };

interface ResolveWebHelpConfigOptions {
  localConfig?: unknown;
}

/**
 * fork（F2.7）：Web 端帮助与社群配置同样只读内置 config/default.json。
 * 原实现会向部署 endpoint 请求 /api/v1/client/configs（buildHelpAppConfigUrl +
 * createHelpAppConfigReader），现在不再构造/发起任何远端请求。
 */
export async function resolveWebHelpConfig(options: ResolveWebHelpConfigOptions = {}) {
  return resolveLocalHelpAppConfig(options.localConfig ?? localDefaultAppConfig);
}

export async function resolveWebCommunityUrl(
  locale: Locale,
  options: ResolveWebHelpConfigOptions = {},
): Promise<string | undefined> {
  return (await resolveWebHelpConfig(options)).community_urls?.[locale];
}
