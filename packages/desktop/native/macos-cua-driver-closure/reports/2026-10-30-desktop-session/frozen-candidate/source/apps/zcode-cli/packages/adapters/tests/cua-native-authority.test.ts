import { duplexPair, type Duplex } from "node:stream";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySessionEventStore,
  createModelId,
  createModelProviderId,
  createSessionId,
  type Model,
  type ModelOptions,
  type ModelProperties,
} from "@zcode/contracts";
import { AgentRuntime, type AgentRuntimeDeps } from "@zcode/core";
import { describe, expect, it } from "vitest";
import { createCuaNativeAuthoritySession } from "../src/mcp/cua-native-authority.js";

const PRODUCER = "launcher-producer-1";

function createHeldModelFactory(gate: Promise<void>): AgentRuntimeDeps["modelFactory"] {
  const inputFormat = {
    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: false,
    supportsPdf: true,
  };
  const properties: ModelProperties = {
    contextWindow: 200_000,
    inputFormat,
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  };
  return (input) => {
    const build = (options: ModelOptions): Model => ({
      providerId: createModelProviderId(input.selection.providerId),
      modelId: createModelId(input.selection.modelId),
      properties,
      optionSpecs: {
        reasoningLevel: { values: ["disabled"] },
        maxOutputTokens: { max: 32_000 },
      },
      options,
      bind: (next) => build({ ...options, ...next }),
      generateText: async () => {
        await gate;
        return {
          finishReason: "stop" as const,
          model: "test",
          providerMetadata: undefined,
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      async *streamText() {
        await gate;
        yield {
          type: "finish" as const,
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    });
    return build({ maxOutputTokens: 32_000, reasoningLevel: "disabled" });
  };
}

interface HeldTurn {
  readonly runtime: AgentRuntime;
  readonly scope: NonNullable<ReturnType<AgentRuntime["createCuaSubmissionTurnScope"]>>;
  readonly gate: { readonly promise: Promise<void>; readonly resolve: () => void };
  readonly completion: Promise<unknown>;
}

async function startHeldTurn(key: string, id: string): Promise<HeldTurn> {
  let release!: () => void;
  const gatePromise = new Promise<void>((done) => {
    release = done;
  });
  const gate = { promise: gatePromise, resolve: release };
  const sessionId = createSessionId(key);
  const runtime = new AgentRuntime(
    sessionId,
    { mode: "build", modelSelection: { providerId: "test-provider", modelId: "test-model" } },
    {
      eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
      modelFactory: createHeldModelFactory(gate.promise),
      cuaSubmission: {
        appIncarnation: "app-native-authority",
        hostInstanceId: "host-native-authority",
        runtimeInstanceId: `runtime-${key}`,
        sessionId: String(sessionId),
        workspaceKey: "/workspace/cua-native-authority",
      },
    },
  );
  const registration = runtime.getCuaSubmissionRegistrar()?.register({
    origin: "desktop",
    inputKind: "new-submission",
    sourceCommandId: id,
    queueItemId: `queue_${id}`,
  });
  if (!registration?.accepted) throw new Error("registration was not accepted");
  const receipt = await runtime.admitPrompt(id, undefined, {
    inputId: id,
    intent: {
      sourceCommandId: id,
      queueItemId: `queue_${id}`,
      clientId: "cli",
      kind: "sendText",
      text: id,
      inputOrigin: "desktop",
      admissionSeq: 1,
      admittedAt: 1,
      requestedDelivery: "startNow",
      admittedDelivery: "startNow",
    },
  });
  if (receipt.kind !== "started") throw new Error("prompt did not start");
  await expect.poll(() => runtime.getActiveTurnInfo() !== undefined).toBe(true);
  const scope = runtime.createCuaSubmissionTurnScope();
  if (!scope) throw new Error("scope was not issued");
  return { runtime, scope, gate, completion: receipt.completion };
}

async function finishHeldTurn(held: HeldTurn): Promise<void> {
  held.gate.resolve();
  await held.completion.catch(() => undefined);
  await expect.poll(() => !held.runtime.hasActiveOrQueuedTurnWork()).toBe(true);
}

function createFrameChannel(stream: Duplex) {
  const frames: Record<string, any>[] = [];
  const waiters: Array<(frame: Record<string, any> | Error) => void> = [];
  let ended = false;
  const reader = createInterface({ input: stream });
  reader.on("line", (line) => {
    if (line.trim().length === 0) return;
    const frame = JSON.parse(line) as Record<string, any>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  const stop = (): void => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter(new Error("stream ended"));
  };
  reader.on("close", stop);
  stream.on("error", stop);
  return {
    next(timeoutMs = 2_000) {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      if (ended) return Promise.reject(new Error("stream ended"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
        waiters.push((frame) => {
          clearTimeout(timer);
          if (frame instanceof Error) reject(frame);
          else resolve(frame);
        });
      });
    },
  };
}

function send(stream: Duplex, requestId: string, method: string, payload: object): void {
  stream.write(`${JSON.stringify({ requestId, method, payload })}\n`);
}

function checkPayload(scope: HeldTurn["scope"], patch: Record<string, unknown> = {}) {
  return {
    ref: scope.ref,
    traceId: scope.traceId,
    producerIncarnation: PRODUCER,
    runId: scope.runId,
    turnId: scope.turnId,
    ...patch,
  };
}

function openSession(scope: HeldTurn["scope"], options: Record<string, unknown> = {}) {
  const [host, helper] = duplexPair();
  const frames = createFrameChannel(helper);
  const session = createCuaNativeAuthoritySession({
    scope,
    stream: host,
    producerIncarnation: PRODUCER,
    requestTimeoutMs: 1_000,
    closeTimeoutMs: 500,
    ...options,
  });
  return { host, helper, frames, session };
}

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.write("tail", 33, "ascii");
  return bytes;
}

async function createCaptureFixture(width = 2400, height = 1600) {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-capture-"));
  await chmod(root, 0o700);
  const bytes = pngBytes(width, height);
  const path = join(root, "capture.png");
  await writeFile(path, bytes);
  return {
    root,
    png: {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width,
      height,
      bytes: bytes.byteLength,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function capturePayload(
  scope: HeldTurn["scope"],
  fixture: Awaited<ReturnType<typeof createCaptureFixture>>,
  target: { pid: number; windowId: number },
) {
  return {
    ref: scope.ref,
    traceId: scope.traceId,
    producerIncarnation: PRODUCER,
    runId: scope.runId,
    turnId: scope.turnId,
    target,
    png: fixture.png,
    resourcesReleased: true,
    machineLeaseReleased: true,
  };
}

describe("CuaNativeAuthoritySession", () => {
  it("bootstraps only from the runtime scope and rejects caller identity", async () => {
    const held = await startHeldTurn("native-bootstrap", "native-bootstrap-a");
    const { helper, frames, session } = openSession(held.scope);
    try {
      send(helper, "b1", "bootstrap", { sessionId: "spoofed-session" });
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "b1",
        method: "bootstrap",
        result: { ok: false, reason: "invalid_payload" },
      });

      send(helper, "b2", "bootstrap", {});
      const response = await frames.next();
      expect(response.result).toMatchObject({
        ok: true,
        traceId: held.scope.traceId,
        ref: held.scope.ref,
        producerIncarnation: PRODUCER,
        runId: held.scope.runId,
        turnId: held.scope.turnId,
      });
      expect(session.diagnostics).toMatchObject({
        executable: false,
        candidateIsGrant: false,
        nativeFence: "unknown",
        machineLease: "unavailable",
        stopComplete: false,
      });
      session.close();
      helper.end();
      await expect(session.waitForClose()).resolves.toMatchObject({
        reason: "adapter-close",
        ownerRevoked: false,
        authorityRevoke: "not-requested",
        transportClosed: true,
        cleanupPending: false,
      });
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("checks the exact captured identity and blocks checks after owner revoke", async () => {
    const held = await startHeldTurn("native-check", "native-check-a");
    const { helper, frames, session } = openSession(held.scope);
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();

      send(helper, "c-turn", "check", checkPayload(held.scope, { turnId: "other-turn" }));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c-turn",
        result: { ok: false, reason: "association_mismatch" },
      });
      send(
        helper,
        "c-ref",
        "check",
        checkPayload(held.scope, {
          ref: { ...held.scope.ref, sessionId: "other-session" },
        }),
      );
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c-ref",
        result: { ok: false, reason: "ref_mismatch" },
      });
      send(helper, "c-ok", "check", checkPayload(held.scope));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c-ok",
        result: { ok: true, ref: held.scope.ref, traceId: held.scope.traceId },
      });

      expect(held.runtime.stopActiveForegroundExecution()).toMatchObject({ kind: "stopped" });
      const revocation = await frames.next();
      expect(revocation.result).toMatchObject({
        ok: true,
        projection: { status: "revoked", revocationReason: "user-stop" },
      });
      helper.end();
      await expect(session.waitForClose()).resolves.toMatchObject({
        reason: "owner-revoked",
        ownerRevoked: true,
        revocationForwarded: true,
        authorityRevoke: "revoked",
        transportClosed: true,
        cleanupPending: false,
      });
      await expect(frames.next(100)).rejects.toThrow("stream ended");
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("treats normal scope close as EOF only and never revokes the lineage", async () => {
    const held = await startHeldTurn("native-close", "native-close-a");
    const { helper, frames, session } = openSession(held.scope);
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      held.scope.close();
      await new Promise((resolve) => helper.once("end", resolve));
      helper.end();
      await expect(session.waitForClose()).resolves.toMatchObject({
        reason: "scope-closed",
        ownerRevoked: false,
        revocationForwarded: false,
        authorityRevoke: "not-requested",
        transportClosed: true,
        cleanupPending: false,
      });
      expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({ status: "candidate" });
      const terminal = await startHeldTurn("native-terminal-scope", "native-terminal-scope-a");
      terminal.scope.close();
      const closedSession = openSession(terminal.scope);
      await new Promise((resolve) => closedSession.helper.once("end", resolve));
      closedSession.helper.end();
      await expect(closedSession.session.waitForClose()).resolves.toMatchObject({
        reason: "scope-closed",
        ownerRevoked: false,
        authorityRevoke: "not-requested",
      });
      expect(closedSession.host.listenerCount("data")).toBe(0);
      expect(closedSession.host.listenerCount("close")).toBe(0);
      await finishHeldTurn(terminal);
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("revokes on transport failures with a bound frame budget", async () => {
    const failures: Array<[string, string, (stream: Duplex) => void]> = [
      ["eof", "eof", (stream) => stream.end()],
      ["json", "protocol-error", (stream) => stream.write("{not-json}\n")],
      ["method", "protocol-error", (stream) => send(stream, "m", "unknown", {})],
    ];
    for (const [key, reason, write] of failures) {
      const held = await startHeldTurn(`native-${key}`, `native-${key}-a`);
      const opened = openSession(held.scope);
      try {
        send(opened.helper, "b", "bootstrap", {});
        await opened.frames.next();
        write(opened.helper);
        await expect(opened.session.waitForClose()).resolves.toMatchObject({
          reason,
          ownerRevoked: true,
          authorityRevoke: "revoked",
        });
        expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
          status: "revoked",
          revocationReason: "control-lost",
        });
      } finally {
        await finishHeldTurn(held);
      }
    }
    const bounded = await startHeldTurn("native-bounds", "native-bounds-a");
    const boundedSession = openSession(bounded.scope, { maxFrameBytes: 128 });
    try {
      boundedSession.helper.write("x".repeat(256));
      await expect(boundedSession.session.waitForClose()).resolves.toMatchObject({
        reason: "protocol-error",
        ownerRevoked: true,
        authorityRevoke: "revoked",
        transportClosed: true,
        cleanupPending: false,
      });
      expect(boundedSession.session.diagnostics.lastFailure).toBe("frame_too_large");
      expect(bounded.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "control-lost",
      });
    } finally {
      await finishHeldTurn(bounded);
    }
  });

  it("keeps a successful revocation receipt when owner stop races an explicit revoke", async () => {
    const held = await startHeldTurn("native-race", "native-race-a");
    const { helper, frames, session } = openSession(held.scope);
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      send(helper, "r1", "revoke", { traceId: held.scope.traceId, ref: held.scope.ref });
      held.runtime.stopActiveForegroundExecution();
      const seen = [await frames.next(), await frames.next(1_000).catch(() => undefined)];
      expect(
        seen.some(
          (frame) =>
            frame?.method === "revoked" ||
            (frame?.method === "revoke" &&
              frame.result?.ok === true &&
              frame.result.revocation?.status === "revoked"),
        ),
      ).toBe(true);
      helper.end();
      await expect(session.waitForClose()).resolves.toMatchObject({ ownerRevoked: true });
    } finally {
      await finishHeldTurn(held);
    }
  });

  it("accepts one captureResult while live and closes the consumer normally", async () => {
    const held = await startHeldTurn("native-capture", "native-capture-a");
    const fixture = await createCaptureFixture();
    let accepted: Record<string, unknown> | undefined;
    const imageResult = {
      content: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
    };
    const { helper, frames, session } = openSession(held.scope, {
      capture: {
        root: fixture.root,
        target: { pid: 321, windowId: 654 },
        accept: async (payload: Record<string, unknown>) => {
          accepted = payload;
          return imageResult;
        },
      },
    });
    try {
      send(helper, "target-injection", "bootstrap", { target: { pid: 321, windowId: 654 } });
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "target-injection",
        result: { ok: false, reason: "invalid_payload" },
      });
      send(helper, "b", "bootstrap", {});
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "b",
        result: {
          ok: true,
          target: { pid: 321, windowId: 654 },
        },
      });

      send(
        helper,
        "capture-1",
        "captureResult",
        capturePayload(held.scope, fixture, { pid: 321, windowId: 654 }),
      );
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "capture-1",
        result: { ok: true, accepted: true },
      });
      expect(accepted).toMatchObject({
        target: { pid: 321, windowId: 654 },
        png: { width: 2400, height: 1600 },
      });
      await expect(session.waitForClose()).resolves.toMatchObject({
        reason: "adapter-close",
        ownerRevoked: false,
        revocationForwarded: false,
        authorityRevoke: "not-requested",
        nativeFence: "unknown",
        stopComplete: false,
      });
      expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
      });
      expect(imageResult.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    } finally {
      await fixture.cleanup();
      await finishHeldTurn(held);
    }
  });

  it("rejects captureResult binding mismatches and terminal scopes without revoking", async () => {
    const held = await startHeldTurn("native-capture-reject", "native-capture-reject-a");
    const fixture = await createCaptureFixture();
    let acceptCalls = 0;
    const { helper, frames, session } = openSession(held.scope, {
      capture: {
        root: fixture.root,
        target: { pid: 321, windowId: 654 },
        accept: async () => {
          acceptCalls += 1;
          return { content: [] };
        },
      },
    });
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      send(helper, "capture-bad", "captureResult", {
        ref: { ...held.scope.ref, sessionId: "spoofed-session" },
        traceId: held.scope.traceId,
        producerIncarnation: PRODUCER,
        runId: held.scope.runId,
        turnId: held.scope.turnId,
        target: { pid: 321, windowId: 654 },
        png: fixture.png,
        resourcesReleased: true,
        machineLeaseReleased: true,
      });
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "capture-bad",
        result: { ok: false, reason: "ref_mismatch" },
      });
      session.close();
      await expect(session.waitForClose()).resolves.toMatchObject({
        reason: "adapter-close",
        ownerRevoked: false,
        authorityRevoke: "not-requested",
      });
      expect(acceptCalls).toBe(0);
      expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
      });
    } finally {
      await fixture.cleanup();
      await finishHeldTurn(held);
    }
  });
});
