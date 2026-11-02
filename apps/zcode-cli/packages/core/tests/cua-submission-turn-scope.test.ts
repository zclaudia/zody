import { describe, expect, it, vi } from "vitest";
import { createSessionId, createTurnId } from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  createCuaTestRuntime,
  createDeferred,
  cuaIntent,
  modelText,
} from "./fixtures/cua-runtime-fixture.js";

function registerDesktop(runtime: AgentRuntime, id: string, queueItemId = `queue_${id}`) {
  const registrar = runtime.getCuaSubmissionRegistrar();
  if (!registrar) throw new Error("missing CUA registrar");
  return registrar.register({
    origin: "desktop",
    inputKind: "new-submission",
    sourceCommandId: id,
    queueItemId,
  });
}

async function waitForActiveTurn(runtime: AgentRuntime): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runtime.getActiveTurnInfo()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("active turn did not start");
}

async function waitForIdle(runtime: AgentRuntime): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!runtime.hasActiveOrQueuedTurnWork()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("runtime did not become idle");
}

interface HeldTurn {
  readonly runtime: AgentRuntime;
  readonly gate: ReturnType<typeof createDeferred<unknown>>;
  readonly completion: Promise<unknown>;
}

async function startHeldTurn(options: {
  key: string;
  id: string;
  abortSignal?: AbortSignal;
}): Promise<HeldTurn> {
  const gate = createDeferred<unknown>();
  const runtime = createCuaTestRuntime({
    key: options.key,
    generateText: async () => {
      await gate.promise;
      return modelText("done");
    },
  });
  const registration = registerDesktop(runtime, options.id);
  if (!registration.accepted) throw new Error(registration.reason);
  const receipt = await runtime.admitPrompt(options.id, undefined, {
    inputId: options.id,
    intent: cuaIntent(options.id, "desktop"),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });
  if (receipt.kind !== "started") throw new Error("prompt did not start");
  await waitForActiveTurn(runtime);
  return { runtime, gate, completion: receipt.completion };
}

function internal(runtime: AgentRuntime): AgentRuntimeInternal {
  return runtime as unknown as AgentRuntimeInternal;
}

async function finishHeldTurn(held: HeldTurn): Promise<void> {
  held.gate.resolve(undefined);
  await held.completion.catch(() => undefined);
  await waitForIdle(held.runtime);
}

