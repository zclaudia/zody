import { describe, expect, it, vi } from "vitest";
import type { CuaSubmissionRef } from "@zcode/contracts";
import type { ControlChannelRequestResult } from "@zcode/zcode-cua/control-channel";
import {
  forwardControlRevocation,
  forwardControlStop,
} from "../src/mcp/cua-submission-control-forward.js";
import type { CuaSubmissionControlFailure } from "../src/mcp/cua-submission-control-contract.js";
import type { ControlOnlyDiagnosticLauncher } from "../src/mcp/control-only-launcher.js";

const ref: CuaSubmissionRef = Object.freeze({
  submissionLineageId: "lineage-forward",
  authorizationRevision: 2,
  appIncarnation: "app-forward",
  hostInstanceId: "host-forward",
  runtimeInstanceId: "runtime-forward",
  sessionId: "session-forward",
  workspaceKey: "/workspace/forward",
});

const unknownStop = Object.freeze({
  nativeFenced: false,
  pending: true,
  ownedInputsReleased: false,
  leaseReleased: false,
});

function launcher(result: ControlChannelRequestResult): ControlOnlyDiagnosticLauncher {
  return {
    binding: {},
    closed: false,
    closeReason: null,
    close: async () => undefined,
    request: async () => result,
  } as unknown as ControlOnlyDiagnosticLauncher;
}

function result(input: {
  phase: string;
  revoked: { authorizationRevoked: boolean; complete: boolean };
  stop: Record<string, unknown> | null;
}): ControlChannelRequestResult {
  return {
    ack: { body: { phase: input.phase, facts: { stop: input.stop } } },
    evaluation: { revoked: input.revoked, stop: input.stop },
  } as unknown as ControlChannelRequestResult;
}

async function run(
  forward: (options: {
    launcher: ControlOnlyDiagnosticLauncher;
    ref: CuaSubmissionRef;
    onFailure: (failure: CuaSubmissionControlFailure) => void;
  }) => Promise<boolean>,
  candidate: ControlChannelRequestResult,
): Promise<{ ok: boolean; failures: CuaSubmissionControlFailure[] }> {
  const failures: CuaSubmissionControlFailure[] = [];
  const ok = await forward({
    launcher: launcher(candidate),
    ref,
    onFailure: (failure) => failures.push(failure),
  });
  return { ok, failures };
}

describe("CUA submission control forward acknowledgement semantics", () => {
  it("requires complete authority revocation for revoke", async () => {
    const rejected = await run(
      forwardControlRevocation,
      result({
        phase: "revoked",
        revoked: { authorizationRevoked: false, complete: false },
        stop: null,
      }),
    );
    expect(rejected).toEqual({ ok: false, failures: ["control_ack_rejected"] });

    const accepted = await run(
      forwardControlRevocation,
      result({
        phase: "revoked",
        revoked: { authorizationRevoked: true, complete: true },
        stop: null,
      }),
    );
    expect(accepted).toEqual({ ok: true, failures: [] });
  });

  it("rejects a stop acknowledgement that only claims admission closure", async () => {
    const candidate = result({
      phase: "revoked",
      revoked: { authorizationRevoked: true, complete: true },
      stop: unknownStop,
    });
    await expect(run(forwardControlStop, candidate)).resolves.toEqual({
      ok: false,
      failures: ["control_ack_rejected"],
    });
  });

  it("requires stop_pending with pending and the unknown native tuple", async () => {
    const accepted = await run(
      forwardControlStop,
      result({
        phase: "stop_pending",
        revoked: { authorizationRevoked: true, complete: true },
        stop: {
          ...unknownStop,
          complete: false,
          reasons: ["native_not_fenced", "pending"],
        },
      }),
    );
    expect(accepted).toEqual({ ok: true, failures: [] });

    const pendingFalse = await run(
      forwardControlStop,
      result({
        phase: "stop_pending",
        revoked: { authorizationRevoked: true, complete: true },
        stop: { ...unknownStop, pending: false },
      }),
    );
    expect(pendingFalse).toEqual({ ok: false, failures: ["unsupported_native_ack"] });
  });

  it("does not invoke a launcher request after close", async () => {
    const request = vi.fn();
    const closed = { ...launcher({} as ControlChannelRequestResult), closed: true, request };
    const failures: CuaSubmissionControlFailure[] = [];
    await expect(
      forwardControlStop({ launcher: closed, ref, onFailure: (failure) => failures.push(failure) }),
    ).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });
});
