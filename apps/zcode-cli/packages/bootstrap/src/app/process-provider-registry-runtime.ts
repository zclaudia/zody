import {
  MutableAccountProviderConfigSource,
  createAccountProviderConfigSnapshot,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
} from "@zcode/provider";
import {
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
} from "@zcode/shared";
import { dirname, join } from "node:path";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  downloadZCodeBuiltinRelease,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** Standalone Prompt CLI / TUI 的旧配置一次性导入与内置配置刷新回调。 */
  readonly standalone?: {
    readonly legacyCliUserConfigFilePath?: string;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  }

  const accountSource = new MutableAccountProviderConfigSource();
  const bundledFile = options.standalone
    ? env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim()
    : undefined;
  // fork：默认关闭内置配置的官方远程刷新——官方 release（如 revision 31）会把已删除的
  // account:* 官方账号 provider 带回运行时，破坏「内置列表剔除官方账号」的装配决策
  // （specs/fork-official-deps-removal-tasks.md F4.1a followUps 实测：E2E 打包 agent 联网时
  // configRevision 被回填为 zcode-builtin:31）。仅显式设置 ZCODE_BUILTIN_REMOTE_REFRESH=1
  // 时启用，留作未来接入自建控制面的过渡开关。
  const remoteRefreshEnabled = ["1", "true", "yes"].includes(
    (env.ZCODE_BUILTIN_REMOTE_REFRESH ?? "").trim().toLowerCase(),
  );
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile
      ? {
          zcodeBuiltinFilePath: bundledFile,
          zcodeBuiltinActiveFilePath: paths.zcodeBuiltinFilePath,
          ...(remoteRefreshEnabled
            ? {
                zcodeBuiltinRemote: {
                  controlFilePath: join(
                    dirname(paths.zcodeBuiltinFilePath),
                    "zcode-builtin-refresh.json",
                  ),
                  resolveEndpointKey: () => resolveRuntimeZCodeEndpointOrigin(env),
                  fetchRelease: (endpointOrigin, signal) =>
                    downloadZCodeBuiltinRelease({
                      endpointOrigin,
                      signal,
                      appVersion: ZCODE_VERSION,
                      platform: resolveZCodeBuiltinClientPlatform(),
                      request: options.standalone?.request ?? globalThis.fetch,
                    }),
                  onRefreshResult: options.standalone?.onBuiltinRefreshResult,
                },
              }
            : {}),
        }
      : {}),
    onZCodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    accountSource,
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  // fork（F4.9）：Standalone Coding Plan 账号服务删除后，Built-in 变更不再有
  // AccountService 自动重算 basedOnZCodeBuiltinRevision；Mutable Account Overlay 必须
  // 跟随 Built-in 重定基，否则 Registry 会判定账号事实过期而持续服务旧快照。
  // Provider/states 原样保留，只更新 baseline revision；账号链收口后此处随 F4.7 再简化。
  const disposeAccountRebase = runtime.configService.onDidChange(() => {
    void (async () => {
      try {
        const [config, account] = await Promise.all([
          runtime.configService.read(),
          accountSource.read(),
        ]);
        if (account.basedOnZCodeBuiltinRevision === config.zcodeBuiltinRevision) return;
        accountSource.replace(
          createAccountProviderConfigSnapshot(
            config.zcodeBuiltinRevision,
            account.providers,
            account.states ?? {},
          ),
          "config-rebased",
        );
        await runtime.registryService.refresh("account-config-rebased");
      } catch (error) {
        options.standalone?.onBuiltinRefreshError?.(error);
      }
    })();
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      // fork（F4.9）：Standalone Coding Plan 账号运行时随 CLI 登录一并删除；
      // 进程 Registry 仅保留 Host 推送的通用 Account Overlay（账号链收口见 F4.7）。
      return Object.freeze({
        accountSource,
        async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
          const changed = accountSource.replace(next, "host-account-config");
          // Source 去重只证明收过，不证明上次刷新成功。重交时仍刷新；配套配置未到
          // 则由 Registry 保留完整旧快照，不能把接收确认冒充应用确认。
          await runtime.registryService.refresh("host-account-config");
          return changed;
        },
        dispose() {
          disposeAccountRebase();
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    disposeAccountRebase();
    runtime.dispose();
    throw error;
  }
}

/** 把协议信封解析为进程 Registry 使用的第三层 Account Config Overlay。 */
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision 不能为空");
  const basedOnZCodeBuiltinRevision = input.basedOnZCodeBuiltinRevision.trim();
  if (!basedOnZCodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision 不能为空");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // 仅约束托管 Worker 的普通账号信封；独立 CLI、API 和闲时不需要 current。
    // fork（F4.11）：账号 Provider 已下线，不再用 builtin 身份表过滤；旧 Worker 发来的
    // zhipu-account 信封仍要求 current 与 entitled 同时存在，避免发布半份账号事实。
    if (
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State 缺少 current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnZCodeBuiltinRevision,
    providers,
    // 与 Overlay 属于同一快照；不能只更新 revision 却丢掉当前连接事实。
    ...(input.states ? { states: input.states } : {}),
  });
}
