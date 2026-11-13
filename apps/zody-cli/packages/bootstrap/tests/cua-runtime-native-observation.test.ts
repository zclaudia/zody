import { duplexPair } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import type { CuaSubmissionTurnScope } from "@zody/contracts";
import type { AgentRuntime } from "@zody/core";
import { observeCuaRuntimeOnce } from "../src/app/cua-runtime-native-observation.js";
import { createCuaObservationCallbacks } from "../src/app/cua-runtime-observation-factory.js";
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
    reorderRef() {
      projectionRef = Object.fromEntries(
        Object.entries(scope.ref).reverse(),
      ) as typeof projectionRef;
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

const request = { method: "list_apps" as const, arguments: {} };
function setup() {
  const scope = createScope();
  const control = fakeRuntime(scope);
  const [host, helper] = duplexPair();
  const frames: Array<any> = [];
  createInterface({ input: helper }).on("line", (line) => frames.push(JSON.parse(line)));
  const expected = {
    sessionId: scope.ref.sessionId,
    workspaceKey: scope.ref.workspaceKey,
    turnId: scope.turnId,
  };
  const options = {
    connect: async () => host,
    producerIncarnation: "producer-app-capture",
    captureRoot: "/unused",
    expected,
    request,
  };
  const send = (id: string, method: string, payload: object) =>
    helper.write(`${JSON.stringify({ requestId: id, method, payload })}\n`);
  const association = {
    ref: scope.ref,
    traceId: scope.traceId,
    producerIncarnation: options.producerIncarnation,
    runId: scope.runId,
    turnId: scope.turnId,
  };
  const bootstrap = async () => {
    send("b", "bootstrap", {});
    await expect.poll(() => frames.some((f) => f.requestId === "b")).toBe(true);
  };
  const deliver = () =>
    send("r", "observationResult", {
      ...association,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify([{ pid: 1, name: "app", bundle_id: null, active: false }]),
          },
        ],
      },
    });
  return {
    scope,
    control,
    helper,
    frames,
    options,
    expected,
    bootstrap,
    deliver,
    send,
    association,
  };
}
describe("observation composition", () => {
  it("rejects mismatched expected identity before connecting", async () => {
    const f = setup();
    let connected = false;
    await expect(
      observeCuaRuntimeOnce(f.control.runtime, {
        ...f.options,
        expected: { ...f.expected, workspaceKey: "other" },
        connect: async () => {
          connected = true;
          throw new Error();
        },
      }),
    ).rejects.toThrow("scope_mismatch");
    expect(connected).toBe(false);
    f.helper.destroy();
  });
  it("returns only after normal close and accepts reordered equivalent ref", async () => {
    const f = setup();
    const pending = observeCuaRuntimeOnce(f.control.runtime, f.options);
    await f.bootstrap();
    f.control.reorderRef();
    f.deliver();
    await expect(pending).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(f.scope.closed).toBe(true);
    f.helper.destroy();
  });
  it.each(["supersede", "bumpRevision", "changeTurn"] as const)(
    "rejects %s before final delivery",
    async (change) => {
      const f = setup();
      const pending = observeCuaRuntimeOnce(f.control.runtime, f.options);
      await f.bootstrap();
      if (change === "changeTurn") f.control.changeTurn("other");
      else f.control[change]();
      f.deliver();
      await expect(pending).rejects.toThrow("scope_superseded");
      f.helper.destroy();
    },
  );
  it("rejects malformed result and abort without delivering content", async () => {
    const f = setup();
    const pending = observeCuaRuntimeOnce(f.control.runtime, f.options);
    await f.bootstrap();
    f.send("r", "observationResult", {
      ...f.association,
      result: { content: [{ type: "text", text: "secret" }] },
    });
    await expect(pending).rejects.toThrow();
    f.helper.destroy();
    const a = setup();
    const controller = new AbortController();
    const aborted = observeCuaRuntimeOnce(a.control.runtime, {
      ...a.options,
      signal: controller.signal,
    });
    await a.bootstrap();
    controller.abort();
    await expect(aborted).rejects.toThrow();
    a.deliver();
    a.helper.destroy();
  });
  it("factory verifier binds the exact expected object and original full ref", async () => {
    const f = setup();
    let run = f.scope.runId;
    Object.assign(f.control.runtime, { getActiveForegroundExecutionId: () => run });
    const callbacks = createCuaObservationCallbacks(() => f.control.runtime, f.options);
    const pending = callbacks.observationOnce(request, { expected: f.expected });
    await f.bootstrap();
    f.deliver();
    await pending;
    f.control.reorderRef();
    expect(callbacks.verifyObservationScope(f.expected)).toBe(true);
    expect(callbacks.verifyObservationScope({ ...f.expected })).toBe(false);
    run = "other";
    expect(callbacks.verifyObservationScope(f.expected)).toBe(false);
    run = f.scope.runId;
    f.control.bumpRevision();
    expect(callbacks.verifyObservationScope(f.expected)).toBe(false);
    f.helper.destroy();
  });
  it("aborts a pending connection when the real scope closes", async () => {
    const f = setup();
    let signal!: AbortSignal;
    const pending = observeCuaRuntimeOnce(f.control.runtime, {
      ...f.options,
      connect: (s) => {
        signal = s!;
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("connection cancelled")), {
            once: true,
          }),
        );
      },
    });
    f.scope.invalidate("scope-closed");
    await expect(pending).rejects.toThrow();
    expect(signal.aborted).toBe(true);
    f.helper.destroy();
  });
  it("read denial returns only a sanitized error and never accepts window content", async () => {
    const f = setup();
    Object.assign(f.control.runtime, {
      requestCuaNativeReadConfirmation: async () => ({ allowed: false }),
    });
    const pending = observeCuaRuntimeOnce(f.control.runtime, {
      ...f.options,
      request: { method: "get_app_state", arguments: { app_ref: { pid: 42, window_id: 8 } } },
    });
    await f.bootstrap();
    f.send("c", "confirmRead", {
      ...f.association,
      generation: 1,
      target: {
        pid: 42,
        windowId: 8,
        layer: 0,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        ownerName: "app",
        windowName: "win",
      },
    });
    await expect
      .poll(() => f.frames.find((frame) => frame.requestId === "c")?.result?.allowed)
      .toBe(false);
    f.send("r", "observationResult", {
      ...f.association,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ code: "permission_denied", message: "private content" }),
          },
        ],
      },
    });
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private content");
    f.helper.destroy();
  });
});
