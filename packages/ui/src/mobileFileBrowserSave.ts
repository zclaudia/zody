import type { IFileService } from "@zcode/services";
import type { FileStat, IPlatformService, SaveFileResult } from "@zcode/shared";

export const MOBILE_FILE_SAVE_MAX_BYTES = 16 * 1024 * 1024;
export const MOBILE_FILE_SAVE_RANGE_BYTES = 1024 * 1024;

/**
 * MF08: 保存取消使用的错误形态。遵循 Web 约定（DOMException AbortError）以 name 识别，
 * 不依赖 DOMException 全局存在，纯 Node 测试环境也可构造。
 */
export function createMobileSaveAbortError(): Error {
  const error = new Error("Mobile file save was canceled.");
  error.name = "AbortError";
  return error;
}

export function isMobileSaveAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfSaveAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createMobileSaveAbortError();
  }
}

export async function readMobileFileForSave(
  fileService: Pick<IFileService, "stat" | "readFileRange">,
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfSaveAborted(signal);
  const before = await fileService.stat({ path });
  if (before.type !== "file" || before.size === undefined) {
    throw new Error("File size is unavailable.");
  }
  if (before.mtimeMs === undefined) {
    throw new Error("File modification time is unavailable.");
  }
  if (before.size > MOBILE_FILE_SAVE_MAX_BYTES) {
    throw new Error("File exceeds the 16 MiB mobile save limit.");
  }

  const bytes = new Uint8Array(before.size);
  let offset = 0;
  while (offset < before.size) {
    // MF08: 取消后在 chunk 之间停止读取，不再占用远端 range 通道，也不会把半份数据交给保存。
    throwIfSaveAborted(signal);
    const length = Math.min(MOBILE_FILE_SAVE_RANGE_BYTES, before.size - offset);
    const chunk = await fileService.readFileRange({ path, offset, length });
    if (chunk.byteLength !== length) {
      throw new Error("File changed while it was being read.");
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const after: FileStat = await fileService.stat({ path });
  if (
    after.type !== "file" ||
    after.size !== before.size ||
    after.mtimeMs === undefined ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error("File changed while it was being read.");
  }
  return bytes;
}

export async function saveMobileOriginalFile({
  fileService,
  platform,
  path,
  suggestedName,
  signal,
}: {
  fileService: Pick<IFileService, "stat" | "readFileRange">;
  platform: Pick<IPlatformService, "saveFile">;
  path: string;
  suggestedName: string;
  signal?: AbortSignal;
}): Promise<SaveFileResult> {
  if (!platform.saveFile) {
    throw new Error("Native file saving is unavailable.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readMobileFileForSave(fileService, path, signal);
  } catch (error) {
    // 取消不是失败：返回 canceled 让 UI 静默回到可保存状态，不弹错误 toast。
    if (isMobileSaveAbortError(error)) {
      return { success: false, canceled: true };
    }
    throw error;
  }
  // 读取全部完成后可能已被取消；此时不发起原生保存，保证 Downloads 不留半成品。
  if (signal?.aborted) {
    return { success: false, canceled: true };
  }
  const exactBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(exactBuffer).set(bytes);
  return platform.saveFile({ data: exactBuffer, suggestedName });
}
