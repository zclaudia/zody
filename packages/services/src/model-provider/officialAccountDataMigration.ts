/* eslint-disable max-lines -- 五个存量存储位置的一次性迁移必须共享同一幂等判定，拆开会复制键匹配规则 */
import { readFile } from "node:fs/promises";
import type { PersonalProviderConfigRepository } from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";

/**
 * fork（F4.1a）：官方账号 provider 下线后的一次性存量数据迁移。
 *
 * 产品规则（总纲阶段 4）：
 * - 存量官方账号凭据不再读取并在首次启动时清理；
 * - 选中模型属于已删除的官方账号 provider 时回落到「未配置模型」，不得启动失败，
 *   也不得静默改选其他付费 provider；
 * - 迁移必须幂等（每次 Host 启动都可安全重跑，无命中则零写入）。
 *
 * 覆盖的存储位置：
 * 1. provider_config.json 的 defaultModelSelection（含读路径上的Personal 覆盖层）；
 * 2. ~/.zcode/v2/agents-state.json 的内置/插件子代理模型选择覆盖；
 * 3. credentials.json 的 `oauth:*`、`zcodejwttoken`、`account-provider:*` 键；
 * 4. app settings 的 providerFamilyDomain / providerFamilyConnectionSelections /
 *    startPlanRecommendationDismissed 保留可解析、不在此删除（schema 兼容读取）；
 * 5. 自动化任务的模型选择走 tasksDatabase 账本迁移 0004（见 tasksDatabase/migrations.ts）；
 * 6. 渲染端 localStorage（composer 草稿 / 最近模型）由 packages/ui 的启动迁移处理。
 */

const logger = createServiceLogger("official-account-data-migration");

/** 官方账号 provider 的 providerId 统一前缀（Built-in Config 已不再声明这些 provider）。 */
export function isOfficialAccountProviderId(providerId: string | undefined): boolean {
  return typeof providerId === "string" && providerId.startsWith("account:");
}

export interface OfficialAccountDataMigrationResult {
  clearedDefaultModelSelection: boolean;
  removedSubagentOverrides: number;
  removedCredentialKeys: string[];
}

export interface OfficialAccountDataMigrationOptions {
  /** provider_config.json 的 Personal 覆盖层所有者；缺省时跳过该项迁移。 */
  personalRepository?: PersonalProviderConfigRepository;
  /** agents-state.json 物理路径；缺省时跳过子代理覆盖迁移。 */
  resolveAgentsStateFilePath?: () => Promise<string>;
  /** credentials.json 物理路径；缺省时跳过凭据键清理。 */
  credentialsFilePath?: string;
}

/** Host 启动时执行；任何单项失败都只降级为该位置跳过，不允许让启动失败。 */
export async function runOfficialAccountProviderDataMigration(
  options: OfficialAccountDataMigrationOptions = {},
): Promise<OfficialAccountDataMigrationResult> {
  const result: OfficialAccountDataMigrationResult = {
    clearedDefaultModelSelection: false,
    removedSubagentOverrides: 0,
    removedCredentialKeys: [],
  };

  if (options.personalRepository) {
    try {
      result.clearedDefaultModelSelection = await clearAccountDefaultModelSelection(
        options.personalRepository,
      );
    } catch (error) {
      logger.warn(undefined, "清理 provider_config.json 的账号模型选择失败，已跳过该项", {
        error,
      });
    }
  }

  if (options.resolveAgentsStateFilePath) {
    try {
      result.removedSubagentOverrides = await removeAccountSubagentOverrides(
        await options.resolveAgentsStateFilePath(),
      );
    } catch (error) {
      logger.warn(undefined, "清理 agents-state.json 的账号模型覆盖失败，已跳过该项", {
        error,
      });
    }
  }

  if (options.credentialsFilePath) {
    try {
      result.removedCredentialKeys = await removeOfficialAccountCredentialKeys(
        options.credentialsFilePath,
      );
    } catch (error) {
      logger.warn(undefined, "清理 credentials.json 的官方账号键失败，已跳过该项", { error });
    }
  }

  if (
    result.clearedDefaultModelSelection ||
    result.removedSubagentOverrides > 0 ||
    result.removedCredentialKeys.length > 0
  ) {
    logger.info("官方账号存量数据迁移完成", {
      clearedDefaultModelSelection: result.clearedDefaultModelSelection,
      removedSubagentOverrides: result.removedSubagentOverrides,
      removedCredentialKeyCount: result.removedCredentialKeys.length,
    });
  }
  return result;
}

