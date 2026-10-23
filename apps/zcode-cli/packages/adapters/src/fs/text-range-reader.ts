import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  createFileSystemError,
  type FileSystemTextEncoding,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
} from "@zcode/contracts";
import {
  createStreamingTextDecoder,
  decodeTextBuffer,
  detectLineEndings,
  detectTextEncoding,
  getUtf8SampleTailCompletionLength,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";

const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024;
const ENCODING_SAMPLE_BYTES = 4096;

export async function readTextFileRangeFromNode(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  throwIfAborted(signal);
  assertWithinMaxBytes(request.path, info.size, request.maxBytes);

  if (info.size <= FAST_PATH_MAX_BYTES) {
    return readRangeFast(request, info, signal);
  }

  return readRangeStreaming(request, info, signal);
}

function assertWithinMaxBytes(path: string, sizeBytes: number, maxBytes: number | undefined): void {
  if (maxBytes === undefined || sizeBytes <= maxBytes) return;
  throw createFileSystemError({
    code: "too_large",
    path,
    message: `File content (${formatFileSize(sizeBytes)}) exceeds maximum allowed size (${formatFileSize(maxBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
  });
}

async function readRangeFast(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  throwIfAborted(signal);
  const buffer = await readFile(request.path);
  throwIfAborted(signal);
  const decoded = decodeTextBuffer({
    buffer,
    encoding: request.encoding,
    path: request.path,
  });
  const encoding = decoded.encoding;
  const rawContent = decoded.content;
  const isText = shouldNormalizeLineEndings(encoding);
  const normalized = isText ? normalizeLineEndings(rawContent) : rawContent;
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const offsetLine = normalizeOffsetLine(request.offsetLine);
  const selectedLines = selectLines(lines, offsetLine, request.limitLines);

  return {
    path: request.path,
    content: selectedLines.join("\n"),
    encoding,
    lineEndings: isText ? detectLineEndings(rawContent) : undefined,
    bytesRead: buffer.byteLength,
    sizeBytes: info.size,
    truncated: false,
    startLine: offsetLine + 1,
    lineCount: selectedLines.length,
    totalLines: lines.length,
    revision: {
      id: revisionId(info.mtimeMs, info.size),
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    },
  };
}

async function readRangeStreaming(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  const encoding = request.encoding ?? (await detectEncodingFromHead(request.path, signal));
  const decoder = createStreamingTextDecoder(encoding);
  const selectedLines: string[] = [];
  const offsetLine = normalizeOffsetLine(request.offsetLine);
  const limitLines = normalizeLimitLines(request.limitLines);
  let carry = "";
  let lineIndex = 0;
  let bytesRead = 0;
  let crlfCount = 0;
  let lfCount = 0;
  let sawAnyBytes = false;

  const stream = createReadStream(request.path);
  const abort = (): void => {
    stream.destroy(createAbortError(request.path));
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sawAnyBytes = sawAnyBytes || buffer.byteLength > 0;
      bytesRead += buffer.byteLength;
      const text = decoder.write(buffer);
      const parts = `${carry}${text}`.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        const normalized = normalizeCompletedLine(part);
        if (part.endsWith("\r")) crlfCount += 1;
        else lfCount += 1;
        if (shouldSelectLine(lineIndex, offsetLine, limitLines, selectedLines.length)) {
          selectedLines.push(normalized);
        }
        lineIndex += 1;
      }
    }

    const finalText = decoder.end();
    if (finalText.length > 0) {
      carry += finalText;
    }
    if (sawAnyBytes) {
      const normalized = normalizeCompletedLine(carry);
      if (shouldSelectLine(lineIndex, offsetLine, limitLines, selectedLines.length)) {
        selectedLines.push(normalized);
      }
      lineIndex += 1;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  return {
    path: request.path,
    content: selectedLines.join("\n"),
    encoding,
    lineEndings: crlfCount > lfCount ? "CRLF" : "LF",
    bytesRead,
    sizeBytes: info.size,
    truncated: false,
    startLine: offsetLine + 1,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    revision: {
      id: revisionId(info.mtimeMs, info.size),
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    },
  };
}

async function detectEncodingFromHead(
  path: string,
  signal?: AbortSignal,
): Promise<FileSystemTextEncoding> {
  throwIfAborted(signal);
  const handle = await open(path, "r");
  try {
    const head = await readEncodingSample(handle, ENCODING_SAMPLE_BYTES, signal);
    throwIfAborted(signal);
    const utf8Tail = await readUtf8TailCompletion(handle, head, signal);
    throwIfAborted(signal);
    return detectTextEncoding(head, undefined, utf8Tail);
  } finally {
    await handle.close();
  }
}

// FileHandle.read 允许短读：返回值小于请求长度不代表 EOF，只有 0 字节才是。
// 单次读取可能只返回少量字节，必须循环补齐样本，否则短读样本会被误判为二进制或 GBK。
async function readEncodingSample(
  handle: FileHandle,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const sample = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(sample, filled, length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return sample.subarray(0, filled);
}

// 4096 字节边界可能切断 UTF-8 多字节字符的尾部；此时按需读取边界之后的真实字节，
// 只在补齐后能构成合法 UTF-8 时才用于判定（见 detectTextEncoding 的 utf8Tail 参数）。
// 补齐字节只用于判定，不进入正文、bytesRead 或行计数。
async function readUtf8TailCompletion(
  handle: FileHandle,
  head: Buffer,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const missingBytes = getUtf8SampleTailCompletionLength(head);
  if (missingBytes === 0) return undefined;

  const tail = Buffer.alloc(missingBytes);
  let filled = 0;
  while (filled < missingBytes) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(
      tail,
      filled,
      missingBytes - filled,
      head.byteLength + filled,
    );
    // 补齐前到达 EOF：按已读到的实际字节判定，不用零填充凑样本。
    if (bytesRead === 0) return undefined;
    filled += bytesRead;
  }
  return tail;
}

function normalizeOffsetLine(offsetLine: number | undefined): number {
  return Math.max(0, Math.trunc(offsetLine ?? 0));
}

function normalizeLimitLines(limitLines: number | undefined): number | undefined {
  if (limitLines === undefined) return undefined;
  return Math.max(0, Math.trunc(limitLines));
}

function selectLines(lines: string[], offsetLine: number, limitLines: number | undefined): string[] {
  const limit = normalizeLimitLines(limitLines);
  return limit === undefined ? lines.slice(offsetLine) : lines.slice(offsetLine, offsetLine + limit);
}

function shouldSelectLine(
  lineIndex: number,
  offsetLine: number,
  limitLines: number | undefined,
  selectedCount: number,
): boolean {
  if (lineIndex < offsetLine) return false;
  return limitLines === undefined || selectedCount < limitLines;
}

function normalizeCompletedLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatUnit(bytes / 1024)}KB`;
  return `${formatUnit(bytes / (1024 * 1024))}MB`;
}

function formatUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError("file range read");
}

function createAbortError(path: string): Error {
  const error = new Error(`File system operation was cancelled: ${path}`);
  error.name = "AbortError";
  return error;
}
