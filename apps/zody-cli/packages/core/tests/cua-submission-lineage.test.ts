import { describe, expect, it, vi } from "vitest";
import type {
  CuaSubmissionAdmissionResult,
  CuaSubmissionProjection,
  CuaSubmissionRef,
} from "@zody/contracts";
import {
  CuaSubmissionAuthority,
  type CuaSubmissionAuthorityOptions,
} from "../src/runtime/cua/index.js";

const IDENTITY: Pick<
  CuaSubmissionAuthorityOptions,
  "appIncarnation" | "hostInstanceId" | "runtimeInstanceId" | "sessionId" | "workspaceKey"
> = {
  appIncarnation: "app-incarnation-1",
  hostInstanceId: "host-1",
  runtimeInstanceId: "runtime-1",
  sessionId: "session-1",
  workspaceKey: "workspace-1",
};

function createOwner(
  overrides: Partial<CuaSubmissionAuthorityOptions> = {},
): CuaSubmissionAuthority {
  return new CuaSubmissionAuthority({ ...IDENTITY, ...overrides });
}

function admitted(result: CuaSubmissionAdmissionResult): CuaSubmissionRef {
  if (!result.accepted) throw new Error(`expected admission, got ${result.reason}`);
  return result.ref;
}

function admit(owner: CuaSubmissionAuthority, suffix = "1"): CuaSubmissionRef {
  return admitted(
    owner.admitLive({
      origin: "desktop",
      inputKind: "new-submission",
      sourceCommandId: `command-${suffix}`,
      queueItemId: `queue-${suffix}`,
    }),
  );
}

function mutateRef(ref: CuaSubmissionRef, field: keyof CuaSubmissionRef, value: string | number) {
  (ref as unknown as Record<string, string | number>)[field] = value;
}

function unknownProjection(): CuaSubmissionProjection {
  return { status: "unknown", nativeFence: "unknown", mobileDelivery: "unknown" };
}

