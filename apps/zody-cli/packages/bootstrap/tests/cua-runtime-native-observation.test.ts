import { duplexPair } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
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
  it("records real revocation without body or identity and never delivers a late candidate", async () => {
    const f = setup();
    const info = vi.fn();
    const pending = observeCuaRuntimeOnce(f.control.runtime, { ...f.options, logger: { info } });
    const failed = expect(pending).rejects.toThrow();
    await f.bootstrap();
    let release!: (value: { status: "candidate"; ref: typeof f.scope.ref }) => void;
    vi.spyOn(f.scope.producerPort, "resolve").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.deliver();
    await expect.poll(() => Boolean(release)).toBe(true);
    f.scope.invalidate("owner-revoked");
    release({ status: "candidate", ref: f.scope.ref });
    await failed;
    const events = info.mock.calls.map(([message]) =>
      JSON.parse(String(message).split("cua-read-delivery: ")[1]!),
    );
    expect(events.map((e) => e.event)).toEqual(["invalidated", "discarded"]);
    expect(events[0].reason).toBe("owner-revoked");
    expect(events[1].sequence).toBeGreaterThan(events[0].sequence);
    expect(events[0].scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(events[0]).sort()).toEqual([
      "event",
      "observationId",
      "pid",
      "reason",
      "scopeDigest",
      "sequence",
    ]);
    expect(events[0].scopeDigest).toBe(events[1].scopeDigest);
    f.deliver();
    f.helper.destroy();
  });
  it("diagnostic failure cannot grant or prevent normal authorized delivery", async () => {
    const f = setup();
    const pending = observeCuaRuntimeOnce(f.control.runtime, {
      ...f.options,
      logger: {
        info() {
          throw new Error("logger unavailable");
        },
      },
    });
    await f.bootstrap();
    f.deliver();
    await expect(pending).resolves.toMatchObject({ content: [{ type: "text" }] });
    f.helper.destroy();
  });
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

it("returns a control receipt while retaining its authority watcher until owner invalidation", async () => {
  const f = setup();
  Object.assign(f.control.runtime, {
    requestCuaNativeControlConfirmation: async () => ({ allowed: true }),
  });
  const invocation = new AbortController();
  const pending = observeCuaRuntimeOnce(f.control.runtime, {
    ...f.options,
    signal: invocation.signal,
    request: {
      method: "left_click",
      arguments: { target: { type: "element", index: 0 }, state_id: "frozen" },
    },
  });
  await f.bootstrap();
  f.send("c", "confirmControl", {
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
      ownerName: "Fixture",
      windowName: "Window",
    },
  });
  await expect.poll(() => f.frames.some((frame) => frame.requestId === "c")).toBe(true);
  f.send("r", "controlResult", {
    ...f.association,
    lease_watch: true,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            action_sent: true,
            dispatch_status: "sent",
            state_sync_status: "not_requested",
          }),
        },
      ],
    },
  });
  await expect(pending).resolves.toMatchObject({ content: [{ type: "text" }] });
  expect(f.scope.closed).toBe(false);
  invocation.abort();
  await Promise.resolve();
  expect(f.scope.closed).toBe(false);
  vi.spyOn(f.scope.producerPort, "revoke").mockResolvedValue({
    status: "revoked",
    ref: { ...f.scope.ref, authorizationRevision: 2 },
    revocationReason: "user-stop",
    idempotent: true,
    projection: {
      status: "revoked",
      ref: { ...f.scope.ref, authorizationRevision: 2 },
      revocationReason: "user-stop",
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    },
  });
  f.scope.invalidate("owner-revoked");
  await expect.poll(() => f.frames.some((frame) => frame.method === "revoked")).toBe(true);
  f.helper.destroy();
});

it("routes tool Stop to the current owner revoke without opening another native connection", async () => {
  const f = setup();
  const revoke = vi.spyOn(f.scope.producerPort, "revoke").mockResolvedValue({
    status: "revoked",
    ref: f.scope.ref,
    revocationReason: "user-stop",
    idempotent: true,
    projection: {
      status: "revoked",
      ref: f.scope.ref,
      revocationReason: "user-stop",
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    },
  });
  const connect = vi.fn();
  const callbacks = createCuaObservationCallbacks(() => f.control.runtime, {
    ...f.options,
    connect,
  });
  const result = await callbacks.observationOnce!(
    { method: "stop_computer_control", arguments: {} },
    { expected: f.expected },
  );
  expect(result).toMatchObject({ content: [{ type: "text" }] });
  expect(revoke).toHaveBeenCalledWith({ ref: f.scope.ref, reason: "user-stop" });
  expect(connect).not.toHaveBeenCalled();
  f.helper.destroy();
});

