import { signControlBody } from "./control-protocol.js";
import { readStrictObject } from "./control-protocol-json.js";

const HANDLER_RESULT_KEYS = ["phase", "facts"];

export function readEnvelopeKindHint(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return null;
  }
  const bodyDescriptor = Object.getOwnPropertyDescriptor(envelope, "body");
  if (!bodyDescriptor || !("value" in bodyDescriptor)) {
    return null;
  }
  const body = bodyDescriptor.value;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(body, "kind");
  if (!kindDescriptor || !("value" in kindDescriptor)) {
    return null;
  }
  return kindDescriptor.value === "request" || kindDescriptor.value === "ack"
    ? kindDescriptor.value
    : null;
}

export function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

export function encodeControlFrame(envelope) {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

export function buildControlAckEnvelope({
  request,
  result,
  keyId,
  direction,
  binding,
  sequence,
  role,
  privateKey,
}) {
  const fields = readStrictObject(result, HANDLER_RESULT_KEYS, "control channel handler result");
  return signControlBody(
    {
      keyId,
      kind: "ack",
      direction,
      binding,
      messageId: `${role}-ack-${sequence}`,
      sequence,
      replyToMessageId: request.messageId,
      replyToSequence: request.sequence,
      replyToPayloadDigest: request.payloadDigest,
      submissionLineageId: request.submissionLineageId,
      authorizationRevision: request.authorizationRevision,
      phase: fields.phase,
      facts: fields.facts,
    },
    privateKey,
  );
}
