import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { performHandshake } from "../src/remote/handshake.js";
import type { StdioStream } from "../src/remote/backend.js";

function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const callbacks = new Set<(code: number) => void>();
  const stream: StdioStream = {
    stdin,
    stdout,
    stderr,
    onClose: (fn) => {
      callbacks.add(fn);
      return { dispose: () => callbacks.delete(fn) };
    },
  };
  return { stream, stdin, stdout, stderr, callbacks };
}
const hello = {
  type: "zody-hello",
  version: "test",
  platform: "test",
  arch: "test",
  pid: 1,
  generation: 2,
};

describe("RemoteServer client handshake", () => {
  it("accepts a fragmented new hello and preserves binary trailing bytes", async () => {
    const f = fixture();
    const pending = performHandshake(f.stream, "synthetic", 1000);
    const line = Buffer.from(JSON.stringify(hello) + "\n");
    const remainder = Buffer.from([0xf0, 0x9f, 0, 0xff]);
    f.stdout.write(line.subarray(0, 7));
    f.stdout.write(Buffer.concat([line.subarray(7), remainder]));
    const result = await pending;
    expect(result.remaining).toEqual(remainder);
    expect(JSON.parse(f.stdin.read().toString())).toMatchObject({
      type: "zody-hello-ack",
      clientId: "synthetic",
      generation: 2,
    });
    expect(f.callbacks.size).toBe(0);
  });
  it.each([
    { ...hello, type: "zcode-hello" },
    { ...hello, generation: 1 },
    { ...hello, generation: undefined },
    { ...hello, type: undefined },
    { ...hello, extra: true },
  ])("rejects incompatible hello without ack", async (value) => {
    const f = fixture();
    const pending = performHandshake(f.stream, "synthetic", 1000);
    f.stdout.write(JSON.stringify(value) + "\n");
    await expect(pending).rejects.toThrow();
    expect(f.stdin.read()).toBeNull();
    expect(f.callbacks.size).toBe(0);
  });
  it.each([null, [], "synthetic", 17, false])("rejects JSON value %s instead of treating it as a banner", async (value) => {
    const f = fixture();
    const pending = performHandshake(f.stream, "synthetic", 1000);
    f.stdout.write(JSON.stringify(value) + "\n");
    await expect(pending).rejects.toThrow("Invalid hello");
    expect(f.stdin.read()).toBeNull();
    expect(f.callbacks.size).toBe(0);
  });
  it("rejects EOF and releases listeners", async () => {
    const f = fixture();
    const pending = performHandshake(f.stream, "synthetic", 1000);
    f.stdout.end();
    await expect(pending).rejects.toThrow();
    expect(f.stdout.listenerCount("data")).toBe(0);
    expect(f.callbacks.size).toBe(0);
  });
});

describe("RemoteServer server ack gate", () => {
  const ack = { type: "zody-hello-ack", version: "test", clientId: "client", generation: 2 };
  it("accepts a fragmented ack, pauses and returns following bytes intact", async () => {
    const { waitForStdioAck } = await import("../src/stdioHandshake.js");
    const input = new PassThrough();
    const pending = waitForStdioAck(input, 1000);
    const frame = Buffer.from(JSON.stringify(ack) + "\n");
    const tail = Buffer.from([0xf0, 0x9f, 0, 0xff]);
    input.write(frame.subarray(0, 8));
    input.write(Buffer.concat([frame.subarray(8), tail]));
    expect(await pending).toEqual(ack);
    expect(input.read()).toEqual(tail);
    expect(input.listenerCount("data")).toBe(0);
  });
  it.each([
    { ...ack, type: "zcode-hello-ack" },
    { ...ack, generation: 1 },
    { ...ack, generation: undefined },
    { ...ack, extra: true },
  ])("rejects invalid ack before admission", async (value) => {
    const { waitForStdioAck } = await import("../src/stdioHandshake.js");
    const input = new PassThrough();
    const pending = waitForStdioAck(input, 1000);
    input.write(JSON.stringify(value) + "\n");
    await expect(pending).rejects.toThrow();
    expect(input.listenerCount("data")).toBe(0);
  });
  it.each(["eof", "error", "abort", "timeout"])("cleans listeners on %s", async (reason) => {
    const { waitForStdioAck } = await import("../src/stdioHandshake.js");
    const input = new PassThrough();
    const controller = new AbortController();
    const pending = waitForStdioAck(input, reason === "timeout" ? 5 : 1000, controller.signal);
    if (reason === "eof") input.end();
    if (reason === "error") input.emit("error", new Error("synthetic"));
    if (reason === "abort") controller.abort();
    await expect(pending).rejects.toThrow();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });
});

