import { fail } from "./control-protocol-limits.js";
import { canonicalizeControlJson, immutableControlValue } from "./control-protocol-json.js";
import { OPPOSITE_DIRECTION, normalizeAck, normalizeRequest } from "./control-protocol-schema.js";

const FAILURE_PHASES = new Set(["unknown", "rejected", "retained_fault"]);
const FINAL_STOP_PHASES = new Set(["fenced", "drained"]);

export function evaluateControlAck(requestBody, ackBody) {
  const request = normalizeRequest(requestBody, "request");
  const ack = normalizeAck(ackBody, "ack");
  if (ack.direction !== OPPOSITE_DIRECTION.get(request.direction)) {
    fail("correlation_mismatch", "ACK direction must be the reverse of the request direction");
  }
  if (ack.replyToMessageId !== request.messageId) {
    fail("correlation_mismatch", "ACK does not reply to the request messageId");
  }
  if (ack.replyToSequence !== request.sequence) {
    fail("correlation_mismatch", "ACK does not reply to the request sequence");
  }
  if (ack.replyToPayloadDigest !== request.payloadDigest) {
    fail("correlation_mismatch", "ACK does not reply to the request payloadDigest");
  }
  if (ack.submissionLineageId !== request.submissionLineageId) {
    fail("correlation_mismatch", "ACK does not carry the request submissionLineageId");
  }
  if (ack.authorizationRevision !== request.authorizationRevision) {
    fail("correlation_mismatch", "ACK does not carry the request authorizationRevision");
  }
  if (canonicalizeControlJson(ack.binding) !== canonicalizeControlJson(request.binding)) {
    fail("correlation_mismatch", "ACK binding does not match the request binding");
  }
  const phaseFailed = FAILURE_PHASES.has(ack.phase);
  const admissionClosed = ack.facts.projection.admissionClosed;
  const projectionApplied = ack.facts.projection.projectionApplied;
  const authorizationRevoked = ack.facts.revoked.authorizationRevoked;
  const projection = {
    admissionClosed,
    projectionApplied,
    complete: !phaseFailed && admissionClosed && projectionApplied,
  };
  const revoked = {
    authorizationRevoked,
    complete: !phaseFailed && authorizationRevoked,
  };
  let stop = null;
  if (request.payload.operation === "stop") {
    if (ack.facts.stop === null) {
      fail("invalid_schema", "stop acknowledgement requires facts.stop");
    }
    const stopFacts = ack.facts.stop;
    const reasons = [];
    if (phaseFailed) {
      reasons.push("phase_failure");
    }
    if (!FINAL_STOP_PHASES.has(ack.phase)) {
      reasons.push("phase_not_final");
    }
    if (!admissionClosed) {
      reasons.push("admission_not_closed");
    }
    if (!projectionApplied) {
      reasons.push("projection_not_applied");
    }
    if (!authorizationRevoked) {
      reasons.push("authorization_not_revoked");
    }
    if (!stopFacts.nativeFenced) {
      reasons.push("native_not_fenced");
    }
    if (stopFacts.pending) {
      reasons.push("pending");
    }
    if (!stopFacts.ownedInputsReleased) {
      reasons.push("owned_inputs_not_released");
    }
    if (!stopFacts.leaseReleased) {
      reasons.push("lease_not_released");
    }
    stop = {
      nativeFenced: stopFacts.nativeFenced,
      pending: stopFacts.pending,
      ownedInputsReleased: stopFacts.ownedInputsReleased,
      leaseReleased: stopFacts.leaseReleased,
      complete: reasons.length === 0,
      reasons,
    };
  }
  return immutableControlValue({
    operation: request.payload.operation,
    projection,
    revoked,
    stop,
  });
}