it("treats repeated idle tool Stop as an inactive receipt without a grant", async () => {
  const f = setup();
  Object.assign(f.control.runtime, { createCuaSubmissionTurnScope: () => undefined });
  const callbacks = createCuaObservationCallbacks(() => f.control.runtime, f.options);
  for (let i = 0; i < 2; i++) {
    const result = await callbacks.observationOnce!(
      { method: "stop_computer_control", arguments: {} },
      { expected: f.expected },
    );
    expect(JSON.parse(String(result.content[0]?.text))).toEqual({
      action_sent: false,
      dispatch_status: "not_sent",
      state_sync_status: "not_requested",
      control_status: "inactive",
    });
  }
  f.helper.destroy();
});

it("closes a retained watcher before reporting inactive when the owner scope is gone", async () => {
  const f = setup();
  Object.assign(f.control.runtime, {
    requestCuaNativeControlConfirmation: async () => ({ allowed: true }),
    getActiveForegroundExecutionId: () => f.scope.runId,
  });
  const callbacks = createCuaObservationCallbacks(() => f.control.runtime, f.options);
  const pending = callbacks.observationOnce!(
    {
      method: "left_click",
      arguments: { target: { type: "element", index: 0 }, state_id: "frozen" },
    },
    { expected: f.expected },
  );
  await f.bootstrap();
  f.send("c", "confirmControl", {
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
      ownerName: "Fixture",
      windowName: "Window",
    },
  });
  await expect.poll(() => f.frames.some((frame) => frame.requestId === "c")).toBe(true);
  f.send("r", "controlResult", {
    ...f.association,
    lease_watch: true,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            action_sent: true,
            dispatch_status: "sent",
            state_sync_status: "not_requested",
          }),
        },
      ],
    },
  });
  await pending;
  expect(f.scope.closed).toBe(false);
  Object.assign(f.control.runtime, { createCuaSubmissionTurnScope: () => undefined });
  const stopped = await callbacks.observationOnce!(
    { method: "stop_computer_control", arguments: {} },
    { expected: f.expected },
  );
  expect(f.scope.closed).toBe(true);
  expect(JSON.parse(String(stopped.content[0]?.text))).toMatchObject({
    control_status: "inactive",
  });
  f.helper.destroy();
});

it("carries the verified remote association into native bootstrap without changing the submission ref", async () => {
  const f = setup();
  Object.assign(f.control.runtime, { matchesCuaContext: () => true });
  const pending = observeCuaRuntimeOnce(f.control.runtime, {
    ...f.options,
    expected: {
      ...f.expected,
      workspaceIdentity: f.expected.workspaceKey,
      remoteSessionId: "remote-session",
    },
  });
  await f.bootstrap();
  const bootstrap = f.frames.find((frame) => frame.requestId === "b");
  expect(bootstrap.result).toMatchObject({
    workspaceIdentity: f.expected.workspaceKey,
    remoteSessionId: "remote-session",
    ref: f.scope.ref,
  });
  f.scope.invalidate("scope-closed");
  await expect(pending).rejects.toThrow();
  f.helper.destroy();
});

it("uses the existing workspace key for remote association when identity is absent", async () => {
  const f = setup();
  Object.assign(f.control.runtime, { matchesCuaContext: () => true });
  const pending = observeCuaRuntimeOnce(f.control.runtime, {
    ...f.options,
    expected: { ...f.expected, remoteSessionId: "remote-session" },
  });
  await f.bootstrap();
  expect(f.frames.find((frame) => frame.requestId === "b").result).toMatchObject({
    workspaceIdentity: f.expected.workspaceKey,
    remoteSessionId: "remote-session",
  });
  f.scope.invalidate("scope-closed");
  await expect(pending).rejects.toThrow();
  f.helper.destroy();
});

it("rejects a mismatched workspace identity before native connection", async () => {
  const f = setup();
  Object.assign(f.control.runtime, { matchesCuaContext: () => true });
  const connect = vi.fn();
  await expect(
    observeCuaRuntimeOnce(f.control.runtime, {
      ...f.options,
      connect,
      expected: { ...f.expected, workspaceIdentity: "different", remoteSessionId: "remote" },
    }),
  ).rejects.toThrow("scope_mismatch");
  expect(connect).not.toHaveBeenCalled();
  f.helper.destroy();
});
