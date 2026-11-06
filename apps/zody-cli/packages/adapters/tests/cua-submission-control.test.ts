import { appendFile } from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionRevocationResult,
  CuaSubmissionRevokeRequest,
  CuaSubmissionProducerPort,
  CuaSubmissionResolveRequest,
} from "@zody/contracts";
import {
  createCuaSubmissionControlSession,
  unsupportedNativeAckReason,
  type CuaSubmissionControlSession,
} from "../src/mcp/cua-submission-control.js";
import type { ControlOnlyLaunchCommand } from "../src/mcp/control-only-launcher.js";

const childPath = resolve(import.meta.dirname, "fixtures/cua-submission-control-child.mjs");
const waitTimeoutMs = 15_000;

interface TestPortOptions {
  readonly logPath?: string;
  readonly resolutions?: Array<
    CuaSubmissionProjection | ((ref: CuaSubmissionRef) => CuaSubmissionProjection)
  >;
  readonly resolveHook?: (ref: CuaSubmissionRef) => Promise<CuaSubmissionProjection>;
  readonly revokeHook?: (
    request: CuaSubmissionRevokeRequest,
  ) => Promise<CuaSubmissionRevocationResult>;
}

class TestProducerPort implements CuaSubmissionProducerPort {
  readonly resolveCalls: CuaSubmissionRef[] = [];
  readonly revokeCalls: CuaSubmissionRevokeRequest[] = [];
  readonly #options: TestPortOptions;
  #resolveCount = 0;

  constructor(options: TestPortOptions = {}) {
    this.#options = options;
  }

