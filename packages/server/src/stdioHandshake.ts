import { helloAckMessageSchema, formatZodError } from "@zody/shared";
import type { HelloAckMessage } from "@zody/shared";
import type { Readable } from "node:stream";

/** Read one ack and hand all bytes after its LF back to the paused RPC stream. */
export function waitForStdioAck(
  input: Readable,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<HelloAckMessage> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, ack?: HelloAckMessage, remaining?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
        return;
      }
      if (remaining?.length) input.unshift(remaining);
      resolve(ack!);
    };
    const onEnd = () => finish(new Error("Stream closed before hello-ack"));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(new Error("Handshake canceled"));
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const index = buffer.indexOf(10);
      if (index < 0) return;
      try {
        const result = helloAckMessageSchema.safeParse(
          JSON.parse(buffer.subarray(0, index).toString("utf8")),
        );
        if (!result.success) {
          finish(new Error(`Invalid hello-ack: ${formatZodError(result.error)}`));
          return;
        }
        finish(undefined, result.data, buffer.subarray(index + 1));
      } catch (error) {
        finish(new Error(`Invalid hello-ack: ${String(error)}`));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Handshake timeout: no hello-ack received within timeout")),
      timeoutMs,
    );
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
