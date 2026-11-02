import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCuaHelperCellTransport as createRawCuaHelperCellTransport,
  cuaHelperSourceSha256,
  type CuaHelperCellTransportOptions,
} from "../src/cell-helper-transport.js";
import {
  computeHelperTransportProof,
  serializeHelperProof,
  transportProofCanonical,
} from "@zcode/shared/cua-helper-transport-auth";
import {
  CELL_PROTOCOL_VERSION,
  encodeCellRequest,
  type CellRequest,
} from "../src/cell-protocol.js";

const SOURCE = "console.log(1)\n";
const SOURCE_SHA = cuaHelperSourceSha256(SOURCE);
const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function request(code: string): CellRequest {
  return {
    version: CELL_PROTOCOL_VERSION,
    invocationId: "invocation-1",
    code,
    requestMeta: { session_id: "session-1" },
    syncTimeoutMs: 30_000,
    documentationRoots: { browser: "/docs/browser", cua: "/docs/cua" },
  };
}

async function endpointFor(handler: (socket: Socket) => void): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zody-cell-helper-"));
  directories.push(directory);
  const endpoint = join(directory, "cell.sock");
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  return endpoint;
}

function readyLine(cellPid = 4242): string {
  return `${JSON.stringify({ schemaVersion: 1, type: "cell-ready", cellPid })}\n`;
}

function proofLine(open: Record<string, unknown>): string {
  const challenge = open.challenge as string;
  const sourceSha256 = open.sourceSha256 as string;
  const requestMaxBytes = open.requestMaxBytes as number;
  const responseMaxBytes = open.responseMaxBytes as number;
  const canonical = transportProofCanonical(
    "cell",
    challenge,
    sourceSha256,
    requestMaxBytes,
    responseMaxBytes,
  );
  return `${JSON.stringify({
    schemaVersion: 1,
    type: "helper-proof",
    role: "cell",
    challenge,
    proof: computeHelperTransportProof(TEST_KEY, canonical),
  })}\n`;
}

function createCuaHelperCellTransport(options: CuaHelperCellTransportOptions) {
  return createRawCuaHelperCellTransport({
    transportAuthenticationKey: () => TEST_KEY,
    ...options,
  });
}

function writeProofAndReady(
  socket: Socket,
  open: Record<string, unknown>,
  cellPid = 4242,
): void {
  socket.write(proofLine(open));
  socket.write(readyLine(cellPid));
}

function responseLine(invocationId: string, result = "2"): string {
  return JSON.stringify({
    version: CELL_PROTOCOL_VERSION,
    invocationId,
    ok: true,
    result: { result, logs: "" },
  });
}

function exitLine(): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "cell-exit",
    reaped: true,
    exitCode: 0,
    signal: null,
  });
}

class InMemoryPeer extends Duplex {
  finalCalls = 0;

  constructor(private readonly onClientBytes: (chunk: Buffer) => void) {
    super();
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.onClientBytes(Buffer.from(chunk));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.finalCalls += 1;
    callback();
  }

  pushFromHelper(data: string | Buffer): void {
    this.push(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  }

  helperEnd(): void {
    this.push(null);
  }
}

function proofForOpen(
  open: Record<string, unknown>,
  options: {
    readonly key?: string;
    readonly role?: "cell" | "authority";
    readonly challenge?: string;
  } = {},
): string {
  const role = options.role ?? "cell";
  const challenge = options.challenge ?? (open.challenge as string);
  const canonical =
    role === "cell"
      ? transportProofCanonical(
          "cell",
          challenge,
          open.sourceSha256 as string,
          open.requestMaxBytes as number,
          open.responseMaxBytes as number,
        )
      : transportProofCanonical("authority", challenge, "", 0, 0);
  return serializeHelperProof(
    role,
    challenge,
    computeHelperTransportProof(options.key ?? TEST_KEY, canonical),
  );
}

function startInMemoryHelper(
  onLine: (line: string, peer: InMemoryPeer, index: number) => void,
): {
  readonly connect: (path: string, signal: AbortSignal) => Promise<Duplex>;
  readonly peer: () => InMemoryPeer;
} {
  let peer: InMemoryPeer | undefined;
  let buffer = "";
  let index = 0;
  return {
    connect: async () => {
      const created = new InMemoryPeer((chunk) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          onLine(line, created, index);
          index += 1;
          newline = buffer.indexOf("\n");
        }
      });
      peer = created;
      return created;
    },
    peer: () => {
      if (peer === undefined) throw new Error("in-memory peer was not connected");
      return peer;
    },
  };
}

