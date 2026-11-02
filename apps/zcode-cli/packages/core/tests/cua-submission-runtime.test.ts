import { describe, expect, it, vi } from "vitest";
import { createSessionId, type TurnInputIntentMetadata } from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import type { RevokedProjection } from "../src/runtime/cua/index.js";
import {
  createCuaTargetSessionStore,
  createCuaTestRuntime,
  createDeferred,
  cuaIntent,
  modelText,
} from "./fixtures/cua-runtime-fixture.js";

async function runPrompt(
  runtime: AgentRuntime,
  text: string,
  intent: TurnInputIntentMetadata,
  options: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<AgentRuntime["admitPrompt"]>>> {
  const result = await runtime.admitPrompt(text, undefined, {
    inputId: intent.sourceCommandId,
    intent,
    ...options,
  });
  if (result.kind === "started") await result.completion;
  return result;
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

async function waitForHeldInput(runtime: AgentRuntime, pendingInputId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projection = await runtime.getProjection();
    if (projection.pendingSteerInputs.some((item) => item.pendingInputId === pendingInputId)) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`held input did not appear: ${pendingInputId}`);
}

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

function activeSignal(runtime: AgentRuntime): AbortSignal | undefined {
  return (
    runtime as unknown as {
      activeForegroundExecution?: { controller: AbortController };
    }
  ).activeForegroundExecution?.controller.signal;
}

describe("CUA submission runtime lifecycle", () => {
  it("admits only a desktop turn backed by a live credential and revokes on mobile/unknown input", async () => {
    const desktop = createCuaTestRuntime({ key: "cua-runtime-desktop" });
    const registration = registerDesktop(desktop, "desktop-a");
    if (!registration.accepted) throw new Error(registration.reason);
    expect(JSON.stringify(registration.ticket)).toBe("{}");
    expect(Object.keys(registration.ticket)).toEqual([]);

    await runPrompt(desktop, "desktop A", cuaIntent("desktop-a", "desktop"));
    const admitted = desktop.getCuaSubmissionProjection();
    if (admitted.status !== "candidate") throw new Error("desktop credential was not admitted");
    expect(admitted.ref.submissionLineageId).toBeTruthy();
    expect(admitted.nativeFence).toBe("unknown");
    expect(admitted.mobileDelivery).toBe("unknown");

    const mobile = createCuaTestRuntime({ key: "cua-runtime-mobile" });
    const mobileRegistration = registerDesktop(mobile, "desktop-before-mobile");
    if (!mobileRegistration.accepted) throw new Error(mobileRegistration.reason);
    await runPrompt(mobile, "desktop before mobile", cuaIntent("desktop-before-mobile", "desktop"));
    await runPrompt(mobile, "mobile input", cuaIntent("mobile-input", "mobile"));
    expect(mobile.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "mobile-steer",
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    });

    const unknown = createCuaTestRuntime({ key: "cua-runtime-unknown" });
    const unknownRegistration = registerDesktop(unknown, "desktop-before-unknown");
    if (!unknownRegistration.accepted) throw new Error(unknownRegistration.reason);
    await runPrompt(
      unknown,
      "desktop before unknown",
      cuaIntent("desktop-before-unknown", "desktop"),
    );
    await runPrompt(unknown, "unknown input", cuaIntent("unknown-input", undefined));
    expect(unknown.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "unknown-input",
    });
  });

  it("does not treat persisted desktop intent without a live credential as CUA admission", async () => {
    const runtime = createCuaTestRuntime({ key: "cua-runtime-intent-only" });
    await runPrompt(runtime, "intent only", cuaIntent("intent-only", "desktop"));
    expect(runtime.getCuaSubmissionProjection()).toEqual({
      status: "unknown",
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    });
  });

  it("keeps local steer on the current lineage while mobile guide revokes first", async () => {
    const gate = createDeferred<unknown>();
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-steer",
      generateText: async () => {
        await gate.promise;
        return modelText("done");
      },
    });
    const registration = registerDesktop(runtime, "steer-a");
    if (!registration.accepted) throw new Error(registration.reason);
    const first = await runtime.admitPrompt("A", undefined, {
      inputId: "steer-a",
      intent: cuaIntent("steer-a", "desktop"),
    });
    if (first.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(runtime);
    const before = runtime.getCuaSubmissionProjection();
    if (before.status !== "candidate") throw new Error("expected candidate");

    const localSteer = await runPrompt(
      runtime,
      "local guide",
      cuaIntent("local-guide", "desktop", "guide"),
      { queueDelivery: "guide" },
    );
    expect(localSteer.kind).toBe("queued");
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "candidate",
      ref: { submissionLineageId: before.ref.submissionLineageId },
    });

    const mobileGuide = await runPrompt(
      runtime,
      "mobile guide",
      cuaIntent("mobile-guide", "mobile", "guide"),
      { queueDelivery: "guide" },
    );
    expect(mobileGuide.kind).toBe("queued");
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "mobile-steer",
    });

    gate.resolve(undefined);
    await first.completion.catch(() => undefined);
  });

  it("observes direct steerTurn only after accepted target validation", async () => {
    for (const origin of ["mobile", "unknown"] as const) {
      const gate = createDeferred<unknown>();
      const runtime = createCuaTestRuntime({
        key: `cua-runtime-direct-steer-${origin}`,
        generateText: async () => {
          await gate.promise;
          return modelText("done");
        },
      });
      const registration = registerDesktop(runtime, `direct-steer-a-${origin}`);
      if (!registration.accepted) throw new Error(registration.reason);
      const first = await runtime.admitPrompt("A", undefined, {
        inputId: `direct-steer-a-${origin}`,
        intent: cuaIntent(`direct-steer-a-${origin}`, "desktop"),
      });
      if (first.kind !== "started") throw new Error("first prompt did not start");
      await waitForActiveTurn(runtime);
      const activeTurnId = runtime.getActiveTurnInfo()?.turnId;
      if (!activeTurnId) throw new Error("expected active turn");
      const before = runtime.getCuaSubmissionProjection();
      if (before.status !== "candidate") throw new Error("expected candidate");

      const wrongTarget = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: `wrong-${origin}` as never,
        input: "wrong target",
        intent: cuaIntent(`direct-steer-wrong-${origin}`, origin, "guide"),
      });
      expect(wrongTarget).toMatchObject({ kind: "rejected", reason: "expected_turn_mismatch" });
      expect(runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
        ref: { submissionLineageId: before.ref.submissionLineageId },
      });

      const accepted = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: activeTurnId,
        input: "accepted direct steer",
        intent: cuaIntent(`direct-steer-${origin}`, origin, "guide"),
      });
      expect(accepted.kind).toBe("queued");
      expect(runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: origin === "mobile" ? "mobile-steer" : "unknown-input",
        ref: { submissionLineageId: before.ref.submissionLineageId },
      });

      gate.resolve(undefined);
      await first.completion.catch(() => undefined);
    }
  });

  it("observes direct enqueueDeferredInput without consuming desktop credentials", async () => {
    const desktop = createCuaTestRuntime({ key: "cua-runtime-direct-enqueue-desktop" });
    const desktopRegistration = registerDesktop(desktop, "direct-enqueue-desktop");
    if (!desktopRegistration.accepted) throw new Error(desktopRegistration.reason);
    const queuedDesktop = await desktop.enqueueDeferredInput({
      delivery: "queue",
      input: "desktop queued",
      intent: cuaIntent("direct-enqueue-desktop", "desktop", "queue"),
    });
    expect(queuedDesktop.kind).toBe("queued");
    expect(desktop.getCuaSubmissionProjection().status).toBe("unknown");
    expect(desktop.getCuaSubmissionRegistrar()?.cancel(desktopRegistration.ticket)).toBe(true);

    for (const origin of ["mobile", "unknown"] as const) {
      const runtime = createCuaTestRuntime({
        key: `cua-runtime-direct-enqueue-${origin}`,
      });
      const registration = registerDesktop(runtime, `direct-enqueue-a-${origin}`);
      if (!registration.accepted) throw new Error(registration.reason);
      await runPrompt(runtime, "A", cuaIntent(`direct-enqueue-a-${origin}`, "desktop"));
      const before = runtime.getCuaSubmissionProjection();
      if (before.status !== "candidate") throw new Error("expected candidate");

      const queued = await runtime.enqueueDeferredInput({
        delivery: "queue",
        input: `${origin} queued`,
        intent: cuaIntent(`direct-enqueue-${origin}`, origin, "queue"),
      });
      expect(queued.kind).toBe("queued");
      expect(runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: origin === "mobile" ? "mobile-steer" : "unknown-input",
        ref: { submissionLineageId: before.ref.submissionLineageId },
      });
    }
  });

  it("consumes a queued desktop credential exactly once on promotion", async () => {
    const gate = createDeferred<unknown>();
    let calls = 0;
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-queue-promotion",
      generateText: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return modelText("done");
      },
    });
    const firstRegistration = registerDesktop(runtime, "queue-a");
    if (!firstRegistration.accepted) throw new Error(firstRegistration.reason);
    const first = await runtime.admitPrompt("A", undefined, {
      inputId: "queue-a",
      intent: cuaIntent("queue-a", "desktop"),
    });
    if (first.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(runtime);
    const firstProjection = runtime.getCuaSubmissionProjection();
    if (firstProjection.status !== "candidate") throw new Error("expected first candidate");

    const queuedRegistration = registerDesktop(runtime, "queue-b");
    if (!queuedRegistration.accepted) throw new Error(queuedRegistration.reason);
    const queued = await runtime.admitPrompt("B", undefined, {
      inputId: "queue-b",
      intent: cuaIntent("queue-b", "desktop", "queue"),
      queueDelivery: "queue",
    });
    expect(queued.kind).toBe("queued");
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "candidate",
      ref: { submissionLineageId: firstProjection.ref.submissionLineageId },
    });

    gate.resolve(undefined);
    await first.completion;
    await waitForIdle(runtime);

    const promoted = await runtime.admitPrompt("B", undefined, {
      inputId: "queue-b",
      intent: cuaIntent("queue-b", "desktop"),
      requireIdle: true,
    });
    if (promoted.kind !== "started") throw new Error("queued promotion did not start");
    await promoted.completion;
    await waitForIdle(runtime);
    const afterPromotion = runtime.getCuaSubmissionProjection();
    if (afterPromotion.status !== "candidate") throw new Error("expected promoted candidate");
    expect(afterPromotion.ref.submissionLineageId).not.toBe(
      firstProjection.ref.submissionLineageId,
    );
    expect(runtime.getCuaSubmissionRegistrar()?.cancel(queuedRegistration.ticket)).toBe(false);
    expect(afterPromotion.ref.authorizationRevision).toBe(1);
  });

  it("drops a queued credential when the queue item is removed and cannot revive it", async () => {
    const gate = createDeferred<unknown>();
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-queue-removal",
      generateText: async () => {
        await gate.promise;
        return modelText("done");
      },
    });
    const firstRegistration = registerDesktop(runtime, "removed-a");
    if (!firstRegistration.accepted) throw new Error(firstRegistration.reason);
    const first = await runtime.admitPrompt("A", undefined, {
      inputId: "removed-a",
      intent: cuaIntent("removed-a", "desktop"),
    });
    if (first.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(runtime);

    const queuedRegistration = registerDesktop(runtime, "removed-b");
    if (!queuedRegistration.accepted) throw new Error(queuedRegistration.reason);
    const queued = await runtime.admitPrompt("B", undefined, {
      inputId: "removed-b",
      intent: cuaIntent("removed-b", "desktop", "queue"),
      queueDelivery: "queue",
    });
    if (queued.kind !== "queued") throw new Error("second prompt did not queue");

    await expect(
      runtime.removePendingInputById({
        pendingInputId: queued.pendingInputId,
        reason: "user_removed",
        traceContext: {
          queryId: "removed-b",
          sessionId: runtime.sessionId,
          traceId: "trace-removed-b",
        },
      }),
    ).resolves.toBe(true);
    // 删除动作已经同步作废 ticket，调用方不再需要按住原凭证。
    expect(runtime.getCuaSubmissionRegistrar()?.cancel(queuedRegistration.ticket)).toBe(false);

    gate.resolve(undefined);
    await first.completion;
    await waitForIdle(runtime);
    await runPrompt(runtime, "B replay", cuaIntent("removed-b", "desktop"));
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "unknown-input",
      nativeFence: "unknown",
    });
  });

  it("keeps a held ticket through promoted removal but drops it on user removal", async () => {
    const promotedGate = createDeferred<unknown>();
    const promotedRuntime = createCuaTestRuntime({
      key: "cua-runtime-held-promoted",
      generateText: async () => {
        await promotedGate.promise;
        return modelText("done");
      },
    });
    const promotedFirst = registerDesktop(promotedRuntime, "held-promoted-a");
    if (!promotedFirst.accepted) throw new Error(promotedFirst.reason);
    const promotedFirstRun = await promotedRuntime.admitPrompt("A", undefined, {
      inputId: "held-promoted-a",
      intent: cuaIntent("held-promoted-a", "desktop"),
    });
    if (promotedFirstRun.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(promotedRuntime);
    const promotedRegistration = registerDesktop(promotedRuntime, "held-promoted-b");
    if (!promotedRegistration.accepted) throw new Error(promotedRegistration.reason);
    const held = await promotedRuntime.admitPrompt("B", undefined, {
      inputId: "held-promoted-b",
      intent: cuaIntent("held-promoted-b", "desktop", "queue"),
      queueDelivery: "queue",
    });
    if (held.kind !== "queued") throw new Error("second prompt did not queue");
    promotedGate.resolve(undefined);
    await promotedFirstRun.completion;
    await waitForIdle(promotedRuntime);
    await waitForHeldInput(promotedRuntime, held.pendingInputId);
    await expect(
      promotedRuntime.discardHeldPendingInputById(
        held.pendingInputId,
        {
          queryId: "held-promoted-b",
          sessionId: promotedRuntime.sessionId,
          traceId: "trace-held-promoted-b",
        },
        undefined,
        "promoted",
      ),
    ).resolves.toBe(true);
    const promoted = await promotedRuntime.admitPrompt("B promoted", undefined, {
      inputId: "held-promoted-b",
      intent: cuaIntent("held-promoted-b", "desktop"),
      requireIdle: true,
    });
    if (promoted.kind !== "started") throw new Error("held ticket was not preserved for admission");
    await promoted.completion;
    expect(promotedRuntime.getCuaSubmissionProjection().status).toBe("candidate");

    const removedGate = createDeferred<unknown>();
    const removedRuntime = createCuaTestRuntime({
      key: "cua-runtime-held-removed",
      generateText: async () => {
        await removedGate.promise;
        return modelText("done");
      },
    });
    const removedFirst = registerDesktop(removedRuntime, "held-removed-a");
    if (!removedFirst.accepted) throw new Error(removedFirst.reason);
    const removedFirstRun = await removedRuntime.admitPrompt("A", undefined, {
      inputId: "held-removed-a",
      intent: cuaIntent("held-removed-a", "desktop"),
    });
    if (removedFirstRun.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(removedRuntime);
    const removedRegistration = registerDesktop(removedRuntime, "held-removed-b");
    if (!removedRegistration.accepted) throw new Error(removedRegistration.reason);
    const removedHeld = await removedRuntime.admitPrompt("B", undefined, {
      inputId: "held-removed-b",
      intent: cuaIntent("held-removed-b", "desktop", "queue"),
      queueDelivery: "queue",
    });
    if (removedHeld.kind !== "queued") throw new Error("second prompt did not queue");
    removedGate.resolve(undefined);
    await removedFirstRun.completion;
    await waitForIdle(removedRuntime);
    await waitForHeldInput(removedRuntime, removedHeld.pendingInputId);
    await expect(
      removedRuntime.removePendingInputById({
        pendingInputId: removedHeld.pendingInputId,
        reason: "user_removed",
        traceContext: {
          queryId: "held-removed-b",
          sessionId: removedRuntime.sessionId,
          traceId: "trace-held-removed-b",
        },
      }),
    ).resolves.toBe(true);
    expect(removedRuntime.getCuaSubmissionRegistrar()?.cancel(removedRegistration.ticket)).toBe(
      false,
    );
  });

  it("invalidates the removed queue ticket before the discard event is persisted", async () => {
    const gate = createDeferred<unknown>();
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-queue-persist-failure",
      generateText: async () => {
        await gate.promise;
        return modelText("done");
      },
    });
    const firstRegistration = registerDesktop(runtime, "persist-failure-a");
    if (!firstRegistration.accepted) throw new Error(firstRegistration.reason);
    const first = await runtime.admitPrompt("A", undefined, {
      inputId: "persist-failure-a",
      intent: cuaIntent("persist-failure-a", "desktop"),
    });
    if (first.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(runtime);
    const queuedRegistration = registerDesktop(runtime, "persist-failure-b");
    if (!queuedRegistration.accepted) throw new Error(queuedRegistration.reason);
    const queued = await runtime.admitPrompt("B", undefined, {
      inputId: "persist-failure-b",
      intent: cuaIntent("persist-failure-b", "desktop", "queue"),
      queueDelivery: "queue",
    });
    if (queued.kind !== "queued") throw new Error("second prompt did not queue");

    vi.spyOn(runtime, "appendEvent").mockRejectedValueOnce(new Error("discard persist failed"));
    await expect(
      runtime.removePendingInputById({
        pendingInputId: queued.pendingInputId,
        reason: "user_removed",
        traceContext: {
          queryId: "persist-failure-b",
          sessionId: runtime.sessionId,
          traceId: "trace-persist-failure-b",
        },
      }),
    ).rejects.toThrow("discard persist failed");
    expect(runtime.getCuaSubmissionRegistrar()?.cancel(queuedRegistration.ticket)).toBe(false);
    gate.resolve(undefined);
    await first.completion;
  });

  it("does not let a replayed old association point at a new current lineage", async () => {
    const runtime = createCuaTestRuntime({ key: "cua-runtime-replay" });
    for (const id of ["assoc-a", "assoc-b"]) {
      const registration = registerDesktop(runtime, id);
      if (!registration.accepted) throw new Error(registration.reason);
      await runPrompt(runtime, id, cuaIntent(id, "desktop"));
    }
    const currentB = runtime.getCuaSubmissionProjection();
    if (currentB.status !== "candidate") throw new Error("expected B candidate");

    await runPrompt(runtime, "replay A", cuaIntent("assoc-a", "desktop"));
    const replayed = runtime.getCuaSubmissionProjection();
    if (replayed.status !== "revoked") throw new Error("old association revived current lineage");
    expect(replayed.ref.submissionLineageId).toBe(currentB.ref.submissionLineageId);
    expect(replayed.revocationReason).toBe("unknown-input");

    expect(registerDesktop(runtime, "assoc-a")).toEqual({ accepted: false, reason: "consumed" });
  });

  it("binds source and queue tombstones and rejects old-owner tickets", async () => {
    const sameSource = createCuaTestRuntime({ key: "cua-runtime-same-source" });
    const sourceRegistration = registerDesktop(sameSource, "source-a", "queue-source-a");
    if (!sourceRegistration.accepted) throw new Error(sourceRegistration.reason);
    await runPrompt(sameSource, "source A", {
      ...cuaIntent("source-a", "desktop"),
      queueItemId: "queue-source-a",
    });
    expect(registerDesktop(sameSource, "source-a", "queue-other")).toEqual({
      accepted: false,
      reason: "consumed",
    });

    const sameQueue = createCuaTestRuntime({ key: "cua-runtime-same-queue" });
    const queueRegistration = sameQueue.getCuaSubmissionRegistrar()?.register({
      origin: "desktop",
      inputKind: "new-submission",
      sourceCommandId: "queue-owner-a",
      queueItemId: "shared-queue",
    });
    if (!queueRegistration?.accepted) throw new Error("queue registration failed");
    await runPrompt(sameQueue, "queue owner A", {
      ...cuaIntent("queue-owner-a", "desktop"),
      queueItemId: "shared-queue",
    });
    expect(
      sameQueue.getCuaSubmissionRegistrar()?.register({
        origin: "desktop",
        inputKind: "new-submission",
        sourceCommandId: "queue-owner-b",
        queueItemId: "shared-queue",
      }),
    ).toEqual({ accepted: false, reason: "consumed" });

    const ownerA = createCuaTestRuntime({ key: "cua-runtime-owner-a" });
    const ownerB = createCuaTestRuntime({ key: "cua-runtime-owner-b" });
    const ticket = registerDesktop(ownerA, "old-owner");
    if (!ticket.accepted) throw new Error(ticket.reason);
    expect(ownerB.getCuaSubmissionRegistrar()?.cancel(ticket.ticket)).toBe(false);
    expect(ownerA.getCuaSubmissionRegistrar()?.cancel(ticket.ticket)).toBe(true);
  });

  it("syncs owner revision from producer revocation without reviving on steer or continuation", async () => {
    const gate = createDeferred<unknown>();
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-producer-revoke",
      generateText: async () => {
        await gate.promise;
        return modelText("done");
      },
    });
    const registration = registerDesktop(runtime, "producer-a");
    if (!registration.accepted) throw new Error(registration.reason);
    const first = await runtime.admitPrompt("A", undefined, {
      inputId: "producer-a",
      intent: cuaIntent("producer-a", "desktop"),
    });
    if (first.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(runtime);
    const candidate = runtime.getCuaSubmissionProjection();
    if (candidate.status !== "candidate") throw new Error("expected candidate");

    const port = runtime.getCuaSubmissionProducerPort();
    if (!port) throw new Error("missing producer port");
    await port.revoke({ ref: candidate.ref, reason: "control-lost" });
    const revoked = runtime.getCuaSubmissionProjection();
    expect(revoked).toMatchObject({
      status: "revoked",
      revocationReason: "control-lost",
      ref: {
        submissionLineageId: candidate.ref.submissionLineageId,
        authorizationRevision: candidate.ref.authorizationRevision + 1,
      },
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    });

    const steer = await runPrompt(
      runtime,
      "desktop steer after revoke",
      cuaIntent("after-revoke-steer", "desktop", "guide"),
      { queueDelivery: "guide" },
    );
    expect(steer.kind).toBe("queued");
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      ref: { submissionLineageId: candidate.ref.submissionLineageId },
    });

    gate.resolve(undefined);
    await first.completion.catch(() => undefined);
    await runtime.executeTurn("direct continuation", undefined, {
      intent: cuaIntent("direct-continuation", "desktop"),
    });
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      ref: { submissionLineageId: candidate.ref.submissionLineageId },
    });
  });

  it("does not mint a candidate from automatic target continuation", async () => {
    const sessionId = createSessionId("cua-runtime-target-continuation");
    const targetFixture = createCuaTargetSessionStore(sessionId);
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-target-continuation",
      sessionId,
      sessionStore: targetFixture.store,
    });
    const registration = registerDesktop(runtime, "target-a");
    if (!registration.accepted) throw new Error(registration.reason);
    await runPrompt(runtime, "A", cuaIntent("target-a", "desktop"));
    const current = runtime.getCuaSubmissionProjection();
    if (current.status !== "candidate") throw new Error("expected candidate");

    const continuationRegistration = registerDesktop(runtime, "target-continuation");
    if (!continuationRegistration.accepted) throw new Error(continuationRegistration.reason);
    const continuation = await runtime.continueActiveTargetIfIdle({
      inputId: "target-continuation",
      intent: cuaIntent("target-continuation", "desktop"),
    });
    expect(continuation?.response).toBe("done");
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "candidate",
      ref: {
        submissionLineageId: current.ref.submissionLineageId,
        authorizationRevision: current.ref.authorizationRevision,
      },
    });
    expect(runtime.getCuaSubmissionRegistrar()?.cancel(continuationRegistration.ticket)).toBe(true);
  });

  it("revokes before abort, ignores expected mismatch/internal promotion, and stops idle lineage", async () => {
    const orderingGate = createDeferred<unknown>();
    let active: AbortSignal | undefined;
    const observed: Array<{ aborted: boolean; reason: string }> = [];
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-stop-order",
      generateText: async () => {
        await orderingGate.promise;
        return modelText("done");
      },
      onRevocation: (projection: RevokedProjection) => {
        observed.push({ aborted: active?.aborted ?? false, reason: projection.revocationReason });
      },
    });
    const registration = registerDesktop(runtime, "stop-a");
    if (!registration.accepted) throw new Error(registration.reason);
    const first = await runtime.admitPrompt("A", undefined, {
      inputId: "stop-a",
      intent: cuaIntent("stop-a", "desktop"),
    });
    if (first.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(runtime);
    active = activeSignal(runtime);

    expect(
      runtime.stopActiveForegroundExecution({ expectedForegroundExecutionId: "wrong-task" }),
    ).toMatchObject({ kind: "mismatch" });
    expect(runtime.getCuaSubmissionProjection().status).toBe("candidate");
    expect(observed).toEqual([]);

    expect(
      runtime.stopActiveForegroundExecution({ preserveQueueAutoDrainOnCancel: true }),
    ).toMatchObject({ kind: "stopped" });
    expect(runtime.getCuaSubmissionProjection().status).toBe("candidate");
    expect(observed).toEqual([]);

    expect(runtime.stopActiveForegroundExecution()).toMatchObject({ kind: "idle" });
    expect(observed).toEqual([{ aborted: true, reason: "user-stop" }]);
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "user-stop",
    });
    orderingGate.resolve(undefined);
    await first.completion.catch(() => undefined);

    const idleRuntime = createCuaTestRuntime({ key: "cua-runtime-stop-idle" });
    const idleRegistration = registerDesktop(idleRuntime, "idle-a");
    if (!idleRegistration.accepted) throw new Error(idleRegistration.reason);
    await runPrompt(idleRuntime, "A", cuaIntent("idle-a", "desktop"));
    expect(
      idleRuntime.stopActiveForegroundExecution({ expectedForegroundExecutionId: "other" }),
    ).toEqual({ kind: "idle" });
    expect(idleRuntime.getCuaSubmissionProjection().status).toBe("candidate");
    expect(idleRuntime.stopActiveForegroundExecution()).toEqual({ kind: "idle" });
    expect(idleRuntime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "user-stop",
    });
  });

  it("cancels pending credentials on user stop so later queue promotion cannot revive CUA", async () => {
    const gate = createDeferred<unknown>();
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-stop-before-abort",
      generateText: async () => {
        await gate.promise;
        return modelText("done");
      },
    });
    const firstRegistration = registerDesktop(runtime, "stop-before-abort-a");
    if (!firstRegistration.accepted) throw new Error(firstRegistration.reason);
    const first = await runtime.admitPrompt("A", undefined, {
      inputId: "stop-before-abort-a",
      intent: cuaIntent("stop-before-abort-a", "desktop"),
    });
    if (first.kind !== "started") throw new Error("first prompt did not start");
    await waitForActiveTurn(runtime);

    const queuedRegistration = registerDesktop(runtime, "stop-before-abort-b");
    if (!queuedRegistration.accepted) throw new Error(queuedRegistration.reason);
    await runtime.admitPrompt("B", undefined, {
      inputId: "stop-before-abort-b",
      intent: cuaIntent("stop-before-abort-b", "desktop", "queue"),
      queueDelivery: "queue",
    });
    expect(runtime.stopActiveForegroundExecution()).toMatchObject({ kind: "stopped" });
    expect(runtime.getCuaSubmissionRegistrar()?.cancel(queuedRegistration.ticket)).toBe(false);
    gate.resolve(undefined);
    await first.completion.catch(() => undefined);

    const promoted = await runtime.admitPrompt("B", undefined, {
      inputId: "stop-before-abort-b",
      intent: cuaIntent("stop-before-abort-b", "desktop"),
      requireIdle: true,
    });
    if (promoted.kind !== "started") throw new Error("queued promotion did not start");
    await promoted.completion;
    expect(runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "user-stop",
    });
  });

  it("disposes once on shutdown and does not inherit current refs or tickets across runtimes", async () => {
    const revocations: RevokedProjection[] = [];
    const runtime = createCuaTestRuntime({
      key: "cua-runtime-shutdown",
      onRevocation: (projection) => revocations.push(projection),
    });
    const registration = registerDesktop(runtime, "shutdown-a");
    if (!registration.accepted) throw new Error(registration.reason);
    await runPrompt(runtime, "A", cuaIntent("shutdown-a", "desktop"));
    const candidate = runtime.getCuaSubmissionProjection();
    if (candidate.status !== "candidate") throw new Error("expected candidate");

    runtime.beginShutdown();
    runtime.beginShutdown();
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      status: "revoked",
      revocationReason: "runtime-dispose",
      ref: { submissionLineageId: candidate.ref.submissionLineageId },
    });
    expect(
      runtime.getCuaSubmissionRegistrar()?.register({
        origin: "desktop",
        inputKind: "new-submission",
        sourceCommandId: "after-shutdown",
      }),
    ).toEqual({ accepted: false, reason: "disposed" });
    expect(runtime.getCuaSubmissionProjection()).toEqual({
      status: "unknown",
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    });

    const replacement = createCuaTestRuntime({
      key: "cua-runtime-shutdown",
      runtimeInstanceId: "runtime-replacement",
    });
    expect(replacement.getCuaSubmissionProjection().status).toBe("unknown");
    expect(replacement.getCuaSubmissionRegistrar()?.cancel(registration.ticket)).toBe(false);
  });

  it("keeps normal chat working without CUA deps and limits capacity/invalid input to CUA", async () => {
    const noDeps = createCuaTestRuntime({
      key: "cua-runtime-no-deps",
      omitCuaIdentity: true,
    });
    expect(noDeps.getCuaSubmissionRegistrar()).toBeUndefined();
    await expect(
      runPrompt(noDeps, "plain chat", cuaIntent("plain", "desktop")),
    ).resolves.toMatchObject({ kind: "started" });
    expect(noDeps.getCuaSubmissionProjection().status).toBe("unknown");

    const limited = createCuaTestRuntime({
      key: "cua-runtime-capacity",
      maxPendingLiveSubmissions: 1,
      maxLineages: 1,
    });
    const registrar = limited.getCuaSubmissionRegistrar();
    if (!registrar) throw new Error("missing registrar");
    expect(
      registrar.register({
        origin: "desktop",
        inputKind: "new-submission",
        sourceCommandId: "",
      }),
    ).toEqual({ accepted: false, reason: "invalid_input" });
    expect(registerDesktop(limited, "capacity-a")).toMatchObject({ accepted: true });
    expect(registerDesktop(limited, "capacity-b")).toEqual({ accepted: false, reason: "capacity" });
    await runPrompt(limited, "A", cuaIntent("capacity-a", "desktop"));
    expect(limited.getCuaSubmissionProjection().status).toBe("candidate");

    const second = registerDesktop(limited, "capacity-c");
    if (!second.accepted) throw new Error(second.reason);
    await expect(
      runPrompt(limited, "C", cuaIntent("capacity-c", "desktop")),
    ).resolves.toMatchObject({ kind: "started" });
    expect(limited.getCuaSubmissionProjection()).toMatchObject({
      status: "revoked",
      revocationReason: "unknown-input",
    });
  });
});
