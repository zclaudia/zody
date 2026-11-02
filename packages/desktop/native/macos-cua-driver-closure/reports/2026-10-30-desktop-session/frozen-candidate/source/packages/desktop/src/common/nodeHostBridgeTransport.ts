import { deserialize, serialize } from "node:v8";
import type { Duplex } from "node:stream";
import {
  estimateNodeHostBridgeFrameBytes,
  isNodeHostBridgeFrame,
  type NodeHostBridgeChannel,
  type NodeHostBridgeFrame,
} from "./nodeHostBridgeProtocol.js";

export const MAX_NODE_HOST_BRIDGE_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SEND_QUEUE_FRAMES = 1024;
const MAX_SEND_QUEUE_BYTES = 64 * 1024 * 1024;

export interface NodeHostBridgeProcessLike {
  channel?: unknown;
  send?: (...args: any[]) => boolean;
  disconnect?: () => void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
}

function assertSendQueueWithinBound(frames: number, bytes: number): void {
  if (frames > MAX_SEND_QUEUE_FRAMES || bytes > MAX_SEND_QUEUE_BYTES) {
    throw new Error("Node Host bridge send queue overflow");
  }
}

/**
 * Ordered, bounded frames over Node child process IPC (`process.send`).
 *
 * `process.send` returns false when the channel is backed up. We intentionally serialise
 * sends through the callback so the application-level queue is bounded instead of letting
 * libuv buffer an unbounded number of frames.
 */
export function createProcessIpcChannel(
  processLike: NodeHostBridgeProcessLike,
): NodeHostBridgeChannel {
  let frameListener: ((frame: NodeHostBridgeFrame) => void) | null = null;
  let closeListener: ((error?: Error) => void) | null = null;
  let closed = false;
  let inFlight = false;
  let flushing = false;
  const queue: Array<{ frame: NodeHostBridgeFrame; bytes: number }> = [];
  let queuedBytes = 0;

  const detach = () => {
    processLike.off?.("message", onMessage);
    processLike.off?.("disconnect", onDisconnect);
    processLike.off?.("exit", onDisconnect);
  };

  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    detach();
    closeListener?.(error);
  };

  const flush = () => {
    if (closed || inFlight || flushing) return;
    flushing = true;
    const send = processLike.send;
    if (!send) {
      flushing = false;
      return;
    }
    try {
      while (!closed && !inFlight && queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        queuedBytes -= next.bytes;
        inFlight = true;
        try {
          send(next.frame, (error: Error | null) => {
            inFlight = false;
            if (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            flush();
          });
        } catch (error) {
          inFlight = false;
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    } finally {
      flushing = false;
    }
  };

  const onMessage = (raw: unknown) => {
    if (closed) return;
    if (!isNodeHostBridgeFrame(raw)) {
      fail(new Error("Invalid Node Host bridge frame"));
      return;
    }
    frameListener?.(raw);
  };
  const onDisconnect = () => fail(new Error("Node Host IPC disconnected"));

  processLike.on("message", onMessage);
  processLike.once("disconnect", onDisconnect);
  processLike.once("exit", onDisconnect);

  return {
    send(frame) {
      if (closed || !processLike.send) return;
      const bytes = estimateNodeHostBridgeFrameBytes(frame);
      try {
        assertSendQueueWithinBound(queue.length + 1, queuedBytes + bytes);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      queue.push({ frame, bytes });
      queuedBytes += bytes;
      flush();
    },
    onFrame(listener) {
      frameListener = listener;
      return () => {
        if (frameListener === listener) frameListener = null;
      };
    },
    onClose(listener) {
      closeListener = listener;
      return () => {
        if (closeListener === listener) closeListener = null;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      queuedBytes = 0;
      detach();
      processLike.disconnect?.();
    },
  };
}

/** Length-prefixed v8 frames over a dedicated duplex fd (socketpair/pipe). */
export function createLengthPrefixedV8Channel(duplex: Duplex): NodeHostBridgeChannel {
  let frameListener: ((frame: NodeHostBridgeFrame) => void) | null = null;
  let closeListener: ((error?: Error) => void) | null = null;
  let closed = false;
  let blocked = false;
  let flushing = false;
  let buffer = Buffer.alloc(0);
  const queue: Buffer[] = [];
  let queuedBytes = 0;

  const detach = () => {
    duplex.off("data", onData);
    duplex.off("drain", onDrain);
    duplex.off("error", onError);
    duplex.off("close", onClose);
    duplex.off("end", onEnd);
  };

  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    buffer = Buffer.alloc(0);
    detach();
    closeListener?.(error);
    duplex.destroy();
  };

  const flush = () => {
    if (closed || blocked || flushing) return;
    flushing = true;
    try {
      while (!closed && !blocked && queue.length > 0) {
        const chunk = queue.shift()!;
        queuedBytes -= chunk.length;
        try {
          if (!duplex.write(chunk)) {
            blocked = true;
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    } finally {
      flushing = false;
    }
  };

  const onData = (chunk: Buffer | string) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length > MAX_NODE_HOST_BRIDGE_FRAME_BYTES) {
        fail(new Error(`Node Host bridge frame exceeds limit: ${length}`));
        return;
      }
      if (buffer.length < 4 + length) return;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        const frame = deserialize(payload) as unknown;
        if (!isNodeHostBridgeFrame(frame)) {
          fail(new Error("Invalid Node Host bridge frame"));
          return;
        }
        frameListener?.(frame);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  };
  const onDrain = () => {
    blocked = false;
    flush();
  };
  const onError = (error: Error) => fail(error);
  const onClose = () => {
    if (closed) return;
    closed = true;
    detach();
    closeListener?.();
  };
  const onEnd = () => onClose();

  duplex.on("data", onData);
  duplex.on("drain", onDrain);
  duplex.on("error", onError);
  duplex.on("close", onClose);
  duplex.on("end", onEnd);

  return {
    send(frame) {
      if (closed) return;
      let chunk: Buffer;
      try {
        const payload = serialize(frame);
        if (payload.length > MAX_NODE_HOST_BRIDGE_FRAME_BYTES) {
          fail(new Error(`Node Host bridge frame exceeds limit: ${payload.length}`));
          return;
        }
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(payload.length, 0);
        chunk = Buffer.concat([header, payload]);
        assertSendQueueWithinBound(queue.length + 1, queuedBytes + chunk.length);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      queue.push(chunk);
      queuedBytes += chunk.length;
      flush();
    },
    onFrame(listener) {
      frameListener = listener;
      return () => {
        if (frameListener === listener) frameListener = null;
      };
    },
    onClose(listener) {
      closeListener = listener;
      return () => {
        if (closeListener === listener) closeListener = null;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      queuedBytes = 0;
      buffer = Buffer.alloc(0);
      detach();
      duplex.destroy();
    },
  };
}
