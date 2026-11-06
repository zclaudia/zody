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
} from "@zody/contracts";
import { AgentRuntime, type AgentRuntimeDeps } from "@zody/core";
import { describe, expect, it } from "vitest";
import {
  CUA_NATIVE_AUTHORITY_CONFIRM_TARGET_MAX_STRING_BYTES,
  parseCuaNativeAuthorityRequest,
  readCuaNativeConfirmRequestPayload,
} from "../src/mcp/cua-native-authority-contract.js";
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

const CONFIRM_TARGET = {
  pid: 321,
  windowId: 654,
  layer: 0,
  x: 12,
  y: 34,
  width: 1280,
  height: 800,
  ownerName: "Safari",
  windowName: "Zody CUA Spec",
};

function confirmPayload(
  scope: HeldTurn["scope"],
  generation = 1,
  patch: Record<string, unknown> = {},
) {
  return {
    ref: scope.ref,
    traceId: scope.traceId,
    producerIncarnation: PRODUCER,
    runId: scope.runId,
    turnId: scope.turnId,
    generation,
    target: { ...CONFIRM_TARGET },
    ...patch,
  };
}

function inertCapture() {
  return {
    root: "/tmp/zody-cua-confirm-inert",
    target: { pid: CONFIRM_TARGET.pid, windowId: CONFIRM_TARGET.windowId },
    accept: async () => ({ content: [] }),
  };
}

describe("CuaNativeAuthority confirm contract", () => {
  it("parses a confirm method frame and its payload", () => {
    const frame = parseCuaNativeAuthorityRequest(
      JSON.stringify({
        requestId: "confirm-parse",
        method: "confirm",
        payload: confirmPayload(
          {
            ref: {
              submissionLineageId: "lineage",
              authorizationRevision: 1,
              appIncarnation: "app",
              hostInstanceId: "host",
              runtimeInstanceId: "runtime",
              sessionId: "session",
              workspaceKey: "/workspace",
            },
            traceId: "trace",
            runId: "run",
            turnId: "turn",
          } as never,
          7,
        ),
      }),
    );
    expect(frame).toMatchObject({ ok: true, frame: { method: "confirm" } });
    if (!frame.ok) throw new Error("expected confirm frame to parse");
    const payload = readCuaNativeConfirmRequestPayload(frame.frame.payload);
    expect(payload).toEqual({ generation: 7, target: CONFIRM_TARGET });
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("accepts target strings at the exact 128-character bound", () => {
    const payload = readCuaNativeConfirmRequestPayload(
      confirmPayload({ ref: {}, traceId: "t", runId: "r", turnId: "turn" } as never, 1, {
        target: {
          ...CONFIRM_TARGET,
          ownerName: "a".repeat(CUA_NATIVE_AUTHORITY_CONFIRM_TARGET_MAX_STRING_BYTES),
          windowName: "b".repeat(CUA_NATIVE_AUTHORITY_CONFIRM_TARGET_MAX_STRING_BYTES),
        },
      }),
    );
    expect(payload?.generation).toBe(1);
  });

  it("accepts fractional CGRect coordinates and empty window names", () => {
    // native target 直接来自 CGRect（double），安全整数约束会拒掉真实窗口。
    const payload = readCuaNativeConfirmRequestPayload(
      confirmPayload({ ref: {}, traceId: "t", runId: "r", turnId: "turn" } as never, 1, {
        target: {
          ...CONFIRM_TARGET,
          x: 12.5,
          y: -34.25,
          width: 1280.75,
          height: 800.5,
          // 无标题窗口 ownerName/windowName 可以是空串；UI 按缺失行处理。
          ownerName: "",
          windowName: "",
        },
      }),
    );
    expect(payload?.target).toMatchObject({
      x: 12.5,
      y: -34.25,
      width: 1280.75,
      height: 800.5,
      ownerName: "",
      windowName: "",
    });
  });

  it("accepts UTF-8 window names counted by bytes", () => {
    const ownerName = "文本编辑";
    const windowName = "未命名";
    const payload = readCuaNativeConfirmRequestPayload(
      confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, ownerName, windowName } }),
    );
    expect(payload?.target).toMatchObject({ ownerName, windowName });
    // 字节上限仍是 128：42 个 3 字节汉字 = 126 字节可接受，43 个 = 129 字节拒绝。
    expect(
      readCuaNativeConfirmRequestPayload(
        confirmPayload({} as never, 1, {
          target: { ...CONFIRM_TARGET, windowName: "窗".repeat(42) },
        }),
      )?.target.windowName,
    ).toBe("窗".repeat(42));
    expect(
      readCuaNativeConfirmRequestPayload(
        confirmPayload({} as never, 1, {
          target: { ...CONFIRM_TARGET, windowName: "窗".repeat(43) },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects malformed confirm payloads", () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["zero generation", confirmPayload({} as never, 0)],
      ["negative generation", confirmPayload({} as never, -1)],
      ["fractional generation", confirmPayload({} as never, 1.5)],
      ["unknown payload field", confirmPayload({} as never, 1, { extra: true })],
      ["missing generation", { ...confirmPayload({} as never, 1), generation: undefined }],
      [
        "unknown target field",
        confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, extra: true } }),
      ],
      ["missing target field", confirmPayload({} as never, 1, { target: undefined })],
      [
        "oversized ownerName",
        confirmPayload({} as never, 1, {
          target: {
            ...CONFIRM_TARGET,
            ownerName: "a".repeat(CUA_NATIVE_AUTHORITY_CONFIRM_TARGET_MAX_STRING_BYTES + 1),
          },
        }),
      ],
      [
        "oversized windowName",
        confirmPayload({} as never, 1, {
          target: {
            ...CONFIRM_TARGET,
            windowName: "b".repeat(CUA_NATIVE_AUTHORITY_CONFIRM_TARGET_MAX_STRING_BYTES + 1),
          },
        }),
      ],
      [
        "non-string ownerName",
        confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, ownerName: 7 } }),
      ],
      [
        "oversized UTF-8 windowName",
        confirmPayload({} as never, 1, {
          target: { ...CONFIRM_TARGET, windowName: "窗".repeat(43) },
        }),
      ],
      [
        "non-integer pid",
        confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, pid: 1.5 } }),
      ],
      [
        "negative windowId",
        confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, windowId: -2 } }),
      ],
      [
        "non-integer layer",
        confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, layer: 0.5 } }),
      ],
      ["non-number x", confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, x: "3" } })],
      [
        "non-finite height",
        confirmPayload({} as never, 1, {
          target: { ...CONFIRM_TARGET, height: Number.POSITIVE_INFINITY },
        }),
      ],
      [
        "non-positive width",
        confirmPayload({} as never, 1, { target: { ...CONFIRM_TARGET, width: 0 } }),
      ],
    ];
    for (const [name, payload] of invalid) {
      expect(readCuaNativeConfirmRequestPayload(payload), name).toBeUndefined();
    }
  });
});