describe("CuaSubmissionTurnScope runtime wiring", () => {
  it("issues one pinned scope from the real active turn and foreground execution", async () => {
    const held = await startHeldTurn({ key: "cua-scope-identity", id: "scope-identity-a" });
    const runtimeInternal = internal(held.runtime);
    const activeTurn = runtimeInternal.activeTurn;
    const candidate = held.runtime.getCuaSubmissionProjection();
    if (!activeTurn || candidate.status !== "candidate") {
      throw new Error("expected active regular turn and candidate");
    }

    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    expect(scope.ref).toEqual(candidate.ref);
    expect(scope.traceId).toBe(activeTurn.traceContext.traceId);
    expect(scope.turnId).toBe(activeTurn.turnId);
    expect(scope.runId).toBe(held.runtime.getActiveForegroundExecutionId());
    expect(held.runtime.createCuaSubmissionTurnScope()).toBe(scope);

    expect(Object.isFrozen(scope)).toBe(true);
    expect(() => {
      (scope as unknown as { ref: unknown }).ref = { ...candidate.ref, sessionId: "other" };
    }).toThrow();
    expect(scope.ref).toEqual(candidate.ref);

    scope.close();
    // 关闭后重复创建不能复活旧 turn。
    expect(held.runtime.createCuaSubmissionTurnScope()).toBeUndefined();
    expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({ status: "candidate" });
    await finishHeldTurn(held);
  });

  it("returns undefined without coordinator, regular turn, live foreground or candidate", async () => {
    const idle = createCuaTestRuntime({ key: "cua-scope-idle" });
    expect(idle.createCuaSubmissionTurnScope()).toBeUndefined();

    const noDeps = createCuaTestRuntime({ key: "cua-scope-no-deps", omitCuaIdentity: true });
    expect(noDeps.createCuaSubmissionTurnScope()).toBeUndefined();

    const subagent = createCuaTestRuntime({
      key: "cua-scope-subagent",
      config: { parentSessionId: createSessionId("cua-scope-parent") },
    });
    expect(subagent.createCuaSubmissionTurnScope()).toBeUndefined();

    const held = await startHeldTurn({ key: "cua-scope-regular-only", id: "scope-regular-a" });
    const runtimeInternal = internal(held.runtime);
    const regular = runtimeInternal.activeTurn;
    if (!regular) throw new Error("expected regular turn");
    held.runtime.finishActiveTurn(regular);
    held.runtime.beginActiveTurn(createTurnId(), regular.traceContext, "compact", false);
    expect(held.runtime.createCuaSubmissionTurnScope()).toBeUndefined();
    runtimeInternal.finishActiveTurn(runtimeInternal.activeTurn);
    await finishHeldTurn(held);
  });

  it("binds idempotently for the same producer and rejects a different producer", async () => {
    const held = await startHeldTurn({ key: "cua-scope-bind", id: "scope-bind-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");

    expect(scope.bindProducer("launcher-incarnation-a")).toBe(true);
    expect(scope.bindProducer("launcher-incarnation-a")).toBe(true);
    expect(scope.bindProducer("launcher-incarnation-b")).toBe(false);
    expect(scope.bindProducer("")).toBe(false);

    scope.close();
    expect(scope.bindProducer("launcher-incarnation-a")).toBe(false);
    await finishHeldTurn(held);
  });

  it("normal close emits scope-closed, releases the binding and never revokes the lineage", async () => {
    const held = await startHeldTurn({ key: "cua-scope-close", id: "scope-close-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    const coordinator = internal(held.runtime).cuaSubmissionCoordinator;
    if (!coordinator) throw new Error("missing coordinator");
    const endTurn = vi.spyOn(coordinator, "endTurn");
    const revokeCurrent = vi.spyOn(coordinator, "revokeCurrent");
    const reasons: string[] = [];
    const unsubscribe = scope.onInvalidated((reason) => reasons.push(reason));

    scope.close();
    scope.close();
    expect(reasons).toEqual(["scope-closed"]);
    expect(endTurn).toHaveBeenCalledTimes(1);
    expect(endTurn.mock.calls[0]?.[0]).toEqual({
      ref: scope.ref,
      runId: scope.runId,
      turnId: scope.turnId,
    });
    expect(revokeCurrent).not.toHaveBeenCalled();
    expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({ status: "candidate" });

    const late = vi.fn();
    const lateUnsubscribe = scope.onInvalidated(late);
    expect(late).toHaveBeenCalledWith("scope-closed");
    lateUnsubscribe();

    // normal scope-closed 不得借旧 scope 发新的 revoke，仍有效 lineage 保持 candidate。
    await expect(
      scope.producerPort.revoke({ ref: scope.ref, reason: "producer-lost" }),
    ).resolves.toMatchObject({ status: "unknown" });
    expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({ status: "candidate" });

    unsubscribe();
    await finishHeldTurn(held);
  });

  it("returns the real owner revoke receipt even when the revoke itself closes the scope", async () => {
    const held = await startHeldTurn({ key: "cua-scope-revoke-receipt", id: "scope-revoke-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    const reasons: string[] = [];
    scope.onInvalidated((reason) => reasons.push(reason));

    const first = await scope.producerPort.revoke({
      ref: scope.ref,
      reason: "producer-lost",
    });
    expect(first).toMatchObject({ status: "revoked", revocationReason: "producer-lost" });
    expect(reasons).toEqual(["owner-revoked"]);
    expect(scope.invalidated).toBe(true);

    // owner-revoked 之后同原 ref 的幂等 revoke 继续拿到 owner 事实，adapter cleanup 不误报失败。
    const again = await scope.producerPort.revoke({
      ref: scope.ref,
      reason: "producer-lost",
    });
    expect(again).toMatchObject({ status: "revoked", idempotent: true });

    const late = vi.fn();
    scope.onInvalidated(late);
    expect(late).toHaveBeenCalledWith("owner-revoked");
    expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "producer-lost",
    });
    await finishHeldTurn(held);
  });

  it("invalidates scope-closed on real turn end without revoking the lineage", async () => {
    const held = await startHeldTurn({ key: "cua-scope-turn-end", id: "scope-turn-end-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    const reasons: string[] = [];
    scope.onInvalidated((reason) => reasons.push(reason));

    await finishHeldTurn(held);
    expect(reasons).toEqual(["scope-closed"]);
    expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({ status: "candidate" });
  });

  it("latches owner-revoked before abort on user stop", async () => {
    const held = await startHeldTurn({ key: "cua-scope-stop", id: "scope-stop-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    const reasons: string[] = [];
    scope.onInvalidated((reason) => reasons.push(reason));

    expect(held.runtime.stopActiveForegroundExecution()).toMatchObject({ kind: "stopped" });
    expect(reasons).toEqual(["owner-revoked"]);
    expect(scope.invalidated).toBe(true);
    expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "user-stop",
    });
    await expect(scope.producerPort.resolve({ ref: scope.ref })).resolves.toMatchObject({
      status: "unknown",
    });

    await finishHeldTurn(held);
    // foreground 结束后的 scope-closed 不得覆盖首个 owner-revoked。
    expect(reasons).toEqual(["owner-revoked"]);
  });

  it("invalidates synchronously when the foreground parent aborts before the held model returns", async () => {
    const parent = new AbortController();
    const held = await startHeldTurn({
      key: "cua-scope-parent-abort",
      id: "scope-parent-abort-a",
      abortSignal: parent.signal,
    });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    const reasons: string[] = [];
    scope.onInvalidated((reason) => reasons.push(reason));

    parent.abort(new Error("parent aborted while model is held"));
    // 模型尚未返回，scope 必须已同步失效并拒绝晚到 resolve。
    expect(scope.invalidated).toBe(true);
    expect(reasons).toEqual(["scope-closed"]);
    await expect(scope.producerPort.resolve({ ref: scope.ref })).resolves.toMatchObject({
      status: "unknown",
    });
    const late = vi.fn();
    scope.onInvalidated(late);
    expect(late).toHaveBeenCalledWith("scope-closed");

    await finishHeldTurn(held);
  });

  it("commits the real owner revocation before notifying the scope on shutdown", async () => {
    const held = await startHeldTurn({ key: "cua-scope-shutdown-order", id: "scope-shutdown-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    const observedReasons: string[] = [];
    let observedBind: boolean | undefined;
    let observedStatus: string | undefined;
    let observedOwnerStatus: string | undefined;
    let ownerRead: Promise<{ status: string }> | undefined;
    scope.onInvalidated((reason) => {
      if (reason !== "owner-revoked") return;
      observedReasons.push(reason);
      // listener 必须当场看到 owner 已撤销；旧顺序会在 authority 仍 candidate 时误报 owner-revoked。
      observedStatus = held.runtime.getCuaSubmissionProjection().status;
      observedBind = scope.bindProducer("shutdown-late-producer");
      const ownerPort = held.runtime.getCuaSubmissionProducerPort();
      ownerRead = ownerPort?.resolve({ ref: scope.ref }).then((projection) => {
        observedOwnerStatus = projection.status;
        return projection;
      });
    });

    held.runtime.beginShutdown();
    expect(observedReasons).toEqual(["owner-revoked"]);
    expect(observedBind).toBe(false);
    expect(scope.invalidated).toBe(true);
    expect(held.runtime.createCuaSubmissionTurnScope()).toBeUndefined();
    expect(observedStatus).not.toBe("candidate");
    expect(["revoked", "unknown"]).toContain(observedStatus);
    if (!ownerRead) throw new Error("owner port was not read from the invalidation listener");
    await expect(ownerRead).resolves.not.toMatchObject({ status: "candidate" });
    expect(observedOwnerStatus).not.toBe("candidate");
    await finishHeldTurn(held);
  });

  it("re-checks invalidation after await so a late resolve cannot return candidate", async () => {
    const held = await startHeldTurn({ key: "cua-scope-late-resolve", id: "scope-late-resolve-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");

    const pending = scope.producerPort.resolve({ ref: scope.ref });
    scope.close();
    await expect(pending).resolves.toMatchObject({ status: "unknown" });
    await finishHeldTurn(held);
  });

  it("re-checks live binding state on resolve even if an invalidation hook was missed", async () => {
    const held = await startHeldTurn({ key: "cua-scope-live-resolve", id: "scope-live-resolve-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");

    internal(held.runtime).activeTurn = undefined;
    await expect(scope.producerPort.resolve({ ref: scope.ref })).resolves.toMatchObject({
      status: "unknown",
    });
    scope.close();
    await finishHeldTurn(held);
  });

  it("producerPort rejects any non-pinned complete ref", async () => {
    const held = await startHeldTurn({ key: "cua-scope-strict-ref", id: "scope-strict-ref-a" });
    const scope = held.runtime.createCuaSubmissionTurnScope();
    if (!scope) throw new Error("scope was not issued");
    const ref = scope.ref;
    const variants = [
      { ...ref, submissionLineageId: "other-lineage" },
      { ...ref, appIncarnation: "other-app" },
      { ...ref, hostInstanceId: "other-host" },
      { ...ref, runtimeInstanceId: "other-runtime" },
      { ...ref, sessionId: "other-session" },
      { ...ref, workspaceKey: "other-workspace" },
      { ...ref, authorizationRevision: ref.authorizationRevision + 1 },
    ];

    for (const variant of variants) {
      await expect(scope.producerPort.resolve({ ref: variant })).resolves.toMatchObject({
        status: "unknown",
      });
      await expect(
        scope.producerPort.revoke({ ref: variant, reason: "producer-lost" }),
      ).resolves.toMatchObject({ status: "unknown" });
    }
    await expect(scope.producerPort.resolve({ ref })).resolves.toMatchObject({
      status: "candidate",
    });
    expect(held.runtime.getCuaSubmissionProjection()).toMatchObject({ status: "candidate" });
    await finishHeldTurn(held);
  });
});
