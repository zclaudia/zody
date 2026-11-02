import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ReadSealedResourceOptions {
  /** 固定同级资源名解析出的路径；只在打开时使用，校验后不再按路径执行。 */
  path: string;
  /** 封装构建钉住的原始字节 SHA-256（小写十六进制）。 */
  expectedSha256: string;
  /** 封装构建给出的资源字节上限。 */
  maxBytes: number;
  /** 所有权校验的期望 uid；默认取当前进程 uid。 */
  expectedUid?: number;
}

export interface SealedResourceSnapshot {
  /** 与已核验原始字节一一对应的 UTF-8 内容；字符串本身不可变。 */
  readonly source: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * 在同一个 O_NOFOLLOW 句柄上有界读取固定资源，校验元数据、上限、摘要和 UTF-8 无损性。
 *
 * 返回的 source 是同一份已核验字节的解码结果；调用方之后不得再按 path 打开执行。
 * 读取期间文件即使增长，也会在超过 maxBytes 时拒绝，而不是继续读入更多内容。
 */
export async function readSealedResourceSnapshot(
  options: ReadSealedResourceOptions,
): Promise<SealedResourceSnapshot> {
  // 在首个 await 前冻结本次校验输入；调用方之后即使改写 options 对象，也不能让
  // open/read 期间的预期摘要、上限、路径或 owner 漂移。这不是新的授权状态。
  const path = options.path;
  const expectedSha256 = options.expectedSha256;
  const maxBytes = options.maxBytes;
  const expectedUid = options.expectedUid ?? process.getuid?.();

  if (expectedUid === undefined) {
    throw new Error("cua_node_repl_server_owner_check_unavailable");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("cua_node_repl_server_size_limit_invalid");
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("cua_node_repl_server_sha_invalid");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK 只为避免路径在校验前被换成 FIFO 时 open 挂起；后续 fstat 仍要求
    // regular file，普通文件的 read 语义不受影响。
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error("cua_node_repl_server_open_failed", { cause: error });
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("cua_node_repl_server_not_regular");
    if (info.uid !== expectedUid) throw new Error("cua_node_repl_server_owner_mismatch");
    if ((info.mode & 0o022) !== 0) throw new Error("cua_node_repl_server_writable");
    if (info.size <= 0 || info.size > maxBytes) {
      throw new Error("cua_node_repl_server_size_out_of_bounds");
    }

    const bytes = await readBoundedBytes(
      async (buffer) => {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        return bytesRead;
      },
      maxBytes,
    );
    if (bytes.length === 0) {
      throw new Error("cua_node_repl_server_size_out_of_bounds");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256) {
      throw new Error("cua_node_repl_server_sha_mismatch");
    }
    const source = decodeUtf8Lossless(bytes);
    return Object.freeze({ source, sha256, size: bytes.length });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 有界读取：最多读 maxBytes + 1 字节，超过 maxBytes 立即失败。
 *
 * 独立导出是为了用可控 reader 确定性覆盖“读取期间增长”；生产路径只传入同一句柄的 read。
 */
export async function readBoundedBytes(
  readChunk: (buffer: Buffer) => Promise<number>,
  maxBytes: number,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("cua_node_repl_server_size_limit_invalid");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("cua_node_repl_server_chunk_invalid");
  }

  const limit = maxBytes + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, limit - total));
    const bytesRead = await readChunk(buffer);
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) {
      throw new Error("cua_node_repl_server_read_invalid");
    }
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) {
      throw new Error("cua_node_repl_server_size_out_of_bounds");
    }
  }
  return Buffer.concat(chunks, total);
}

/**
 * 无损 UTF-8 解码；保留 BOM，并回编码校验原始字节完全一致，避免 U+FFFD 替换后执行别的内容。
 */
export function decodeUtf8Lossless(bytes: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    throw new Error("cua_node_repl_server_utf8_invalid");
  }
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new Error("cua_node_repl_server_utf8_lossy");
  }
  return source;
}
