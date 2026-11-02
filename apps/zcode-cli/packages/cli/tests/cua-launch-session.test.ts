import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import type { RunZCodeProtocolAgentOptions } from "@zcode/bootstrap";
import {
  computeHelperTransportProof,
  parseHelperProofRequestLine,
  serializeHelperProof,
  transportProofCanonical,
} from "@zcode/shared/cua-helper-transport-auth";
import {
  parseCuaLaunchSessionReady,
  runCuaLaunchSession,
  type CuaLaunchSessionReady,
} from "../src/cua-launch-session.js";

const SHA = "a".repeat(64);
const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const REPLAYED_CHALLENGE = "40".repeat(32);

function controlLine(value: unknown): PassThrough {
  const stream = new PassThrough();
  stream.end(`${JSON.stringify(value)}\n`);
  return stream;
}

function liveControl(value: unknown): PassThrough {
  const stream = new PassThrough();
  stream.write(`${JSON.stringify(value)}\n`);
  return stream;
}

function ready(overrides: Partial<CuaLaunchSessionReady> = {}): CuaLaunchSessionReady {
  return {
    schemaVersion: 1,
    type: "session-ready",
    entryName: "cli-entry.mjs",
    authorityEndpoint: "/private/tmp/zody-authority.sock",
    nodePid: process.pid,
    entrySha256: SHA,
    producerIncarnation: "producer-launch",
    captureRoot: "/private/tmp/zody-capture",
    cellEndpoint: "/private/tmp/zody-cell.sock",
    transportAuthenticationKey: TEST_KEY,
    ...overrides,
  };
}

type Capture = NonNullable<RunZCodeProtocolAgentOptions["cuaNativeCapture"]>;

class FakeAuthorityPeer extends Duplex {
  private input = "";
  readonly requests: string[] = [];

  constructor(
    private readonly onRequest: (request: Record<string, unknown>, peer: FakeAuthorityPeer) => void,
  ) {
    super();
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.input += chunk.toString("utf8");
    const newline = this.input.indexOf("\n");
    if (newline < 0) {
      callback();
      return;
    }
    const line = this.input.slice(0, newline);
    this.input = this.input.slice(newline + 1);
    this.requests.push(line);
    try {
      this.onRequest(JSON.parse(line) as Record<string, unknown>, this);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  peerWrite(data: string): void {
    this.push(Buffer.from(data, "utf8"));
  }
}

function authorityPeer(options: {
  readonly proofKey?: string;
  readonly proofRole?: "authority" | "cell";
  readonly proofChallenge?: string;
  readonly canonicalChallenge?: string;
  readonly errorReason?: string;
  readonly trailing?: string;
} = {}): FakeAuthorityPeer {
  return new FakeAuthorityPeer((request, peer) => {
    if (options.errorReason !== undefined) {
      peer.peerWrite(
        `${JSON.stringify({
          schemaVersion: 1,
          type: "helper-proof-error",
          reason: options.errorReason,
        })}\n`,
      );
      return;
    }
    const parsed = parseHelperProofRequestLine(JSON.stringify(request));
    const frameChallenge = options.proofChallenge ?? parsed.challenge;
    const canonicalChallenge = options.canonicalChallenge ?? frameChallenge;
    const role = options.proofRole ?? "authority";
    const canonical =
      role === "cell"
        ? transportProofCanonical("cell", canonicalChallenge, "ab".repeat(32), 1, 1)
        : transportProofCanonical("authority", canonicalChallenge, "", 0, 0);
    const proof = computeHelperTransportProof(options.proofKey ?? TEST_KEY, canonical);
    peer.peerWrite(serializeHelperProof(role, frameChallenge, proof));
    if (options.trailing !== undefined) peer.peerWrite(options.trailing);
  });
}

function readyForEntry(entryName: CuaLaunchSessionReady["entryName"], root: string): unknown {
  const frame = ready({ entryName, captureRoot: root });
  if (entryName === "cli-entry.mjs") return frame;
  const { cellEndpoint: _cellEndpoint, ...withoutCell } = frame;
  if (entryName === "host-entry.mjs") {
    const { transportAuthenticationKey: _key, ...withoutKey } = withoutCell;
    return withoutKey;
  }
  return withoutCell;
}

async function runAuthorityCase(
  peer: Duplex,
  onCapture: (capture: Capture) => Promise<void>,
  entryName: CuaLaunchSessionReady["entryName"] = "cli-entry.mjs",
): Promise<{ connectCalls: number; agentCalled: boolean }> {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-authority-"));
  await chmod(root, 0o700);
  const control = new PassThrough();
  let connectCalls = 0;
  let agentCalled = false;
  try {
    const running = runCuaLaunchSession({
      entryName,
      control,
      input: new PassThrough(),
      output: new PassThrough(),
      connectAuthority: async () => {
        connectCalls += 1;
        return peer;
      },
      runProtocolAgent: async (options) => {
        agentCalled = true;
        assert.ok(options?.cuaNativeCapture);
        await onCapture(options.cuaNativeCapture);
      },
    });
    control.write(`${JSON.stringify(readyForEntry(entryName, root))}\n`);
    await running;
    return { connectCalls, agentCalled };
  } finally {
    control.end();
    await rm(root, { recursive: true, force: true });
  }
}

async function readAtLeast(stream: Duplex, expectedBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let received = "";
    const onData = (chunk: Buffer | string) => {
      received += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(received, "utf8") >= expectedBytes) {
        stream.removeListener("error", onError);
        resolve(received);
      }
    };
    const onError = (error: Error) => {
      stream.removeListener("data", onData);
      reject(error);
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.resume();
  });
}

