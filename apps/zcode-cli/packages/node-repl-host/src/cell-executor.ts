import { close, createWriteStream, read } from "node:fs";
import { promisify } from "node:util";
import {
  CELL_REQUEST_MAX_BYTES,
  CELL_RUN_FLAG,
  CellProtocolError,
  cellErrorResponse,
  cellResultResponse,
  encodeCellResponse,
  parseCellRequest,
  type CellResponse,
} from "./cell-protocol.js";
import { createNodeReplSessionExecutor } from "./node-repl-session-executor.js";

export function isCellInvocation(argv: readonly string[]): boolean {
  return argv.includes(CELL_RUN_FLAG);
}

/**
 * cell 子进程入口：fd3 只读一次并等待 close 后才执行模型代码，结果只写 fd4 并等待 close
 * 后才退出。stdout/stderr 留给有界诊断，既不是 MCP stdout 也不是本协议的一部分。
 */
export async function runCellMain(): Promise<number> {
  let invocationId: string | undefined;
  try {
    const raw = await readCellRequest();
    const request = parseCellRequest(raw);
    invocationId = request.invocationId;
    const execute = createNodeReplSessionExecutor({
      browserDocumentationRoot: request.documentationRoots.browser,
      cuaDocumentationRoot: request.documentationRoots.cua,
    });
    const result = await execute({
      code: request.code,
      requestMeta: request.requestMeta,
      signal: new AbortController().signal,
      syncTimeoutMs: request.syncTimeoutMs,
      cuaBroker: request.cuaCapability,
      browserBroker: request.browserCapability,
    });
    return (await writeCellResponse(cellResultResponse(request.invocationId, result))) ? 0 : 1;
  } catch (error) {
    await writeCellResponse(cellErrorResponse(invocationId, error));
    return 1;
  }
}

const readFd = promisify(read);
const closeFd = promisify(close);

async function readCellRequest(): Promise<string> {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const { bytesRead } = await readFd(3, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > CELL_REQUEST_MAX_BYTES) {
        throw new CellProtocolError("node_repl cell request exceeded 1 MiB");
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(chunk);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        const prefix = Buffer.concat(chunks);
        return prefix.subarray(0, prefix.length - chunk.length + newline).toString("utf8");
      }
    }
    if (bytes === 0) {
      throw new CellProtocolError("node_repl cell request was truncated");
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\n$/u, "");
  } finally {
    // 必须在执行模型代码前真正关闭 fd3；这里 await 异步 close，而不是 fire-and-forget。
    await closeFd(3).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBADF") throw error;
    });
  }
}

async function writeCellResponse(response: CellResponse): Promise<boolean> {
  let line: string;
  try {
    line = encodeCellResponse(response);
  } catch (error) {
    if (!(error instanceof CellProtocolError)) return false;
    // 结果超过预算时只回一个小的协议错误，不能把无界结果继续写进 fd4。
    const fallback = cellErrorResponse(response.invocationId ?? undefined, error);
    try {
      line = encodeCellResponse(fallback);
    } catch {
      return false;
    }
  }

  const stream = createWriteStream("", { fd: 4, autoClose: true });
  let wrote = false;
  let failed = false;
  const closed = new Promise<boolean>((resolve) => {
    stream.once("finish", () => {
      wrote = true;
    });
    stream.once("error", () => {
      failed = true;
    });
    stream.once("close", () => resolve(wrote && !failed));
  });
  try {
    stream.end(line);
  } catch {
    failed = true;
    stream.destroy();
  }
  // 必须等 fd4 真正关闭后再让进程退出，否则父进程可能在读到完整 frame 前看到 EOF/exit。
  return await closed;
}
