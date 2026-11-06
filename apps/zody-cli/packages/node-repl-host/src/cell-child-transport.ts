import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { NodeReplRunResult } from "@zody/core/repl";
import {
  CELL_DIAGNOSTIC_MAX_BYTES,
  CellProtocolError,
  parseCellResponse,
  type CellRequest,
} from "./cell-protocol.js";

export interface CellChildInput {
  abortGraceMs: number;
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  line: string;
  request: CellRequest;
  responseMaxBytes: number;
  signal: AbortSignal;
  /** 可信 composition 已校验的 server 源码；只经私有 stdin 传送，不进 argv/env。 */
  stdinSource?: string;
}

export interface CellSourceWriter {
  readonly stream: Writable;
  readonly source: string;
  /** 已取消、已退出或已有传输错误时不再继续写。 */
  isUnavailable(): boolean;
  onError(error: unknown): void;
}

/**
 * 把已核验源码快照写入 cell 的私有 stdin，并收口 backpressure/error/close。
 *
 * 独立导出是为了用可控 Writable 确定性覆盖 backpressure、error、abort 和提前 close；
 * 生产路径只由 runCellChild 调用。写入结束时不删除 error 监听，等 close 再清理，
 * 避免 EPIPE 在 end 后变成未处理异常。
 */
export function writeCellSource(input: CellSourceWriter): void {
  const stdin = input.stream;
  let ended = false;
  let failed = false;

  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    input.onError(error);
  };
  const cleanup = () => {
    stdin.off("error", onError);
    stdin.off("drain", onDrain);
    stdin.off("close", onClose);
  };
  const end = () => {
    if (ended || failed) return;
    ended = true;
    try {
      stdin.end();
    } catch (error) {
      fail(error);
    }
  };
  const onError = (error: unknown) => {
    fail(error);
  };
  const onClose = () => {
    cleanup();
    if (!ended) {
      fail(new Error("node_repl cell stdin closed before the source snapshot was sent"));
    }
  };
  const onDrain = () => {
    stdin.off("drain", onDrain);
    if (failed || ended) return;
    if (input.isUnavailable()) {
      fail(new Error("node_repl cell source snapshot write was cancelled"));
      stdin.destroy();
      return;
    }
    end();
  };

  if (input.isUnavailable()) {
    fail(new Error("node_repl cell source snapshot write was cancelled"));
    stdin.destroy();
    return;
  }

  stdin.on("error", onError);
  stdin.once("close", onClose);
  try {
    if (!stdin.write(input.source, "utf8")) {
      stdin.once("drain", onDrain);
    } else {
      end();
    }
  } catch (error) {
    fail(error);
    stdin.destroy();
  }
}

/**
 * 跑一次 cell 子进程。
 *
 * 同步边界：
 * - 成功/失败都以直接子进程的 `exit` 为准，`close` 只覆盖 spawn 失败，不作为退出证据。
 * - 完整 frame 到达且直接子进程干净退出才成功；先解析协议错误，再拒绝非零退出的成功响应。
 * - abort/协议错误在直接子进程退出后立刻收掉父端 pipe 并拒绝，不等待后代释放继承的 fd。
 * - 正常退出但没有完整 frame 时，等 fd4 `end` 判截断；外部 signal deadline 是最后兜底。
 */
