import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  isOfficialAccountProviderId,
  removeAccountSubagentOverrides,
  removeOfficialAccountCredentialKeys,
  runOfficialAccountProviderDataMigration,
} from "../src/model-provider/officialAccountDataMigration.js";

describe("F4.1a 官方账号存量数据迁移", () => {
  const tempDirs: string[] = [];
  const makeTempDir = async (prefix: string) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

  it("provider_config.json：defaultModelSelection 指向 account:* 时清空为未配置，不改选其他 provider", async () => {
    const dir = await makeTempDir("zcode-account-migration-config-");
    const configPath = join(dir, "provider_config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "my-openai-proxy",
                config: {
                  group: "standard-personal",
                  api: { type: "openai-chat-completions", baseUrl: "https://example.invalid/v1" },
                  access: { type: "api-key", apiKey: "sk-test" },
                  personalModelIds: ["gpt-test"],
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          defaultModelSelection: {
            providerId: "account:zai-individual-coding-plan",
            modelId: "GLM-5.3",
          },
        },
      }),
      "utf-8",
    );
    const repository = new NodePersonalProviderConfigRepository({
      filePath: configPath,
      pollingIntervalMs: false,
    });
    try {
      const result = await runOfficialAccountProviderDataMigration({ personalRepository: repository });
      expect(result.clearedDefaultModelSelection).toBe(true);
      const onDisk = await readJson(configPath);
      // 清空即「未配置模型」，绝不静默改选 BYOK/其他付费 provider。
      expect(onDisk.config.defaultModelSelection).toBeUndefined();
    } finally {
      repository.dispose();
    }
  });

  it("provider_config.json：BYOK/自定义模型选择保留，重复迁移零写入（幂等）", async () => {
    const dir = await makeTempDir("zcode-account-migration-config-");
    const configPath = join(dir, "provider_config.json");
    const seed = {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "my-openai-proxy",
              config: {
                group: "standard-personal",
                api: { type: "openai-chat-completions", baseUrl: "https://example.invalid/v1" },
                access: { type: "api-key", apiKey: "sk-test" },
                personalModelIds: ["gpt-test"],
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId: "my-openai-proxy", modelId: "gpt-test" },
      },
    };
    await writeFile(configPath, JSON.stringify(seed), "utf-8");
    const before = await readFile(configPath, "utf-8");
    const repository = new NodePersonalProviderConfigRepository({
      filePath: configPath,
      pollingIntervalMs: false,
    });
    try {
      const first = await runOfficialAccountProviderDataMigration({ personalRepository: repository });
      const second = await runOfficialAccountProviderDataMigration({ personalRepository: repository });
      expect(first.clearedDefaultModelSelection).toBe(false);
      expect(second.clearedDefaultModelSelection).toBe(false);
      // 幂等：非 account 选择不触发任何写盘（编码归一除外，语义不变）。
      const onDisk = await readJson(configPath);
      expect(onDisk.config.defaultModelSelection).toEqual({
        providerId: "my-openai-proxy",
        modelId: "gpt-test",
      });
      expect(onDisk.config.providerConfigRules.providerRules).toHaveLength(1);
      expect(before.length).toBeGreaterThan(0);
    } finally {
      repository.dispose();
    }
  });

  it("agents-state.json：内置与插件子代理的 account:* 覆盖按条目删除，其余字段保留", async () => {
    const dir = await makeTempDir("zcode-account-migration-agents-");
    const stateFile = join(dir, "agents-state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        builtInModelSelectionOverrides: {
          "general-purpose": { providerId: "account:zai-start-plan", modelId: "GLM-5.2" },
          Explore: { providerId: "my-openai-proxy", modelId: "gpt-test" },
        },
        pluginAgentModelSelectionOverrides: {
          "plugin-a": { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" },
        },
        disabledAgentIds: ["legacy-agent"],
      }),
      "utf-8",
    );
    const removed = await removeAccountSubagentOverrides(stateFile);
    expect(removed).toBe(2);
    const state = await readJson(stateFile);
    expect(state.builtInModelSelectionOverrides).toEqual({
      Explore: { providerId: "my-openai-proxy", modelId: "gpt-test" },
    });
    expect(state.pluginAgentModelSelectionOverrides).toEqual({});
    expect(state.disabledAgentIds).toEqual(["legacy-agent"]);
  });

  it("agents-state.json：无 account 覆盖或文件缺失时零写入（幂等）", async () => {
    const dir = await makeTempDir("zcode-account-migration-agents-");
    const stateFile = join(dir, "agents-state.json");
    const seed = {
      builtInModelSelectionOverrides: {
        Explore: { providerId: "personal-zai", modelId: "glm-5.3" },
      },
      disabledAgentIds: [],
    };
    await writeFile(stateFile, JSON.stringify(seed), "utf-8");
    const before = await readFile(stateFile, "utf-8");
    expect(await removeAccountSubagentOverrides(stateFile)).toBe(0);
    expect(await removeAccountSubagentOverrides(stateFile)).toBe(0);
    expect(await readFile(stateFile, "utf-8")).toBe(before);
    // 缺失文件不创建。
    expect(await removeAccountSubagentOverrides(join(dir, "missing.json"))).toBe(0);
    await expect(readFile(join(dir, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("credentials.json：oauth:*/zcodejwttoken/account-provider:* 键删除，其他键保留", async () => {
    const dir = await makeTempDir("zcode-account-migration-creds-");
    const credsFile = join(dir, "credentials.json");
    await writeFile(
      credsFile,
      JSON.stringify({
        "oauth:active_provider": "enc-zai",
        "oauth:zai:access_token": "enc-token",
        "oauth:bigmodel:refresh_token": "enc-refresh",
        zcodejwttoken: "enc-jwt",
        "account-provider:zai:api-key": "enc-derived",
        "user-api-key:openai": "enc-user-key",
      }),
      "utf-8",
    );
    const removed = await removeOfficialAccountCredentialKeys(credsFile);
    expect(removed.sort()).toEqual([
      "account-provider:zai:api-key",
      "oauth:active_provider",
      "oauth:bigmodel:refresh_token",
      "oauth:zai:access_token",
      "zcodejwttoken",
    ]);
    const rest = await readJson(credsFile);
    expect(rest).toEqual({ "user-api-key:openai": "enc-user-key" });
  });

  it("credentials.json：无官方账号键或文件缺失时零写入（幂等）", async () => {
    const dir = await makeTempDir("zcode-account-migration-creds-");
    const credsFile = join(dir, "credentials.json");
    await writeFile(credsFile, JSON.stringify({ "user-api-key:openai": "enc-user-key" }), "utf-8");
    const before = await readFile(credsFile, "utf-8");
    expect(await removeOfficialAccountCredentialKeys(credsFile)).toEqual([]);
    expect(await removeOfficialAccountCredentialKeys(credsFile)).toEqual([]);
    expect(await readFile(credsFile, "utf-8")).toBe(before);
    expect(await removeOfficialAccountCredentialKeys(join(dir, "missing.json"))).toEqual([]);
  });

  it("总迁移入口：各存储位置一次性完成，重复执行结果一致", async () => {
    const dir = await makeTempDir("zcode-account-migration-all-");
    const configPath = join(dir, "provider_config.json");
    const stateFile = join(dir, "agents-state.json");
    const credsFile = join(dir, "credentials.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          defaultModelSelection: {
            providerId: "account:zai-individual-coding-plan",
            modelId: "GLM-5.3",
          },
        },
      }),
      "utf-8",
    );
    await writeFile(
      stateFile,
      JSON.stringify({
        builtInModelSelectionOverrides: {
          "general-purpose": { providerId: "account:zai-start-plan", modelId: "GLM-5.2" },
        },
      }),
      "utf-8",
    );
    await writeFile(
      credsFile,
      JSON.stringify({ "oauth:zai:access_token": "enc-token", zcodejwttoken: "enc-jwt" }),
      "utf-8",
    );
    const repository = new NodePersonalProviderConfigRepository({
      filePath: configPath,
      pollingIntervalMs: false,
    });
    try {
      const first = await runOfficialAccountProviderDataMigration({
        personalRepository: repository,
        resolveAgentsStateFilePath: async () => stateFile,
        credentialsFilePath: credsFile,
      });
      expect(first.clearedDefaultModelSelection).toBe(true);
      expect(first.removedSubagentOverrides).toBe(1);
      expect(first.removedCredentialKeys.sort()).toEqual(["oauth:zai:access_token", "zcodejwttoken"]);

      const second = await runOfficialAccountProviderDataMigration({
        personalRepository: repository,
        resolveAgentsStateFilePath: async () => stateFile,
        credentialsFilePath: credsFile,
      });
      expect(second).toEqual({
        clearedDefaultModelSelection: false,
        removedSubagentOverrides: 0,
        removedCredentialKeys: [],
      });
    } finally {
      repository.dispose();
    }
  });

  it("isOfficialAccountProviderId 只匹配 account: 前缀", () => {
    expect(isOfficialAccountProviderId("account:zai-start-plan")).toBe(true);
    expect(isOfficialAccountProviderId("personal-zai")).toBe(false);
    expect(isOfficialAccountProviderId("template:zai-api")).toBe(false);
    expect(isOfficialAccountProviderId(undefined)).toBe(false);
  });

  it("personalRepository 缺省时不抛错（无 Personal 仓库的环境只迁移其余位置）", async () => {
    const dir = await makeTempDir("zcode-account-migration-partial-");
    const credsFile = join(dir, "credentials.json");
    await writeFile(credsFile, JSON.stringify({ zcodejwttoken: "enc-jwt" }), "utf-8");
    const result = await runOfficialAccountProviderDataMigration({
      credentialsFilePath: credsFile,
    });
    expect(result.clearedDefaultModelSelection).toBe(false);
    expect(result.removedCredentialKeys).toEqual(["zcodejwttoken"]);
  });

  it("损坏的 agents-state.json / credentials.json 跳过且不抛错，由各自服务保留恢复语义", async () => {
    const dir = await makeTempDir("zcode-account-migration-corrupt-");
    const stateFile = join(dir, "agents-state.json");
    const credsFile = join(dir, "credentials.json");
    await mkdir(dir, { recursive: true });
    await writeFile(stateFile, "{broken", "utf-8");
    await writeFile(credsFile, "{broken", "utf-8");
    const result = await runOfficialAccountProviderDataMigration({
      resolveAgentsStateFilePath: async () => stateFile,
      credentialsFilePath: credsFile,
    });
    expect(result.removedSubagentOverrides).toBe(0);
    expect(result.removedCredentialKeys).toEqual([]);
    // 不覆盖损坏文件证据。
    expect(await readFile(stateFile, "utf-8")).toBe("{broken");
    expect(await readFile(credsFile, "utf-8")).toBe("{broken");
  });
});
