import type { Duplex } from "node:stream";

export interface CuaNativeAuthorityWireLimits {
  readonly maxFrameBytes: number;
  readonly maxPendingBytes: number;
  readonly maxPendingRequests: number;
  readonly closeTimeoutMs: number;
}

export interface CuaNativeAuthorityWireCloseFacts {
  readonly transportClosed: boolean;
  readonly cleanupPending: boolean;
}

export interface CuaNativeAuthorityWireCallbacks {
  onLine(line: string): Promise<void>;
  onFailure(reason: string): void;
  onWriteFailure(reason: string): void;
}

/** 只负责私有 Duplex 的有界帧读写与 close 事实；不解析 authority 协议。 */
export class CuaNativeAuthorityWire {
  readonly #stream: Duplex;
  readonly #limits: CuaNativeAuthorityWireLimits;
  readonly #callbacks: CuaNativeAuthorityWireCallbacks;
  #input = "";
  #closed = false;
  #transportClosed = false;
  #closePromise?: Promise<CuaNativeAuthorityWireCloseFacts>;
  #closeTimer?: ReturnType<typeof setTimeout>;

  readonly #onData = (chunk: string | Buffer): void => {
    if (this.#closed) return;
    this.#input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const bufferedBytes = Buffer.byteLength(this.#input, "utf8");
    if (bufferedBytes > this.#limits.maxPendingBytes) {
      this.#callbacks.onFailure("input_backlog_exceeded");
      return;
    }
    if (this.#input.split("\n").length - 1 > this.#limits.maxPendingRequests) {
      this.#callbacks.onFailure("too_many_pending_requests");
      return;
    }
    if (!this.#input.includes("\n") && bufferedBytes > this.#limits.maxFrameBytes) {
      this.#callbacks.onFailure("frame_too_large");
      return;
    }
    this.#stream.pause();
    void this.#drainInput().finally(() => {
      if (!this.#closed) this.#stream.resume();
    });
  };
  readonly #onEnd = (): void => {
    this.#callbacks.onFailure("eof");
  };
  readonly #onError = (): void => {
    this.#callbacks.onFailure("transport-error");
  };
  readonly #onClose = (): void => {
    this.#transportClosed = true;
    if (!this.#closed) this.#callbacks.onFailure("transport-error");
  };

  constructor(
    stream: Duplex,
    limits: CuaNativeAuthorityWireLimits,
    callbacks: CuaNativeAuthorityWireCallbacks,
  ) {
    this.#stream = stream;
    this.#limits = limits;
    this.#callbacks = callbacks;
    this.#stream.setEncoding("utf8");
    this.#stream.on("data", this.#onData);
    this.#stream.on("end", this.#onEnd);
    this.#stream.on("error", this.#onError);
    this.#stream.on("close", this.#onClose);
    this.#stream.resume();
  }

  get transportClosed(): boolean {
    return this.#transportClosed;
  }

  async #drainInput(): Promise<void> {
    while (!this.#closed) {
      const newline = this.#input.indexOf("\n");
      if (newline < 0) return;
      const line = this.#input.slice(0, newline).trim();
      this.#input = this.#input.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > this.#limits.maxFrameBytes) {
        this.#callbacks.onFailure("frame_too_large");
        return;
      }
      try {
        await this.#callbacks.onLine(line);
      } catch {
        this.#callbacks.onFailure("handler_failed");
        return;
      }
    }
  }

  write(frame: { requestId: string; method: string; result: unknown }): boolean {
    if (this.#closed) return false;
    if (this.#stream.destroyed || !this.#stream.writable) {
      this.#callbacks.onWriteFailure("stream_not_writable");
      return false;
    }
    let line: string;
    try {
      line = `${JSON.stringify(frame)}\n`;
    } catch {
      this.#callbacks.onWriteFailure("encode_failed");
      return false;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    const pending = this.#stream.writableLength ?? 0;
    if (bytes > this.#limits.maxFrameBytes || pending + bytes > this.#limits.maxPendingBytes) {
      this.#callbacks.onWriteFailure("output_backlog_exceeded");
      return false;
    }
    try {
      this.#stream.write(line);
      return true;
    } catch {
      this.#callbacks.onWriteFailure("write_failed");
      return false;
    }
  }

  close(graceful: boolean): Promise<CuaNativeAuthorityWireCloseFacts> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#stream.removeListener("data", this.#onData);
    this.#stream.removeListener("end", this.#onEnd);
    this.#closePromise = new Promise((resolve) => {
      let completed = false;
      const destroyWhenBothEnded = (): void => {
        if (this.#stream.writableEnded && !this.#stream.destroyed) this.#stream.destroy();
      };
      const detach = (): void => {
        this.#stream.removeListener("error", this.#onError);
        this.#stream.removeListener("close", this.#onClose);
        this.#stream.removeListener("end", destroyWhenBothEnded);
        if (this.#closeTimer) clearTimeout(this.#closeTimer);
        this.#closeTimer = undefined;
      };
      const complete = (transportClosed: boolean): void => {
        if (completed) return;
        completed = true;
        this.#transportClosed = transportClosed;
        if (!this.#stream.destroyed) this.#stream.destroy();
        resolve({ transportClosed, cleanupPending: !transportClosed });
      };
      // destroy() 只是开始；只有已观察 close（或 emitClose 已置 closed）才算 transportClosed。
      if (this.#transportClosed || this.#stream.closed === true) {
        this.#transportClosed = true;
        complete(true);
        detach();
        return;
      }
      this.#stream.once("close", () => {
        complete(true);
        detach();
      });
      this.#closeTimer = setTimeout(
        () => {
          // timeout 只代表未确认 close；仍然 destroy 释放资源，但不谎报 transportClosed。
          complete(false);
        },
        Math.max(0, this.#limits.closeTimeoutMs),
      );
      this.#closeTimer.unref?.();
      if (graceful && this.#stream.writable) {
        try {
          this.#stream.once("end", destroyWhenBothEnded);
          this.#stream.end(destroyWhenBothEnded);
        } catch {
          this.#stream.destroy();
        }
        return;
      }
      this.#stream.destroy();
    });
    return this.#closePromise;
  }
}
