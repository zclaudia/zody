import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type ModelSelection,
  type Provider,
} from "../src/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";
import { resolveEffectiveModelSelection } from "../src/effective-model-selection.js";

function provider(
  providerId: string,
  modelId: string,
  reasoningValues: readonly string[] = ["low", "high"],
): Provider {
  return {
    providerId,
    config: createApiKeyProviderConfig({
      apiFormat: "anthropic-messages",
      baseURL: "https://api.example.com",
      apiKey: "test-key",
      models: [modelId],
    }),
    models: [
      {
        modelId,
        config: new ModelConfig({
          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: false,
            contextWindow: 200_000,
            inputFormat: {
              supportsText: true,
              supportsImage: false,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: true,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          }),
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: {
              values: reasoningValues,
              map:
                reasoningValues.length === 1 && reasoningValues[0] === "disabled"
                  ? "{}"
                  : "{'thinking': {'effort': value}}",
            },
            maxOutputTokens: {
              max: 32_000,
              map: "{'max_tokens': maxOutputTokens}",
            },
          }),
        }),
      },
    ],
  };
}

describe("当前有效选择只读解析", () => {
  // fork（F4.11）：账号类 Provider 分类（account-plan / account-offpeak）随官方账号与
  // 闲时链路删除，去除 classifyProvider/accountStates 后只保留普通 BYOK/自定义 provider 行为。
  const original = Object.freeze({
    providerId: "personal",
    modelId: "same",
    options: Object.freeze({ reasoningLevel: "high" }),
  });
  const resolve = (providers: Provider[], selection: ModelSelection = original) =>
    resolveEffectiveModelSelection({
      registry: { revision: 1, providers },
      selection,
    });

  it("保留同模型同档位；原意图不改且 options 为冻结副本", () => {
    const result = resolve([provider("personal", "same")]);
    expect(result).toEqual({ effectiveSelection: { ...original } });
    expect(result.effectiveSelection?.options).not.toBe(original.options);
  });

  it("只缺档位时保留模型，不按位置或最高值替换", () => {
    expect(resolve([provider("personal", "same", ["low", "max"])])).toEqual({
      effectiveSelection: { providerId: "personal", modelId: "same" },
      selectionIssue: "reasoning-level-not-supported",
    });
  });

  it("缺同模型时留空，不找首模型、不归一大小写", () => {
    expect(resolve([provider("personal", "SAME")])).toEqual({
      effectiveSelection: null,
      selectionIssue: "model-not-found",
    });
  });

  it("暂时缺模型再恢复时始终从原意图重算", () => {
    expect(resolve([]).effectiveSelection).toBeNull();
    expect(resolve([provider("personal", "same")]).effectiveSelection?.options).toEqual(
      original.options,
    );
  });

  it("原意图为空不采用其他模型，未知 provider 不猜成正式身份", () => {
    const registry = { revision: 1, providers: [provider("personal", "same")] };
    expect(resolveEffectiveModelSelection({ registry, selection: null })).toEqual({
      effectiveSelection: null,
      selectionIssue: "selection-missing",
    });
    expect(resolve(registry.providers, { ...original, providerId: "account:not-formal" })).toEqual({
      effectiveSelection: null,
      selectionIssue: "provider-not-found",
    });
  });

  it("hidden provider 不可选", () => {
    const hidden = {
      ...provider("personal", "same"),
      config: createApiKeyProviderConfig({ visibility: "hidden" }),
    };
    expect(resolve([hidden]).effectiveSelection).toBeNull();
    expect(resolve([provider("personal", "same")]).effectiveSelection).not.toBeNull();
  });
});

