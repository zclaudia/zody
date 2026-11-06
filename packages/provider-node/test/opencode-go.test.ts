import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zody/model-option-map";
import { ModelConfig, ModelConfigRules, parseZodyBuiltinModelConfigRules } from "@zody/provider";

const url = "https://opencode.ai/zen/go/v1";
// F08（上游 v3.17.1 rev43）：Go 端点成员随上游更新——新增 minimax-m3.1-flash、
// kimi-k3.1-pro、mimo-v2.6 系、claude-haiku-5-5、gpt-6-luna、grok-4.7；
// 旧型号 mimo-v2.5 系、gpt-5.6-luna、grok-4.6 随上游降级为默认关闭。
const members = {
  "opencode-go-chat": [
    "minimax-m3.1-flash",
    "kimi-k3.1-pro",
    "glm-5.3-flash",
    "glm-5.3",
    "kimi-k3",
    "kimi-k2.7-code",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "mimo-v2.6-pro",
    "mimo-v2.6-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "glm-5.2",
    "glm-5.1",
    "kimi-k2.6",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "hy4-preview",
    "hy3",
  ],
  "opencode-go-messages": [
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "claude-haiku-5-5",
  ],
  "opencode-go-responses": ["gpt-6-luna", "grok-4.7", "gpt-5.6-luna", "grok-4.6"],
};
const enabled = new Set([
  "minimax-m3.1-flash",
  "kimi-k3.1-pro",
  "glm-5.3-flash",
  "glm-5.3",
  "kimi-k3",
  "kimi-k2.7-code",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "minimax-m3",
  "qwen3.8-max",
  "qwen3.8-flash",
  "claude-haiku-5-5",
  "gpt-6-luna",
  "grok-4.7",
]);
let rules: ModelConfigRules;
let templates: {
  templateId: string;
  config: {
    api: { type: string; baseUrl: string };
    access: unknown;
    logo: unknown;
    builtinModelIds: string[];
  };
}[];
// F08（上游 v3.17.1 rev43）：新成员的 Go 端点能力/参数直接声明在模板条目
// （templateModelRules 的 properties/optionSpecs），自建供应商在同一端点只能解析到
// 通用规则或兜底；这些成员不断言与 manual 一致，由模板条目声明生效断言覆盖。
let templateDeclared = new Set<string>();
beforeAll(async () => {
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zody-builtin.json", import.meta.url), "utf8"),
  );
  rules = parseZodyBuiltinModelConfigRules(release.config.modelConfigRules);
  templates = release.config.providerConfigRules.templateRules;
  templateDeclared = new Set(
    release.config.modelConfigRules.templateModelRules
      .filter(
        (rule: {
          templateId: string;
          modelId: string;
          config: { properties?: unknown; optionSpecs?: unknown };
        }) => rule.config.properties !== undefined || rule.config.optionSpecs !== undefined,
      )
      .map((rule: { templateId: string; modelId: string }) => `${rule.templateId}/${rule.modelId}`),
  );
});
const input = (modelId: string, apiType = "openai-chat-completions", baseUrl = url) => ({
  providerId: "personal-go",
  modelId,
  apiType,
  baseUrl,
});
const patch = (config: ModelConfig, level: string) =>
  compileModelOptionMaps({
    reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
    maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
  }).apply({}, { reasoningLevel: level, maxOutputTokens: 4096 });

