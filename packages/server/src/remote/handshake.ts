import type { HelloMessage, HelloAckMessage } from "@zody/shared";
import {
  ZODY_VERSION,
  ZODY_RENAME_GENERATION,
  formatZodError,
  helloMessageSchema,
  helloAckMessageSchema,
} from "@zody/shared";
import type { StdioStream } from "./backend.js";

const MAX_HANDSHAKE_DIAGNOSTIC_CHARS = 2048;

export interface HandshakeResult {
  hello: HelloMessage;
  /** Remaining data after the handshake line (to be fed into RPC) */
  remaining: Buffer | null;
}

/**
 * Perform the client-side handshake:
 * 1. Read lines from stdout until we find a zody-hello JSON
 *    (skip SSH banner/motd lines)
 * 2. Send a zody-hello-ack to stdin
 * 3. Return the hello info and any remaining data
 */
export function performHandshake(
  stream: StdioStream,
  clientId: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    let stdoutText = "";
    let stderrText = "";
    let settled = false;
    let closeDisposable: { dispose(): void } | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      stream.stdout.removeListener("data", onData);
      stream.stdout.removeListener("end", onEnd);
      stream.stdout.removeListener("error", onError);
      stream.stderr.removeListener("data", onStderrData);
      stream.stdin.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      closeDisposable?.dispose();
    };
    const fail = (message: string, exitCode?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          formatHandshakeFailure(message, { exitCode, stdout: stdoutText, stderr: stderrText }),
        ),
      );
    };
    const onEnd = () => fail("Stream closed before handshake completed");
    const onError = (error: Error) => fail(`Handshake stream error: ${error.message}`);
    const onAbort = () => fail("Handshake canceled");
    const onStderrData = (chunk: Buffer) => {
      stderrText = appendLimited(stderrText, chunk.toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, bytes]);
      stdoutText = appendLimited(stdoutText, bytes.toString("utf8"));
      while (true) {
        const index = buffer.indexOf(10);
        if (index < 0) return;
        const line = buffer.subarray(0, index).toString("utf8").trim();
        buffer = buffer.subarray(index + 1);
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const result = helloMessageSchema.safeParse(raw);
        if (!result.success) {
          fail(`Invalid hello: ${formatZodError(result.error)}`);
          return;
        }
        // 先暂停，确保在消费者重新装配 RPC 前不会丢失随后的字节。
        (stream.stdout as NodeJS.ReadableStream & { pause(): void }).pause();
        const ack: HelloAckMessage = {
          type: "zody-hello-ack",
          version: ZODY_VERSION,
          clientId,
          generation: ZODY_RENAME_GENERATION,
        };
        const checkedAck = helloAckMessageSchema.safeParse(ack);
        if (!checkedAck.success) {
          fail(`Invalid hello-ack: ${formatZodError(checkedAck.error)}`);
          return;
        }
        try {
          stream.stdin.write(JSON.stringify(ack) + "\n", (error?: Error | null) => {
            // Writable error 事件负责统一拒绝；回调先触发时不能提前移除 error 监听。
            if (error || settled) return;
            settled = true;
            cleanup();
            resolve({ hello: result.data, remaining: buffer.length ? Buffer.from(buffer) : null });
          });
        } catch (error) {
          fail(`Handshake ack write failed: ${String(error)}`);
        }
        return;
      }
    };
    const timeout = setTimeout(
      () => fail("Handshake timeout: no zody-hello received within timeout"),
      timeoutMs,
    );
    stream.stdout.on("data", onData);
    stream.stdout.once("end", onEnd);
    stream.stdout.once("error", onError);
    stream.stderr.on("data", onStderrData);
    stream.stdin.once("error", onError);
    closeDisposable = stream.onClose((code) =>
      fail("Stream closed before handshake completed", code),
    );
    if (settled) {
      closeDisposable.dispose();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_HANDSHAKE_DIAGNOSTIC_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_HANDSHAKE_DIAGNOSTIC_CHARS);
}

function formatHandshakeFailure(
  message: string,
  diagnostics: {
    exitCode?: number;
    stdout: string;
    stderr: string;
  },
): string {
  const parts = [message];
  if (diagnostics.exitCode !== undefined) {
    parts.push(`exit code ${diagnostics.exitCode}`);
  }
  const stderr = diagnostics.stderr.trim();
  if (stderr.length > 0) {
    parts.push(`stderr: ${JSON.stringify(stderr)}`);
  }
  const stdout = diagnostics.stdout.trim();
  if (stdout.length > 0) {
    // 远端 server 在 hello 前退出时，真正原因只存在 stdout/stderr。
    // 如果错误只保留“握手关闭”，SSH 启动失败会在 host/main 日志中被压成无上下文的 {}。
    parts.push(`stdout: ${JSON.stringify(stdout)}`);
  }
  return parts.length === 1 ? message : `${message} (${parts.slice(1).join("; ")})`;
}
