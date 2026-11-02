import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { RunZCodeProtocolAgentOptions } from "@zcode/bootstrap";
import {
  parseCuaLaunchSessionReady,
  runCuaLaunchSession,
  type CuaLaunchSessionReady,
} from "../src/cua-launch-session.js";

const SHA = "a".repeat(64);

function controlLine(value: unknown): PassThrough {
  const stream = new PassThrough();
  stream.end(`${JSON.stringify(value)}\n`);
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
    ...overrides,
  };
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
});

test("launch requires this PID, private capture root and only optional explicit SHA", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-launch-"));
  await chmod(root, 0o700);
  const control = new PassThrough();
  const input = new PassThrough();
  const output = new PassThrough();
  let seen: RunZCodeProtocolAgentOptions | undefined;
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
      runProtocolAgent: async (options) => {
        seen = options;
      },
    });
    assert.equal(seen?.cuaNativeCapture?.captureRoot, root);
    assert.equal(seen?.cuaNativeCapture?.producerIncarnation, "producer-launch");
    assert.equal(seen?.cuaNodeReplMcpPortFactory, factory);
    assert.equal(seen?.presentationSurface, "zcode_desktop");
    assert.equal(seen?.lifecycle?.deadlineAt, undefined);

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
        control: controlLine(ready({ entryName: "host-entry.mjs" })),
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
