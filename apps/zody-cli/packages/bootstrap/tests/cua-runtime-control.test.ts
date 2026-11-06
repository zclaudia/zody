import { describe, expect, it, vi } from "vitest";
import type {
  CuaSubmissionProducerPort,
  CuaSubmissionRef,
  CuaSubmissionTurnInvalidationReason,
  CuaSubmissionTurnScope,
} from "@zody/contracts";
import type { AgentRuntime } from "@zody/core";
import { createCuaRuntimeControlSession } from "../src/app/cua-runtime-control.js";

function scopeDouble(): CuaSubmissionTurnScope {
  const ref: CuaSubmissionRef = Object.freeze({
    submissionLineageId: "lineage-bootstrap",
    authorizationRevision: 1,
    appIncarnation: "app-bootstrap",
    hostInstanceId: "host-bootstrap",
    runtimeInstanceId: "runtime-bootstrap",
    sessionId: "session-bootstrap",
    workspaceKey: "/workspace/bootstrap",
  });
  const producerPort: CuaSubmissionProducerPort = {
    resolve: async () => ({
      status: "candidate",
      ref,
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    }),
    revoke: async () => ({
      status: "revoked",
      ref,
      revocationReason: "control-lost",
      idempotent: false,
      projection: {
        status: "revoked",
        ref,
        revocationReason: "control-lost",
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      },
    }),
  };
  return {
    ref,
    traceId: "trace-bootstrap" as never,
    runId: "run-bootstrap",
    turnId: "turn-bootstrap" as never,
    producerPort,
    bindProducer: () => true,
    onInvalidated: (_listener: (reason: CuaSubmissionTurnInvalidationReason) => void) =>
      () => undefined,
    close: () => undefined,
  };
}

describe("bootstrap CUA runtime control entry", () => {
  it("refuses without a trusted launch composition or a real runtime scope", () => {
    const runtime = {
      createCuaSubmissionTurnScope: vi.fn(() => undefined),
    } as unknown as AgentRuntime;
    expect(createCuaRuntimeControlSession(runtime, undefined)).toBeUndefined();
    expect(runtime.createCuaSubmissionTurnScope).not.toHaveBeenCalled();
    expect(
      createCuaRuntimeControlSession(runtime, {
        launch: { args: [], command: process.execPath },
      }),
    ).toBeUndefined();
    expect(runtime.createCuaSubmissionTurnScope).toHaveBeenCalledTimes(1);
  });

  it("hands the runtime scope to the existing control-only session without starting IO", () => {
    const scope = scopeDouble();
    const runtime = {
      createCuaSubmissionTurnScope: () => scope,
    } as unknown as AgentRuntime;
    const session = createCuaRuntimeControlSession(runtime, {
      launch: { args: [], command: process.execPath },
    });
    expect(session?.traceId).toBe("trace-bootstrap");
    expect(session?.diagnostics()).toMatchObject({
      control: "created",
      executable: false,
      nativeFence: "unknown",
      stopComplete: false,
    });
  });
});
