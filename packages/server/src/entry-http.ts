import { createLocalServices, getAppConfigDir } from "@zody/services/node";
import {
  materializeBundledZodyBuiltinProviderConfig,
  readBundledZodyBuiltinProviderConfig,
} from "./bundledZodyBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const zodyBuiltinProviderConfigFilePath = await materializeBundledZodyBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZodyBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host =
    process.env["ZODY_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || "127.0.0.1";
  const staticRoot = process.env["ZODY_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZODY_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // fork（bot channels 移除）：topic-resource relay（createTopicResourcePeers /
  // topicResourceRelayChannel）是第三方 IM bot 的资源回传链，随 bot channels 整体删除。
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: zodyBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