/** defaultModelSelection 指向 account:* 时清空；进入「未配置模型」引导，不回落到其他 provider。 */
async function clearAccountDefaultModelSelection(
  repository: PersonalProviderConfigRepository,
): Promise<boolean> {
  const current = await repository.read();
  if (!isOfficialAccountProviderId(current.defaultModelSelection?.providerId)) {
    return false;
  }
  await repository.update((latest) => ({
    providers: latest.providers,
    ...(latest.providerTemplates ? { providerTemplates: latest.providerTemplates } : {}),
    models: latest.models,
    ...(latest.providerOrder ? { providerOrder: latest.providerOrder } : {}),
    // 明确置为 undefined：进入「未配置模型」引导，不回落到任何其他付费 provider。
    defaultModelSelection: undefined,
  }));
  return true;
}

/**
 * agents-state.json 中指向 account:* 的子代理模型覆盖按条目删除。
 * 文件缺失视为未配置（零写入）；其余字段原样保留。
 */
export async function removeAccountSubagentOverrides(stateFilePath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 损坏文件交给 subagentsService 既有恢复语义，迁移不做兜底改写。
    logger.warn(undefined, "agents-state.json 不是合法 JSON，跳过账号覆盖清理", {
      stateFilePath,
    });
    return 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return 0;
  }
  const state = parsed as Record<string, unknown>;
  let removed = 0;
  for (const field of [
    "builtInModelSelectionOverrides",
    "pluginAgentModelSelectionOverrides",
  ] as const) {
    const overrides = state[field];
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
      continue;
    }
    for (const [agentName, selection] of Object.entries(overrides)) {
      const providerId =
        typeof selection === "object" && selection !== null && !Array.isArray(selection)
          ? (selection as Record<string, unknown>).providerId
          : undefined;
      if (isOfficialAccountProviderId(providerId as string | undefined)) {
        delete (overrides as Record<string, unknown>)[agentName];
        removed += 1;
      }
    }
  }
  if (removed === 0) return 0;

  // 与 subagentsService 的既有写入路径同一把锁与原子写，避免迁移覆盖并发更新。
  await atomicWriteText(stateFilePath, `${JSON.stringify({ ...state }, null, 2)}\n`);
  return removed;
}

const OFFICIAL_ACCOUNT_CREDENTIAL_KEY_PREFIXES = ["oauth:", "account-provider:"] as const;
const OFFICIAL_ACCOUNT_CREDENTIAL_EXACT_KEYS = ["zcodejwttoken"] as const;

/** credentials.json 中官方账号键整键删除；文件缺失/空变更零写入。 */
export async function removeOfficialAccountCredentialKeys(
  credentialsFilePath: string,
): Promise<string[]> {
  return withFileLock(credentialsFilePath, async () => {
    let raw: string;
    try {
      raw = await readFile(credentialsFilePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 损坏凭据文件由 credentialService 的 refuse-to-overwrite 语义负责；迁移不能抢先覆盖。
      logger.warn(undefined, "credentials.json 不是合法 JSON，跳过官方账号键清理", {
        credentialsFilePath,
      });
      return [];
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const removedKeys = entries
      .map(([key]) => key)
      .filter(
        (key) =>
          (OFFICIAL_ACCOUNT_CREDENTIAL_EXACT_KEYS as readonly string[]).includes(key) ||
          OFFICIAL_ACCOUNT_CREDENTIAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
      );
    if (removedKeys.length === 0) return [];

    const rest = Object.fromEntries(entries.filter(([key]) => !removedKeys.includes(key)));
    await atomicWritePrivateTextFile(
      credentialsFilePath,
      `${JSON.stringify(rest, null, 2)}\n`,
    );
    return removedKeys;
  });
}
