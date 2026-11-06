import { readFile } from "node:fs/promises";
import { compileModelOptionMaps } from "@zody/model-option-map";
import { fileURLToPath } from "node:url";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderApiConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
} from "@zody/provider";
import { describe, expect, it } from "vitest";
import {
  NodeZodyBuiltinProviderConfigSource,
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../src/index.js";

// 发布验证必须指向最终上传的那份文件，而不是默认悄悄检查仓库源文件。
const zodyBuiltinProviderConfigFilePath =
  process.env.ZODY_BUILTIN_RELEASE_TEST_FILE?.trim() ||
  fileURLToPath(new URL("../../../config/provider/zody-builtin.json", import.meta.url));

function reasoningPatch(map: string, reasoningLevel: string) {
  return compileModelOptionMaps({ reasoningLevel: { map }, maxOutputTokens: { map: "{}" } }).apply(
    {},
    { reasoningLevel, maxOutputTokens: 32000 },
  );
}

describe("Zody Built-in Provider Config 完整性", () => {
  it.each(["anthropic-messages", "openai-chat-completions", "openai-responses"] as const)(
    "未知模型在 %s 下拥有完整两档兜底并可进入 Registry",
    async (apiType) => {
      const source = new NodeZodyBuiltinProviderConfigSource({
        bundledFilePath: zodyBuiltinProviderConfigFilePath,
        watch: false,
      });
      try {
        const snapshot = await source.read();
        const model = snapshot.models.resolve({
          providerId: "unknown-provider",
          modelId: "future-unknown-model",
          apiType,
          baseUrl: "https://unknown.example/v1",
        });
        expect(model.validateComplete()).toEqual([]);
        expect(model.optionSpecs?.maxOutputTokens?.max).toBe(32_000);
        expect(model.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
        expect(model.properties?.inputFormat.supportsImage).toBe(false);
        const result = new ProviderConfigResolver().resolve({
          zodyBuiltinProviders: snapshot.providers,
          zodyBuiltinProviderTemplates: snapshot.providerTemplates,
          accountProviders: ProviderConfigMap.empty(),
          zodyBuiltinModelRules: snapshot.models,
          personalModels: ModelConfigRules.empty(),
          personalProviders: new ProviderConfigMap([
            [
              "unknown-provider",
              new ProviderConfig({
                group: "standard-personal",
                api: new ProviderApiConfig({
                  type: apiType,
                  baseUrl: "https://unknown.example/v1",
                }),
                access: new ApiKeyAccessConfig({ apiKey: "test-only" }),
                personalModelIds: ["future-unknown-model"],
              }),
            ],
          ]),
        });
        expect(
          result.registryProviders
            .find((entry) => entry.providerId === "unknown-provider")
            ?.models.map((entry) => entry.modelId),
        ).toContain("future-unknown-model");
      } finally {
        source.dispose();
      }
    },
  );
  it("GLM-5.3-Flash 的媒体输入能力在 BYOK 模板上保持明确", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const rawRelease = JSON.parse(await readFile(zodyBuiltinProviderConfigFilePath, "utf8")) as {
        revision: number;
        config: { modelConfigRules: Record<string, unknown> };
      };
      expect(rawRelease.config.modelConfigRules).toMatchObject({
        modelRules: expect.any(Array),
        modelApiRules: expect.any(Array),
        providerSiteRules: expect.any(Array),
        templateModelRules: expect.any(Array),
        builtinProviderModelRules: expect.any(Array),
      });
      expect(rawRelease.config.modelConfigRules).not.toHaveProperty("matchRules");
      expect(snapshot.revision).toMatch(
        new RegExp(`^zcode-builtin:${rawRelease.revision}:[a-f0-9]{64}$`, "u"),
      );
      const apiTemplateIds = [
        "zai-api",
        "bigmodel-api",
        "zai-standard-api",
        "bigmodel-standard-api",
      ] as const;
      for (const templateId of apiTemplateIds) {
        const modelIds = snapshot.providerTemplates?.get(templateId)?.config.builtinModelIds ?? [];
        expect(modelIds, `${templateId} 必须同时提供 GLM-5.3 系列`).toEqual(
          expect.arrayContaining(["GLM-5.3", "GLM-5.3-Flash"]),
        );
      }

      // fork（F4.1a）：官方账号 provider 已从 Built-in Config 下线，不再声明任何
      // account:* provider 与其模型规则；模板（BYOK API key）保留。
      expect([...snapshot.providers.keys()]).toEqual([]);

      const resolve = (modelId: string) =>
        snapshot.models.resolve({
          providerId: "personal-zai",
          templateId: "zai-api",
          modelId,
          apiType: "anthropic-messages",
          // 模型层自身能力与 §6.3.1 已批准的站点覆盖分开验证。
          baseUrl: "https://other.example.com/anthropic",
        });
      const glm53 = resolve("glm-5.3").toJSON();
      const glm53Flash = resolve("glm-5.3-flash").toJSON();

      expect(glm53.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "high", "max"],
      });
      expect(glm53.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(reasoningPatch(glm53.optionSpecs!.reasoningLevel!.map!, "low")).toMatchObject({
        output_config: { effort: "low" },
      });
      expect(glm53.properties?.inputFormat).toMatchObject({
        supportsImage: false,
        supportsVideo: false,
      });

      expect(glm53Flash).toEqual({
        ...glm53,
        properties: {
          ...glm53.properties,
          inputFormat: {
            ...glm53.properties?.inputFormat,
            supportsImage: true,
            supportsVideo: true,
            supportsPdf: true,
          },
        },
      });
      const glm53FlashChat = snapshot.models.resolve({
        providerId: "personal-zai",
        templateId: "zai-api",
        modelId: "glm-5.3-flash",
        apiType: "openai-chat-completions",
        baseUrl: "https://api.z.ai/api/anthropic",
      });
      expect(glm53FlashChat.properties?.inputFormat.supportsPdf).toBe(true);
    } finally {
      source.dispose();
    }
  });

  it("按当前官方证据声明各厂商主推模型和关键静态属性", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      // F08（上游 v3.17.1 rev43）：各厂商主推模型列表前缀随上游更新。
      expect(
        snapshot.providerTemplates?.get("moonshot-kimi")?.config.builtinModelIds.slice(0, 3),
      ).toEqual(["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"]);
      expect(
        snapshot.providerTemplates?.get("minimax")?.config.builtinModelIds.slice(0, 3),
      ).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7"]);
      for (const providerId of ["qwen-alibaba-model-studio-cn", "qwen-alibaba-model-studio-intl"]) {
        expect(
          snapshot.providerTemplates?.get(providerId)?.config.builtinModelIds.slice(0, 2),
        ).toEqual(["qwen3.8-max", "qwen3.8-flash"]);
      }
      expect(snapshot.providerTemplates?.get("openai")?.config.builtinModelIds.slice(0, 4)).toEqual(
        ["gpt-6-astra", "gpt-5.6-terra", "gpt-6.1-sol", "gpt-6-luna"],
      );

      const resolve = (
        providerId: string,
        modelId: string,
        apiType: "anthropic-messages" | "openai-chat-completions" | "openai-responses",
        baseUrl: string,
      ) => snapshot.models.resolve({ providerId, modelId, apiType, baseUrl });

      const qwen38 = resolve(
        "qwen-alibaba-model-studio-intl",
        "qwen3.8-flash",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      );
      expect(qwen38.properties?.toJSON()).toMatchObject({
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
          supportsAudio: false,
          supportsPdf: false,
        },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
      });
      expect(qwen38.optionSpecs?.maxOutputTokens).toMatchObject({
        max: 131_072,
      });

      const mimo = resolve(
        "xiaomi-mimo",
        "mimo-v2.5",
        "anthropic-messages",
        "https://api.xiaomimimo.com/anthropic",
      );
      expect(mimo.properties?.inputFormat.toJSON()).toMatchObject({
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: true,
      });

      const kimiCode = resolve(
        "moonshot-kimi",
        "kimi-k2.7-code",
        "anthropic-messages",
        "https://api.moonshot.cn/anthropic",
      );
      expect(kimiCode.properties?.contextWindow).toBe(262_144);
      expect(kimiCode.properties?.inputFormat.toJSON()).toMatchObject({
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
      });

      const kimiK3 = resolve(
        "moonshot-kimi",
        "kimi-k3",
        "anthropic-messages",
        "https://api.moonshot.cn/anthropic",
      );
      expect(kimiK3.properties?.toJSON()).toMatchObject({
        contextWindow: 1_048_576,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
        },
      });

      const kimiK3Compact = resolve(
        "moonshot-kimi",
        "k3-256k",
        "anthropic-messages",
        "https://api.kimi.com/coding/",
      );
      expect(kimiK3Compact.properties?.toJSON()).toMatchObject({
        contextWindow: 262_144,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
        },
      });

      const minimax = resolve(
        "minimax",
        "MiniMax-M2.7",
        "anthropic-messages",
        "https://api.minimaxi.com/anthropic",
      );
      expect(minimax.properties?.toJSON()).toMatchObject({
        contextWindow: 204_800,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
        },
      });

      const minimaxM3 = resolve(
        "minimax",
        "MiniMax-M3",
        "anthropic-messages",
        "https://api.minimaxi.com/anthropic",
      );
      expect(minimaxM3.properties?.toJSON()).toMatchObject({
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
        },
      });
    } finally {
      source.dispose();
    }
  });

  it("MiMo API 与 Token Plan 是独立模板，端点与模型成员互不越界", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const api = snapshot.providerTemplates?.get("xiaomi-mimo");
      const tokenPlan = snapshot.providerTemplates?.get("xiaomi-mimo-token-plan");
      expect(api?.templateNameMap).toEqual({
        "zh-CN": "Xiaomi MiMo API",
        "en-US": "Xiaomi MiMo API",
      });
      expect(tokenPlan?.templateNameMap).toEqual({
        "zh-CN": "Xiaomi MiMo Token Plan",
        "en-US": "Xiaomi MiMo Token Plan",
      });
      expect(api?.config.access).toMatchObject({
        type: "api-key",
        apiKeyManagementUrl: "https://platform.xiaomimimo.com/",
      });
      expect(tokenPlan?.config.access).toMatchObject({
        type: "api-key",
        apiKeyManagementUrl: "https://platform.xiaomimimo.com/",
      });
      expect(api?.config.api?.type).toBe("anthropic-messages");
      expect(tokenPlan?.config.api?.type).toBe("anthropic-messages");
      expect(api?.config.api?.baseUrl).toBe("https://api.xiaomimimo.com/anthropic");
      expect(tokenPlan?.config.api?.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/anthropic");
      expect(tokenPlan?.config.api?.baseUrl).not.toBe(api?.config.api?.baseUrl);
      // 厂商已于 2026-10-21 下线 v2.5：两个模板都只声明 v2.6，旧 v2.5 Personal 由下方用例覆盖。
      expect(api?.config.builtinModelIds).toEqual(["mimo-v2.6-pro", "mimo-v2.6-flash"]);
      expect(tokenPlan?.config.builtinModelIds).toEqual(["mimo-v2.6-pro", "mimo-v2.6-flash"]);
      expect(api?.config.builtinModelIds).not.toContain("mimo-v2.5");
      expect(tokenPlan?.config.builtinModelIds).not.toContain("mimo-v2.5");
    } finally {
      source.dispose();
    }
  });

  it("MiMo v2.6 与 v2.5 模型规则分别命中，能力不串用", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const resolve = (templateId: string, modelId: string) => {
        const template = snapshot.providerTemplates?.get(templateId);
        expect(template, `${templateId} 模板必须存在`).toBeDefined();
        return snapshot.models.resolve({
          providerId: `template:${templateId}`,
          templateId,
          modelId,
          apiType: "anthropic-messages",
          baseUrl: template!.config.api!.baseUrl,
        });
      };
      const assertV26 = (owner: string, modelId: string, model: ReturnType<typeof resolve>) => {
        expect(model.enabled, `${owner}/${modelId} 必须默认启用`).toBe(true);
        expect(model.validateComplete(["templates", owner, "models", modelId])).toEqual([]);
        expect(model.properties?.toJSON(), `${owner}/${modelId}`).toMatchObject({
          contextWindow: 1_000_000,
          inputFormat: {
            supportsText: true,
            supportsImage: true,
            supportsVideo: true,
            supportsAudio: true,
            supportsPdf: false,
          },
        });
        expect(model.optionSpecs?.maxOutputTokens?.max, `${owner}/${modelId}`).toBe(131_072);
        expect(model.optionSpecs?.reasoningLevel?.values, `${owner}/${modelId}`).toEqual([
          "disabled",
          "enabled",
        ]);
        // 复审要求：Map 必须真正 apply，否则 map 写错不会有任何用例失败。
        expect(reasoningPatch(model.optionSpecs!.reasoningLevel!.map!, "enabled")).toEqual({
          thinking: { type: "enabled" },
        });
        expect(reasoningPatch(model.optionSpecs!.reasoningLevel!.map!, "disabled")).toEqual({
          thinking: { type: "disabled" },
        });
      };

      for (const modelId of ["mimo-v2.6-pro", "mimo-v2.6-flash"]) {
        const apiModel = resolve("xiaomi-mimo", modelId);
        assertV26("xiaomi-mimo", modelId, apiModel);
        const tokenPlanModel = resolve("xiaomi-mimo-token-plan", modelId);
        assertV26("xiaomi-mimo-token-plan", modelId, tokenPlanModel);
        // 端点差异只属于模板，不能派生第二份模型能力。
        expect(tokenPlanModel.properties?.toJSON()).toEqual(apiModel.properties?.toJSON());
        expect(tokenPlanModel.optionSpecs?.toJSON()).toEqual(apiModel.optionSpecs?.toJSON());
      }

      // 厂商另有独立的 mimo-v2.6-pro-ultraspeed，套餐权益与参数未核验；
      // 规则必须精确匹配，不能按名称亲属关系继承 v2.6 的全模态与 1M 上下文。
      for (const templateId of ["xiaomi-mimo", "xiaomi-mimo-token-plan"]) {
        const ultraspeed = resolve(templateId, "mimo-v2.6-pro-ultraspeed");
        expect(ultraspeed.properties?.contextWindow, templateId).toBe(200_000);
        expect(ultraspeed.properties?.inputFormat.toJSON(), templateId).toMatchObject({
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
        });
        expect(ultraspeed.optionSpecs?.maxOutputTokens?.max, templateId).toBe(32_000);
      }

      // v2.5 已退出模板成员，但规则保留给存量 Personal 配置解析；
      // 它不能被 v2.6 全模态规则覆盖，v2.5-pro 仍是纯文本模型。
      const v25Pro = resolve("xiaomi-mimo", "mimo-v2.5-pro");
      expect(v25Pro.enabled).toBe(true);
      expect(v25Pro.properties?.contextWindow).toBe(1_000_000);
      expect(v25Pro.properties?.inputFormat.toJSON()).toMatchObject({
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
      });
      expect(v25Pro.optionSpecs?.maxOutputTokens?.max).toBe(131_072);
      expect(v25Pro.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
      const v25 = resolve("xiaomi-mimo", "mimo-v2.5");
      expect(v25.enabled).toBe(true);
      expect(v25.properties?.contextWindow).toBe(1_000_000);
      expect(v25.properties?.inputFormat.toJSON()).toMatchObject({
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: true,
      });
      expect(v25.optionSpecs?.maxOutputTokens?.max).toBe(131_072);
      expect(v25.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
    } finally {
      source.dispose();
    }
  });

  it("MiMo v2.6 规则命中带厂商/网关前缀的模型 ID 与 [1m] 标记，且不误伤 ultraspeed", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      // 聚合站点与网关会透传带前缀的模型 ID；厂商 Claude Code 接入页还支持 `[1m]` 后缀
      // 显式选择 1M 上下文变体。v2.6 能力规则必须同时命中这些写法。
      // 复审反例（2026-10-24）：规则收敛为裸 ID 后，vendor/、gateway/vendor/ 前缀会落回 200K/32K 兜底。
      const resolve = (modelId: string) =>
        snapshot.models.resolve({
          providerId: "aggregate-gateway-instance",
          modelId,
          apiType: "anthropic-messages",
        });

      for (const [variantModelId, directModelId] of [
        ["vendor/mimo-v2.6-pro", "mimo-v2.6-pro"],
        ["vendor/mimo-v2.6-flash", "mimo-v2.6-flash"],
        ["gateway/vendor/mimo-v2.6-pro", "mimo-v2.6-pro"],
        ["gateway/vendor/mimo-v2.6-flash", "mimo-v2.6-flash"],
        // `[1m]` 是厂商接入层的 1M 上下文标记，不是新型号；能力必须与裸 ID 完全一致。
        ["mimo-v2.6-pro[1m]", "mimo-v2.6-pro"],
        ["mimo-v2.6-flash[1m]", "mimo-v2.6-flash"],
        ["vendor/mimo-v2.6-pro[1m]", "mimo-v2.6-pro"],
        ["gateway/vendor/mimo-v2.6-flash[1m]", "mimo-v2.6-flash"],
      ] as const) {
        const variant = resolve(variantModelId);
        const direct = resolve(directModelId);
        expect(variant.properties?.toJSON(), variantModelId).toEqual(direct.properties?.toJSON());
        expect(variant.optionSpecs?.toJSON(), variantModelId).toEqual(direct.optionSpecs?.toJSON());
        expect(variant.properties?.contextWindow, variantModelId).toBe(1_000_000);
        expect(variant.properties?.inputFormat.toJSON(), variantModelId).toMatchObject({
          supportsImage: true,
          supportsVideo: true,
          supportsAudio: true,
        });
        expect(variant.optionSpecs?.maxOutputTokens?.max, variantModelId).toBe(131_072);
        expect(reasoningPatch(variant.optionSpecs!.reasoningLevel!.map!, "enabled")).toEqual({
          thinking: { type: "enabled" },
        });
      }

      // 尾缀仍须精确：ultraspeed 是独立型号，不能按名称亲属关系继承 v2.6 的全模态与输出上限。
      for (const modelId of [
        "vendor/mimo-v2.6-pro-ultraspeed",
        "gateway/vendor/mimo-v2.6-pro-ultraspeed",
      ]) {
        const ultraspeed = resolve(modelId);
        expect(ultraspeed.properties?.contextWindow, modelId).toBe(200_000);
        expect(ultraspeed.properties?.inputFormat.toJSON(), modelId).toMatchObject({
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
        });
        expect(ultraspeed.optionSpecs?.maxOutputTokens?.max, modelId).toBe(32_000);
      }

      // 前缀必须有 `/` 边界：没有分隔符的近似名不能被当成透传 ID。
      for (const modelId of ["notmimo-v2.6-pro", "notmimo-v2.6-flash"]) {
        const lookalike = resolve(modelId);
        expect(lookalike.properties?.contextWindow, modelId).toBe(200_000);
        expect(lookalike.optionSpecs?.maxOutputTokens?.max, modelId).toBe(32_000);
      }
    } finally {
      source.dispose();
    }
  });

  it("MiMo 模板升级不静默改写旧 Personal 的名称、Key、URL 与禁用态", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const personalProviders = new ProviderConfigMap([
        {
          providerId: "my-mimo-api",
          templateId: "xiaomi-mimo",
          providerName: "我的 MiMo API",
          enabled: false,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({
              apiKey: "sk-personal-v25",
              apiKeyManagementUrl: "https://platform.xiaomimimo.com/personal",
            }),
            api: new ProviderApiConfig({
              type: "anthropic-messages",
              baseUrl: "https://api.xiaomimimo.com/anthropic",
            }),
            personalModelIds: ["mimo-v2.5-pro"],
            modelOrder: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5-pro"],
          }),
        },
        {
          providerId: "my-mimo-token-plan-sgp",
          templateId: "xiaomi-mimo-token-plan",
          providerName: "MiMo Token Plan (SGP)",
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({
              apiKey: "tp-personal-sgp",
              apiKeyManagementUrl: "https://platform.xiaomimimo.com/token-plan",
            }),
            api: new ProviderApiConfig({
              type: "anthropic-messages",
              baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
            }),
            personalModelIds: ["mimo-v2.6-pro"],
          }),
        },
      ]);
      const resolution = new ProviderConfigResolver().resolve({
        zodyBuiltinProviders: snapshot.providers,
        zodyBuiltinProviderTemplates: snapshot.providerTemplates,
        accountProviders: ProviderConfigMap.empty(),
        personalProviders,
        zodyBuiltinModelRules: snapshot.models,
        personalModels: ModelConfigRules.empty(),
      });
      expect(resolution.issues).toEqual([]);

      const oldV25 = resolution.resolvedProviders.find(
        (provider) => provider.providerId === "my-mimo-api",
      );
      expect(oldV25).toMatchObject({
        providerName: "我的 MiMo API",
        enabled: false,
        config: {
          access: {
            type: "api-key",
            apiKey: "sk-personal-v25",
            apiKeyManagementUrl: "https://platform.xiaomimimo.com/personal",
          },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://api.xiaomimimo.com/anthropic",
          },
          personalModelIds: ["mimo-v2.5-pro"],
          modelOrder: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5-pro"],
        },
      });
      // v2.5 已退出模板成员，但 Personal 已保存的 v2.5 模型、顺序和禁用态都不能被写回或删除。
      expect(oldV25?.models.map((model) => model.modelId)).toEqual([
        "mimo-v2.6-flash",
        "mimo-v2.6-pro",
        "mimo-v2.5-pro",
      ]);
      expect(oldV25?.models.find((model) => model.modelId === "mimo-v2.5-pro")).toMatchObject({
        source: "personal",
        enabled: true,
        executable: false,
      });
      expect(resolution.registryProviders.map((provider) => provider.providerId)).not.toContain(
        "my-mimo-api",
      );

      const tokenPlanSgp = resolution.resolvedProviders.find(
        (provider) => provider.providerId === "my-mimo-token-plan-sgp",
      );
      expect(tokenPlanSgp).toMatchObject({
        providerName: "MiMo Token Plan (SGP)",
        enabled: true,
        config: {
          access: {
            type: "api-key",
            apiKey: "tp-personal-sgp",
            apiKeyManagementUrl: "https://platform.xiaomimimo.com/token-plan",
          },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
          },
        },
      });
      const tokenPlanRegistry = resolution.registryProviders.find(
        (provider) => provider.providerId === "my-mimo-token-plan-sgp",
      );
      // 海外覆盖 URL 与 Key 管理页必须原样进入 Registry，不能被归一化回模板默认值。
      expect(tokenPlanRegistry?.config.api?.baseUrl).toBe(
        "https://token-plan-sgp.xiaomimimo.com/anthropic",
      );
      expect(tokenPlanRegistry?.config.access).toMatchObject({
        apiKeyManagementUrl: "https://platform.xiaomimimo.com/token-plan",
      });
      expect(tokenPlanRegistry?.models.map((model) => model.modelId)).toEqual([
        "mimo-v2.6-pro",
        "mimo-v2.6-flash",
      ]);

      // 厂商下线 v2.5 是外部事实：Personal 文件里的历史默认选择与已存字段原样往返，不由模板升级迁移。
      const personalFile = decodeProviderConfigFile(
        encodeProviderConfigFile({
          providers: personalProviders,
          models: ModelConfigRules.empty(),
          defaultModelSelection: {
            providerId: "my-mimo-api",
            modelId: "mimo-v2.5-pro",
          },
        }),
      );
      expect(personalFile.defaultModelSelection).toEqual({
        providerId: "my-mimo-api",
        modelId: "mimo-v2.5-pro",
      });
      expect(personalFile.providers.get("my-mimo-api")?.toJSON()).toMatchObject({
        access: {
          apiKey: "sk-personal-v25",
          apiKeyManagementUrl: "https://platform.xiaomimimo.com/personal",
        },
        personalModelIds: ["mimo-v2.5-pro"],
        modelOrder: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5-pro"],
      });
    } finally {
      source.dispose();
    }
  });

  it("生产与测试 Built-in 配置的 MiMo 子集保持一致", async () => {
    // 测试配置当前由人工镜像维护（仓库没有生成/校验脚本），构建测试只校验 schema 与 revision；
    // 这里按 MiMo 子集做 parity，防止两份配置在后续改动中漂移而行为测试仍只读生产文件。
    type BuiltinRaw = {
      revision: number;
      config: {
        providerConfigRules: { templateRules: readonly { templateId: string }[] };
        modelConfigRules: {
          modelRules: readonly { modelMatch?: string }[];
          modelApiRules: readonly { modelMatch?: string }[];
          templateModelRules: readonly { templateId: string }[];
        };
      };
    };
    const isMimoTemplate = (templateId: string) =>
      templateId === "xiaomi-mimo" || templateId === "xiaomi-mimo-token-plan";
    const readRaw = async (fileName: string): Promise<BuiltinRaw> =>
      JSON.parse(
        await readFile(new URL(`../../../config/provider/${fileName}`, import.meta.url), "utf8"),
      ) as BuiltinRaw;
    const pickMiMoSubset = (raw: BuiltinRaw) => ({
      templates: raw.config.providerConfigRules.templateRules.filter((template) =>
        isMimoTemplate(template.templateId),
      ),
      modelRules: raw.config.modelConfigRules.modelRules.filter((rule) =>
        rule.modelMatch?.includes("mimo"),
      ),
      modelApiRules: raw.config.modelConfigRules.modelApiRules.filter((rule) =>
        rule.modelMatch?.includes("mimo"),
      ),
      templateModelRules: raw.config.modelConfigRules.templateModelRules.filter((rule) =>
        isMimoTemplate(rule.templateId),
      ),
    });

    const release = await readRaw("zody-builtin.json");
    const testConfig = await readRaw("zody-builtin.test.json");
    expect(testConfig.revision).toBe(release.revision);
    expect(pickMiMoSubset(testConfig)).toEqual(pickMiMoSubset(release));
  });

  // 上游 v3.17.1（a60ba6a7）内置配置 rev33 → rev43 的 13 个新 BYOK 模板。
  const f08NewTemplateIds = [
    "kimi-code-cn",
    "kimi-code-intl",
    "minimax-m-plan-cn",
    "qwen-coding-plan-cn",
    "qwen-token-plan-team-cn",
    "tencent-tokenhub-cn",
    "tencent-tokenhub-intl",
    "volcengine-ark",
    "volcengine-coding-plan",
    "volcengine-agent-plan",
    "stepfun",
    "stepfun-step-plan",
    "siliconflow-cn",
  ] as const;

  it("F08 rev43 新模板按上游全量收录，端点与成员独立声明", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const expected: Readonly<
        Record<
          string,
          { name: string; apiType: string; baseUrl: string; models: readonly string[] }
        >
      > = {
        "kimi-code-cn": {
          name: "Kimi Code（国内）",
          apiType: "openai-chat-completions",
          baseUrl: "https://api.kimi.com/coding/v1",
          models: [
            "k3.1-pro",
            "k3.1-pro-highspeed",
            "k3",
            "k3-256k",
            "kimi-for-coding",
            "kimi-for-coding-highspeed",
          ],
        },
        "kimi-code-intl": {
          name: "Kimi Code（国际）",
          apiType: "openai-chat-completions",
          baseUrl: "https://api.kimi.ai/coding/v1",
          models: [
            "k3.1-pro",
            "k3.1-pro-highspeed",
            "k3",
            "k3-256k",
            "kimi-for-coding",
            "kimi-for-coding-highspeed",
          ],
        },
        "minimax-m-plan-cn": {
          name: "MiniMax M Plan（中国）",
          apiType: "anthropic-messages",
          baseUrl: "https://api.minimax.cn/anthropic",
          models: ["MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"],
        },
        "qwen-coding-plan-cn": {
          name: "阿里云百炼 Coding Plan（中国）",
          apiType: "openai-chat-completions",
          baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
          models: ["qwen3.7-plus"],
        },
        "qwen-token-plan-team-cn": {
          name: "阿里云百炼 Token Plan 团队版（中国）",
          apiType: "openai-chat-completions",
          baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
          models: ["qwen3.8-max", "qwen3.8-flash"],
        },
        "tencent-tokenhub-cn": {
          name: "腾讯 TokenHub 广州 API（中国站）",
          apiType: "openai-chat-completions",
          baseUrl: "https://tokenhub.tencentmaas.com/v1",
          models: ["hy3", "hy4-preview"],
        },
        "tencent-tokenhub-intl": {
          name: "腾讯 TokenHub 新加坡 API（中国站）",
          apiType: "openai-chat-completions",
          baseUrl: "https://tokenhub-intl.tencentmaas.com/v1",
          models: ["hy3", "hy4-preview"],
        },
        "volcengine-ark": {
          name: "火山方舟 API",
          apiType: "anthropic-messages",
          baseUrl: "https://ark.cn-beijing.volces.com/api/compatible",
          models: [
            "doubao-seed-evolving",
            "doubao-seed-2-1-pro-260915",
            "doubao-seed-2-1-lite-260915",
            "doubao-seed-2-1-turbo-260628",
          ],
        },
        "volcengine-coding-plan": {
          name: "火山方舟 Coding Plan",
          apiType: "anthropic-messages",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
          models: ["doubao-seed-2.1-pro", "doubao-seed-2.1-lite"],
        },
        "volcengine-agent-plan": {
          name: "火山方舟 Agent Plan",
          apiType: "anthropic-messages",
          baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
          models: ["doubao-seed-2.1-pro", "doubao-seed-2.1-lite"],
        },
        stepfun: {
          name: "阶跃星辰 API",
          apiType: "anthropic-messages",
          baseUrl: "https://api.stepfun.com",
          models: ["step-5-preview", "step-3.7-flash"],
        },
        "stepfun-step-plan": {
          name: "阶跃星辰 Step Plan",
          apiType: "anthropic-messages",
          baseUrl: "https://api.stepfun.com/step_plan",
          models: ["step-5-preview", "step-3.7-flash"],
        },
        "siliconflow-cn": {
          name: "硅基流动 API（中国）",
          apiType: "openai-chat-completions",
          baseUrl: "https://api.siliconflow.cn/v1",
          models: ["zai-org/GLM-5.3", "deepseek-ai/DeepSeek-V4-Flash", "moonshotai/Kimi-K2.7-Code"],
        },
      };
      const seenBaseUrls = new Set<string>();
      for (const templateId of f08NewTemplateIds) {
        const template = snapshot.providerTemplates?.get(templateId);
        expect(template, `${templateId} 必须收录`).toBeDefined();
        const want = expected[templateId]!;
        expect(template?.templateNameMap["zh-CN"]).toBe(want.name);
        expect(template?.config.access?.type).toBe("api-key");
        expect(template?.config.api?.type).toBe(want.apiType);
        expect(template?.config.api?.baseUrl).toBe(want.baseUrl);
        expect(template?.config.builtinModelIds).toEqual(want.models);
        // 同一厂商的多套餐模板端点必须互不相同，也不得复用其他模板端点。
        expect(seenBaseUrls.has(want.baseUrl), `${templateId} 的 baseUrl 不得与其他模板重复`).toBe(
          false,
        );
        seenBaseUrls.add(want.baseUrl);
      }
    } finally {
      source.dispose();
    }
  });

  it("F08 新模板成员能力可解析，且 templateModelRules 只按 templateId+modelId 精确命中", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      for (const templateId of f08NewTemplateIds) {
        const template = snapshot.providerTemplates?.get(templateId)!;
        for (const modelId of template.config.builtinModelIds ?? []) {
          const model = snapshot.models.resolve({
            providerId: `template:${templateId}`,
            templateId,
            modelId,
            apiType: template.config.api?.type,
            baseUrl: template.config.api?.baseUrl,
          });
          expect(model.validateComplete(["templates", templateId, "models", modelId])).toEqual([]);
          // 新模板成员默认启用；Preview 型号按上游声明默认关闭，需要用户显式选择。
          const expectedEnabled = modelId !== "MiniMax-M3.1-Flash-Preview";
          expect(model.enabled, `${templateId}/${modelId}`).toBe(expectedEnabled);
        }
      }

      // 代表型号能力断言（上游 rev43 声明值）。
      const volcengine = snapshot.providerTemplates?.get("volcengine-ark")!;
      const doubao = snapshot.models.resolve({
        providerId: "template:volcengine-ark",
        templateId: "volcengine-ark",
        modelId: "doubao-seed-evolving",
        apiType: volcengine.config.api?.type,
        baseUrl: volcengine.config.api?.baseUrl,
      });
      expect(doubao.properties?.contextWindow).toBe(1_024_000);
      expect(doubao.optionSpecs?.maxOutputTokens?.max).toBe(256_000);
      expect(reasoningPatch(doubao.optionSpecs!.reasoningLevel!.map!, "low")).toEqual({
        output_config: { effort: "low" },
      });

      const kimiCode = snapshot.providerTemplates?.get("kimi-code-cn")!;
      const k31 = snapshot.models.resolve({
        providerId: "template:kimi-code-cn",
        templateId: "kimi-code-cn",
        modelId: "k3.1-pro",
        apiType: kimiCode.config.api?.type,
        baseUrl: kimiCode.config.api?.baseUrl,
      });
      expect(k31.properties?.contextWindow).toBe(1_048_576);
      expect(k31.optionSpecs?.reasoningLevel?.values).toEqual(["low", "high", "max"]);

      // 串命中反例：templateModelRules 按 templateId+modelId 精确匹配。
      // 同一 modelId 出现在其他模板下不得继承新模板的 enabled 或能力声明。
      const exactEnabled = new Map(
        snapshot.models
          .rules()
          .flatMap((rule) =>
            rule.type === "template-model" && rule.config.enabled !== undefined
              ? ([[`${rule.templateId}\0${rule.modelId}`, rule.config.enabled]] as const)
              : [],
          ),
      );
      expect(exactEnabled.get("kimi-code-cn\0kimi-for-coding")).toBe(true);
      expect(exactEnabled.has("moonshot-kimi\0kimi-for-coding")).toBe(false);
      expect(exactEnabled.get("volcengine-coding-plan\0doubao-seed-2.1-pro")).toBe(true);
      // 火山方舟按量模板的成员是带日期后缀的 doubao-seed-2-1-*，与套餐模板的
      // doubao-seed-2.1-* 是不同型号，互相不得串命中。
      expect(exactEnabled.has("volcengine-ark\0doubao-seed-2.1-pro")).toBe(false);
      expect(exactEnabled.has("volcengine-coding-plan\0doubao-seed-2-1-pro-260915")).toBe(false);

      // 行为级反例：minimax-m-plan-cn 的 Preview 成员默认关闭（上游声明 false）；
      // 它不是 minimax（按量）模板的成员，若 templateModelRules 按 modelId 全局串命中，
      // minimax 下同名型号会被错误关闭。zody 的 `.*` 兜底规则声明 enabled:true，
      // 非成员型号应保持默认启用。
      const mPlan = snapshot.providerTemplates?.get("minimax-m-plan-cn")!;
      const previewInMPlan = snapshot.models.resolve({
        providerId: "template:minimax-m-plan-cn",
        templateId: "minimax-m-plan-cn",
        modelId: "MiniMax-M3.1-Flash-Preview",
        apiType: mPlan.config.api?.type,
        baseUrl: mPlan.config.api?.baseUrl,
      });
      expect(previewInMPlan.enabled).toBe(false);
      const minimaxTemplate = snapshot.providerTemplates?.get("minimax")!;
      const previewInMinimax = snapshot.models.resolve({
        providerId: "template:minimax",
        templateId: "minimax",
        modelId: "MiniMax-M3.1-Flash-Preview",
        apiType: minimaxTemplate.config.api?.type,
        baseUrl: minimaxTemplate.config.api?.baseUrl,
      });
      expect(previewInMinimax.enabled, "minimax 模板不得继承 m-plan 模板的 disabled 声明").toBe(
        true,
      );
    } finally {
      source.dispose();
    }
  });

  it("F08 生产与测试 Built-in 配置的新模板子集与站点规则保持一致", async () => {
    // 与 MiMo parity 同理：测试配置由人工镜像维护，按 F08 子集做 parity 防漂移。
    // providerSiteRules 在测试配置中允许出现重复条目（上游如此），比较时去重。
    type BuiltinRaw = {
      revision: number;
      config: {
        providerConfigRules: { templateRules: readonly { templateId: string }[] };
        modelConfigRules: {
          templateModelRules: readonly { templateId: string }[];
          providerSiteRules: readonly unknown[];
        };
      };
    };
    const readRaw = async (fileName: string): Promise<BuiltinRaw> =>
      JSON.parse(
        await readFile(new URL(`../../../config/provider/${fileName}`, import.meta.url), "utf8"),
      ) as BuiltinRaw;
    const pick = (raw: BuiltinRaw) => ({
      templates: raw.config.providerConfigRules.templateRules.filter((template) =>
        (f08NewTemplateIds as readonly string[]).includes(template.templateId),
      ),
      templateModelRules: raw.config.modelConfigRules.templateModelRules.filter((rule) =>
        (f08NewTemplateIds as readonly string[]).includes(rule.templateId),
      ),
      siteRules: [
        ...new Set(raw.config.modelConfigRules.providerSiteRules.map((x) => JSON.stringify(x))),
      ],
    });

    const release = await readRaw("zcode-builtin.json");
    const testConfig = await readRaw("zcode-builtin.test.json");
    expect(release.revision).toBe(43);
    expect(testConfig.revision).toBe(43);
    expect(pick(testConfig)).toEqual(pick(release));
    // 上游 rev43 新增的站点规则随配置收录：glm-5.3 在 Z.ai / BigModel / Zody highspeed
    // 三个 Anthropic 端点不支持视频；opencode go 的 chat-completions 端点不支持
    // JSON Schema 输出。
    const releaseSiteRules = pick(release).siteRules;
    for (const rule of [
      JSON.stringify({
        modelMatch: "glm-5\\.3",
        apiTypeMatch: "anthropic-messages",
        baseUrlMatch: "https://api\\.z\\.ai/api/anthropic/?",
        config: { properties: { inputFormat: { supportsVideo: false } } },
      }),
      JSON.stringify({
        modelMatch: "glm-5\\.3",
        apiTypeMatch: "anthropic-messages",
        baseUrlMatch: "https://open\\.bigmodel\\.cn/api/anthropic/?",
        config: { properties: { inputFormat: { supportsVideo: false } } },
      }),
      JSON.stringify({
        modelMatch: "glm-5\\.3",
        apiTypeMatch: "anthropic-messages",
        baseUrlMatch: "https://zcode\\.z\\.ai/api/v1/highspeed/anthropic/?",
        config: { properties: { inputFormat: { supportsVideo: false } } },
      }),
      JSON.stringify({
        modelMatch: ".*",
        apiTypeMatch: "openai-chat-completions",
        baseUrlMatch: "https://opencode\\.ai/zen/go/v1/?",
        config: { properties: { supportsJsonSchemaOutput: false } },
      }),
    ]) {
      expect(releaseSiteRules, `缺少上游 rev43 站点规则 ${rule}`).toContain(rule);
    }
  });

  it("聚合供应商按维护清单提供独立模板，不复用上游 Provider 配置", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const openrouter = snapshot.providerTemplates?.get("openrouter")?.config;
      expect(openrouter?.api?.type).toBe("anthropic-messages");
      expect(openrouter?.api?.baseUrl).toBe("https://openrouter.ai/api");
      expect(openrouter?.builtinModelIds).toEqual(
        expect.arrayContaining(["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "z-ai/glm-5.3"]),
      );
      for (const templateId of [
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]) {
        expect(snapshot.providerTemplates?.has(templateId)).toBe(true);
      }
    } finally {
      source.dispose();
    }
  });

  it("聚合供应商同型号命中模型规则和 API Map，保留完整 ID 且每家至少启用一个代表型号", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const pairs = [
        ["openai/gpt-5.6-sol", "gpt-5.6-sol"],
        ["anthropic/claude-opus-5", "claude-opus-5"],
        ["anthropic/claude-haiku-4.5", "claude-haiku-4-5-20251001"],
        ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
        ["moonshotai/kimi-k3", "kimi-k3"],
        ["z-ai/glm-5.3", "glm-5.3"],
        ["qwen/qwen3.8-max", "qwen3.8-max"],
        ["minimax/minimax-m3", "MiniMax-M3"],
        ["xiaomi/mimo-v2.5-pro", "mimo-v2.5-pro"],
        ["x-ai/grok-4.6", "grok-4.6"],
      ];
      for (const [aggregateId, directId] of pairs) {
        const resolve = (modelId: string, templateId?: string) =>
          snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: "anthropic-messages",
            baseUrl: "https://openrouter.ai/api",
          });
        const aggregate = resolve(aggregateId!, "openrouter");
        const direct = resolve(directId!);
        expect(aggregate.properties?.toJSON(), aggregateId).toEqual(direct.properties?.toJSON());
        expect(aggregate.optionSpecs?.toJSON(), aggregateId).toEqual(direct.optionSpecs?.toJSON());
      }
      for (const templateId of ["openrouter", "opencode-zen-messages", "opencode-zen-chat"]) {
        const template = snapshot.providerTemplates!.get(templateId)!.config;
        const enabledByVendor = new Map<string, boolean>();
        for (const modelId of template.builtinModelIds!) {
          const vendor =
            templateId === "openrouter" ? modelId.split("/")[0]! : modelId.split("-")[0]!;
          const model = snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: template.api!.type,
            baseUrl: template.api!.baseUrl,
          });
          enabledByVendor.set(
            vendor,
            (enabledByVendor.get(vendor) ?? false) || model.enabled === true,
          );
        }
        for (const [vendor, enabled] of enabledByVendor)
          expect(enabled, `${templateId}/${vendor}`).toBe(true);
      }
      const haiku = snapshot.models.resolve({
        providerId: "zen",
        templateId: "opencode-zen-messages",
        modelId: "claude-haiku-4-5",
        apiType: "anthropic-messages",
        baseUrl: "https://opencode.ai/zen/v1",
      });
      expect(haiku.properties?.inputFormat.supportsImage).toBe(true);
      expect(haiku.properties?.contextWindow).toBe(200_000);
    } finally {
      source.dispose();
    }
  });

  it("每个 Provider 的默认 enabled 模型形成成员前缀，历史或 alias 型号默认关闭", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const exactEnabled = new Map(
        snapshot.models
          .rules()
          .flatMap((rule) =>
            rule.config.enabled === undefined ||
            (rule.type !== "provider-model" && rule.type !== "template-model")
              ? []
              : [
                  [
                    `${rule.type === "provider-model" ? rule.providerId : rule.templateId}\0${rule.modelId}`,
                    rule.config.enabled,
                  ] as const,
                ],
          ),
      );

      const memberships = [
        ...snapshot.providers.entries(),
        ...(snapshot.providerTemplates
          ?.entries()
          .map(([id, template]) => [id, template.config] as const) ?? []),
      ];
      for (const [ownerId, owner] of memberships) {
        const states = (owner.builtinModelIds ?? []).map((modelId) => {
          const enabled = exactEnabled.get(`${ownerId}\0${modelId}`);
          expect(enabled, `${ownerId}/${modelId} 必须显式声明 Built-in 默认 enabled`).toBeTypeOf(
            "boolean",
          );
          return enabled!;
        });
        const firstDisabled = states.indexOf(false);
        if (firstDisabled >= 0) {
          expect(
            states.slice(firstDisabled).every((enabled) => !enabled),
            `${ownerId} 的 enabled 成员必须在 disabled 成员之前`,
          ).toBe(true);
        }
      }

      expect(exactEnabled.get("openai\0gpt-5.6")).toBe(false);
      // F08（上游 rev43）：gpt-5.6-sol 随 gpt-6.1-sol 上线降级为默认关闭。
      expect(exactEnabled.get("openai\0gpt-5.6-sol")).toBe(false);
      expect(exactEnabled.get("openai\0gpt-6.1-sol")).toBe(true);
      expect(exactEnabled.get("minimax\0MiniMax-M3")).toBe(true);
      expect(exactEnabled.get("xai\0grok-4.3")).toBe(false);
    } finally {
      source.dispose();
    }
  });

  it("按产品分组声明 Zhipu 系统 Provider 与外部主流 Provider", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      // fork（F4.1a）：官方账号 provider 下线后 Built-in 不再声明 Provider 实例，
      // 模型事实全部收敛到模板（BYOK）与通用规则。
      expect(snapshot.providers.keys()).toEqual([]);
      expect(snapshot.providerTemplates?.keys()).toEqual([
        "zai-api",
        "zai-standard-api",
        "bigmodel-api",
        "bigmodel-standard-api",
        "moonshot-kimi",
        // F08（上游 v3.17.1 rev43）：13 个新模板按上游顺序全量收录（BYOK），
        // opencode-go 三模板顺序跟随上游重排为 responses → messages → chat。
        "kimi-code-cn",
        "kimi-code-intl",
        "minimax",
        "minimax-m-plan-cn",
        "deepseek",
        "qwen-alibaba-model-studio-cn",
        "qwen-alibaba-model-studio-intl",
        "qwen-coding-plan-cn",
        "qwen-token-plan-team-cn",
        "xiaomi-mimo",
        "xiaomi-mimo-token-plan",
        "tencent-tokenhub-cn",
        "tencent-tokenhub-intl",
        "volcengine-ark",
        "volcengine-coding-plan",
        "volcengine-agent-plan",
        "stepfun",
        "stepfun-step-plan",
        "openai",
        "anthropic",
        "xai",
        "siliconflow-cn",
        "openrouter",
        "opencode-go-responses",
        "opencode-go-messages",
        "opencode-go-chat",
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]);
      for (const [templateId, template] of snapshot.providerTemplates?.entries() ?? []) {
        expect(
          template.templateNameMap["zh-CN"]?.trim(),
          `${templateId} 缺少中文 Template 名称`,
        ).toBeTruthy();
        expect(
          template.templateNameMap["en-US"]?.trim(),
          `${templateId} 缺少英文 Template 名称`,
        ).toBeTruthy();
        expect(template.config.logo, `${templateId} 缺少 Built-in Logo 引用`).toMatchObject({
          type: "builtin",
        });
      }
      for (const [providerId, provider] of snapshot.providers.entries()) {
        expect(provider.logo, `${providerId} 缺少 Built-in Logo 引用`).toMatchObject({
          type: "builtin",
        });
      }
      expect(snapshot.providerTemplates?.get("moonshot-kimi")?.templateNameMap).toEqual({
        "zh-CN": "Kimi",
        "en-US": "Kimi",
      });
      expect(
        snapshot.providerTemplates?.get("qwen-alibaba-model-studio-cn")?.templateNameMap,
      ).toEqual({
        "zh-CN": "阿里云百炼（中国）",
        "en-US": "Alibaba Cloud (China)",
      });
      expect(
        snapshot.providerTemplates?.get("qwen-alibaba-model-studio-intl")?.templateNameMap,
      ).toEqual({
        "zh-CN": "阿里云百炼（国际）",
        "en-US": "Alibaba Cloud (Global)",
      });

      expect(snapshot.providerTemplates?.get("openai")?.config.toJSON()).toMatchObject({
        // F08（上游 rev43）：openai 新增 gpt-6.1-sol / gpt-6-luna，gpt-5.6-sol 降级为默认关闭。
        builtinModelIds: [
          "gpt-6-astra",
          "gpt-5.6-terra",
          "gpt-6.1-sol",
          "gpt-6-luna",
          "gpt-5.6-sol",
          "gpt-5.6-luna",
          "gpt-5.6",
          "gpt-5.4",
          "gpt-5.4-pro",
          "gpt-5.4-mini",
          "gpt-5.4-nano",
          "gpt-5.3-codex",
        ],
        access: {
          type: "api-key",
          apiKeyManagementUrl: "https://platform.openai.com/api-keys",
        },
        api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      });
      expect(snapshot.providerTemplates?.get("anthropic")?.config.toJSON()).toMatchObject({
        // F08（上游 rev43）：anthropic 新增 claude-5.5 系三款。
        builtinModelIds: [
          "claude-fable-5-1",
          "claude-opus-5-5",
          "claude-sonnet-5-5",
          "claude-haiku-5-5",
          "claude-fable-5",
          "claude-opus-5",
          "claude-sonnet-5",
          "claude-haiku-4-5-20251001",
        ],
        access: {
          type: "api-key",
          apiKeyManagementUrl: "https://console.anthropic.com/settings/keys",
        },
        api: { type: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
      });
      expect(snapshot.providerTemplates?.get("xai")?.config.toJSON()).toMatchObject({
        // F08（上游 rev43）：xai 新增 grok-4.7 并重排为 build 系在前。
        builtinModelIds: ["grok-build-0.1", "grok-4.7", "grok-4.6", "grok-4.3"],
        access: {
          type: "api-key",
          apiKeyManagementUrl: "https://console.x.ai",
        },
        api: { type: "openai-responses", baseUrl: "https://api.x.ai/v1" },
      });
      expect(snapshot.providerTemplates?.get("zai-api")?.config.toJSON()).toMatchObject({
        access: { type: "zhipu-coding-plan-api-key" },
      });
      expect(snapshot.providerTemplates?.get("bigmodel-api")?.config.toJSON()).toMatchObject({
        access: { type: "zhipu-coding-plan-api-key" },
      });
    } finally {
      source.dispose();
    }
  });

  it("按模型家族连续排列 Rule，且不保留语义等价的重复 matcher", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const rules = (await source.read()).models.rules().filter((rule) => rule.type === "match");
      const selectorKeys = rules.map((rule) =>
        JSON.stringify([
          rule.providerMatch ?? "",
          rule.modelMatch.toLowerCase(),
          rule.apiMatch ?? "",
          rule.baseUrlMatch ?? "",
        ]),
      );
      expect(new Set(selectorKeys).size).toBe(selectorKeys.length);

      // 分组后“模型家族连续”只约束 Model Rule 本组；把 Model/API/Site 三组拼起来会
      // 人为制造重复家族，无法再验证原本想检查的书写顺序。
      const rawRelease = JSON.parse(await readFile(zodyBuiltinProviderConfigFilePath, "utf8")) as {
        config: { modelConfigRules: { modelRules: readonly { modelMatch: string }[] } };
      };
      const modelRules = rawRelease.config.modelConfigRules.modelRules;
      const familySequence = modelRules
        .map((rule) => builtinRuleFamily(rule))
        .filter((family, index, families) => family !== families[index - 1]);
      expect(familySequence).toEqual([
        "fallback",
        "glm",
        "gpt",
        "claude",
        "grok",
        "kimi",
        "minimax",
        "deepseek",
        "qwen",
        "mimo",
      ]);
    } finally {
      source.dispose();
    }
  });

  it("Reasoning 公开档位按语义强度从低到高排列", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const levelRank: Readonly<Record<string, number>> = {
        disabled: 0,
        none: 0,
        nothink: 0,
        off: 0,
        enabled: 1,
        minimal: 0.5,
        low: 1,
        medium: 2,
        high: 3,
        xhigh: 4,
        max: 5,
      };

      for (const rule of (await source.read()).models.rules()) {
        const values = rule.config.optionSpecs?.reasoningLevel?.values;
        if (!values) continue;
        const ranks = values.map((value) => levelRank[value]);
        expect(
          ranks.every((rank) => rank !== undefined),
          `${rule.modelMatch} 存在未知 Reasoning 档位，需先声明其顺序语义`,
        ).toBe(true);
        expect(
          ranks.every((rank, index) => index === 0 || rank! >= ranks[index - 1]!),
          `${rule.modelMatch} 的 Reasoning 档位必须从低到高排列`,
        ).toBe(true);
      }
    } finally {
      source.dispose();
    }
  });

  it("解析 OpenAI Responses 与 Anthropic Messages 的模型事实和 reasoning 映射", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const openAi = snapshot.models.resolve({
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        apiType: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      expect(openAi.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 1_050_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: true,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      });
      expect(openAi.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["none", "low", "medium", "high", "xhigh", "max"],
      });
      for (const effort of ["xhigh", "max"]) {
        expect(reasoningPatch(openAi.optionSpecs!.reasoningLevel!.map!, effort)).toEqual({
          reasoning: { effort },
        });
      }

      const grok46 = snapshot.models.resolve({
        providerId: "xai",
        modelId: "grok-4.6",
        apiType: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      });
      expect(grok46.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 500_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      });
      expect(grok46.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "medium", "high", "xhigh"],
      });
      expect(reasoningPatch(grok46.optionSpecs!.reasoningLevel!.map!, "xhigh")).toEqual({
        reasoning: { effort: "xhigh" },
      });

      const grokBuild = snapshot.models.resolve({
        providerId: "xai",
        modelId: "grok-build-0.1",
        apiType: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      });
      expect(grokBuild.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 256_000,
        inputFormat: { supportsText: true, supportsImage: true },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
      });

      const grok43 = snapshot.models.resolve({
        providerId: "xai",
        modelId: "grok-4.3",
        apiType: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      });
      expect(grok43.properties?.contextWindow).toBe(1_000_000);
      expect(grok43.optionSpecs?.reasoningLevel?.toJSON()).toMatchObject({
        // 此模型未声明专用档位，继续继承 Model 通用兜底。
        values: ["disabled", "enabled"],
      });
      expect(reasoningPatch(grok43.optionSpecs!.reasoningLevel!.map!, "disabled")).toEqual({
        reasoning: { effort: "none" },
      });

      const anthropic = snapshot.models.resolve({
        providerId: "anthropic",
        modelId: "claude-opus-5",
        apiType: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
      });
      expect(anthropic.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: true,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: true,
        supportsMidConversationSystem: true,
      });
      expect(anthropic.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "medium", "high", "xhigh", "max"],
      });
      expect(anthropic.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(reasoningPatch(anthropic.optionSpecs!.reasoningLevel!.map!, "max")).toMatchObject({
        output_config: { effort: "max" },
      });

      const deepSeek = snapshot.models.resolve({
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        apiType: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
      });
      expect(deepSeek.properties?.supportsJsonSchemaOutput).toBe(false);
      expect(deepSeek.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["disabled", "low", "high", "max"],
      });
      expect(deepSeek.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(reasoningPatch(deepSeek.optionSpecs!.reasoningLevel!.map!, "low")).toMatchObject({
        output_config: { effort: "low" },
      });

      for (const modelId of ["qwen3.5-plus", "qwen3.5-flash", "qwen3-vl-plus"]) {
        expect(
          snapshot.models.resolve({
            providerId: "qwen-alibaba-model-studio-cn",
            modelId,
            apiType: "anthropic-messages",
            baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
          }).properties?.supportsJsonSchemaOutput,
        ).toBe(false);
      }

      const deepSeekResponses = snapshot.models.resolve({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        apiType: "openai-responses",
        baseUrl: "https://api.deepseek.com",
      });
      expect(deepSeekResponses.properties?.supportsJsonSchemaOutput).toBe(true);
      expect(reasoningPatch(deepSeekResponses.optionSpecs!.reasoningLevel!.map!, "max")).toEqual({
        reasoning: { effort: "max" },
      });
    } finally {
      source.dispose();
    }
  });

  it("每个 Built-in 模板与模型成员都完整，启用成员在补齐访问材料后进入正式 Registry", async () => {
    const source = new NodeZodyBuiltinProviderConfigSource({
      bundledFilePath: zodyBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      // fork（F4.1a）：官方账号 provider 下线，Registry 装配只验证模板（BYOK）来源。
      const personalProviders: Array<{
        providerId: string;
        templateId: string;
        config: ProviderConfig;
      }> = [];
      const expectedModelIds = new Map<string, readonly string[]>();

      for (const [templateId, template] of snapshot.providerTemplates?.entries() ?? []) {
        const providerId = `template:${templateId}`;
        const builtinModelIds = template.config.builtinModelIds ?? [];
        expect(new Set(builtinModelIds).size, `${templateId} 存在重复 Template 模型成员`).toBe(
          builtinModelIds.length,
        );
        const enabledModelIds = builtinModelIds.filter((modelId) => {
          const model = snapshot.models.resolve({
            providerId,
            templateId,
            modelId,
            apiType: template.config.api?.type,
            baseUrl: template.config.api?.baseUrl,
          });
          expect(model.validateComplete(["templates", templateId, "models", modelId])).toEqual([]);
          return model.enabled !== false;
        });
        expectedModelIds.set(providerId, enabledModelIds);
        expect(["api-key", "zhipu-coding-plan-api-key"]).toContain(template.config.access?.type);
        if (template.config.access?.type !== "zhipu-account") {
          expect(template.config.access.apiKey, `${templateId} 不得保存 API Key`).toBeUndefined();
        }
        personalProviders.push({
          providerId,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({
              type: template.config.access?.type,
              apiKey: `test-key-for-${templateId}`,
            }),
          }),
        });
      }

      const resolution = new ProviderConfigResolver().resolve({
        zodyBuiltinProviders: snapshot.providers,
        zodyBuiltinProviderTemplates: snapshot.providerTemplates,
        accountProviders: ProviderConfigMap.empty(),
        personalProviders: new ProviderConfigMap(personalProviders),
        zodyBuiltinModelRules: snapshot.models,
        personalModels: ModelConfigRules.empty(),
      });

      expect(resolution.issues).toEqual([]);
      expect(resolution.registryProviders.map(({ providerId }) => providerId)).toEqual([
        "template:zai-api",
        "template:zai-standard-api",
        "template:bigmodel-api",
        "template:bigmodel-standard-api",
        "template:moonshot-kimi",
        // F08（上游 v3.17.1 rev43）：13 个新模板进入 Registry，顺序与 Built-in 列表一致。
        "template:kimi-code-cn",
        "template:kimi-code-intl",
        "template:minimax",
        "template:minimax-m-plan-cn",
        "template:deepseek",
        "template:qwen-alibaba-model-studio-cn",
        "template:qwen-alibaba-model-studio-intl",
        "template:qwen-coding-plan-cn",
        "template:qwen-token-plan-team-cn",
        "template:xiaomi-mimo",
        "template:xiaomi-mimo-token-plan",
        "template:tencent-tokenhub-cn",
        "template:tencent-tokenhub-intl",
        "template:volcengine-ark",
        "template:volcengine-coding-plan",
        "template:volcengine-agent-plan",
        "template:stepfun",
        "template:stepfun-step-plan",
        "template:openai",
        "template:anthropic",
        "template:xai",
        "template:siliconflow-cn",
        "template:openrouter",
        "template:opencode-go-responses",
        "template:opencode-go-messages",
        "template:opencode-go-chat",
        "template:opencode-zen-responses",
        "template:opencode-zen-messages",
        "template:opencode-zen-chat",
      ]);

      for (const provider of resolution.registryProviders) {
        expect(
          provider.models.map(({ modelId }) => modelId),
          `${provider.providerId} 的 Registry 模型成员必须与 Built-in Config 一致`,
        ).toEqual(expectedModelIds.get(provider.providerId));
        for (const model of provider.models) {
          expect(
            model.config.validateComplete([
              "providers",
              provider.providerId,
              "models",
              model.modelId,
            ]),
          ).toEqual([]);
        }
      }
    } finally {
      source.dispose();
    }
  });

  it("正式 Built-in JSON 不携带旧模型能力字段", async () => {
    const document = JSON.parse(
      await readFile(zodyBuiltinProviderConfigFilePath, "utf8"),
    ) as unknown;
    const keys = collectObjectKeys(document);

    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("modalities");
    expect(keys).not.toContain("magic_name");
    expect(keys).not.toContain("supportsImages");
    // Todo104：supportsPdf/Video 是 inputFormat 内的正式字段，不能因同名误判成旧扁平能力。
    for (const key of [
      "input_format",
      "output_format",
      "support_text",
      "support_image",
      "support_pdf",
      "support_video",
      "support_audio",
    ]) {
      expect(keys).not.toContain(key);
    }
    expect(keys).not.toContain("budget_tokens");
    expect(keys).not.toContain("budgetTokens");
  });
});

