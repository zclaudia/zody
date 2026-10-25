import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  WebRemoteControlMobileDirectoryEntry,
  WebRemoteControlMobileDirectoryListResult,
} from "@zcode/shared";

/**
 * 手机「打开其他项目」目录选择器的 Main 侧 bounded 列表（第二批 E3）。
 *
 * 走 app 级 payload 而不是 host 的 IFileService：空态（桌面没有任何打开的 workspace）
 * 没有 bridge 可用，而选择器恰恰是这个场景的主要入口。每次现读、无缓存、无状态；
 * 仅返回目录条目，符号链接沿用桌面树的跟随语义（跟随目标是目录才收录，并带标识）。
 */

/** 与 shared schema 的 entries 上限一致；超限返回 too-large，不截断后伪称完整列表。 */
export const MOBILE_DIRECTORY_LISTING_MAX_ENTRIES = 1000;

type ListingErrorCode = Extract<WebRemoteControlMobileDirectoryListResult, { ok: false }>["error"];

function mapListingError(error: unknown): WebRemoteControlMobileDirectoryListResult {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    // ENOTDIR 可能来自 opendir 本身（path 是文件）：统一归 not-directory，
    // 与 readdir 语义一致，手机端两种提示可以合并。
    return code === "ENOENT"
      ? { ok: false, error: "not-found" }
      : { ok: false, error: "not-directory" };
  }
  return { ok: false, error: "unreadable" };
}

async function isSymbolicLinkToDirectory(
  entryPath: string,
  isSymbolicLink: boolean,
): Promise<boolean> {
  if (!isSymbolicLink) {
    return false;
  }
  try {
    // 断链或不可跟随的链接：桌面树语义是跟随目标决定归属，跟随失败不收录。
    return (await stat(entryPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 列出 `path`（省略 = homedir）下的目录条目，按名称码点排序。
 */
export async function listMobileDirectoryEntries(
  path?: string,
): Promise<WebRemoteControlMobileDirectoryListResult> {
  const resolvedPath = path === undefined || path.trim() === "" ? homedir() : path.trim();
  const pathError: ListingErrorCode | undefined = !isAbsolute(resolvedPath)
    ? "path-invalid"
    : undefined;
  if (pathError) {
    return { ok: false, error: pathError };
  }

  let directory;
  try {
    directory = await opendir(resolvedPath);
  } catch (error) {
    return mapListingError(error);
  }

  const entries: WebRemoteControlMobileDirectoryEntry[] = [];
  try {
    for (;;) {
      const dirent = await directory.read();
      if (dirent === null) {
        break;
      }
      if (entries.length >= MOBILE_DIRECTORY_LISTING_MAX_ENTRIES) {
        return { ok: false, error: "too-large" };
      }
      const entryPath = join(resolvedPath, dirent.name);
      const isDirectory =
        dirent.isDirectory() ||
        (await isSymbolicLinkToDirectory(entryPath, dirent.isSymbolicLink()));
      if (!isDirectory) {
        continue;
      }
      entries.push({
        name: dirent.name,
        path: entryPath,
        ...(dirent.isSymbolicLink() ? { isSymbolicLink: true } : {}),
      });
    }
  } catch (error) {
    return mapListingError(error);
  } finally {
    await directory.close().catch(() => {});
  }

  // 码点排序：localeCompare 在同码位不同 locale 下顺序不一致（MS07 的教训），
  // 选择器只需稳定顺序，不承诺本地化字母序。
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parentPath = dirname(resolvedPath);
  return {
    ok: true,
    resolvedPath,
    // dirname("/") === "/"：根目录没有上级，手机端据此隐藏「返回上级」。
    parentPath: parentPath === resolvedPath ? null : parentPath,
    entries,
  };
}
