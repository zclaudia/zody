import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
} from "@zody/provider";
import { NodePersonalProviderConfigRepository } from "@zody/provider-node";
import { getE2EAppDataPaths } from "./desktop-app.js";

export const CUA_SCREENSHOT_PROVIDER = "e2e-cua-screenshot";
export const CUA_SCREENSHOT_MODEL = "cua-screenshot-fixture";

/** 独立回环 provider；绝不读取 capture 模式凭据或真实用户配置。 */
export async function seedCuaScreenshotProvider(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("CUA R1 provider must use HTTP loopback");
  }
  const repository = new NodePersonalProviderConfigRepository({
    filePath: getE2EAppDataPaths().configFile,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.setRule({
        providerId: CUA_SCREENSHOT_PROVIDER,
        providerName: "CUA R1 fixture",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "cua-r1-loopback-fixture" }),
          api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl }),
          personalModelIds: [CUA_SCREENSHOT_MODEL],
        }),
      }),
      models: current.models.setExact(
        CUA_SCREENSHOT_PROVIDER,
        CUA_SCREENSHOT_MODEL,
        new ModelConfig({
          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: false,
            contextWindow: 200000,
            inputFormat: {
              supportsText: true,
              supportsImage: true,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: false,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          }),
          optionSpecs: new ModelOptionSpecsConfig({
            maxOutputTokens: { max: 32000 },
          }),
        }),
      ),
    }));
  } finally {
    repository.dispose();
  }
}