describe("CuaNativeAuthoritySession confirm", () => {
  it("rejects confirm before bootstrap and never asks the user", async () => {
    const held = await startHeldTurn("native-confirm-bootstrap", "native-confirm-bootstrap-a");
    let confirmCalls = 0;
    const { helper, frames } = openSession(held.scope, {
      confirmRequest: async () => {
        confirmCalls += 1;
        return { allowed: true };
      },
    });
    try {
      send(helper, "c0", "confirm", confirmPayload(held.scope));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c0",
        method: "confirm",
        result: { ok: false, reason: "not_bootstrapped" },
      });
      expect(confirmCalls).toBe(0);
    } finally {
      await finishHeldTurn(held);
      helper.destroy();
    }
  });

  it("rejects association mismatches with confirmation-invalid", async () => {
    const held = await startHeldTurn("native-confirm-assoc", "native-confirm-assoc-a");
    let confirmCalls = 0;
    const { helper, frames } = openSession(held.scope, {
      capture: inertCapture(),
      confirmRequest: async () => {
        confirmCalls += 1;
        return { allowed: true };
      },
    });
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      send(helper, "c-turn", "confirm", confirmPayload(held.scope, 1, { turnId: "other-turn" }));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c-turn",
        result: { ok: false, reason: "confirmation-invalid" },
      });
      send(
        helper,
        "c-ref",
        "confirm",
        confirmPayload(held.scope, 1, {
          ref: { ...held.scope.ref, sessionId: "other-session" },
        }),
      );
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c-ref",
        result: { ok: false, reason: "confirmation-invalid" },
      });
      send(
        helper,
        "c-prod",
        "confirm",
        confirmPayload(held.scope, 1, { producerIncarnation: "p2" }),
      );
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c-prod",
        result: { ok: false, reason: "confirmation-invalid" },
      });
      expect(confirmCalls).toBe(0);
    } finally {
      await finishHeldTurn(held);
      helper.destroy();
    }
  });

  it("rejects duplicate generations without a second user prompt", async () => {
    const held = await startHeldTurn("native-confirm-dup", "native-confirm-dup-a");
    let confirmCalls = 0;
    const { helper, frames, session } = openSession(held.scope, {
      capture: inertCapture(),
      confirmRequest: async () => {
        confirmCalls += 1;
        return { allowed: true };
      },
    });
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      send(helper, "c1", "confirm", confirmPayload(held.scope, 3));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c1",
        method: "confirm",
        result: { ok: true, allowed: true },
      });
      send(helper, "c1-again", "confirm", confirmPayload(held.scope, 3));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c1-again",
        result: { ok: false, reason: "confirmation-duplicate" },
      });
      expect(confirmCalls).toBe(1);
      session.close();
    } finally {
      await finishHeldTurn(held);
      helper.destroy();
    }
  });

  it("writes the allowed true and false outcomes verbatim", async () => {
    const held = await startHeldTurn("native-confirm-outcome", "native-confirm-outcome-a");
    const { helper, frames, session } = openSession(held.scope, {
      capture: inertCapture(),
      confirmRequest: async (payload: { generation: number }) => ({
        allowed: payload.generation % 2 === 1,
      }),
    });
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      send(helper, "allow-me", "confirm", confirmPayload(held.scope, 1));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "allow-me",
        method: "confirm",
        result: { ok: true, allowed: true },
      });
      send(helper, "deny-me", "confirm", confirmPayload(held.scope, 2));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "deny-me",
        method: "confirm",
        result: { ok: true, allowed: false },
      });
      session.close();
    } finally {
      await finishHeldTurn(held);
      helper.destroy();
    }
  });

  it("maps contract failure outcomes to ok:false with the runtime reason", async () => {
    const held = await startHeldTurn("native-confirm-outcome-fail", "native-confirm-outcome-fail-a");
    const { helper, frames, session } = openSession(held.scope, {
      capture: inertCapture(),
      confirmRequest: async (payload: { generation: number }) =>
        payload.generation === 1
          ? { ok: false, reason: "confirmation-invalid" }
          : { ok: false, reason: "confirmation-unavailable" },
    });
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      send(helper, "invalid-me", "confirm", confirmPayload(held.scope, 1));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "invalid-me",
        method: "confirm",
        result: { ok: false, reason: "confirmation-invalid" },
      });
      send(helper, "unavailable-me", "confirm", confirmPayload(held.scope, 2));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "unavailable-me",
        method: "confirm",
        result: { ok: false, reason: "confirmation-unavailable" },
      });
      session.close();
    } finally {
      await finishHeldTurn(held);
      helper.destroy();
    }
  });

  it("maps a confirmRequest failure to ok:false confirmation-failed", async () => {
    const held = await startHeldTurn("native-confirm-fail", "native-confirm-fail-a");
    const { helper, frames, session } = openSession(held.scope, {
      capture: inertCapture(),
      confirmRequest: async () => {
        throw new Error("broker_unavailable");
      },
    });
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      send(helper, "c-fail", "confirm", confirmPayload(held.scope, 1));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "c-fail",
        method: "confirm",
        result: { ok: false, reason: "confirmation-failed" },
      });
      // 会话必须保持可用：失败的确认不能拖垮后续帧处理。
      send(helper, "check-after", "check", checkPayload(held.scope));
      await expect(frames.next()).resolves.toMatchObject({
        requestId: "check-after",
        result: { ok: true },
      });
      session.close();
    } finally {
      await finishHeldTurn(held);
      helper.destroy();
    }
  });

  it("answers confirmation-unavailable without capture composition or confirmRequest", async () => {
    const held = await startHeldTurn("native-confirm-missing", "native-confirm-missing-a");
    const plain = openSession(held.scope);
    const noRequest = openSession(held.scope, { capture: inertCapture() });
    try {
      send(plain.helper, "b", "bootstrap", {});
      await plain.frames.next();
      send(plain.helper, "c-plain", "confirm", confirmPayload(held.scope));
      await expect(plain.frames.next()).resolves.toMatchObject({
        requestId: "c-plain",
        result: { ok: false, reason: "confirmation-unavailable" },
      });

      send(noRequest.helper, "b", "bootstrap", {});
      await noRequest.frames.next();
      send(noRequest.helper, "c-noreq", "confirm", confirmPayload(held.scope));
      await expect(noRequest.frames.next()).resolves.toMatchObject({
        requestId: "c-noreq",
        result: { ok: false, reason: "confirmation-unavailable" },
      });
      plain.session.close();
      noRequest.session.close();
    } finally {
      await finishHeldTurn(held);
      plain.helper.destroy();
      noRequest.helper.destroy();
    }
  });

  it("does not revive an invalidated session with a late confirm frame", async () => {
    const held = await startHeldTurn("native-confirm-late", "native-confirm-late-a");
    let confirmCalls = 0;
    const { helper, frames, session } = openSession(held.scope, {
      capture: inertCapture(),
      confirmRequest: async () => {
        confirmCalls += 1;
        return { allowed: true };
      },
    });
    try {
      send(helper, "b", "bootstrap", {});
      await frames.next();
      expect(held.runtime.stopActiveForegroundExecution()).toMatchObject({ kind: "stopped" });
      await session.waitForClose();
      send(helper, "c-late", "confirm", confirmPayload(held.scope, 1));
      await new Promise((resolve) => setImmediate(resolve));
      expect(confirmCalls).toBe(0);
      expect(session.diagnostics.invalidated).toBe(true);
    } finally {
      await finishHeldTurn(held);
      helper.destroy();
    }
  });
});