describe("real child ack gate", () => {
  it("admits only after a valid ack and hands the child exact trailing bytes", async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { pathToFileURL } = await import("node:url");
    const { resolve } = await import("node:path");
    const helper = pathToFileURL(resolve(import.meta.dirname, "../src/stdioHandshake.ts")).href;
    const code = `import { waitForStdioAck } from ${JSON.stringify(helper)}; process.stdout.write("ready\\n"); try { await waitForStdioAck(process.stdin, 1000); const data = process.stdin.read(); process.stdout.write(JSON.stringify({admitted:true, bytes:[...data]}) + "\\n"); process.stdin.destroy(); } catch { process.stdout.write(JSON.stringify({admitted:false}) + "\\n"); process.exitCode=1; }`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    try {
      while (!Buffer.concat(chunks).toString().includes("ready\n")) {
        await Promise.race([
          once(child.stdout, "data"),
          once(child, "close").then(() => {
            throw new Error("child exited before ready");
          }),
        ]);
      }
      const tail = Buffer.from([0xf0, 0x9f, 0, 0xff]);
      child.stdin.write(
        Buffer.concat([
          Buffer.from(
            JSON.stringify({
              type: "zody-hello-ack",
              version: "test",
              clientId: "child",
              generation: 2,
            }) + "\n",
          ),
          tail,
        ]),
      );
      const [exit] = await once(child, "close");
      expect(exit).toBe(0);
      expect(Buffer.concat(chunks).toString()).toContain(
        JSON.stringify({ admitted: true, bytes: [...tail] }),
      );
    } finally {
      if (child.exitCode === null) child.kill();
      child.stdin.destroy();
    }
  });
});

describe("RPC stream handoff", () => {
  it.each(["same chunk", "next chunk"])(
    "delivers the first RPC frame in %s after listeners attach",
    async (mode) => {
      const { wrapStdioStream } = await import("../src/remote/stdio-socket.js");
      const { SocketProtocol } = await import("@zody/rpc");
      const f = fixture();
      const pending = performHandshake(f.stream, "synthetic", 1000);
      const payload = Buffer.from("rpc-synthetic");
      const frame = Buffer.alloc(13 + payload.length);
      frame.writeUInt8(1, 0);
      frame.writeUInt32BE(payload.length, 9);
      payload.copy(frame, 13);
      const line = Buffer.from(JSON.stringify(hello) + "\n");
      f.stdout.write(mode === "same chunk" ? Buffer.concat([line, frame]) : line);
      const result = await pending;
      if (result.remaining) f.stdout.unshift(result.remaining);
      const protocol = new SocketProtocol(wrapStdioStream(f.stream));
      const received = new Promise<string>((resolve) =>
        protocol.onMessage((value) => resolve(Buffer.from(value.buffer).toString())),
      );
      if (mode === "next chunk") f.stdout.write(frame);
      f.stdout.resume();
      expect(await received).toBe("rpc-synthetic");
      protocol.dispose();
    },
  );
});

describe("client handshake cleanup", () => {
  it.each(["error", "abort", "timeout"])(
    "cleans readers and close subscription after %s",
    async (kind) => {
      const f = fixture();
      const abort = new AbortController();
      const pending = performHandshake(
        f.stream,
        "synthetic",
        kind === "timeout" ? 5 : 1000,
        abort.signal,
      );
      if (kind === "abort") abort.abort();
      if (kind === "error") f.stdout.emit("error", new Error("synthetic"));
      await expect(pending).rejects.toThrow();
      expect(f.stdout.listenerCount("data")).toBe(0);
      expect(f.stderr.listenerCount("data")).toBe(0);
      expect(f.callbacks.size).toBe(0);
    },
  );
  it("skips an SSH banner before the new hello", async () => {
    const f = fixture();
    const pending = performHandshake(f.stream, "synthetic", 1000);
    f.stdout.write(`welcome\n${JSON.stringify(hello)}\n`);
    expect((await pending).hello).toEqual(hello);
  });
});

describe("real stdio entry admission", () => {
  it("emits hello and exits without ready or RPC after an old ack", async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { resolve } = await import("node:path");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(import.meta.dirname, "../src/entry-stdio.ts")],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
          XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => output.push(data));
    child.stderr.on("data", (data: Buffer) => errors.push(data));
    try {
      while (!Buffer.concat(output).includes(10)) {
        await Promise.race([
          once(child.stdout, "data"),
          once(child, "close").then(() => {
            throw new Error(`entry failed before hello: ${Buffer.concat(errors).toString()}`);
          }),
        ]);
      }
      expect(JSON.parse(Buffer.concat(output).toString().trim())).toMatchObject({
        type: "zody-hello",
        generation: 2,
      });
      child.stdin.write(
        JSON.stringify({ type: "zcode-hello-ack", version: "old", clientId: "old" }) + "\n",
      );
      const [exit] = await once(child, "close");
      expect(exit).toBe(1);
      expect(Buffer.concat(output).toString().trim().split("\n")).toHaveLength(1);
      expect(Buffer.concat(errors).toString()).not.toContain("stdio mode ready");
    } finally {
      if (child.exitCode === null) child.kill();
      child.stdin.destroy();
    }
  }, 15000);
});

it("rejects an ack write failure without leaking handshake listeners", async () => {
  const { Writable } = await import("node:stream");
  const f = fixture();
  f.stream.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("synthetic write failure"));
    },
  });
  const pending = performHandshake(f.stream, "synthetic", 1000);
  f.stdout.write(JSON.stringify(hello) + "\n");
  await expect(pending).rejects.toThrow("synthetic write failure");
  expect(f.stdout.listenerCount("data")).toBe(0);
  expect(f.callbacks.size).toBe(0);
});
