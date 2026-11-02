import { describe, expect, it, vi } from "vitest";
import type { CuaSubmissionRef, CuaSubmissionRevocationResult } from "@zcode/contracts";
import type { ControlChannelRequest } from "@zcode/zcode-cua/control-channel";
import { handleBoundInboundRevocation } from "../src/mcp/cua-submission-control-inbound.js";

const ref: CuaSubmissionRef = Object.freeze({
  submissionLineageId: "lineage-inbound-epoch",
  authorizationRevision: 1,
  appIncarnation: "app-inbound-epoch",
  hostInstanceId: "host-inbound-epoch",
  runtimeInstanceId: "runtime-inbound-epoch",
  sessionId: "session-inbound-epoch",
  workspaceKey: "/workspace/inbound-epoch",
});

function request(): ControlChannelRequest {
  return {
    body: {
      authorizationRevision: ref.authorizationRevision,
      payload: { operation: "revoke_submission" },
      submissionLineageId: ref.submissionLineageId,
    },
    digest: "digest",
    keyId: "producer",
    signal: new AbortController().signal,
  } as unknown as ControlChannelRequest;
}

describe("CUA submission inbound reverse revocation", () => {
  it("keeps the authority revocation but rejects a late ACK after control invalidation", async () => {
    let epoch = 0;
    let invalidated = false;
    const revokedRef = Object.freeze({ ...ref, authorizationRevision: 2 });
    let markRevokeStarted!: () => void;
    let releaseRevoke!: (result: CuaSubmissionRevocationResult) => void;
    const revokeStarted = new Promise<void>((resolve) => {
      markRevokeStarted = resolve;
    });
    const revokeGate = new Promise<CuaSubmissionRevocationResult>((resolve) => {
      releaseRevoke = resolve;
    });
    const onRevoked = vi.fn((next: CuaSubmissionRef) => {
      expect(next).toEqual(revokedRef);
      invalidated = true;
      return true;
    });

    const responsePromise = handleBoundInboundRevocation({
      request: request(),
      eligible: true,
      authoritativeRef: ref,
      resolve: async () => ({ ok: true }),
      stillEligible: () => true,
      beginInbound: () => true,
      endInbound: () => undefined,
      revoke: async () => {
        markRevokeStarted();
        return await revokeGate;
      },
      onAuthorityRejected: (failure) => {
        throw new Error(`unexpected authority rejection: ${failure}`);
      },
      onRevoked,
      invalidated: () => invalidated,
      invalidationEpoch: () => epoch,
    });
    await revokeStarted;
    epoch = 1;
    releaseRevoke({
      status: "revoked",
      ref: revokedRef,
      revocationReason: "control-lost",
      idempotent: false,
      projection: {
        status: "revoked",
        ref: revokedRef,
        revocationReason: "control-lost",
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      },
    });
    const response = await responsePromise;
    expect(response.phase).toBe("rejected");
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(invalidated).toBe(true);
  });
});
