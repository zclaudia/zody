import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** I16 决策：保留期 30 天，只按输出文件 mtime 判定。 */
export const OUTPUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TOOL_CALL_OUTPUT_FILES = new Set(["stdout.log", "stderr.log"]);
/** 升级前的扁平命名：{session}/{toolCallId}-stdout.log。 */
const LEGACY_OUTPUT_FILE_PATTERN = /-(?:stdout|stderr)\.log$/u;

/**
 * I16：adapter 构造时（以及选中第二层默认数据根时）扫描持久输出根，
 * 删除超过保留期的 adapter 输出文件，再删除「因此变空」的 toolCall / session 目录。
 *
 * 依据 docs/tmpdir-storage-paths-spec.md「清理 owner 与时点」：
 * - 只处理 adapter 命名的普通文件；符号链接、非普通文件和其它文件一律跳过，
 *   避免顺着链接删除根外内容（根外目标的 mtime 不被检查）。
 * - 只删除本次确实删除了文件的空目录，不碰原本就为空、可能正被并发创建使用的目录。
 * - 扫描/删除失败静默跳过，不阻塞构造/关闭，也不改变命令结果或查询错误分类；
 *   adapter 当前不单独记录清理错误计数。
 * - 不删除根目录本身。
 */
export async function cleanupStaleExecutionOutput(
  rootDir: string,
  now: number = Date.now(),
): Promise<void> {
  const cutoff = now - OUTPUT_RETENTION_MS;
  const sessions = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  // 会话之间互不依赖；并行扫描避免输出根较大时拖长 close() 等待。
  await Promise.all(
    sessions
      .filter((session) => session.isDirectory())
      .map((session) => cleanupSession(join(rootDir, session.name), cutoff)),
  );
}

async function cleanupSession(sessionDir: string, cutoff: number): Promise<void> {
  const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  let removedFromSession = false;
  for (const entry of entries) {
    const entryPath = join(sessionDir, entry.name);
    if (entry.isDirectory()) {
      removedFromSession =
        (await cleanupToolCallDirectory(entryPath, cutoff)) || removedFromSession;
      continue;
    }
    if (entry.isFile() && LEGACY_OUTPUT_FILE_PATTERN.test(entry.name)) {
      if (await isStaleOutputFile(entryPath, cutoff)) {
        removedFromSession = (await removeFile(entryPath)) || removedFromSession;
      }
    }
  }
  if (removedFromSession) {
    // 仍有近期输出或其它产物时 rmdir 失败，按约定保留。
    await rmdir(sessionDir).catch(() => undefined);
  }
}

async function cleanupToolCallDirectory(directory: string, cutoff: number): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let removed = false;
  for (const entry of entries) {
    if (!entry.isFile() || !TOOL_CALL_OUTPUT_FILES.has(entry.name)) continue;
    const filePath = join(directory, entry.name);
    if (await isStaleOutputFile(filePath, cutoff)) {
      removed = (await removeFile(filePath)) || removed;
    }
  }
  if (!removed) return false;
  // 目录仍有非输出产物时 rmdir 会失败，按约定保留。
  await rmdir(directory).catch(() => undefined);
  return true;
}

async function isStaleOutputFile(path: string, cutoff: number): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info !== undefined && info.isFile() && info.mtimeMs < cutoff;
}

async function removeFile(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