test("parses strict session-ready and rejects path/spoof shapes", () => {
  assert.deepEqual(parseCuaLaunchSessionReady(JSON.stringify(ready())), ready());
  const { schemaVersion: _schemaVersion, ...missingSchema } = ready();
  assert.throws(
    () => parseCuaLaunchSessionReady(JSON.stringify(missingSchema)),
    /schema_version_unsupported/,
  );
  assert.throws(
    () => parseCuaLaunchSessionReady(JSON.stringify({ ...ready(), schemaVersion: 2 })),
    /schema_version_unsupported/,
  );
  assert.throws(
    () =>
      parseCuaLaunchSessionReady(
        JSON.stringify({ ...ready(), entryName: "not-an-entry.mjs" }),
      ),
    /entry_name_invalid/,
  );
  const { entryName: _entryName, ...missingEntry } = ready();
  assert.throws(
    () => parseCuaLaunchSessionReady(JSON.stringify(missingEntry)),
    /entry_name_invalid/,
  );
  assert.throws(
    () => parseCuaLaunchSessionReady(JSON.stringify({ ...ready(), authorityEndpoint: "relative.sock" })),
    /authority_endpoint_invalid/,
  );
  assert.throws(
    () => parseCuaLaunchSessionReady(JSON.stringify({ ...ready(), captureRoot: "/tmp/../tmp/x\0" })),
    /capture_root_invalid/,
  );
  assert.throws(
    () => parseCuaLaunchSessionReady(JSON.stringify({ ...ready(), extra: true })),
    /session_ready_invalid/,
  );
  assert.throws(
    () => parseCuaLaunchSessionReady(JSON.stringify({ ...ready(), cellEndpoint: "cell.sock" })),
    /cell_endpoint_invalid/,
  );
  assert.throws(
    () =>
      parseCuaLaunchSessionReady(
        JSON.stringify({ ...ready(), entryName: "host-entry.mjs" }),
      ),
    /cell_endpoint_invalid/,
  );
  const { cellEndpoint: _cellEndpoint, ...hostReady } = ready({ entryName: "host-entry.mjs" });
  assert.equal(
    parseCuaLaunchSessionReady(JSON.stringify(hostReady)).cellEndpoint,
    undefined,
  );

  for (const entryName of ["cli-entry.mjs", "session-entry.mjs"] as const) {
    const frame = ready({ entryName });
    const withoutCell =
      entryName === "cli-entry.mjs"
        ? frame
        : (({ cellEndpoint: _cell, ...rest }) => rest)(frame);
    const { transportAuthenticationKey: _key, ...withoutKey } = withoutCell;
    assert.throws(
      () => parseCuaLaunchSessionReady(JSON.stringify(withoutKey)),
      /transport_key_required/,
    );
  }
  assert.throws(
    () =>
      parseCuaLaunchSessionReady(
        JSON.stringify({ ...ready(), transportAuthenticationKey: "A".repeat(64) }),
      ),
    /transport_key_invalid/,
  );
  const { transportAuthenticationKey: _hostKey, ...hostWithoutKey } = hostReady;
  assert.equal(
    parseCuaLaunchSessionReady(JSON.stringify(hostWithoutKey)).transportAuthenticationKey,
    undefined,
  );
});

