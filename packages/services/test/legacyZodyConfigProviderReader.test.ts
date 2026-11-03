import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import {
  createModelProviderModelConfig,
  isModelProviderModelConfig,
  type ModelProviderConfig,
  type ModelProviderModelConfig,
} from "../src/model-provider/legacyModelProviderSerialized.js";
import { readLegacyZodyConfigProviders } from "../src/model-provider/legacyZodyConfigProviderReader.js";

function createProvider(): ModelProviderConfig {
  return {
    id: "custom:test",
    name: "Test Provider",
    endpoints: {
      baseURL: "https://example.test/api",
      paths: {
        anthropic: "/messages",
      },
    },
    apiFormat: "anthropic-messages",
    defaultKind: "anthropic",
    apiKey: "test-key",
    models: [
      createModelProviderModelConfig({
        id: "test-model",
        kinds: ["anthropic"],
        defaultKind: "anthropic",
      }),
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

function legacyConfigWithModels(
  models: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return {
    provider: {
      "custom:test": {
        name: "Test Provider",
        options: { baseURL: "https://example.test/api", apiKey: "test-key" },
        models,
      },
    },
  };
}

function readModel(
  providers: readonly ModelProviderConfig[],
  modelId: string,
): ModelProviderModelConfig {
  const model = providers
    .find((provider) => provider.id === "custom:test")
    ?.models.find((entry) => isModelProviderModelConfig(entry) && entry.id === modelId);
  if (!model || !isModelProviderModelConfig(model)) {
    throw new Error(`未找到模型配置: ${modelId}`);
  }
  return model;
}

describe("legacyZCodeConfigProviderReader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-provider-store-"));
    setDataBaseDir(tempDir);
  });

  afterEach(() => {
    setDataBaseDir(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("彻底忽略 model-providers.json", async () => {
    const legacyConfigDir = join(tempDir, ".zody", "v2");
    mkdirSync(legacyConfigDir, { recursive: true });
    writeFileSync(
      join(legacyConfigDir, "model-providers.json"),
      JSON.stringify({
        schemaVersion: "zcode.model-providers.v2",
        providers: [createProvider()],
      }),
      "utf8",
    );
    const providers = await readLegacyZodyConfigProviders();

    const configDir = join(tempDir, ".zody", "v2");
    expect(providers).toEqual([]);
    expect(() => readFileSync(join(configDir, "config.json"), "utf-8")).toThrow();
  });

  it("只从已发布旧 config.json 读取 Provider", async () => {
    const legacyConfigDir = join(tempDir, ".zody", "v2");
    mkdirSync(legacyConfigDir, { recursive: true });
    writeFileSync(
      join(legacyConfigDir, "config.json"),
      JSON.stringify({
        provider: {
          "custom:test": {
            name: "Test Provider",
            options: { baseURL: "https://example.test/api", apiKey: "test-key" },
            models: { "test-model": {} },
          },
        },
      }),
      "utf8",
    );

    const providers = await readLegacyZodyConfigProviders();

    expect(providers.map((provider) => provider.id)).toEqual(["custom:test"]);
  });

  it("输出上限按 limit.output > options.max_tokens > 顶层 maxOutputTokens 取值", async () => {
    const configDir = join(tempDir, ".zody", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(
        legacyConfigWithModels({
          "limit-wins": {
            limit: { output: 4000 },
            options: { max_tokens: 3000 },
            maxOutputTokens: 2000,
          },
          "options-wins": { options: { max_tokens: 3000 }, maxOutputTokens: 2000 },
          "top-level-only": { maxOutputTokens: 2000 },
        }),
      ),
      "utf8",
    );

    const providers = await readLegacyZodyConfigProviders();

    expect(readModel(providers, "limit-wins").maxOutputTokens).toBe(4000);
    expect(readModel(providers, "options-wins").maxOutputTokens).toBe(3000);
    expect(readModel(providers, "top-level-only").maxOutputTokens).toBe(2000);
  });

  it.each([
    ["0", 0],
    ["负数", -1],
    ["小数", 1024.5],
    ["字符串", "1024"],
  ])("拒绝 maxOutputTokens 为%s的旧配置", async (_label, value) => {
    const configDir = join(tempDir, ".zody", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(legacyConfigWithModels({ "test-model": { maxOutputTokens: value } })),
      "utf8",
    );

    await expect(readLegacyZodyConfigProviders()).rejects.toThrow(
      /stage=schema .*field=provider\.custom:test\.models\.test-model\.maxOutputTokens$/,
    );
  });

  it("limit.output 为小数时整份旧配置校验失败，不回退到其他来源", async () => {
    const configDir = join(tempDir, ".zody", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(
        legacyConfigWithModels({
          "test-model": { limit: { output: 1024.5 }, maxOutputTokens: 8192 },
        }),
      ),
      "utf8",
    );

    await expect(readLegacyZodyConfigProviders()).rejects.toThrow(
      /stage=schema .*field=provider\.custom:test\.models\.test-model\.limit\.output$/,
    );
  });

  it("options.max_tokens 的非正整数被忽略并继续 fallback", async () => {
    const configDir = join(tempDir, ".zody", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(
        legacyConfigWithModels({
          "options-decimal-only": { options: { max_tokens: 1024.5 } },
          "options-decimal-fallback": {
            options: { max_tokens: 1024.5 },
            maxOutputTokens: 8192,
          },
          "options-zero": { options: { max_tokens: 0 } },
          "options-negative": { options: { max_tokens: -1 } },
          "options-string": { options: { max_tokens: "1024" } },
        }),
      ),
      "utf8",
    );

    const providers = await readLegacyZodyConfigProviders();

    expect(readModel(providers, "options-decimal-only").maxOutputTokens).toBeUndefined();
    expect(readModel(providers, "options-decimal-fallback").maxOutputTokens).toBe(8192);
    expect(readModel(providers, "options-zero").maxOutputTokens).toBeUndefined();
    expect(readModel(providers, "options-negative").maxOutputTokens).toBeUndefined();
    expect(readModel(providers, "options-string").maxOutputTokens).toBeUndefined();
  });

  it("不把开发阶段曾写入 config.json 的未发布 Provider 格式当作迁移输入", async () => {
    const configDir = join(tempDir, ".zody", "v2");
    const configPath = join(configDir, "config.json");
    const document = {
      schemaVersion: 1,
      providers: { unreleased: { enabled: true } },
      modelConfigRules: [],
    };
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(document, null, 2), "utf8");

    await expect(readLegacyZodyConfigProviders()).resolves.toEqual([]);

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(document);
  });
});
