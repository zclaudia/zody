import { once } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeCellSource } from "../src/cell-child-transport.js";

class ControlledWritable extends Writable {
  readonly chunks: string[] = [];
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString("utf8"));
    this.callbacks.push(callback);
  }

  release(): void {
    const callback = this.callbacks.shift();
    if (!callback) throw new Error("controlled writable has no pending write");
    callback();
  }

  fail(error: Error): void {
    const callback = this.callbacks.shift();
    if (!callback) throw new Error("controlled writable has no pending write");
    callback(error);
  }
}

describe("cell source stdin writer", () => {
  it("waits for drain before ending a backpressured source write", async () => {
    const stream = new ControlledWritable();
    const errors: unknown[] = [];
    const finished = once(stream, "finish");

    writeCellSource({
      stream,
      source: "snapshot-source",
      isUnavailable: () => false,
      onError: (error) => errors.push(error),
    });

    expect(stream.chunks).toEqual(["snapshot-source"]);
    expect(stream.writableEnded).toBe(false);
    expect(errors).toEqual([]);

    stream.release();
    await finished;

    expect(stream.writableEnded).toBe(true);
    expect(errors).toEqual([]);
  });

  it("settles exactly once when the stdin pipe reports EPIPE", async () => {
    const stream = new ControlledWritable();
    const errors: unknown[] = [];
    const errorEvent = once(stream, "error");
    const closeEvent = new Promise<void>((resolve) => {
      stream.once("close", () => resolve());
    });

    writeCellSource({
      stream,
      source: "snapshot-source",
      isUnavailable: () => false,
      onError: (error) => errors.push(error),
    });
    stream.fail(new Error("EPIPE"));

    const [error] = await errorEvent;
    expect(error).toMatchObject({ message: "EPIPE" });
    await closeEvent;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "EPIPE" });
  });

  it("settles when stdin closes before the source is ended", async () => {
    const stream = new ControlledWritable();
    const errors: unknown[] = [];
    const closed = once(stream, "close");

    writeCellSource({
      stream,
      source: "snapshot-source",
      isUnavailable: () => false,
      onError: (error) => errors.push(error),
    });
    stream.destroy();

    await closed;
    expect(errors).toHaveLength(1);
  });
});
