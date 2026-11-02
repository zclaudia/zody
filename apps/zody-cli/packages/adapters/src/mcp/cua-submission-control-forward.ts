import type { CuaSubmissionRef } from "@zody/contracts";
import type { ControlOnlyDiagnosticLauncher } from "./control-only-launcher.js";
import {
  isRejectedControlAck,
  unsupportedNativeAckReason,
  type CuaSubmissionControlFailure,
} from "./cua-submission-control-contract.js";

export interface ForwardControlOptions {
  readonly launcher: ControlOnlyDiagnosticLauncher | null;
  readonly ref: CuaSubmissionRef;
  readonly onFailure: (failure: CuaSubmissionControlFailure) => void;
}

async function forward(
  options: ForwardControlOptions,
  operation: "revoke_submission" | "stop",
): Promise<boolean> {
  const launcher = options.launcher;
  if (!launcher || launcher.closed) return false;
  let response;
  try {
    response = await launcher.request({
      operation,
      submissionLineageId: options.ref.submissionLineageId,
      authorizationRevision: options.ref.authorizationRevision,
    });
  } catch {
    options.onFailure("control_forward_failed");
    return false;
  }
  const unsupported = unsupportedNativeAckReason(response);
  if (unsupported) {
    options.onFailure("unsupported_native_ack");
    return false;
  }
  if (isRejectedControlAck(response)) {
    options.onFailure("control_ack_rejected");
    return false;
  }
  if (operation === "revoke_submission") {
    const revoked = response.evaluation?.revoked;
    if (response.ack.body.phase !== "revoked" || revoked === undefined || !revoked.complete) {
      options.onFailure("control_ack_rejected");
      return false;
    }
    return true;
  }
  const stopFacts = response.ack.body.facts.stop;
  const stop = response.evaluation?.stop;
  if (
    response.ack.body.phase !== "stop_pending" ||
    stopFacts === null ||
    !stopFacts.pending ||
    stopFacts.nativeFenced !== false ||
    stopFacts.ownedInputsReleased !== false ||
    stopFacts.leaseReleased !== false ||
    stop === null ||
    !stop.pending ||
    stop.complete !== false ||
    stop.nativeFenced !== false ||
    stop.ownedInputsReleased !== false ||
    stop.leaseReleased !== false
  ) {
    // stop 成功只接受无 Helper 的 stop_pending 未知原生 tuple；admissionClosed 不是 stop 完成。
    options.onFailure("control_ack_rejected");
    return false;
  }
  return true;
}

export async function forwardControlRevocation(options: ForwardControlOptions): Promise<boolean> {
  return await forward(options, "revoke_submission");
}

export async function forwardControlStop(options: ForwardControlOptions): Promise<boolean> {
  return await forward(options, "stop");
}

export async function forwardControlStopSequence(
  options: ForwardControlOptions & { readonly stillCurrent: () => boolean },
): Promise<boolean> {
  if (!options.stillCurrent()) return false;
  if (!(await forwardControlRevocation(options))) return false;
  if (!options.stillCurrent()) return false;
  if (!(await forwardControlStop(options))) return false;
  return options.stillCurrent();
}
