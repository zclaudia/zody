import {
  zodyProtocolMethods,
  zodyPluginsReferenceCatalogResultSchema,
  type ZodyPluginsReferenceCatalogParams,
} from "@zody/shared";
import type { ZodyProtocolClient } from "#src/zody-agent/zodyProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<ZodyProtocolClient, "request">,
  params: ZodyPluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      zodyProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      zodyPluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      zodyProtocolMethods.pluginsReferenceCatalog,
      params,
      zodyPluginsReferenceCatalogResultSchema,
    );
  }
}