function runCellTransport(
  connect: (path: string, signal: AbortSignal) => Promise<Duplex>,
  options: Partial<CuaHelperCellTransportOptions> = {},
  cellRequest = request("1 + 1"),
  signal = new AbortController().signal,
  responseMaxBytes = 32 * 1024 * 1024,
) {
  const transport = createCuaHelperCellTransport({
    endpoint: () => "/private/tmp/zody-cell.sock",
    sourceSha256: SOURCE_SHA,
    connectImpl: connect,
    ...options,
  });
  return transport.run({
    line: encodeCellRequest(cellRequest),
    request: cellRequest,
    responseMaxBytes,
    signal,
  });
}

describe("createCuaHelperCellTransport", () => {
  it("relays the original fd3 request and full fd4 response stream", async () => {
    let seenRequest = "";
    let readyPid = 0;
    const endpoint = await endpointFor(async (socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const open = JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
      expect(open).toMatchObject({
        schemaVersion: 1,
        type: "cell-open",
        sourceSha256: SOURCE_SHA,
      });
      writeProofAndReady(socket, open);
      seenRequest = (await lines.next()).value as string;
      socket.write(`${responseLine("invocation-1")}\n${exitLine()}\n`);
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
      onCellReady: (pid) => {
        readyPid = pid;
      },
    });
    const cellRequest = request("1 + 1");
    const result = await transport.run({
      line: encodeCellRequest(cellRequest),
      request: cellRequest,
      responseMaxBytes: 32 * 1024 * 1024,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ result: "2", logs: "" });
    expect(readyPid).toBe(4242);
    expect(JSON.parse(seenRequest)).toMatchObject({ invocationId: "invocation-1", code: "1 + 1" });
  });

  it("does not half-close the transport socket after writing the request", async () => {
    let sawRequest = false;
    let endedBeforeResponse = false;
    const endpoint = await endpointFor(async (socket) => {
      socket.once("end", () => {
        if (sawRequest) endedBeforeResponse = true;
      });
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const open = JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
      writeProofAndReady(socket, open);
      await lines.next();
      sawRequest = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket.write(`${responseLine("invocation-1")}\n${exitLine()}\n`);
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 32 * 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ result: "2", logs: "" });
    expect(endedBeforeResponse).toBe(false);
  });

  it("relays a large response within the declared bound", async () => {
    const largeResult = "y".repeat(2 * 1024 * 1024);
    const endpoint = await endpointFor(async (socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const open = JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
      writeProofAndReady(socket, open);
      await lines.next();
      socket.write(`${responseLine("invocation-1", largeResult)}\n${exitLine()}\n`);
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    const result = await transport.run({
      line: encodeCellRequest(cellRequest),
      request: cellRequest,
      responseMaxBytes: 4 * 1024 * 1024,
      signal: new AbortController().signal,
    });
    expect(result.result).toBe(largeResult);
  });

  it("surfaces a cell-error emitted after ready", async () => {
    const endpoint = await endpointFor(async (socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const open = JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
      writeProofAndReady(socket, open);
      await lines.next();
      socket.write(
        `${JSON.stringify({
          schemaVersion: 1,
          type: "cell-error",
          reason: "cell-relay-timeout",
        })}\n${exitLine()}\n`,
      );
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 32 * 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/cell-relay-timeout/u);
  });

  it("rejects identity failure without forwarding the request", async () => {
    let sawExtra = false;
    const endpoint = await endpointFor(async (socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      await lines.next();
      socket.write(
        `${JSON.stringify({
          schemaVersion: 1,
          type: "cell-error",
          reason: "cell-identity-failed",
        })}\n`,
      );
      const next = await Promise.race([
        lines.next(),
        new Promise<IteratorResult<string>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined as never }), 500),
        ),
      ]);
      if (!next.done) sawExtra = true;
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 32 * 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/cell-identity-failed/u);
    expect(sawExtra).toBe(false);
  });

  it("rejects a mismatched source SHA reported by the Helper", async () => {
    const endpoint = await endpointFor(async (socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      await lines.next();
      socket.write(
        `${JSON.stringify({
          schemaVersion: 1,
          type: "cell-error",
          reason: "cell-source-sha-mismatch",
        })}\n`,
      );
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 32 * 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/cell-source-sha-mismatch/u);
  });

  it("requires a positive actual cell PID in the ready frame", async () => {
    const endpoint = await endpointFor(async (socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const open = JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
      socket.write(proofLine(open));
      socket.write(`${JSON.stringify({ schemaVersion: 1, type: "cell-ready", cellPid: 0 })}\n`);
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 32 * 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/cell_pid_invalid/u);
  });

  it("fails closed without a ready endpoint and never invokes connect or spawn", async () => {
    let connected = 0;
    const transport = createCuaHelperCellTransport({
      endpoint: () => undefined,
      sourceSha256: SOURCE_SHA,
      connectImpl: async () => {
        connected += 1;
        throw new Error("must not connect");
      },
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 32 * 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/cell_endpoint_required/u);
    expect(connected).toBe(0);
  });

  it("bounds the response frame", async () => {
    const endpoint = await endpointFor(async (socket) => {
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const open = JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
      writeProofAndReady(socket, open);
      await lines.next();
      socket.write(`${JSON.stringify({ padding: "x".repeat(256) })}\n`);
    });
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 64,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/frame_too_large/u);
  });

  it("destroys the socket on abort and settles the call", async () => {
    let closed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      closed = () => resolve();
    });
    const endpoint = await endpointFor(async (socket) => {
      socket.once("close", closed);
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const open = JSON.parse((await lines.next()).value as string) as Record<string, unknown>;
      writeProofAndReady(socket, open);
      await lines.next();
      socket.write("partial");
    });
    const controller = new AbortController();
    const transport = createCuaHelperCellTransport({
      endpoint: () => endpoint,
      sourceSha256: SOURCE_SHA,
    });
    const cellRequest = request("1 + 1");
    const running = transport.run({
      line: encodeCellRequest(cellRequest),
      request: cellRequest,
      responseMaxBytes: 32 * 1024 * 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("test-abort")), 50);
    await expect(running).rejects.toThrow(/test-abort/u);
    await expect(closedPromise).resolves.toBeUndefined();
  });

  it("in-memory: relays the raw request, keeps the socket open, and decodes split UTF-8", async () => {
    let seenRequest = "";
    let helper: ReturnType<typeof startInMemoryHelper> | undefined;
    helper = startInMemoryHelper((line, peer, index) => {
      if (index === 0) {
        const open = JSON.parse(line) as Record<string, unknown>;
        peer.pushFromHelper(proofForOpen(open));
        peer.pushFromHelper(readyLine());
        return;
      }
      seenRequest = line;
      const text = `${responseLine("invocation-1", "你好🙂")}\n${exitLine()}\n`;
      const bytes = Buffer.from(text, "utf8");
      const split = bytes.indexOf(Buffer.from("好", "utf8")) + 1;
      peer.pushFromHelper(bytes.subarray(0, split));
      setTimeout(() => peer.pushFromHelper(bytes.subarray(split)), 0);
    });
    const cellRequest = request("1 + 1");
    const result = await runCellTransport(helper.connect, {}, cellRequest);
    expect(result).toEqual({ result: "你好🙂", logs: "" });
    expect(seenRequest).toBe(encodeCellRequest(cellRequest).trimEnd());
    expect(helper.peer().finalCalls).toBe(0);
  });

  it("in-memory: rejects a wrong proof and never sends the CellRequest", async () => {
    let sawRequest = false;
    const helper = startInMemoryHelper((line, peer, index) => {
      if (index !== 0) {
        sawRequest = true;
        return;
      }
      const open = JSON.parse(line) as Record<string, unknown>;
      peer.pushFromHelper(proofForOpen(open, { key: "ff".repeat(32) }));
      peer.pushFromHelper(readyLine());
    });
    await expect(runCellTransport(helper.connect)).rejects.toThrow(/proof_invalid/u);
    expect(sawRequest).toBe(false);
  });

  it("in-memory: rejects replay and cross-role proofs before the request", async () => {
    for (const options of [
      { challenge: "40".repeat(32) },
      { role: "authority" as const },
    ]) {
      let sawRequest = false;
      const helper = startInMemoryHelper((line, peer, index) => {
        if (index !== 0) {
          sawRequest = true;
          return;
        }
        const open = JSON.parse(line) as Record<string, unknown>;
        peer.pushFromHelper(proofForOpen(open, options));
        peer.pushFromHelper(readyLine());
      });
      await expect(runCellTransport(helper.connect)).rejects.toThrow(
        /proof_challenge_mismatch/u,
      );
      expect(sawRequest).toBe(false);
    }
  });

  it("in-memory: missing key fails closed before connect", async () => {
    let connected = 0;
    const transport = createRawCuaHelperCellTransport({
      endpoint: () => "/private/tmp/zody-cell.sock",
      sourceSha256: SOURCE_SHA,
      transportAuthenticationKey: () => undefined,
      connectImpl: async () => {
        connected += 1;
        throw new Error("must not connect");
      },
    });
    const cellRequest = request("1 + 1");
    await expect(
      transport.run({
        line: encodeCellRequest(cellRequest),
        request: cellRequest,
        responseMaxBytes: 32 * 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/transport_key_required/u);
    expect(connected).toBe(0);
  });

  it("in-memory: rejects a request frame over the declared bound before connect", async () => {
    let connected = 0;
    const connect = async () => {
      connected += 1;
      throw new Error("must not connect");
    };
    await expect(
      runCellTransport(connect, { requestMaxBytes: 8 }, request("x".repeat(64))),
    ).rejects.toThrow(/request_bound_exceeded/u);
    expect(connected).toBe(0);
  });

  it("in-memory: surfaces a helper error before proof without sending the request", async () => {
    let sawRequest = false;
    const helper = startInMemoryHelper((_line, peer, index) => {
      if (index !== 0) {
        sawRequest = true;
        return;
      }
      peer.pushFromHelper(
        `${JSON.stringify({
          schemaVersion: 1,
          type: "cell-error",
          reason: "cell-identity-failed",
        })}\n`,
      );
    });
    await expect(runCellTransport(helper.connect)).rejects.toThrow(
      /helper_cell_error:cell-identity-failed/u,
    );
    expect(sawRequest).toBe(false);
  });

  it("in-memory: EOF during a response aborts instead of waiting for fd4", async () => {
    const helper = startInMemoryHelper((line, peer, index) => {
      if (index === 0) {
        const open = JSON.parse(line) as Record<string, unknown>;
        peer.pushFromHelper(proofForOpen(open));
        peer.pushFromHelper(readyLine());
        return;
      }
      peer.pushFromHelper('{"version":1,"invocationId":"invocation-1"');
      peer.helperEnd();
    });
    await expect(runCellTransport(helper.connect)).rejects.toThrow(/truncated/u);
    expect(helper.peer().destroyed).toBe(true);
  });

  it("in-memory: enforces the response frame bound", async () => {
    const helper = startInMemoryHelper((line, peer, index) => {
      if (index === 0) {
        const open = JSON.parse(line) as Record<string, unknown>;
        peer.pushFromHelper(proofForOpen(open));
        peer.pushFromHelper(readyLine());
        return;
      }
      peer.pushFromHelper(`${JSON.stringify({ padding: "x".repeat(256) })}\n`);
    });
    await expect(runCellTransport(helper.connect, {}, request("1 + 1"), undefined, 64)).rejects
      .toThrow(/frame_too_large/u);
  });

  it("in-memory: abort after ready destroys the socket and settles", async () => {
    const controller = new AbortController();
    let peer: InMemoryPeer | undefined;
    const helper = startInMemoryHelper((line, created, index) => {
      peer = created;
      if (index === 0) {
        const open = JSON.parse(line) as Record<string, unknown>;
        created.pushFromHelper(proofForOpen(open));
        created.pushFromHelper(readyLine());
        return;
      }
      setTimeout(() => controller.abort(new Error("in-memory-abort")), 0);
    });
    await expect(
      runCellTransport(helper.connect, {}, request("1 + 1"), controller.signal),
    ).rejects.toThrow(/in-memory-abort/u);
    expect(peer?.destroyed).toBe(true);
  });

  it("in-memory: total deadline bounds a cell that never returns a response", async () => {
    const helper = startInMemoryHelper((line, peer, index) => {
      if (index === 0) {
        const open = JSON.parse(line) as Record<string, unknown>;
        peer.pushFromHelper(proofForOpen(open));
        peer.pushFromHelper(readyLine());
      }
    });
    await expect(runCellTransport(helper.connect, { timeoutMs: 100 })).rejects.toThrow(
      /cell_timeout/u,
    );
  });
});