function builtinRuleFamily(rule: {
  readonly providerMatch?: string;
  readonly modelMatch: string;
  readonly apiMatch?: string;
  readonly baseUrlMatch?: string;
}): string {
  const provider = rule.providerMatch?.toLowerCase() ?? "";
  const baseUrl = rule.baseUrlMatch?.toLowerCase() ?? "";
  const model = rule.modelMatch.toLowerCase();
  if (!provider && !baseUrl && (model === ".*" || (!rule.apiMatch && model === ".*\\[1m\\]"))) {
    return "fallback";
  }
  if (provider.includes("github-copilot") || model.includes("gpt")) return "gpt";
  if (provider === "anthropic" || model.includes("claude")) return "claude";
  if (model.includes("grok")) return "grok";
  if (provider === "moonshot-kimi" || /(?:kimi|moonshot|k3)/.test(model)) return "kimi";
  if (model.includes("minimax")) return "minimax";
  if (provider === "deepseek" || model.includes("deepseek")) return "deepseek";
  if (model.includes("qwen")) return "qwen";
  if (model.includes("mimo")) return "mimo";
  if (
    model.includes("glm") ||
    model.includes("ox-alpha") ||
    model.includes("codegeex") ||
    model.includes("emohaa") ||
    provider.includes("zai") ||
    provider.includes("bigmodel") ||
    provider.includes("offpeak-idle-plan") ||
    baseUrl.includes("z\\.ai") ||
    baseUrl.includes("bigmodel\\.cn")
  ) {
    return "glm";
  }
  return "cross-model";
}

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectObjectKeys(child)]);
}