describe("CuaSubmissionAuthority", () => {
  it("admits only trusted desktop new submissions and self-generates lineage identity", () => {
    const owner = createOwner();
    const first = admit(owner, "first");
    const second = admit(owner, "second");

    expect(first.submissionLineageId).not.toBe("command-first");
    expect(first.submissionLineageId).not.toBe(second.submissionLineageId);
    expect(first).toMatchObject({ ...IDENTITY, authorizationRevision: 1 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => mutateRef(first, "authorizationRevision", 99)).toThrow(TypeError);
  });

  it.each(["unknown"] as const)("rejects %s origin without allocating a lineage", (origin) => {
    const owner = createOwner();
    const denied = owner.admitLive({
      origin,
      inputKind: "new-submission",
      sourceCommandId: "command-unknown",
    });

    expect(denied).toEqual({ accepted: false, reason: "ineligible_origin" });
    expect(admit(owner, "desktop-after-rejection").authorizationRevision).toBe(1);
  });

  it("admits a granted mobile new submission with the same lineage identity rules", () => {
    // mobile-origin 授权轮次（2026-11-10）：授权命中的 mobile 新提交经 coordinator 消费
    // 凭证后进入 admitLive；authority 不再按来源拒绝，但只接受 trusted admission 边界
    // （coordinator）传入的 mobile——steer 对 mobile 仍走撤销（见下方 steer 用例）。
    const owner = createOwner();
    const mobile = owner.admitLive({
      origin: "mobile",
      inputKind: "new-submission",
      sourceCommandId: "command-mobile-granted",
      queueItemId: "queue-mobile-granted",
    });

    expect(mobile.accepted).toBe(true);
    if (mobile.accepted) {
      expect(mobile.ref.authorizationRevision).toBe(1);
      expect(Object.isFrozen(mobile.ref)).toBe(true);
      expect(owner.projectNow({ ref: mobile.ref }).status).toBe("candidate");
    }
  });

  it.each(["retry", "replay", "recovery", "continuation", "steer"] as const)(
    "rejects %s input kind from live admission",
    (inputKind) => {
      const owner = createOwner();
      expect(
        owner.admitLive({
          origin: "desktop",
          inputKind,
          sourceCommandId: `command-${inputKind}`,
        }),
      ).toEqual({ accepted: false, reason: "ineligible_input_kind" });
    },
  );

  it("deduplicates source and queue resends without bypassing revocation", async () => {
    const owner = createOwner();
    const initial = admit(owner, "dedup");
    const duplicate = owner.admitLive({
      origin: "desktop",
      inputKind: "new-submission",
      sourceCommandId: "command-dedup",
      queueItemId: "queue-dedup",
    });
    expect(duplicate).toEqual({
      accepted: false,
      reason: "duplicate",
      existingRef: initial,
    });

    const revoked = await owner.revoke({ ref: initial, reason: "user-stop" });
    if (revoked.status !== "revoked") throw new Error("expected revoked");
    const resend = owner.admitLive({
      origin: "desktop",
      inputKind: "new-submission",
      sourceCommandId: "command-dedup",
      queueItemId: "queue-dedup",
    });
    expect(resend).toEqual({
      accepted: false,
      reason: "duplicate",
      existingRef: revoked.ref,
    });
    expect(revoked.ref.submissionLineageId).toBe(initial.submissionLineageId);
    expect(revoked.ref.authorizationRevision).toBe(2);
  });

  it("rejects stale/revoked refs and keeps repeated revocation idempotent", async () => {
    const owner = createOwner();
    const initial = admit(owner);
    const revoked = await owner.revoke({ ref: initial, reason: "user-stop" });
    if (revoked.status !== "revoked") throw new Error("expected revoked");

    expect(
      owner.bindTurn({
        ref: initial,
        producerIncarnation: "producer-1",
        runId: "run-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      ok: false,
      reason: "stale_revision",
    });
    expect(
      owner.bindTurn({
        ref: revoked.ref,
        producerIncarnation: "producer-1",
        runId: "run-1",
        turnId: "turn-1",
      }),
    ).toEqual({ ok: false, reason: "revoked" });
    expect(await owner.resolve({ ref: initial })).toEqual(unknownProjection());
    expect(await owner.resolve({ ref: revoked.ref })).toMatchObject({
      status: "revoked",
      ref: revoked.ref,
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    });

    const repeated = await owner.revoke({ ref: initial, reason: "control-lost" });
    expect(repeated).toMatchObject({
      status: "revoked",
      ref: revoked.ref,
      idempotent: true,
      revocationReason: "user-stop",
    });
  });

  it("requires every identity field and the exact revision for resolve", async () => {
    const owner = createOwner();
    const ref = admit(owner);
    const mismatches: Array<[keyof CuaSubmissionRef, string | number]> = [
      ["submissionLineageId", "other-lineage"],
      ["authorizationRevision", 2],
      ["appIncarnation", "other-app"],
      ["hostInstanceId", "other-host"],
      ["runtimeInstanceId", "other-runtime"],
      ["sessionId", "other-session"],
      ["workspaceKey", "other-workspace"],
    ];

    for (const [field, value] of mismatches) {
      expect(await owner.resolve({ ref: { ...ref, [field]: value } }), field).toEqual(
        unknownProjection(),
      );
    }
    expect(await owner.resolve({ ref })).toMatchObject({ status: "candidate", ref });
  });

  it("reuses one lineage across automatic continuation turns and only ends bindings", async () => {
    const owner = createOwner();
    const ref = admit(owner);

    expect(
      owner.bindTurn({ ref, producerIncarnation: "producer-1", runId: "run-1", turnId: "turn-1" }),
    ).toMatchObject({ ok: true, ref, reusedBinding: false });
    expect(owner.endTurn({ ref, runId: "run-1", turnId: "turn-1" })).toMatchObject({
      ok: true,
      removed: true,
      ref,
    });
    expect(
      owner.bindTurn({ ref, producerIncarnation: "producer-1", runId: "run-1", turnId: "turn-2" }),
    ).toMatchObject({ ok: true, ref, reusedBinding: false });

    expect(await owner.resolve({ ref })).toMatchObject({ status: "candidate", ref });
    expect(ref.authorizationRevision).toBe(1);
  });

  it("does not revive a revoked lineage through local steer or endTurn", async () => {
    const owner = createOwner();
    const initial = admit(owner);
    owner.bindTurn({
      ref: initial,
      producerIncarnation: "producer-1",
      runId: "run-1",
      turnId: "turn-1",
    });
    const revoked = await owner.revoke({ ref: initial, reason: "user-stop" });
    if (revoked.status !== "revoked") throw new Error("expected revoked");

    expect(owner.steer({ ref: initial, origin: "desktop" })).toMatchObject({
      ok: true,
      ref: revoked.ref,
      lineageState: "revoked",
    });
    expect(owner.endTurn({ ref: initial, runId: "run-1", turnId: "turn-1" })).toMatchObject({
      ok: true,
      removed: true,
      ref: revoked.ref,
    });
    expect(await owner.resolve({ ref: revoked.ref })).toMatchObject({ status: "revoked" });
    expect(
      owner.bindTurn({
        ref: revoked.ref,
        producerIncarnation: "producer-1",
        runId: "run-1",
        turnId: "turn-2",
      }),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("revokes on mobile and unknown steer without claiming fence or delivery", async () => {
    const owner = createOwner();
    const mobileRef = admit(owner, "mobile-steer");
    const mobile = owner.steer({ ref: mobileRef, origin: "mobile" });
    expect(mobile).toMatchObject({
      ok: true,
      lineageState: "revoked",
      ref: { authorizationRevision: 2 },
      revocation: { status: "revoked", revocationReason: "mobile-steer" },
    });
    if (!mobile.ok || !mobile.revocation || mobile.revocation.status !== "revoked") {
      throw new Error("expected mobile revocation");
    }
    expect(mobile.revocation.projection).toMatchObject({
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    });

    const unknownRef = admit(owner, "unknown-steer");
    expect(owner.steer({ ref: unknownRef, origin: "unknown" })).toMatchObject({
      ok: true,
      lineageState: "revoked",
      revocation: { status: "revoked", revocationReason: "unknown-input" },
    });
    expect(await owner.resolve({ ref: unknownRef })).toEqual(unknownProjection());
  });

  it("revokes all producer-related lineages and rejects the dead incarnation for new lineages", async () => {
    const owner = createOwner();
    const first = admit(owner, "producer-first");
    const second = admit(owner, "producer-second");
    for (const [index, ref] of [first, second].entries()) {
      owner.bindTurn({
        ref,
        producerIncarnation: "producer-dead",
        runId: `run-${index}`,
        turnId: `turn-${index}`,
      });
    }

    const revoked = owner.producerLost({
      producerIncarnation: "producer-dead",
      reason: "control-lost",
    });
    expect(revoked).toHaveLength(2);
    for (const ref of revoked) {
      expect(await owner.resolve({ ref })).toMatchObject({
        status: "revoked",
        revocationReason: "control-lost",
      });
    }

    const fresh = admit(owner, "after-loss");
    expect(
      owner.bindTurn({
        ref: fresh,
        producerIncarnation: "producer-dead",
        runId: "run-new",
        turnId: "turn-new",
      }),
    ).toEqual({ ok: false, reason: "dead_producer" });
    expect(
      owner.bindTurn({
        ref: fresh,
        producerIncarnation: "producer-new",
        runId: "run-new",
        turnId: "turn-new",
      }),
    ).toMatchObject({ ok: true, ref: fresh });
  });

  it("fails closed when dead producer tombstones are full", () => {
    const owner = createOwner({ maxDeadProducerIncarnations: 1 });
    owner.producerLost({ producerIncarnation: "producer-dead-1", reason: "producer-lost" });
    owner.producerLost({ producerIncarnation: "producer-dead-2", reason: "producer-lost" });
    const ref = admit(owner, "tombstone-full");

    expect(
      owner.bindTurn({
        ref,
        producerIncarnation: "producer-unregistered",
        runId: "run-1",
        turnId: "turn-1",
      }),
    ).toEqual({ ok: false, reason: "producer_registry_exhausted" });
  });

  it("keeps resolve read-only and isolates refs/projections from caller mutation", async () => {
    let observed: Extract<CuaSubmissionProjection, { status: "revoked" }> | undefined;
    const owner = createOwner({ onRevocation: (projection) => (observed = projection) });
    const ref = admit(owner);
    const firstRead = await owner.resolve({ ref });
    expect(firstRead).toMatchObject({ status: "candidate", ref });
    expect(await owner.resolve({ ref })).toMatchObject({ status: "candidate", ref });

    const revoked = await owner.revoke({ ref, reason: "user-stop" });
    if (revoked.status !== "revoked" || !observed) throw new Error("expected revocation");
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.ref)).toBe(true);
    expect(() => mutateRef(observed!.ref, "sessionId", "polluted")).toThrow(TypeError);
    expect(await owner.resolve({ ref: revoked.ref })).toMatchObject({
      status: "revoked",
      ref: revoked.ref,
    });
  });

  it("isolates observer exceptions while revoking every producer lineage", async () => {
    const observer = vi.fn(() => {
      throw new Error("observer unavailable");
    });
    const owner = createOwner({ onRevocation: observer });
    const refs = [admit(owner, "observer-1"), admit(owner, "observer-2")];
    for (const [index, ref] of refs.entries()) {
      owner.bindTurn({
        ref,
        producerIncarnation: "producer-observer",
        runId: `run-${index}`,
        turnId: `turn-${index}`,
      });
    }

    const revoked = owner.producerLost({
      producerIncarnation: "producer-observer",
      reason: "producer-lost",
    });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(revoked).toHaveLength(2);
    for (const ref of revoked) {
      expect(await owner.resolve({ ref })).toMatchObject({ status: "revoked" });
    }
  });

  it("exposes only resolve/revoke through the producer facade", async () => {
    const owner = createOwner();
    const ref = admit(owner);
    const producer = owner.createProducerPort();

    expect(Object.keys(producer).sort()).toEqual(["resolve", "revoke"]);
    expect("admitLive" in producer).toBe(false);
    expect(await producer.resolve({ ref })).toMatchObject({ status: "candidate", ref });
    expect(await producer.revoke({ ref, reason: "user-stop" })).toMatchObject({
      status: "revoked",
    });
  });

  it("rejects refs from an old runtime incarnation", async () => {
    const oldOwner = createOwner();
    const oldRef = admit(oldOwner);
    const newOwner = createOwner({ runtimeInstanceId: "runtime-2" });

    expect(await newOwner.resolve({ ref: oldRef })).toEqual(unknownProjection());
    expect(
      newOwner.bindTurn({
        ref: oldRef,
        producerIncarnation: "producer-1",
        runId: "run-1",
        turnId: "turn-1",
      }),
    ).toEqual({ ok: false, reason: "unknown_lineage" });
  });

  it("bounds lineages with fail-closed tombstones and reclaims only ended turn bindings", async () => {
    const owner = createOwner({ maxLineages: 1, maxActiveTurnsPerLineage: 1 });
    const first = admit(owner, "capacity-first");
    expect(admitResult(owner, "capacity-second")).toEqual({ accepted: false, reason: "capacity" });
    expect(
      owner.bindTurn({
        ref: first,
        producerIncarnation: "producer-1",
        runId: "run",
        turnId: "turn-1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      owner.bindTurn({
        ref: first,
        producerIncarnation: "producer-1",
        runId: "run",
        turnId: "turn-2",
      }),
    ).toEqual({ ok: false, reason: "binding_capacity" });
    expect(owner.endTurn({ ref: first, runId: "run", turnId: "turn-1" })).toMatchObject({
      ok: true,
      removed: true,
    });
    expect(
      owner.bindTurn({
        ref: first,
        producerIncarnation: "producer-1",
        runId: "run",
        turnId: "turn-2",
      }),
    ).toMatchObject({ ok: true });

    await owner.revoke({ ref: first, reason: "user-stop" });
    expect(admitResult(owner, "capacity-after-revoke")).toEqual({
      accepted: false,
      reason: "capacity",
    });
  });

  it("closes admission before dispose observers run and is idempotent", async () => {
    let admitDuringDispose: CuaSubmissionAdmissionResult | undefined;
    let bindDuringDispose: ReturnType<CuaSubmissionAuthority["bindTurn"]> | undefined;
    let owner: CuaSubmissionAuthority;
    owner = createOwner({
      onRevocation: (projection) => {
        admitDuringDispose = owner.admitLive({
          origin: "desktop",
          inputKind: "new-submission",
          sourceCommandId: "during-dispose",
        });
        bindDuringDispose = owner.bindTurn({
          ref: projection.ref,
          producerIncarnation: "producer-during-dispose",
          runId: "run-during-dispose",
          turnId: "turn-during-dispose",
        });
        throw new Error("observer sees closed admission");
      },
    });
    const ref = admit(owner);

    expect(() => owner.dispose()).not.toThrow();
    expect(admitDuringDispose).toEqual({ accepted: false, reason: "disposed" });
    expect(bindDuringDispose).toEqual({ ok: false, reason: "disposed" });
    expect(await owner.resolve({ ref })).toEqual(unknownProjection());
    expect(await owner.revoke({ ref, reason: "user-stop" })).toEqual({
      status: "unknown",
      projection: unknownProjection(),
    });
    expect(() => owner.dispose()).not.toThrow();
  });
});

function admitResult(owner: CuaSubmissionAuthority, suffix: string): CuaSubmissionAdmissionResult {
  return owner.admitLive({
    origin: "desktop",
    inputKind: "new-submission",
    sourceCommandId: `command-${suffix}`,
    queueItemId: `queue-${suffix}`,
  });
}
