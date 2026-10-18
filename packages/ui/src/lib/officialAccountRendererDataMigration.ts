import { logger } from "@/logger.js";

/**
 * fork（F4.1a）：官方账号 provider 下线后，渲染端 localStorage 里仍指向
 * `account:*` 的模型选择要在启动时剔除（一次性、幂等；无命中零写入）。
 *
 * 覆盖键空间（与写入方保持同一 workspaceIdentity 键规则，迁移按前缀全局清理，
 * 不需要逐 workspace 枚举）：
 * - `zcode-v4-composer-drafts:v1:<encodeURIComponent(workspaceKey)>`：仅剔除
 *   各 scope 的 modelSelection 字段，草稿正文与其余状态保留；
 * - `zcode-model-selection-recent-v1:<workspaceKey>`：剔除 modelSelection；
 *   与 mode 一起全空时整个键删除。
 *
 * 读取路径的兜底自愈不在这里做：composer 读取对 Registry 中不存在的 provider
 * 本来就会回落空选择，不会静默改选其他付费 provider。
 */

const V4_DRAFT_STORAGE_KEY_PREFIX = "zcode-v4-composer-drafts:v1:";
const COMPOSER_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";

export interface OfficialAccountRendererMigrationResult {
  cleanedDraftKeys: number;
  cleanedRecentKeys: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOfficialAccountSelection(selection: unknown): boolean {
  return (
    isRecord(selection) &&
    typeof selection.providerId === "string" &&
    selection.providerId.startsWith("account:")
  );
}

export function stripOfficialAccountSelectionsFromStorage(
  storage: Storage | null = typeof window === "undefined" ? null : window.localStorage,
): OfficialAccountRendererMigrationResult {
  const result = { cleanedDraftKeys: 0, cleanedRecentKeys: 0 };
  if (!storage) return result;

  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }

  for (const key of keys) {
    try {
      if (key.startsWith(V4_DRAFT_STORAGE_KEY_PREFIX)) {
        if (cleanComposerDraftKey(storage, key)) result.cleanedDraftKeys += 1;
      } else if (key.startsWith(COMPOSER_RECENT_KEY_PREFIX)) {
        if (cleanComposerRecentKey(storage, key)) result.cleanedRecentKeys += 1;
      }
    } catch (error) {
      // 单键损坏只跳过该键；localStorage 数据不是启动关键路径，不能影响首启。
      logger.warn("[official-account-migration] 渲染端存量键清理失败，已跳过", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.cleanedDraftKeys > 0 || result.cleanedRecentKeys > 0) {
    logger.info("[official-account-migration] 渲染端官方账号模型选择清理完成", { ...result });
  }
  return result;
}

function cleanComposerDraftKey(storage: Storage, key: string): boolean {
  const raw = storage.getItem(key);
  if (!raw) return false;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) return false;

  let changed = false;
  const scopes = parsed.scopes as Record<string, unknown>;
  for (const draft of Object.values(scopes)) {
    if (isRecord(draft) && isOfficialAccountSelection(draft.modelSelection)) {
      delete draft.modelSelection;
      changed = true;
    }
  }
  if (!changed) return false;

  if (Object.keys(scopes).length === 0) {
    storage.removeItem(key);
  } else {
    storage.setItem(key, JSON.stringify(parsed));
  }
  return true;
}

function cleanComposerRecentKey(storage: Storage, key: string): boolean {
  const raw = storage.getItem(key);
  if (!raw) return false;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return false;
  if (!isOfficialAccountSelection(parsed.modelSelection)) return false;

  delete parsed.modelSelection;
  // 与 readComposerRecent 的叶子校验一致：mode 是 submissionMode 字符串；
  // 模型清掉后没有合法 mode 就删整个键。
  if (typeof parsed.mode !== "string" || parsed.mode.trim() === "") {
    storage.removeItem(key);
  } else {
    storage.setItem(key, JSON.stringify(parsed));
  }
  return true;
}