describe("ProviderRegistry", () => {
  it("初始与替换快照保留 Provider 元数据，后续改名或清除不污染旧快照", () => {
    const original = { ...provider("A", "a"), providerName: "Original", templateId: "template-a" };
    const registry = new ProviderRegistry([original]);
    const oldView = registry.getView();
    expect(registry.getProvider("A")).toMatchObject({
      providerName: "Original",
      templateId: "template-a",
    });
    registry.replace(
      [{ ...original, providerName: "Renamed", templateId: "template-b" }],
      "rename",
    );
    expect(registry.getView().providers[0]).toMatchObject({
      providerName: "Renamed",
      templateId: "template-b",
    });
    expect(oldView.providers[0]).toMatchObject({
      providerName: "Original",
      templateId: "template-a",
    });
    expect(Object.isFrozen(oldView.providers[0])).toBe(true);
    registry.replace([provider("A", "a")], "clear-metadata");
    expect(registry.getProvider("A")?.providerName).toBeUndefined();
    expect(registry.getProvider("A")?.templateId).toBeUndefined();
    expect(
      registry.validateSelection({
        providerId: "A",
        modelId: "a",
        options: { reasoningLevel: "high" },
      }),
    ).toEqual({ ok: true });
  });

  it("旧关闭值只在意图解析中迁移，精确执行校验不能接受别名", () => {
    const registry = new ProviderRegistry([provider("A", "a", ["disabled", "enabled"])]);
    const original = { providerId: "A", modelId: "a", options: { reasoningLevel: "off" } };
    const resolved = resolveEffectiveModelSelection({
      selection: original,
      registry: registry.getView(),
      resolveLegacyReasoningLevel: () => "disabled",
    });
    expect(resolved.effectiveSelection?.options?.reasoningLevel).toBe("disabled");
    expect(registry.validateSelection(original).ok).toBe(false);
    expect(registry.validateSelection(resolved.effectiveSelection!).ok).toBe(true);
    const unsupported = resolveEffectiveModelSelection({
      selection: original,
      registry: registry.getView(),
      resolveLegacyReasoningLevel: () => "unsupported",
    });
    expect(unsupported.selectionIssue).toBe("reasoning-level-not-supported");
  });
  it("原子替换有序 View、索引和 revision，并让旧快照保持不变", () => {
    const registry = new ProviderRegistry([provider("A", "a")]);
    const oldView = registry.getView();
    const listener = vi.fn();
    const dispose = registry.onDidChange(listener);

    registry.replace([provider("B", "b"), provider("A", "a2")], "config-updated");

    expect(oldView.providers.map((item) => item.providerId)).toEqual(["A"]);
    expect(registry.getView().providers.map((item) => item.providerId)).toEqual(["B", "A"]);
    expect(registry.getProvider("B")?.models[0]?.modelId).toBe("b");
    expect(registry.getModel("A", "a2")?.modelId).toBe("a2");
    expect(registry.getView().revision).toBe(oldView.revision + 1);
    expect(listener).toHaveBeenCalledWith({
      revision: oldView.revision + 1,
      reason: "config-updated",
    });

    dispose();
  });

  it("返回稳定的 ModelSelection 校验结果", () => {
    const registry = new ProviderRegistry([provider("A", "a")]);

    expect(registry.validateSelection({ providerId: "A", modelId: "a" })).toEqual({
      ok: false,
      code: "reasoning-level-missing",
      providerId: "A",
      modelId: "a",
    });
    expect(registry.validateSelection({ providerId: "missing", modelId: "a" })).toEqual({
      ok: false,
      code: "provider-not-found",
      providerId: "missing",
    });
    expect(registry.validateSelection({ providerId: "A", modelId: "missing" })).toEqual({
      ok: false,
      code: "model-not-found",
      providerId: "A",
      modelId: "missing",
    });
    expect(
      registry.validateSelection({
        providerId: "A",
        modelId: "a",
        options: { reasoningLevel: "low" },
      }),
    ).toEqual({ ok: true });
    expect(
      registry.validateSelection({
        providerId: "A",
        modelId: "a",
        options: { reasoningLevel: "max" },
      }),
    ).toEqual({
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: "A",
      modelId: "a",
      reasoningLevel: "max",
      supportedLevels: ["low", "high"],
    });
    expect(
      new ProviderRegistry([provider("B", "b", ["disabled"])]).validateSelection({
        providerId: "B",
        modelId: "b",
        options: { reasoningLevel: "high" },
      }),
    ).toEqual({
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: "B",
      modelId: "b",
      reasoningLevel: "high",
      supportedLevels: ["disabled"],
    });
  });
});