  async resolve(request: CuaSubmissionResolveRequest): Promise<CuaSubmissionProjection> {
    this.resolveCalls.push(copyRef(request.ref));
    if (this.#options.resolveHook) return await this.#options.resolveHook(request.ref);
    const next = this.#options.resolutions?.[this.#resolveCount];
    this.#resolveCount += 1;
    if (next === undefined) return candidate(request.ref);
    return typeof next === "function" ? next(request.ref) : next;
  }

  async revoke(request: CuaSubmissionRevokeRequest): Promise<CuaSubmissionRevocationResult> {
    this.revokeCalls.push({ reason: request.reason, ref: copyRef(request.ref) });
    if (this.#options.logPath) {
      await appendFile(
        this.#options.logPath,
        `${JSON.stringify({ event: "owner-revoke", reason: request.reason })}\n`,
      );
    }
    if (this.#options.revokeHook) return await this.#options.revokeHook(request);
    const ref = copyRef({
      ...request.ref,
      authorizationRevision: request.ref.authorizationRevision + 1,
    });
    return {
      status: "revoked",
      ref,
      revocationReason: request.reason,
      idempotent: false,
      projection: revoked(ref, request.reason),
    };
  }
}

function copyRef(ref: CuaSubmissionRef): CuaSubmissionRef {
  return Object.freeze({ ...ref });
}

function candidate(ref: CuaSubmissionRef): CuaSubmissionProjection {
  return Object.freeze({
    status: "candidate",
    ref: copyRef(ref),
    nativeFence: "unknown",
    mobileDelivery: "unknown",
  });
}

function revoked(
  ref: CuaSubmissionRef,
  revocationReason: CuaSubmissionRevokeRequest["reason"] = "control-lost",
): Extract<CuaSubmissionProjection, { status: "revoked" }> {
  return Object.freeze({
    status: "revoked",
    ref: copyRef(ref),
    revocationReason,
    nativeFence: "unknown",
    mobileDelivery: "unknown",
  });
}

function unknown(): Extract<CuaSubmissionProjection, { status: "unknown" }> {
  return Object.freeze({ status: "unknown", nativeFence: "unknown", mobileDelivery: "unknown" });
}

function testRef(overrides: Partial<CuaSubmissionRef> = {}): CuaSubmissionRef {
  return Object.freeze({
    submissionLineageId: "lineage-control-binding",
    authorizationRevision: 1,
    appIncarnation: "app-control-binding",
    hostInstanceId: "host-control-binding",
    runtimeInstanceId: "runtime-control-binding",
    sessionId: "session-control-binding",
    workspaceKey: "/workspace/control-binding",
    ...overrides,
  });
}

function launch(
  mode: string,
  logPath: string,
  ref: CuaSubmissionRef,
  command = process.execPath,
): ControlOnlyLaunchCommand {
  return {
    args: [childPath, mode, logPath, ref.submissionLineageId, String(ref.authorizationRevision)],
    command,
  };
}

function createSession(
  ref: CuaSubmissionRef,
  port: CuaSubmissionProducerPort,
  launchCommand: ControlOnlyLaunchCommand,
): CuaSubmissionControlSession {
  return createCuaSubmissionControlSession({
    launch: launchCommand,
    producerPort: port,
    ref,
    traceId: "trace-control-binding",
  });
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), waitTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readLog(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForLog(
  path: string,
  predicate: (events: Array<Record<string, unknown>>) => boolean,
  message: string,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const events = await readLog(path);
    if (predicate(events)) return events;
    await new Promise((resolveWake) => setTimeout(resolveWake, 20));
  }
  throw new Error(`${message}: ${JSON.stringify(await readLog(path))}`);
}

describe("CUA submission control binding", () => {
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-cua-control-binding-"));
  });

  afterAll(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it.each([
    [
      "nativeFenced",
      { nativeFenced: true, pending: true, ownedInputsReleased: false, leaseReleased: false },
    ],
    [
      "pending false",
      { nativeFenced: false, pending: false, ownedInputsReleased: false, leaseReleased: false },
    ],
    [
      "ownedInputsReleased",
      { nativeFenced: false, pending: true, ownedInputsReleased: true, leaseReleased: false },
    ],
    [
      "leaseReleased",
      { nativeFenced: false, pending: true, ownedInputsReleased: false, leaseReleased: true },
    ],
  ])("rejects an authenticated stop ACK that elevates %s", (_label, stop) => {
    const result = {
      ack: { body: { phase: "stop_pending", facts: { stop } } },
      evaluation: { stop: { complete: false } },
    } as unknown as Parameters<typeof unsupportedNativeAckReason>[0];
    expect(unsupportedNativeAckReason(result)).not.toBeNull();
  });

  it("accepts only the unknown stop fact tuple false,true,false,false", () => {
    const result = {
      ack: {
        body: {
          phase: "stop_pending",
          facts: {
            stop: {
              nativeFenced: false,
              pending: true,
              ownedInputsReleased: false,
              leaseReleased: false,
            },
          },
        },
      },
      evaluation: { stop: { complete: false } },
    } as unknown as Parameters<typeof unsupportedNativeAckReason>[0];
    expect(unsupportedNativeAckReason(result)).toBeNull();
  });

  it("rejects unknown, revoked, stale, and wrong-app full refs before starting", async () => {
    const ref = testRef();
    const cases = [
      { expected: "ref_unknown", projection: unknown() },
      {
        expected: "ref_revoked",
        projection: revoked(copyRef({ ...ref, authorizationRevision: 2 })),
      },
      {
        expected: "ref_mismatch",
        projection: candidate(copyRef({ ...ref, authorizationRevision: 0 })),
      },
      {
        expected: "ref_mismatch",
        projection: candidate(copyRef({ ...ref, appIncarnation: "wrong-app" })),
      },
    ] as const;
    for (const item of cases) {
      const port = new TestProducerPort({ resolutions: [item.projection] });
      const session = createSession(
        ref,
        port,
        launch("normal", join(directory, `${item.expected}.log`), ref, join(directory, "missing")),
      );
      await expect(session.start()).rejects.toMatchObject({ code: item.expected });
      expect(port.resolveCalls).toEqual([ref]);
    }
  });

  it("re-resolves the complete ref after a real subprocess start and closes on mismatch", async () => {
    const ref = testRef();
    const logPath = join(directory, "post-start-mismatch.log");
    const port = new TestProducerPort({
      resolutions: [(current) => candidate(current), unknown()],
    });
    const session = createSession(ref, port, launch("normal", logPath, ref));
    await expect(
      withTimeout(session.start(), "post-start rejection timed out"),
    ).rejects.toMatchObject({
      code: "ref_unknown",
    });
    const events = await waitForLog(
      logPath,
      (items) => items.some((item) => item.event === "ready"),
      "child did not start",
    );
    expect(events.some((item) => item.event === "control-closed")).toBe(true);
    expect(port.resolveCalls).toEqual([ref, ref]);
    expect(port.revokeCalls).toEqual([{ reason: "control-lost", ref }]);
  });

  it("revokes the original ref when post-start resolution throws", async () => {
    const ref = testRef();
    const logPath = join(directory, "post-start-resolve-error.log");
    let resolveCount = 0;
    const port = new TestProducerPort({
      resolveHook: async (current) => {
        resolveCount += 1;
        if (resolveCount === 2) throw new Error("resolve transport failed");
        return candidate(current);
      },
    });
    const session = createSession(ref, port, launch("normal", logPath, ref));
    await expect(
      withTimeout(session.start(), "post-start resolve error did not settle"),
    ).rejects.toMatchObject({ code: "ref_unknown" });
    expect(port.revokeCalls).toEqual([{ reason: "control-lost", ref }]);
    await waitForLog(
      logPath,
      (events) => events.some((event) => event.event === "control-closed"),
      "post-start resolve failure did not close the child",
    );
    await withTimeout(session.cleanup(), "post-start resolve error cleanup timed out");
  });

  it("auto-cleans an invalidated inbound binding after the ACK retention limit", async () => {
    const ref = testRef();
    const logPath = join(directory, "inbound-auto-cleanup.log");
    const port = new TestProducerPort();
    const session = createCuaSubmissionControlSession({
      launch: launch("reverse-on-ready", logPath, ref),
      producerPort: port,
      ref,
      requestTimeoutMs: 150,
      traceId: "trace-control-binding",
    });
    await withTimeout(session.start(), "reverse binding did not start");
    await waitForLog(
      logPath,
      (events) => events.some((event) => event.event === "reverse-ack"),
      "inbound revoke did not settle",
    );
    expect(session.diagnostics()).toMatchObject({ invalidated: true });
    await waitForLog(
      logPath,
      (events) => events.some((event) => event.event === "control-closed"),
      "inbound binding was not cleaned up automatically",
    );
    await withTimeout(session.cleanup(), "inbound auto cleanup join failed");
  });

  it("auto-cleans after an inbound authority rejection", async () => {
    const ref = testRef();
    const logPath = join(directory, "inbound-authority-reject.log");
    const port = new TestProducerPort({
      resolutions: [(current) => candidate(current), (current) => candidate(current), unknown()],
    });
    const session = createCuaSubmissionControlSession({
      launch: launch("reverse-on-ready", logPath, ref),
      producerPort: port,
      ref,
      requestTimeoutMs: 150,
      traceId: "trace-control-binding",
    });
    await withTimeout(session.start(), "reverse binding did not start");
    await waitForLog(
      logPath,
      (events) =>
        events.some((event) => event.event === "reverse-ack" && event.phase === "rejected"),
      "authority rejection was not returned to the producer",
    );
    expect(session.diagnostics()).toMatchObject({ invalidated: true, lastFailure: "ref_unknown" });
    await waitForLog(
      logPath,
      (events) => events.some((event) => event.event === "control-closed"),
      "authority-rejected inbound binding was not cleaned up",
    );
    await withTimeout(session.cleanup(), "authority rejection cleanup join failed");
  });

  it("admits only one concurrent inbound authority revocation", async () => {
    const ref = testRef();
    const logPath = join(directory, "inbound-single-flight.log");
    let releaseRevoke!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    const port = new TestProducerPort({
      revokeHook: async (request) => {
        if (request.reason === "control-lost") await gate;
        const next = copyRef({
          ...request.ref,
          authorizationRevision: request.ref.authorizationRevision + 1,
        });
        return {
          status: "revoked",
          ref: next,
          revocationReason: request.reason,
          idempotent: false,
          projection: revoked(next, request.reason),
        };
      },
    });
    const session = createSession(ref, port, launch("reverse-duplicate", logPath, ref));
    await withTimeout(session.start(), "duplicate reverse binding did not start");
    await waitForLog(
      logPath,
      (events) =>
        events.some((event) => event.event === "reverse-ack" && event.phase === "rejected"),
      "concurrent inbound request was not rejected",
    );
    expect(port.revokeCalls.filter((call) => call.reason === "control-lost")).toHaveLength(1);
    releaseRevoke();
    await waitForLog(
      logPath,
      (events) => events.filter((event) => event.event === "reverse-ack").length === 2,
      "concurrent inbound requests did not both settle",
    );
    await withTimeout(session.cleanup(), "duplicate inbound cleanup timed out");
  });

  it("forwards owner revocation with the authority revision without duplicating authority state", async () => {
    const ref = testRef();
    const logPath = join(directory, "owner-revocation.log");
    const port = new TestProducerPort();
    const session = createSession(ref, port, launch("normal", logPath, ref));
    await withTimeout(session.start(), "binding did not start");
    session.onOwnerRevocation(revoked(copyRef({ ...ref, authorizationRevision: 2 }), "user-stop"));
    await waitForLog(
      logPath,
      (items) =>
        items.some(
          (item) =>
            item.event === "request" &&
            item.operation === "revoke_submission" &&
            item.authorizationRevision === 2,
        ),
      "owner revocation was not forwarded",
    );
    await withTimeout(session.cleanup(), "owner revocation cleanup timed out");
    expect(port.revokeCalls).toEqual([{ reason: "control-lost", ref }]);
    expect(session.diagnostics()).toMatchObject({
      candidateIsGrant: false,
      executable: false,
      machineLease: "unavailable",
      nativeFence: "unknown",
      stopComplete: false,
      traceId: "trace-control-binding",
    });
  });

  it("revokes the owner before forwarding stop and never reports native completion", async () => {
    const ref = testRef();
    const logPath = join(directory, "stop.log");
    const port = new TestProducerPort({ logPath });
    const session = createSession(ref, port, launch("normal", logPath, ref));
    await withTimeout(session.start(), "binding did not start");
    const result = await withTimeout(session.stop(), "stop timed out");
    expect(result).toMatchObject({
      authorityRevoked: true,
      controlForwarded: true,
      machineLease: "unavailable",
      nativeFence: "unknown",
      stopComplete: false,
    });
    expect(port.revokeCalls).toHaveLength(2);
    expect(port.revokeCalls[0]).toMatchObject({ reason: "user-stop", ref });
    expect(port.revokeCalls[1]).toMatchObject({ reason: "control-lost", ref });
    const events = await waitForLog(
      logPath,
      (items) =>
        items.filter(
          (item) =>
            item.event === "request" &&
            (item.operation === "revoke_submission" || item.operation === "stop") &&
            item.authorizationRevision === 2,
        ).length === 2,
      "revoke and stop were not forwarded",
    );
    const requests = events.filter((item) => item.event === "request");
    expect(requests.map((item) => item.operation)).toEqual(["revoke_submission", "stop"]);
    expect(events.findIndex((item) => item.event === "owner-revoke")).toBeLessThan(
      events.indexOf(requests[0]!),
    );
    await withTimeout(session.cleanup(), "stop cleanup timed out");
  });

  it("accepts only the exact authenticated reverse ref and invalidates after revoking it", async () => {
    const ref = testRef();
    const logPath = join(directory, "reverse-exact.log");
    const port = new TestProducerPort();
    const session = createSession(ref, port, launch("reverse-on-ready", logPath, ref));
    await withTimeout(session.start(), "binding did not start");
    await waitForLog(
      logPath,
      (items) => items.some((item) => item.event === "reverse-ack"),
      "reverse revoke did not settle",
    );
    expect(port.revokeCalls).toHaveLength(1);
    expect(port.revokeCalls[0]).toMatchObject({ reason: "control-lost", ref });
    expect(session.diagnostics()).toMatchObject({ invalidated: true, ownerRevoked: true });
    await withTimeout(session.cleanup(), "reverse cleanup timed out");
  });

  it("rejects an authenticated reverse request for any other lineage or revision", async () => {
    const ref = testRef();
    const logPath = join(directory, "reverse-arbitrary.log");
    const port = new TestProducerPort();
    const session = createSession(ref, port, launch("reverse-arbitrary", logPath, ref));
    await withTimeout(session.start(), "binding did not start");
    const events = await waitForLog(
      logPath,
      (items) => items.some((item) => item.event === "reverse-ack"),
      "arbitrary reverse request did not settle",
    );
    expect(events.find((item) => item.event === "reverse-ack")).toMatchObject({
      phase: "rejected",
    });
    expect(port.revokeCalls).toEqual([]);
    expect(session.diagnostics()).toMatchObject({ invalidated: false, ownerRevoked: false });
    await withTimeout(session.stop(), "stop after arbitrary reverse timed out");
    await withTimeout(session.cleanup(), "arbitrary reverse cleanup timed out");
  });

  it("rejects fenced and native lease claims from an authenticated ACK", async () => {
    const ref = testRef();
    const logPath = join(directory, "fenced-ack.log");
    const port = new TestProducerPort();
    const session = createSession(ref, port, launch("fenced-ack", logPath, ref));
    await withTimeout(session.start(), "binding did not start");
    const result = await withTimeout(session.stop(), "fenced stop timed out");
    expect(result).toMatchObject({
      authorityRevoked: true,
      controlForwarded: false,
      machineLease: "unavailable",
      nativeFence: "unknown",
      stopComplete: false,
    });
    expect(session.diagnostics()).toMatchObject({
      invalidated: true,
      lastFailure: "unsupported_native_ack",
    });
    await withTimeout(session.cleanup(), "fenced cleanup timed out");
  });

  it("requests authority revoke immediately on startup failure before cleanup", async () => {
    const ref = testRef();
    const port = new TestProducerPort();
    const session = createSession(
      ref,
      port,
      launch("normal", join(directory, "startup-failure.log"), ref, join(directory, "missing")),
    );
    await expect(session.start()).rejects.toMatchObject({ code: "control_start_failed" });
    expect(port.revokeCalls).toHaveLength(1);
    expect(port.revokeCalls[0]).toMatchObject({ reason: "control-lost", ref });
    await withTimeout(session.cleanup(), "startup failure cleanup timed out");
  });

  it("closes the owner-revoke/start race and ignores late observers", async () => {
    const ref = testRef();
    let releaseResolve!: () => void;
    let resolveStarted!: () => void;
    const resolveGate = new Promise<void>((release) => {
      releaseResolve = release;
    });
    const started = new Promise<void>((resolveStartedPromise) => {
      resolveStarted = resolveStartedPromise;
    });
    const port = new TestProducerPort({
      resolveHook: async (current) => {
        resolveStarted();
        await resolveGate;
        return candidate(current);
      },
    });
    const session = createSession(
      ref,
      port,
      launch("normal", join(directory, "start-race.log"), ref),
    );
    const starting = session.start();
    await started;
    session.onOwnerRevocation(revoked(copyRef({ ...ref, authorizationRevision: 2 }), "user-stop"));
    releaseResolve();
    await expect(withTimeout(starting, "start race did not settle")).rejects.toMatchObject({
      code: "control_lost",
    });
    await withTimeout(session.cleanup(), "start race cleanup timed out");
    session.onOwnerRevocation(revoked(copyRef({ ...ref, authorizationRevision: 3 }), "user-stop"));
    expect(port.revokeCalls).toEqual([]);
    expect(session.diagnostics()).toMatchObject({
      control: "closed",
      invalidated: true,
      ownerRevoked: true,
    });
  });

  it("cleanup before start latches invalidation, revokes the borrowed ref, and prevents spawn", async () => {
    const ref = testRef();
    const port = new TestProducerPort();
    const session = createSession(
      ref,
      port,
      launch(
        "normal",
        join(directory, "cleanup-before-start.log"),
        ref,
        join(directory, "missing"),
      ),
    );
    await withTimeout(session.cleanup(), "pre-start cleanup timed out");
    await expect(session.start()).rejects.toMatchObject({ code: "control_lost" });
    expect(port.revokeCalls).toHaveLength(1);
    expect(port.revokeCalls[0]).toMatchObject({ reason: "control-lost", ref });
  });

  it("cleanup during startup joins the in-flight start and closes the real child", async () => {
    const ref = testRef();
    const logPath = join(directory, "cleanup-during-start.log");
    let releasePostflight!: () => void;
    let postflightStarted!: () => void;
    const postflightGate = new Promise<void>((release) => {
      releasePostflight = release;
    });
    const postflightReady = new Promise<void>((resolveStarted) => {
      postflightStarted = resolveStarted;
    });
    let resolveCount = 0;
    const port = new TestProducerPort({
      resolveHook: async (current) => {
        resolveCount += 1;
        if (resolveCount === 2) {
          postflightStarted();
          await postflightGate;
        }
        return candidate(current);
      },
    });
    const session = createSession(ref, port, launch("normal", logPath, ref));
    const starting = session.start();
    await postflightReady;
    const cleaning = session.cleanup();
    releasePostflight();
    await expect(withTimeout(starting, "startup did not settle")).rejects.toMatchObject({
      code: "control_lost",
    });
    await withTimeout(cleaning, "cleanup did not join startup");
    const events = await waitForLog(
      logPath,
      (items) => items.some((item) => item.event === "control-closed"),
      "real child was not closed",
    );
    expect(events.some((item) => item.event === "ready")).toBe(true);
    expect(port.revokeCalls).toHaveLength(1);
    expect(port.revokeCalls[0]).toMatchObject({ reason: "control-lost", ref });
  });

  it("stop before start still revokes the borrowed authority ref", async () => {
    const ref = testRef();
    const port = new TestProducerPort();
    const session = createSession(
      ref,
      port,
      launch("normal", join(directory, "stop-before-start.log"), ref),
    );
    const result = await withTimeout(session.stop(), "pre-start stop timed out");
    expect(result).toMatchObject({
      authorityRevoked: true,
      controlForwarded: false,
      nativeFence: "unknown",
      stopComplete: false,
    });
    expect(port.revokeCalls).toHaveLength(1);
    expect(port.revokeCalls[0]).toMatchObject({ reason: "user-stop", ref });
    await withTimeout(session.cleanup(), "pre-start stop cleanup timed out");
  });

  it("does not report stop success when the real child dies during the ACK", async () => {
    const ref = testRef();
    const logPath = join(directory, "loss-during-ack.log");
    const port = new TestProducerPort();
    const session = createSession(ref, port, launch("close-on-request", logPath, ref));
    await withTimeout(session.start(), "binding did not start");
    const result = await withTimeout(session.stop(), "lost-ACK stop timed out");
    expect(result).toMatchObject({
      authorityRevoked: true,
      controlForwarded: false,
      nativeFence: "unknown",
      stopComplete: false,
    });
    expect(session.diagnostics()).toMatchObject({ invalidated: true });
    expect(port.revokeCalls.map((call) => call.reason)).toEqual(["user-stop", "control-lost"]);
    await withTimeout(session.cleanup(), "lost-ACK cleanup timed out");
  });

  it("forwards a duplicated owner observer only once", async () => {
    const ref = testRef();
    const logPath = join(directory, "duplicate-owner-observer.log");
    const port = new TestProducerPort();
    const session = createSession(ref, port, launch("normal", logPath, ref));
    await withTimeout(session.start(), "binding did not start");
    session.onOwnerRevocation(revoked(copyRef({ ...ref, authorizationRevision: 2 }), "user-stop"));
    session.onOwnerRevocation(revoked(copyRef({ ...ref, authorizationRevision: 2 }), "user-stop"));
    const events = await waitForLog(
      logPath,
      (items) => items.some((item) => item.event === "request"),
      "owner revocation was not forwarded",
    );
    expect(events.filter((item) => item.event === "request")).toHaveLength(1);
    await withTimeout(session.cleanup(), "duplicate observer cleanup timed out");
  });

  it("waits for real child exit when cleanup follows automatic invalidation", async () => {
    const ref = testRef();
    const logPath = join(directory, "cleanup-after-invalidation.log");
    const port = new TestProducerPort();
    const session = createCuaSubmissionControlSession({
      closeTimeoutMs: 250,
      launch: launch("eof-after-ready", logPath, ref),
      producerPort: port,
      ref,
      traceId: "trace-control-binding",
    });
    await withTimeout(session.start(), "binding did not start");
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline && !session.diagnostics().invalidated) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(session.diagnostics().invalidated).toBe(true);
    await withTimeout(session.cleanup(), "post-invalidation cleanup timed out");
    await waitForLog(
      logPath,
      (events) => events.some((item) => item.event === "child-exit"),
      "child exit was not observed after cleanup",
    );
  });
});