describe("Todo149 Go 模板与自建供应商共用站点规则", () => {
  it.each(Object.entries(members))("%s 按官方协议列成员，模板只决定默认启停", (templateId, ids) => {
    const t = templates.find((t) => t.templateId === templateId)!;
    expect(t).toBeDefined();
    expect(t.config.builtinModelIds).toEqual(
      [...ids].sort((a, b) => Number(enabled.has(b)) - Number(enabled.has(a))),
    );
    expect(t.config.api).toEqual({
      type: templateId.endsWith("chat")
        ? "openai-chat-completions"
        : templateId.endsWith("messages")
          ? "anthropic-messages"
          : "openai-responses",
      baseUrl: url,
    });
    expect(t.config.access).toEqual({
      type: "api-key",
      apiKeyManagementUrl: "https://opencode.ai/auth",
    });
    expect(t.config.logo).toEqual({ type: "builtin", key: "opencode" });
    for (const modelId of ids) {
      const i = input(modelId, t.config.api.type);
      const fromTemplate = rules.resolve({ ...i, templateId });
      const manual = rules.resolve(i);
      expect(fromTemplate.validateComplete(), modelId).toEqual([]);
      expect(fromTemplate.enabled, modelId).toBe(enabled.has(modelId));
      if (!templateDeclared.has(`${templateId}/${modelId}`)) {
        expect(fromTemplate.properties?.toJSON()).toEqual(manual.properties?.toJSON());
        expect(fromTemplate.optionSpecs?.toJSON()).toEqual(manual.optionSpecs?.toJSON());
      }
      expect(manual.properties?.supportsNativeWebSearch, modelId).toBe(false);
      for (const level of fromTemplate.optionSpecs!.reasoningLevel!.values!)
        expect(() => patch(fromTemplate, level), `${modelId}/${level}`).not.toThrow();
    }
  });

  it.each([
    // F08：Go 端点新成员按上游模板条目声明能力（通用上下文无对应家族规则，落兜底）。
    ["opencode-go-responses", "gpt-6-luna", 1_050_000, true, true],
    ["opencode-go-responses", "grok-4.7", 500_000, true, false],
    ["opencode-go-messages", "claude-haiku-5-5", 200_000, true, true],
  ] as const)("%s/%s 的模板条目能力声明生效", (templateId, modelId, context, image, pdf) => {
    const fromTemplate = rules.resolve({ ...input(modelId), templateId });
    expect(fromTemplate.properties?.contextWindow).toBe(context);
    expect(fromTemplate.properties?.inputFormat.toJSON()).toMatchObject({
      supportsImage: image,
      supportsPdf: pdf,
    });
  });

  // 原因：GLM 落入通用四组参数兜底，Go 上游严格校验并拒绝 enable_thinking/reasoning。
  it.each(["glm-5.3", "glm-5.3-flash"])(
    "%s 每个档位仅发送 reasoning_effort，不修改其他站点",
    (modelId) => {
      for (const level of ["low", "high", "max"]) {
        expect(patch(rules.resolve(input(modelId)), level)).toEqual({
          reasoning_effort: level,
          max_tokens: 4096,
        });
        expect(patch(rules.resolve(input(modelId, undefined, `${url}/`)), level)).toEqual({
          reasoning_effort: level,
          max_tokens: 4096,
        });
      }
      for (const other of [
        "https://opencode.ai/zen/v1",
        "https://opencode.ai.evil.test/zen/go/v1",
        "https://opencode.ai/zen/go/v10",
        "https://other.test/zen/go/v1",
      ]) {
        expect(patch(rules.resolve(input(modelId, undefined, other)), "high")).toHaveProperty(
          "enable_thinking",
          true,
        );
      }
      expect(patch(rules.resolve(input(modelId, "anthropic-messages")), "high")).toHaveProperty(
        "thinking",
      );
    },
  );

  it.each([
    ["glm-5.2", ["high", "max"], 1000000, 131072],
    ["glm-5.1", ["enabled"], 202752, 32768],
    ["kimi-k3", ["max"], 1048576, 131072],
    ["kimi-k2.7-code", ["enabled"], 262144, 262144],
    ["deepseek-v4-pro", ["high", "max"], 1000000, 384000],
    ["hy3", ["none", "low", "high"], 256000, 128000],
    ["hy4-preview", ["none", "high"], 1024000, 64000],
  ] as const)("%s 使用 Go 能力而不是同名原厂默认", (id, levels, context, max) => {
    const c = rules.resolve(input(id));
    expect(c.optionSpecs?.reasoningLevel?.values).toEqual(levels);
    expect(c.properties?.contextWindow).toBe(context);
    expect(c.optionSpecs?.maxOutputTokens?.max).toBe(max);
  });

  it("视觉与桥接分离；Qwen 的 Go 输出上限不照搬原厂", () => {
    expect(rules.resolve(input("glm-5.3")).properties?.inputFormat.supportsImage).toBe(false);
    expect(rules.resolve(input("glm-5.3-flash")).properties?.inputFormat.toJSON()).toMatchObject({
      supportsImage: true,
      supportsVideo: true,
      supportsPdf: true,
    });
    expect(rules.resolve(input("deepseek-v4-flash")).properties?.inputFormat.supportsImage).toBe(
      false,
    );
    expect(
      rules.resolve(input("deepseek-v4-flash-vision-exp")).properties?.inputFormat.supportsImage,
    ).toBe(true);
    for (const id of ["qwen3.7-max", "qwen3.7-plus"])
      expect(rules.resolve(input(id, "anthropic-messages")).optionSpecs?.maxOutputTokens?.max).toBe(
        65536,
      );
  });

  it.each(["provider-model", "manual-provider-model"] as const)(
    "%s 的个人 Map 仍然优先",
    (type) => {
      const personal = new ModelConfigRules([
        {
          type,
          providerId: "personal-go",
          modelId: "glm-5.3",
          config: new ModelConfig({
            optionSpecs: {
              reasoningLevel: { values: ["high"], map: '{"custom_effort": reasoningLevel}' },
              maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' },
            },
          }),
        },
      ]);
      const c = ModelConfigRules.composeEffective(rules, personal).resolve(input("glm-5.3"));
      expect(patch(c, "high")).toEqual({ custom_effort: "high", max_tokens: 4096 });
      if (type === "manual-provider-model") expect(c.properties?.contextWindow).toBeUndefined();
    },
  );
});
