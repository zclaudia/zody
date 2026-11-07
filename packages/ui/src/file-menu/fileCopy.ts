import type { IPlatformService, SaveFileResult } from "@zody/shared";
import { getPathLeaf } from "@/lib/path.js";
import type { FileCopySource } from "@/file-menu/contract.js";

/**
 * 另存为分块读取（upstream v3.17.1 file-menu/fileCopy，来源 SHA a60ba6a7；
 * 产品规则见 docs/ui/file-open-apps.md「另存为」章节）。
 *
 * 上限 50 MiB：单次 IPC 全量读取大文件既可能被 Host 分段上限截断，也会在读取
 * 期间被并发写破坏，所以按 1 MiB 分块读完并前后核对 stat，再交给保存对话框。
 * 与 mobileFileBrowserSave 的 16 MiB 手机保存限额各自独立，不共享状态。
 */
export const MAX_FILE_COPY_BYTES = 50 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;

export async function readFileCopy(source: FileCopySource, path: string): Promise<ArrayBuffer> {
  const before = await source.stat({ path });
  if (before.type !== "file") throw new Error("not_a_file");
  if (!Number.isSafeInteger(before.size) || before.size! < 0) {
    throw new Error("file_size_unavailable");
  }
  const size = before.size!;
  if (size > MAX_FILE_COPY_BYTES) throw new Error("file_too_large");
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(COPY_CHUNK_BYTES, size - offset);
    const chunk = await source.readFileRange({ path, offset, length });
    if (chunk.byteLength === 0 || chunk.byteLength > length) throw new Error("file_changed");
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const after = await source.stat({ path });
  if (after.type !== "file" || after.size !== size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("file_changed");
  }
  return bytes.buffer;
}

export async function saveFileCopy(
  source: FileCopySource,
  path: string,
  save: NonNullable<IPlatformService["saveFile"]>,
) {
  // 先完整读取原字节再交给保存对话框，选择同一文件也不会先截断源文件。
  const data = await readFileCopy(source, path);
  const result = await save({ data, suggestedName: getPathLeaf(path) || "download" });
  if (!result.success && !result.canceled) throw new Error(result.error || "save_failed");
  return result;
}

/**
 * 成功与取消的提示规则（SHA a60ba6a7）：取消始终不提示；本仓当前所有 saveFile
 * 宿主（桌面保存对话框、手机远控原生保存）都以写盘收尾，成功统一提示已保存。
 * 上游按 canOpenLocalFiles 区分浏览器「已开始下载」文案，该能力位本仓未移植，
 * 故不引入 downloadStarted 分支（见 docs/ui/file-open-apps.md 另存为章节）。
 */
export function fileSaveSuccessMessageId(result: SaveFileResult) {
  if (!result.success || result.canceled) return null;
  return "fileActions.saved";
}
