import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  createAccountProviderConfigSnapshot,
} from "@zcode/provider";
import { zcodeProviderUpdateAccountConfigParamsSchema } from "@zcode/shared";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseProcessAccountProviderConfigSnapshot,
  startProcessProviderRegistryRuntime,
} from "../src/app/process-provider-registry-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("process provider registry runtime", () => {
  it("Standalone 长生命周期下载 URL Release 后跟进 Registry；Managed Worker 不下载", async () => {
    const root = await temporaryDirectory();
    const builtin = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const bundled = join(root, "bundled.json");
    const active = join(root, "active.json");
    await writeFile(bundled, JSON.stringify(builtin));
    await writeFile(active, JSON.stringify(builtin));
    builtin.revision += 1;
    let releaseDownload!: () => void;
    const wait = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      if (String(url).includes("/api/v1/client/configs?"))
        return new Response(
          JSON.stringify({
            code: 0,
            data: { configs: { builtin_provider_config_json: "https://cdn.example.com/new.json" } },
          }),
        );
      await wait;
      return new Response(JSON.stringify(builtin));
    });
    const env = {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: active,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: bundled,
      // fork：远程刷新默认关闭，此处显式开启以验证机制本身。
      ZCODE_BUILTIN_REMOTE_REFRESH: "1",
    };
    const runtime = await startProcessProviderRegistryRuntime(env, {
      standalone: {
        request,
        legacyCliUserConfigFilePath: join(root, "absent.json"),
      },
    });
    const old = runtime.runtime.registryService.getSnapshot()!;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(runtime.runtime.registryService.getSnapshot()).toBe(old);
      releaseDownload();
      await vi.waitFor(() =>
        expect(runtime.runtime.registryService.getSnapshot()!.config.zcodeBuiltinRevision).toMatch(
          `zcode-builtin:${builtin.revision}:`,
        ),
      );
      const next = runtime.runtime.registryService.getSnapshot()!;
      expect(next.account.basedOnZCodeBuiltinRevision).toBe(next.config.zcodeBuiltinRevision);
      expect(JSON.parse(await readFile(active, "utf8")).revision).toBe(builtin.revision);
      expect(JSON.parse(await readFile(bundled, "utf8")).revision).toBe(builtin.revision - 1);
      const worker = await startProcessProviderRegistryRuntime(env);
      try {
        expect(worker.snapshot.config.zcodeBuiltinRevision).toBe(next.config.zcodeBuiltinRevision);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        worker.dispose();
      }
    } finally {
      releaseDownload();
      runtime.dispose();
    }
  });
  it("fork 默认不启用内置配置远程刷新：不请求控制面，active 文件保持 bundled 内容", async () => {
    const root = await temporaryDirectory();
    const builtin = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const bundled = join(root, "bundled.json");
    const active = join(root, "active.json");
    await writeFile(bundled, JSON.stringify(builtin));
    await writeFile(active, JSON.stringify(builtin));
    const request = vi.fn(async () => new Response("{}"));
    // 不设置 ZCODE_BUILTIN_REMOTE_REFRESH：fork 默认关闭官方远程刷新，
    // 防止官方 release 把已删除的 account:* provider 带回运行时（F4.1a followUp）。
    const runtime = await startProcessProviderRegistryRuntime(
      {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: active,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
        ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: bundled,
      },
      {
        standalone: {
          request,
          legacyCliUserConfigFilePath: join(root, "absent.json"),
        },
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(request).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(active, "utf8")).revision).toBe(builtin.revision);
      const snapshot = runtime.runtime.registryService.getSnapshot()!;
      expect(snapshot.config.zcodeBuiltinRevision).toMatch(`zcode-builtin:${builtin.revision}:`);
    } finally {
      runtime.dispose();
    }
  });
  it("Built-in 文件更新仍整体发布 Registry（Standalone 账号运行时已删除）", async () => {
    const root = await temporaryDirectory();
    const builtin = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const filePath = join(root, "builtin.json");
    await writeFile(filePath, JSON.stringify(builtin));
    const runtime = await startProcessProviderRegistryRuntime(
      {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: filePath,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
      },
      { standalone: { legacyCliUserConfigFilePath: join(root, "absent.json") } },
    );
    try {
      builtin.revision += 1;
      await writeFile(filePath, JSON.stringify(builtin));
      await vi.waitFor(() => {
        const next = runtime.runtime.registryService.getSnapshot()!;
        expect(next.config.zcodeBuiltinRevision).toMatch(`zcode-builtin:${builtin.revision}:`);
        expect(next.account.basedOnZCodeBuiltinRevision).toBe(next.config.zcodeBuiltinRevision);
      });
      expect(
        runtime.runtime.registryService.getProvider("account:bigmodel-individual-coding-plan"),
      ).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });
  it("真实 Built-in 下完整状态跨协议往返；仅切 current 即更新 Worker 的 Registry 投影", async () => {
    // F4.1a 已从仓库 builtin 配置删除 account:* 官方账号 provider，原用例依赖
    // builtin 物化 account:bigmodel-*-coding-plan 已不可能；跨协议往返与「仅切
    // current 即更新有效选择」的机制改用本地 fixture 验证（与本文件 zcodeBuiltinRelease
    // 工厂风格一致），不向任何 config JSON 回填账号数据。
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personal = "account:bigmodel-individual-coding-plan";
    const team = "account:bigmodel-team-coding-plan";
    const codingPlanProvider = {
      group: "bigmodel-family",
      access: {
        type: "zhipu-account",
        accountType: "bigmodel",
        mode: "individual-coding-plan",
      },
      api: { type: "anthropic-messages", baseUrl: "https://account.example.com" },
      builtinModelIds: ["GLM-5.3"],
    };
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(
        zcodeBuiltinRelease({
          providers: {
            [personal]: codingPlanProvider,
            [team]: {
              ...codingPlanProvider,
              access: { ...codingPlanProvider.access, mode: "team-coding-plan" },
            },
          },
          templates: {},
          models: [codingPlanModelRule()],
        }),
      ),
      "utf8",
    );
    const runtime = await startProcessProviderRegistryRuntime({
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
    });
    const original = Object.freeze({
      providerId: personal,
      modelId: "GLM-5.3",
      options: Object.freeze({ reasoningLevel: "high" }),
    });
    const facade = createNodeModelSelectionFacade(runtime.runtime.registryService);
    const providers = new ProviderConfigMap(
      [personal, team].map((id) => [
        id,
        new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
      ]),
    );
    const revisions = new Set<string>();
    try {
      for (const current of [personal, team, personal]) {
        const snapshot = createAccountProviderConfigSnapshot(
          runtime.snapshot.config.zcodeBuiltinRevision,
          providers,
          {
            [personal]: {
              availability: "available",
              entitled: true,
              current: current === personal,
            },
            [team]: { availability: "available", entitled: true, current: current === team },
          },
        );
        revisions.add(snapshot.revision);
        const wire = zcodeProviderUpdateAccountConfigParamsSchema.parse(
          JSON.parse(
            JSON.stringify({
              ...snapshot,
              providers: Object.fromEntries(
                [...snapshot.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
              ),
            }),
          ),
        );
        await runtime.syncAccountProviderConfig(parseProcessAccountProviderConfigSnapshot(wire));
        expect(runtime.runtime.registryService.getProvider(current)).toBeDefined();
        expect(
          runtime.runtime.registryService.getProvider(current === personal ? team : personal),
        ).toBeUndefined();
        // fork（F4.11）：账号分类器与“旧账号自动对应到 current 账号”的改写已删除；
        // 选择解析只认 Registry 当前发布的事实。
        expect(
          facade.getView(undefined, undefined, { selection: original }).effectiveSelection,
        ).toEqual(current === personal ? { ...original } : null);
        expect(original.providerId).toBe(personal);
      }
      expect(revisions.size).toBe(2);
    } finally {
      runtime.dispose();
    }
  });

  it("解析独立同步的 Account Provider Config", () => {
    const states = {
      account: { availability: "available", entitled: true, current: false },
    } as const;
    const parsed = parseProcessAccountProviderConfigSnapshot({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "zcode-builtin:1",
      states,
      providers: {
        account: {
          access: { type: "zhipu-account", entitled: true },
          builtinModelIds: ["model-a"],
        },
      },
    });

    expect(
      Object.fromEntries(
        [...parsed.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      account: {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-a"],
      },
    });
    expect(parsed.basedOnZCodeBuiltinRevision).toBe("zcode-builtin:1");
    expect(parsed.states).toEqual(states);
  });

  it("独立 Account Config 同步拒绝 API Provider", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "account-invalid",
        basedOnZCodeBuiltinRevision: "zcode-builtin:1",
        providers: {
          api: {
            access: {
              type: "api-key",
              apiKey: "must-not-enter-account-source",
            },
          },
        },
      }),
    ).toThrow();
  });

  it("独立 Account Config 只接受 entitlement 与账号特定模型成员", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "account-invalid-static-field",
        basedOnZCodeBuiltinRevision: "zcode-builtin:1",
        providers: {
          account: {
            access: { type: "zhipu-account", entitled: true },
            label: "不得由 Account Source 覆盖",
          },
        },
      }),
    ).toThrow();
  });

  it("未注入 Provider Config 路径时拒绝启动", async () => {
    await expect(startProcessProviderRegistryRuntime({})).rejects.toThrow(
      "缺少进程 Provider Registry",
    );
  });

  it("Personal 文件损坏时保留原文件并以内存空配置启动", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(zcodeBuiltinRelease({ providers: {}, templates: {}, models: [] })),
    );
    await writeFile(personalFilePath, "{not-json");
    const started = await startProcessProviderRegistryRuntime({
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    });
    try {
      expect(started.configuredDefaultModelSelection).toBeUndefined();
      expect(await readFile(personalFilePath, "utf8")).toBe("{not-json");
      await expect(
        started.modelSelectionConfigRepository.saveConfiguredDefault(undefined),
      ).rejects.toThrow();
    } finally {
      started.dispose();
    }
    await expect(started.modelSelectionConfigRepository.read()).rejects.toThrow("已 dispose");
    await expect(started.runtime.start()).rejects.toThrow("已 dispose");
  });

  it("从进程环境启动一份 Registry，并由调用方持有生命周期", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(
        zcodeBuiltinRelease({
          providers: {
            account: {
              group: "zai-family",
              access: {
                type: "zhipu-account",
                accountType: "zai",
                mode: "individual-coding-plan",
              },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://account.example.com",
              },
              builtinModelIds: ["model-a"],
            },
          },
          templates: {
            "zcode-template": {
              access: { type: "api-key" },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://api.example.com",
              },
              builtinModelIds: ["model-a"],
            },
          },
          models: [
            {
              modelMatch: "model-a",
              config: {
                enabled: true,

                properties: {
                  requiresMfjsToolSchema: false,
                  contextWindow: 200000,
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
                },
                optionSpecs: {
                  reasoningLevel: { values: ["disabled"], map: "{}" },
                  maxOutputTokens: {
                    max: 32000,
                    map: '{"max_completion_tokens":maxOutputTokens}',
                  },
                },
              },
            },
          ],
        }),
      ),
      "utf8",
    );
    await writeFile(
      personalFilePath,
      JSON.stringify(
        personalRelease([
          {
            providerId: "personal-api",
            templateId: "zcode-template",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "secret" },
            },
          },
        ]),
      ),
      "utf8",
    );

    const started = await startProcessProviderRegistryRuntime({
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    });

    expect(started?.snapshot.registry.providers).toHaveLength(1);
    expect(started?.runtime.registryService.getModel("personal-api", "model-a")).toBeDefined();
    started?.accountSource.replace(
      {
        revision: "account-access-1",
        basedOnZCodeBuiltinRevision: started!.snapshot.config.zcodeBuiltinRevision,
        providers: new ProviderConfigMap([
          [
            "account",
            new ProviderConfig({
              access: new ZhipuAccountAccessConfig({ entitled: true }),
            }),
          ],
        ]),
      },
      "test",
    );
    await started?.runtime.registryService.refresh("wait-for-account-access");
    expect(started?.runtime.registryService.getProvider("account")?.config).toMatchObject({
      access: {
        type: "zhipu-account",
      },
      builtinModelIds: ["model-a"],
    });
    const beforeSwitch = await started.accountSource.read();
    const switched = parseProcessAccountProviderConfigSnapshot({
      revision: "account-access-2",
      basedOnZCodeBuiltinRevision: beforeSwitch.basedOnZCodeBuiltinRevision,
      providers: Object.fromEntries(
        [...beforeSwitch.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
      ),
      states: { account: { availability: "available", entitled: true, current: false } },
    });
    started.accountSource.replace(switched, "account-no-longer-current");
    await started.runtime.registryService.refresh("wait-for-account-selection");
    expect(started.runtime.registryService.getProvider("account")).toBeUndefined();
    expect(started.runtime.registryService.getProvider("personal-api")).toBeDefined();
    started?.dispose();
  });

  it("只有显式开启 Standalone 导入时才迁移旧 CLI 用户 Provider", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    const legacyFilePath = join(root, "legacy-cli.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(
        zcodeBuiltinRelease({
          providers: {},
          templates: {},
          // Personal Provider 仍由 Built-in 通用规则补齐静态模型事实；迁移器只搬运旧文件显式字段。
          models: [completeZCodeBuiltinModelRule()],
        }),
      ),
      "utf8",
    );
    await writeFile(
      legacyFilePath,
      JSON.stringify({
        model: "custom/model-a",
        provider: {
          custom: {
            kind: "anthropic",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com",
            },
            models: {
              "model-a": {
                limit: { context: 64_000, output: 8_000 },
              },
            },
          },
        },
      }),
      "utf8",
    );
    const env = {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    };

    // Protocol 启动会创建自己的空目标文件；若与 Standalone 共用目标，就会提前消费
    // “仅目标不存在时导入”的机会，无法再证明 Standalone importer 的独立边界。
    const protocolRuntime = await startProcessProviderRegistryRuntime({
      ...env,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "protocol-personal.json"),
    });
    expect(protocolRuntime?.snapshot.registry.providers).toEqual([]);
    expect(protocolRuntime?.configuredDefaultModelSelection).toBeUndefined();
    protocolRuntime?.dispose();

    const standaloneRuntime = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyFilePath },
    });
    expect(standaloneRuntime?.snapshot.registry.providers.map((entry) => entry.providerId)).toEqual(
      ["custom"],
    );
    expect(JSON.parse(await readFile(personalFilePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "custom", config: { access: { type: "api-key", apiKey: "secret" } } },
          ],
        },
      },
    });
    expect(standaloneRuntime?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    expect(
      JSON.parse(await readFile(personalFilePath, "utf8")).config.defaultModelSelection,
    ).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    standaloneRuntime?.dispose();

    const protocolRestart = await startProcessProviderRegistryRuntime(env);
    expect(protocolRestart?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    protocolRestart?.dispose();

    await writeFile(
      legacyFilePath,
      JSON.stringify({
        provider: {
          replacement: {
            kind: "anthropic",
            options: {
              apiKey: "replacement-secret",
              baseURL: "https://replacement.example.com",
            },
            models: {
              "model-b": { limit: { context: 32_000, output: 4_000 } },
            },
          },
        },
      }),
      "utf8",
    );
    const restarted = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyFilePath },
    });
    expect(restarted?.snapshot.registry.providers.map((entry) => entry.providerId)).toEqual([
      "custom",
    ]);
    expect(restarted?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    restarted?.dispose();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-process-provider-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function completeZCodeBuiltinModelRule() {
  return {
    modelMatch: ".*",
    config: {
      enabled: true,

      properties: {
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
      },
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: {
          max: 32_000,
          map: '{"max_completion_tokens":maxOutputTokens}',
        },
      },
    },
  } as const;
}

/** 账号 Coding Plan fixture 的模型规则：reasoningLevel 覆盖 high 供有效选择断言使用。 */
function codingPlanModelRule() {
  return {
    modelMatch: "GLM-5.3",
    config: {
      enabled: true,
      properties: {
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
      },
      optionSpecs: {
        reasoningLevel: {
          values: ["disabled", "low", "medium", "high"],
          map: "{}",
        },
        maxOutputTokens: {
          max: 32_000,
          map: '{"max_completion_tokens":maxOutputTokens}',
        },
      },
    },
  } as const;
}

function zcodeBuiltinRelease(input: {
  readonly providers: object;
  readonly templates: object;
  readonly models: readonly unknown[];
}): object {
  return {
    schemaVersion: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: 1,
    config: {
      providerConfigRules: {
        providerRules: Object.entries(input.providers).map(([providerId, config]) => ({
          providerId,
          config,
        })),
        templateRules: Object.entries(input.templates).map(([templateId, config]) => ({
          templateId,
          templateNameMap: { "en-US": templateId, "zh-CN": templateId },
          config,
        })),
      },
      modelConfigRules: {
        modelRules: input.models,
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}

function personalRelease(providerRules: readonly unknown[]) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}
