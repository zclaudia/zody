import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair, type Duplex } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { CuaSubmissionTurnScope, ImageProcessorPort, Logger } from "@zody/contracts";
import type { AgentRuntime } from "@zody/core";
import {
  captureCuaRuntimeOnce,
  createCuaNativeCaptureToolResult,
} from "../src/app/cua-runtime-native-capture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pngBytes(width = 2400, height = 1600): Buffer {
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

async function captureFixture() {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-app-capture-"));
  roots.push(root);
  await chmod(root, 0o700);
  const bytes = pngBytes();
  const path = join(root, "capture.png");
  await writeFile(path, bytes);
  return {
    root,
    path,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function createScope(): CuaSubmissionTurnScope & {
  closed: boolean;
  candidate: boolean;
  invalidate(reason: "owner-revoked" | "scope-closed"): void;
} {
  const listeners = new Set<(reason: "owner-revoked" | "scope-closed") => void>();
  let terminalReason: "owner-revoked" | "scope-closed" | undefined;
  const scope = {
    ref: {
      submissionLineageId: "lineage-app-capture",
      authorizationRevision: 1,
      appIncarnation: "app-app-capture",
      hostInstanceId: "host-app-capture",
      runtimeInstanceId: "runtime-app-capture",
      sessionId: "session-app-capture",
      workspaceKey: "/workspace/app-capture",
    },
    traceId: "trace-app-capture",
    runId: "run-app-capture",
    turnId: "turn-app-capture",
    candidate: true,
    closed: false,
    producerPort: {
      async resolve() {
        return scope.candidate
          ? {
              status: "candidate",
              ref: scope.ref,
              nativeFence: "unknown",
              mobileDelivery: "unknown",
            }
          : { status: "unknown", nativeFence: "unknown", mobileDelivery: "unknown" };
      },
      async revoke() {
        return {
          status: "unknown",
          projection: { status: "unknown", nativeFence: "unknown", mobileDelivery: "unknown" },
        };
      },
    },
    bindProducer() {
      return !scope.closed;
    },
    onInvalidated(listener: (reason: "owner-revoked" | "scope-closed") => void) {
      if (terminalReason) listener(terminalReason);
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      scope.invalidate("scope-closed");
    },
    invalidate(reason: "owner-revoked" | "scope-closed") {
      if (terminalReason) return;
      terminalReason = reason;
      scope.closed = true;
      listeners.forEach((listener) => listener(reason));
      listeners.clear();
    },
  } as unknown as CuaSubmissionTurnScope & {
    closed: boolean;
    candidate: boolean;
    invalidate(reason: "owner-revoked" | "scope-closed"): void;
  };
  return scope;
}

function fakeRuntime(scope: CuaSubmissionTurnScope) {
  let projection: "candidate" | "revoked" | "unknown" = "candidate";
  let projectionRef = scope.ref;
  let activeTurnId: string | undefined = scope.turnId;
  const runtime = {
    createCuaSubmissionTurnScope: () => scope,
    getActiveTurnInfo: () =>
      activeTurnId === undefined
        ? undefined
        : { kind: "regular" as const, queueLength: 0, steerable: true, turnId: activeTurnId },
    getCuaSubmissionProjection: () =>
      projection === "candidate"
        ? {
            status: "candidate",
            ref: projectionRef,
            nativeFence: "unknown",
            mobileDelivery: "unknown",
          }
        : projection === "revoked"
          ? {
              status: "revoked",
              ref: { ...scope.ref, authorizationRevision: scope.ref.authorizationRevision + 1 },
              revocationReason: "user-stop",
              nativeFence: "unknown",
              mobileDelivery: "unknown",
            }
          : { status: "unknown", nativeFence: "unknown", mobileDelivery: "unknown" },
  } as unknown as AgentRuntime;
  return {
    runtime,
    revoke() {
      projection = "revoked";
    },
    unknown() {
      projection = "unknown";
    },
    supersede() {
      projection = "candidate";
      projectionRef = { ...scope.ref, submissionLineageId: "lineage-superseded" };
    },
    bumpRevision() {
      projection = "candidate";
      projectionRef = {
        ...scope.ref,
        authorizationRevision: scope.ref.authorizationRevision + 1,
      };
    },
    changeTurn(turnId: string | undefined) {
      activeTurnId = turnId;
    },
  };
}

function imageProcessor(): ImageProcessorPort {
  return {
    async resizeToFit(request) {
      return { data: request.data, mediaType: request.mediaType, resized: false };
    },
    async prepareForModel(request) {
      return {
        data: request.data,
        mediaType: request.mediaType,
        resized: false,
        compressed: false,
        originalSizeBytes: request.data.byteLength,
        transformedSizeBytes: request.data.byteLength,
        strategy: "original",
      };
    },
  };
}

function send(stream: Duplex, requestId: string, method: string, payload: object): void {
  stream.write(`${JSON.stringify({ requestId, method, payload })}\n`);
}

describe("captureCuaRuntimeOnce", () => {
  it("returns the real image result only after accepted and closes normally", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const [host, helper] = duplexPair();
    const lines = createInterface({ input: helper });
    const frames: Record<string, any>[] = [];
    lines.on("line", (line) => frames.push(JSON.parse(line) as Record<string, any>));
    const deliveries: Array<Record<string, unknown>> = [];
    const logger: Pick<Logger, "info"> = {
      info(_message, context) {
        deliveries.push(context ?? {});
        // 观测失败必须被吸收，不能改变已确认的截图交付。
        throw new Error("logger unavailable");
      },
    };

    const pending = captureCuaRuntimeOnce(fakeRuntime(scope).runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      logger,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(helper, "bootstrap-app", "bootstrap", {});
    await expect.poll(() => frames.some((frame) => frame.requestId === "bootstrap-app")).toBe(true);
    const bootstrap = frames.find((frame) => frame.requestId === "bootstrap-app");
    expect(bootstrap?.result).toMatchObject({ ok: true, target: { pid: 42, windowId: 99 } });

    expect(frames.some((frame) => frame.requestId === "capture-app")).toBe(false);
    send(helper, "capture-app", "captureResult", {
      ref: scope.ref,
      traceId: scope.traceId,
      producerIncarnation: "producer-app-capture",
      runId: scope.runId,
      turnId: scope.turnId,
      target: { pid: 42, windowId: 99 },
      png: {
        path: fixture.path,
        sha256: fixture.sha256,
        width: 2400,
        height: 1600,
        bytes: fixture.bytes.byteLength,
      },
      resourcesReleased: true,
      machineLeaseReleased: true,
    });

    await expect(pending).resolves.toMatchObject({
      content: [{ type: "image", mimeType: "image/png" }],
    });
    expect(deliveries).toEqual([
      expect.objectContaining({
        event: "cua.native_capture.delivered",
        sessionId: scope.ref.sessionId,
        submissionLineageId: scope.ref.submissionLineageId,
        authorizationRevision: scope.ref.authorizationRevision,
        turnId: scope.turnId,
        pngSha256: fixture.sha256,
        width: 2400,
        height: 1600,
        bytes: fixture.bytes.byteLength,
        resourcesReleased: true,
        machineLeaseReleased: true,
      }),
    ]);
    expect(JSON.stringify(deliveries)).not.toContain(fixture.root);
    expect(scope.closed).toBe(true);
    expect(frames.find((frame) => frame.requestId === "capture-app")?.result).toMatchObject({
      ok: true,
      accepted: true,
    });
    helper.destroy();
  });

  it("captures the original scope before connect and never adopts a later turn", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    let createCalls = 0;
    let resolveConnect!: (stream: Duplex) => void;
    const connected = new Promise<Duplex>((resolve) => {
      resolveConnect = resolve;
    });
    const [host, helper] = duplexPair();
    const runtime = {
      createCuaSubmissionTurnScope: () => {
        createCalls += 1;
        return scope;
      },
      getCuaSubmissionProjection: () => ({
        status: "candidate",
        ref: scope.ref,
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      }),
    } as unknown as AgentRuntime;
    const pending = captureCuaRuntimeOnce(runtime, {
      connect: () => connected,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    await expect.poll(() => createCalls).toBe(1);
    scope.invalidate("owner-revoked");
    resolveConnect(host);
    await expect(pending).rejects.toThrow("owner_revoked");
    expect(createCalls).toBe(1);
    expect(scope.closed).toBe(true);
    helper.destroy();
  });

  it("closes the captured scope when connect fails", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    await expect(
      captureCuaRuntimeOnce(fakeRuntime(scope).runtime, {
        connect: async () => {
          throw new Error("connect_failed");
        },
        producerIncarnation: "producer-app-capture",
        captureRoot: fixture.root,
        target: { pid: 42, windowId: 99 },
        imageProcessorPort: imageProcessor(),
      }),
    ).rejects.toThrow("connect_failed");
    expect(scope.closed).toBe(true);
  });

  it("rejects when the broker expectation does not match the live turn scope", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    let connects = 0;
    await expect(
      captureCuaRuntimeOnce(fakeRuntime(scope).runtime, {
        connect: async () => {
          connects += 1;
          throw new Error("must_not_connect");
        },
        producerIncarnation: "producer-app-capture",
        captureRoot: fixture.root,
        target: { pid: 42, windowId: 99 },
        imageProcessorPort: imageProcessor(),
        expected: {
          sessionId: scope.ref.sessionId,
          workspaceKey: scope.ref.workspaceKey,
          turnId: "turn-other",
        },
      }),
    ).rejects.toThrow("scope_mismatch");
    expect(connects).toBe(0);
    expect(scope.closed).toBe(true);
  });

  it("rejects a result when abort or owner stop lands during post-accept cleanup", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const control = fakeRuntime(scope);
    const [host, helper] = duplexPair();
    const frames: Record<string, any>[] = [];
    createInterface({ input: helper }).on("line", (line) => {
      const frame = JSON.parse(line) as Record<string, any>;
      frames.push(frame);
      if (frame.requestId === "capture-abort" && frame.result?.accepted === true) {
        controller.abort();
      }
      if (frame.requestId === "capture-stop" && frame.result?.accepted === true) {
        control.revoke();
      }
    });
    const controller = new AbortController();
    const pendingAbort = captureCuaRuntimeOnce(control.runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
      signal: controller.signal,
    });
    send(helper, "bootstrap-abort", "bootstrap", {});
    sendCapture(helper, "capture-abort", scope, fixture);
    await expect(pendingAbort).rejects.toMatchObject({ name: "AbortError" });
    helper.destroy();

    const stopScope = createScope();
    const stopControl = fakeRuntime(stopScope);
    const [stopHost, stopHelper] = duplexPair();
    createInterface({ input: stopHelper }).on("line", (line) => {
      const frame = JSON.parse(line) as Record<string, any>;
      if (frame.requestId === "capture-stop" && frame.result?.accepted === true) {
        stopControl.revoke();
      }
    });
    const pendingStop = captureCuaRuntimeOnce(stopControl.runtime, {
      connect: async () => stopHost,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(stopHelper, "bootstrap-stop", "bootstrap", {});
    sendCapture(stopHelper, "capture-stop", stopScope, fixture);
    await expect(pendingStop).rejects.toThrow("owner_revoked");
    stopHelper.destroy();
  });

  it("rejects a late image when a new submission supersedes the original scope during close", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const control = fakeRuntime(scope);
    const [host, helper] = duplexPair();
    createInterface({ input: helper }).on("line", (line) => {
      const frame = JSON.parse(line) as Record<string, any>;
      if (frame.requestId === "capture-supersede" && frame.result?.accepted === true) {
        control.supersede();
      }
    });

    const pending = captureCuaRuntimeOnce(control.runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(helper, "bootstrap-supersede", "bootstrap", {});
    sendCapture(helper, "capture-supersede", scope, fixture);

    await expect(pending).rejects.toThrow("scope_superseded");
    helper.destroy();
  });

  it("rejects a late image when the original ref revision is superseded", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const control = fakeRuntime(scope);
    const [host, helper] = duplexPair();
    createInterface({ input: helper }).on("line", (line) => {
      const frame = JSON.parse(line) as Record<string, any>;
      if (frame.requestId === "capture-revision" && frame.result?.accepted === true) {
        control.bumpRevision();
      }
    });

    const pending = captureCuaRuntimeOnce(control.runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(helper, "bootstrap-revision", "bootstrap", {});
    sendCapture(helper, "capture-revision", scope, fixture);

    await expect(pending).rejects.toThrow("scope_superseded");
    helper.destroy();
  });

  it("rejects a late image when the original turn is no longer active", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const control = fakeRuntime(scope);
    const [host, helper] = duplexPair();
    createInterface({ input: helper }).on("line", (line) => {
      const frame = JSON.parse(line) as Record<string, any>;
      if (frame.requestId === "capture-turn" && frame.result?.accepted === true) {
        control.changeTurn("turn-next");
      }
    });

    const pending = captureCuaRuntimeOnce(control.runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(helper, "bootstrap-turn", "bootstrap", {});
    sendCapture(helper, "capture-turn", scope, fixture);
    await expect(pending).rejects.toThrow("turn_changed");
    helper.destroy();

    const noTurnScope = createScope();
    const noTurnControl = fakeRuntime(noTurnScope);
    const [noTurnHost, noTurnHelper] = duplexPair();
    createInterface({ input: noTurnHelper }).on("line", (line) => {
      const frame = JSON.parse(line) as Record<string, any>;
      if (frame.requestId === "capture-no-turn" && frame.result?.accepted === true) {
        noTurnControl.changeTurn(undefined);
      }
    });
    const pendingNoTurn = captureCuaRuntimeOnce(noTurnControl.runtime, {
      connect: async () => noTurnHost,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(noTurnHelper, "bootstrap-no-turn", "bootstrap", {});
    sendCapture(noTurnHelper, "capture-no-turn", noTurnScope, fixture);
    await expect(pendingNoTurn).rejects.toThrow("turn_changed");
    noTurnHelper.destroy();
  });
});

describe("createCuaNativeCaptureToolResult", () => {
  it("uses the existing pure-JS model image budget and returns an image block", async () => {
    const bytes = pngBytes(1, 1);
    const result = await createCuaNativeCaptureToolResult({
      payload: {} as never,
      png: bytes,
      imageProcessorPort: imageProcessor(),
    });
    expect(result.content[0]).toMatchObject({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("fails closed without an image processor", async () => {
    await expect(
      createCuaNativeCaptureToolResult({ payload: {} as never, png: pngBytes(1, 1) }),
    ).rejects.toThrow("image_processor_unavailable");
  });

  it("preserves the processor's real image MIME and enforces the base64 budget", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const jpegProcessor: ImageProcessorPort = {
      ...imageProcessor(),
      async prepareForModel(request) {
        return {
          data: jpeg,
          mediaType: "image/jpeg",
          resized: false,
          compressed: true,
          originalSizeBytes: request.data.byteLength,
          transformedSizeBytes: jpeg.byteLength,
          strategy: "jpeg-fallback",
        };
      },
    };
    await expect(
      createCuaNativeCaptureToolResult({
        payload: {} as never,
        png: pngBytes(1, 1),
        imageProcessorPort: jpegProcessor,
      }),
    ).resolves.toMatchObject({ content: [{ type: "image", mimeType: "image/jpeg" }] });

    const oversizedProcessor: ImageProcessorPort = {
      ...imageProcessor(),
      async prepareForModel() {
        return {
          data: Buffer.alloc(160 * 1024),
          mediaType: "image/png",
          resized: false,
          compressed: false,
          originalSizeBytes: 1,
          transformedSizeBytes: 160 * 1024,
          strategy: "original",
        };
      },
    };
    await expect(
      createCuaNativeCaptureToolResult({
        payload: {} as never,
        png: pngBytes(1, 1),
        imageProcessorPort: oversizedProcessor,
      }),
    ).rejects.toThrow("over_budget");
  });
});

function sendCapture(
  stream: Duplex,
  requestId: string,
  scope: CuaSubmissionTurnScope,
  fixture: Awaited<ReturnType<typeof captureFixture>>,
): void {
  send(stream, requestId, "captureResult", {
    ref: scope.ref,
    traceId: scope.traceId,
    producerIncarnation: "producer-app-capture",
    runId: scope.runId,
    turnId: scope.turnId,
    target: { pid: 42, windowId: 99 },
    png: {
      path: fixture.path,
      sha256: fixture.sha256,
      width: 2400,
      height: 1600,
      bytes: fixture.bytes.byteLength,
    },
    resourcesReleased: true,
    machineLeaseReleased: true,
  });
}

const CONFIRM_FRAME_TARGET = {
  pid: 42,
  windowId: 99,
  layer: 0,
  x: 10,
  y: 20,
  width: 800,
  height: 600,
  ownerName: "Safari",
  windowName: "Zody Docs",
};

function sendConfirm(stream: Duplex, requestId: string, scope: CuaSubmissionTurnScope, generation: number): void {
  send(stream, requestId, "confirm", {
    ref: scope.ref,
    traceId: scope.traceId,
    producerIncarnation: "producer-app-capture",
    runId: scope.runId,
    turnId: scope.turnId,
    generation,
    target: { ...CONFIRM_FRAME_TARGET },
  });
}

function confirmRuntime(
  scope: CuaSubmissionTurnScope,
  handle: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<
    | { allowed: boolean }
    | { allowed: false; failureReason: "confirmation-invalid" | "confirmation-unavailable" }
  >,
) {
  const base = fakeRuntime(scope);
  const calls: Array<Record<string, unknown>> = [];
  const runtime = {
    ...base.runtime,
    requestCuaNativeCaptureConfirmation: (input: Record<string, unknown>) => {
      calls.push(input);
      return handle(input, input.signal as AbortSignal);
    },
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

describe("captureCuaRuntimeOnce confirmRequest wiring", () => {
  it("forwards confirm frames to the runtime confirmation and maps the answer", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const { runtime, calls } = confirmRuntime(scope, async (input) => ({
      allowed: input.generation === 1,
    }));
    const [host, helper] = duplexPair();
    const frames: Record<string, any>[] = [];
    createInterface({ input: helper }).on("line", (line) => {
      frames.push(JSON.parse(line) as Record<string, any>);
    });

    const pending = captureCuaRuntimeOnce(runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(helper, "bootstrap-confirm", "bootstrap", {});
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "bootstrap-confirm"))
      .toBe(true);
    sendConfirm(helper, "confirm-yes", scope, 1);
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "confirm-yes"))
      .toBe(true);
    expect(frames.find((frame) => frame.requestId === "confirm-yes")?.result).toEqual({
      ok: true,
      allowed: true,
    });
    sendConfirm(helper, "confirm-no", scope, 2);
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "confirm-no"))
      .toBe(true);
    expect(frames.find((frame) => frame.requestId === "confirm-no")?.result).toEqual({
      ok: true,
      allowed: false,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      generation: 1,
      target: { pid: 42, windowId: 99, ownerName: "Safari", windowName: "Zody Docs" },
      sessionId: scope.ref.sessionId,
      workspaceKey: scope.ref.workspaceKey,
      traceId: scope.traceId,
      runId: scope.runId,
      turnId: scope.turnId,
    });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);

    sendCapture(helper, "confirm-capture-done", scope, fixture);
    await expect(pending).resolves.toMatchObject({
      content: [{ type: "image", mimeType: "image/png" }],
    });
    helper.destroy();
  });

  it("forwards runtime failureReason as ok:false instead of allowed:false", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const { runtime } = confirmRuntime(scope, async (input) =>
      input.generation === 1
        ? { allowed: false, failureReason: "confirmation-invalid" }
        : { allowed: false, failureReason: "confirmation-unavailable" },
    );
    const [host, helper] = duplexPair();
    const frames: Record<string, any>[] = [];
    createInterface({ input: helper }).on("line", (line) => {
      frames.push(JSON.parse(line) as Record<string, any>);
    });

    const pending = captureCuaRuntimeOnce(runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(helper, "bootstrap-confirm-fail", "bootstrap", {});
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "bootstrap-confirm-fail"))
      .toBe(true);
    sendConfirm(helper, "confirm-invalid", scope, 1);
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "confirm-invalid"))
      .toBe(true);
    expect(frames.find((frame) => frame.requestId === "confirm-invalid")?.result).toEqual({
      ok: false,
      reason: "confirmation-invalid",
    });
    sendConfirm(helper, "confirm-unavailable", scope, 2);
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "confirm-unavailable"))
      .toBe(true);
    expect(frames.find((frame) => frame.requestId === "confirm-unavailable")?.result).toEqual({
      ok: false,
      reason: "confirmation-unavailable",
    });

    sendCapture(helper, "confirm-fail-capture-done", scope, fixture);
    await expect(pending).resolves.toMatchObject({
      content: [{ type: "image", mimeType: "image/png" }],
    });
    helper.destroy();
  });

  it("cascades the capture abort signal into the pending confirmation", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    const outer = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const { runtime, calls } = confirmRuntime(
      scope,
      (input, signal) =>
        new Promise((_, reject) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );
    const [host, helper] = duplexPair();
    const frames: Record<string, any>[] = [];
    createInterface({ input: helper }).on("line", (line) => {
      frames.push(JSON.parse(line) as Record<string, any>);
    });

    const pending = captureCuaRuntimeOnce(runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
      signal: outer.signal,
    });
    send(helper, "bootstrap-confirm-abort", "bootstrap", {});
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "bootstrap-confirm-abort"))
      .toBe(true);
    sendConfirm(helper, "confirm-abort", scope, 1);
    await expect.poll(() => calls.length).toBe(1);
    outer.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seenSignal?.aborted).toBe(true);
    // 连接关闭中：abort 的确认不写响应帧，Helper 靠 EOF 收口。
    expect(frames.some((frame) => frame.requestId === "confirm-abort")).toBe(false);
    expect(scope.closed).toBe(true);
    helper.destroy();
  });

  it("aborts the confirmation when the capture scope is invalidated", async () => {
    const fixture = await captureFixture();
    const scope = createScope();
    let seenSignal: AbortSignal | undefined;
    const { runtime, calls } = confirmRuntime(
      scope,
      (input, signal) =>
        new Promise((_, reject) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );
    const [host, helper] = duplexPair();
    const frames: Record<string, any>[] = [];
    createInterface({ input: helper }).on("line", (line) => {
      frames.push(JSON.parse(line) as Record<string, any>);
    });

    const pending = captureCuaRuntimeOnce(runtime, {
      connect: async () => host,
      producerIncarnation: "producer-app-capture",
      captureRoot: fixture.root,
      target: { pid: 42, windowId: 99 },
      imageProcessorPort: imageProcessor(),
    });
    send(helper, "bootstrap-confirm-stop", "bootstrap", {});
    await expect
      .poll(() => frames.some((frame) => frame.requestId === "bootstrap-confirm-stop"))
      .toBe(true);
    sendConfirm(helper, "confirm-stop", scope, 1);
    await expect.poll(() => calls.length).toBe(1);
    scope.invalidate("owner-revoked");
    await expect(pending).rejects.toThrow("owner_revoked");
    expect(seenSignal?.aborted).toBe(true);
    expect(frames.some((frame) => frame.requestId === "confirm-stop")).toBe(false);
    helper.destroy();
  });
});