test("launch requires this PID, private capture root and only optional explicit SHA", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-launch-"));
  await chmod(root, 0o700);
  const control = new PassThrough();
  const input = new PassThrough();
  const output = new PassThrough();
  let seen: RunZCodeProtocolAgentOptions | undefined;
  let readySeen: CuaLaunchSessionReady | undefined;
  const factory: NonNullable<RunZCodeProtocolAgentOptions["cuaNodeReplMcpPortFactory"]> = (
    input,
  ) => input.port;
  control.write(`${JSON.stringify(ready({ captureRoot: root }))}\n`);
  try {
    await runCuaLaunchSession({
      entryName: "cli-entry.mjs",
      control,
      input,
      output,
      expectedEntrySha256: SHA,
      cuaNodeReplMcpPortFactory: factory,
      onSessionReady: (readyFrame) => {
        readySeen = readyFrame;
      },
      runProtocolAgent: async (options) => {
        seen = options;
      },
    });
    assert.equal(seen?.cuaNativeCapture?.captureRoot, root);
    assert.equal(seen?.cuaNativeCapture?.producerIncarnation, "producer-launch");
    assert.equal(seen?.cuaNodeReplMcpPortFactory, factory);
    assert.equal(seen?.presentationSurface, "zcode_desktop");
    assert.equal(seen?.lifecycle?.deadlineAt, undefined);
    assert.equal(readySeen?.cellEndpoint, "/private/tmp/zody-cell.sock");

    await assert.rejects(
      runCuaLaunchSession({
        entryName: "cli-entry.mjs",
        control: controlLine(ready({ nodePid: process.pid + 1 })),
        input,
        output,
        runProtocolAgent: async () => undefined,
      }),
      /pid_mismatch/,
    );
    await assert.rejects(
      runCuaLaunchSession({
        entryName: "cli-entry.mjs",
        control: controlLine(ready()),
        input,
        output,
        expectedEntrySha256: "b".repeat(64),
        runProtocolAgent: async () => undefined,
      }),
      /entry_sha_mismatch/,
    );
    await assert.rejects(
      runCuaLaunchSession({
        entryName: "cli-entry.mjs",
        control: controlLine(
          (({ cellEndpoint: _cell, ...rest }) => rest)(
            ready({ entryName: "host-entry.mjs" }),
          ),
        ),
        input,
        output,
        runProtocolAgent: async () => undefined,
      }),
      /entry_name_mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CUA factory requires a ready cellEndpoint and never falls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-launch-"));
  await chmod(root, 0o700);
  const factory: NonNullable<RunZCodeProtocolAgentOptions["cuaNodeReplMcpPortFactory"]> = (
    input,
  ) => input.port;
  const { cellEndpoint: _cellEndpoint, ...withoutEndpoint } = ready({ captureRoot: root });
  try {
    await assert.rejects(
      runCuaLaunchSession({
        entryName: "cli-entry.mjs",
        control: controlLine(withoutEndpoint),
        input: new PassThrough(),
        output: new PassThrough(),
        cuaNodeReplMcpPortFactory: factory,
        runProtocolAgent: async () => undefined,
      }),
      /cell_endpoint_required/,
    );

    const { transportAuthenticationKey: _key, ...withoutKey } = ready({ captureRoot: root });
    await assert.rejects(
      runCuaLaunchSession({
        entryName: "cli-entry.mjs",
        control: controlLine(withoutKey),
        input: new PassThrough(),
        output: new PassThrough(),
        cuaNodeReplMcpPortFactory: factory,
        runProtocolAgent: async () => undefined,
      }),
      /transport_key_required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority transport proves the helper identity and keeps same-packet bytes", async () => {
  const trailing = '{"bootstrap":true}\n';
  const peer = authorityPeer({ trailing });
  let received = "";
  const result = await runAuthorityCase(peer, async (capture) => {
    const socket = await capture.connect(new AbortController().signal);
    received = await readAtLeast(socket, Buffer.byteLength(trailing, "utf8"));
  });
  assert.equal(result.connectCalls, 1);
  assert.equal(result.agentCalled, true);
  assert.equal(received, trailing);
  const request = JSON.parse(peer.requests[0] ?? "{}") as Record<string, unknown>;
  assert.equal(request.type, "helper-proof-request");
  assert.equal(request.role, "authority");
  assert.equal(request.sourceSha256, "");
  assert.equal(request.requestMaxBytes, 0);
  assert.equal(request.responseMaxBytes, 0);
});

test("authority transport rejects replay, cross-role and wrong-key proofs", async () => {
  const connect = async (capture: Capture) => {
    await capture.connect(new AbortController().signal);
  };
  await assert.rejects(
    runAuthorityCase(authorityPeer({ canonicalChallenge: REPLAYED_CHALLENGE }), connect),
    /authority_proof_invalid/,
  );
  await assert.rejects(
    runAuthorityCase(authorityPeer({ proofRole: "cell" }), connect),
    /authority_proof_mismatch/,
  );
  await assert.rejects(
    runAuthorityCase(authorityPeer({ proofKey: "ff".repeat(32) }), connect),
    /authority_proof_invalid/,
  );
});

test("authority transport surfaces helper proof errors before wire session data", async () => {
  await assert.rejects(
    runAuthorityCase(
      authorityPeer({ errorReason: "authority-transport-role-invalid" }),
      async (capture) => {
        await capture.connect(new AbortController().signal);
      },
    ),
    /authority_proof_error:authority-transport-role-invalid/,
  );
});

test("missing transport key fails closed before connecting authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-key-"));
  await chmod(root, 0o700);
  const { transportAuthenticationKey: _key, ...withoutKey } = ready({ captureRoot: root });
  let connected = 0;
  let agentCalled = false;
  try {
    await assert.rejects(
      runCuaLaunchSession({
        entryName: "cli-entry.mjs",
        control: controlLine(withoutKey),
        input: new PassThrough(),
        output: new PassThrough(),
        connectAuthority: async () => {
          connected += 1;
          throw new Error("must not connect");
        },
        runProtocolAgent: async () => {
          agentCalled = true;
        },
      }),
      /transport_key_required/,
    );
    assert.equal(connected, 0);
    assert.equal(agentCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host-entry needs no key and session-entry needs no cellEndpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-entry-"));
  await chmod(root, 0o700);
  const hostControl = liveControl(readyForEntry("host-entry.mjs", root));
  const sessionControl = liveControl(readyForEntry("session-entry.mjs", root));
  let hostCapture: Capture | undefined;
  let sessionSeen = false;
  try {
    await runCuaLaunchSession({
      entryName: "host-entry.mjs",
      control: hostControl,
      input: new PassThrough(),
      output: new PassThrough(),
      runProtocolAgent: async (options) => {
        hostCapture = options?.cuaNativeCapture;
      },
    });
    assert.ok(hostCapture);
    await assert.rejects(
      hostCapture.connect(new AbortController().signal),
      /transport_key_required/,
    );

    await runCuaLaunchSession({
      entryName: "session-entry.mjs",
      control: sessionControl,
      input: new PassThrough(),
      output: new PassThrough(),
      runProtocolAgent: async (options) => {
        sessionSeen = options?.cuaNativeCapture !== undefined;
      },
    });
    assert.equal(sessionSeen, true);
  } finally {
    hostControl.end();
    sessionControl.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps fd3 lifetime after ready and stops on EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-launch-"));
  await chmod(root, 0o700);
  const control = new PassThrough();
  let seen: RunZCodeProtocolAgentOptions | undefined;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const running = runCuaLaunchSession({
      entryName: "cli-entry.mjs",
      control,
      input: new PassThrough(),
      output: new PassThrough(),
      runProtocolAgent: async (options) => {
        seen = options;
        started();
        await aborted(options?.lifecycle?.signal);
      },
    });
    control.write(`${JSON.stringify(ready({ captureRoot: root }))}\n`);
    await didStart;
    control.end();
    await running;
    assert.equal(seen?.lifecycle?.signal.aborted, true);
    assert.match(String(seen?.lifecycle?.signal.reason), /control_eof/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps fd3 lifetime after ready and stops on control error", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-launch-"));
  await chmod(root, 0o700);
  const control = new PassThrough();
  let seen: RunZCodeProtocolAgentOptions | undefined;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const running = runCuaLaunchSession({
      entryName: "cli-entry.mjs",
      control,
      input: new PassThrough(),
      output: new PassThrough(),
      runProtocolAgent: async (options) => {
        seen = options;
        started();
        await aborted(options?.lifecycle?.signal);
      },
    });
    control.write(`${JSON.stringify(ready({ captureRoot: root }))}\n`);
    await didStart;
    control.destroy(new Error("native control died"));
    await running;
    assert.equal(seen?.lifecycle?.signal.aborted, true);
    assert.match(String(seen?.lifecycle?.signal.reason), /control_error/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