export function runCellChild(input: CellChildInput): Promise<NodeReplRunResult> {
  return new Promise<NodeReplRunResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      // 普通路径 cell 保持 stdin=ignore；只有携带已核验快照时才启用私有 stdin 管道。
      stdio: [input.stdinSource === undefined ? "ignore" : "pipe", "pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let directExited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let abortReason: unknown;
    let transportError: Error | undefined;
    let responseBuffer = "";
    let responseBytes = 0;
    let responseFrame: string | undefined;
    let responseComplete = false;
    let resultEnded = false;
    let responseTooLarge = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stderr = collectBounded(child.stderr, CELL_DIAGNOSTIC_MAX_BYTES);
    collectBounded(child.stdout, CELL_DIAGNOSTIC_MAX_BYTES);

    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      killTimer = undefined;
    };
    const settle = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else if (result) resolve(result);
      else reject(new Error("node_repl cell returned no result"));
    };
    const closeOwnedPipes = () => {
      // 直接 child 已退出；后代可能继承 fd4/stdout 并无限持有，父端必须主动收口。
      child.stdin?.destroy();
      (child.stdio[3] as Writable | null | undefined)?.destroy();
      (child.stdio[4] as Readable | null | undefined)?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const killChild = () => {
      if (directExited || child.pid === undefined) return;
      // 只保证直接 cell 子进程；进程组/后代清理尚未证明，不能在这里笼统宣称。
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!directExited) child.kill("SIGKILL");
        }, input.abortGraceMs);
        killTimer.unref();
      }
    };
    const recordTransportError = (error: unknown) => {
      transportError ??= error instanceof Error ? error : new Error(String(error));
      if (directExited) finalize();
      else killChild();
    };
    const onAbort = () => {
      abortReason = input.signal.reason ?? new DOMException("aborted", "AbortError");
      if (directExited) finalize();
      else killChild();
    };
    const finalize = () => {
      if (!directExited || settled) return;
      if (abortReason !== undefined) {
        closeOwnedPipes();
        settle(abortReason);
        return;
      }
      if (transportError) {
        closeOwnedPipes();
        settle(transportError);
        return;
      }
      if (responseTooLarge) {
        closeOwnedPipes();
        settle(
          new CellProtocolError(`node_repl cell response exceeded ${input.responseMaxBytes} bytes`),
        );
        return;
      }
      if (responseComplete && responseFrame !== undefined) {
        closeOwnedPipes();
        let response: ReturnType<typeof parseCellResponse>;
        try {
          response = parseCellResponse(responseFrame, input.responseMaxBytes);
          if (response.invocationId !== input.request.invocationId) {
            throw new CellProtocolError("node_repl cell response invocationId mismatch");
          }
        } catch (error) {
          settle(error);
          return;
        }
        if (!response.ok) {
          // 协议错误优先于退出码：子进程写完结构化错误后通常以 1 退出。
          const error = new Error(response.error.message);
          error.name = response.error.name;
          if (response.error.stack) error.stack = response.error.stack;
          settle(error);
          return;
        }
        if (exitCode !== 0 || exitSignal !== null) {
          settle(
            new Error(
              `node_repl cell exited with code=${exitCode ?? "null"}, signal=${exitSignal ?? "null"}`,
            ),
          );
          return;
        }
        settle(undefined, response.result);
        return;
      }
      if (!resultEnded) return;
      closeOwnedPipes();
      const suffix = stderr.text() ? `; stderr: ${stderr.text()}` : "";
      settle(
        new Error(
          `node_repl cell exited before returning a result (code=${exitCode ?? "null"}, signal=${exitSignal ?? "null"})${suffix}`,
        ),
      );
    };
    const onDirectExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (directExited) return;
      directExited = true;
      exitCode = code;
      exitSignal = signal;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      finalize();
    };
    child.once("exit", onDirectExit);
    child.once("error", (error) => {
      if (child.pid === undefined) {
        transportError = error;
        closeOwnedPipes();
        settle(error);
      } else {
        recordTransportError(error);
      }
    });
    child.once("close", () => {
      // close 可能被后代持有的 stdio 拖住；只在 spawn 失败时作为终止信号。
      if (!directExited && child.pid === undefined) {
        settle(transportError ?? new Error("node_repl cell failed to spawn"));
      }
    });

    if (input.stdinSource !== undefined) {
      if (!child.stdin) {
        recordTransportError(new Error("node_repl cell source snapshot pipe is unavailable"));
      } else {
        writeCellSource({
          stream: child.stdin,
          source: input.stdinSource,
          isUnavailable: () =>
            settled ||
            directExited ||
            abortReason !== undefined ||
            transportError !== undefined,
          onError: recordTransportError,
        });
      }
    }

    const requestStream = child.stdio[3] as Writable | null | undefined;
    if (!requestStream) {
      recordTransportError(new Error("node_repl cell request pipe is unavailable"));
    } else {
      requestStream.once("error", recordTransportError);
      try {
        requestStream.end(input.line);
      } catch (error) {
        recordTransportError(error);
      }
    }

    const responseStream = child.stdio[4] as Readable | null | undefined;
    if (!responseStream) {
      recordTransportError(new Error("node_repl cell response pipe is unavailable"));
    } else {
      responseStream.setEncoding("utf8");
      responseStream.on("data", (chunk: string) => {
        if (responseTooLarge || responseComplete) return;
        responseBytes += Buffer.byteLength(chunk);
        responseBuffer += chunk;
        const newline = responseBuffer.indexOf("\n");
        if (newline >= 0) {
          responseFrame = responseBuffer.slice(0, newline);
          responseComplete = true;
          responseBuffer = "";
          // 完整 frame 已到：立即收掉父端读口，后代继承 fd4 也能让调用结算。
          responseStream.destroy();
          if (directExited) finalize();
          return;
        }
        if (responseBytes > input.responseMaxBytes) {
          responseTooLarge = true;
          responseBuffer = "";
          if (directExited) finalize();
          else killChild();
        }
      });
      responseStream.once("end", () => {
        resultEnded = true;
        if (directExited) finalize();
      });
      responseStream.once("error", recordTransportError);
    }

    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
  });
}

function collectBounded(stream: Readable | null, limit: number): { text(): string } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (!stream) return { text: () => "" };
  stream.on("error", () => undefined);
  stream.on("data", (chunk: Buffer | string) => {
    if (bytes >= limit) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const remaining = limit - bytes;
    const slice = buffer.subarray(0, remaining);
    chunks.push(slice);
    bytes += slice.length;
  });
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}
