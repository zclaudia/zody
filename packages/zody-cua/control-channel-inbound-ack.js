import { ControlChannelError, asError } from "./control-channel-errors.js";
import { evaluateControlAck } from "./control-protocol.js";

export function createIncomingAckHandler({ pending, cleanupPending, close, isClosed }) {
  return function handleIncomingAck(verified) {
    if (isClosed()) {
      return;
    }
    const entry = pending.get(verified.body.replyToMessageId);
    if (!entry) {
      close(
        new ControlChannelError(
          "correlation_mismatch",
          "control channel received an ACK with no matching pending request",
        ),
      );
      return;
    }
    let evaluation;
    try {
      evaluation = evaluateControlAck(entry.body, verified.body);
    } catch (error) {
      close(asError(error));
      return;
    }
    pending.delete(entry.body.messageId);
    cleanupPending(entry);
    entry.resolve(
      Object.freeze({
        messageId: entry.body.messageId,
        sequence: entry.body.sequence,
        ack: verified,
        evaluation,
      }),
    );
  };
}

export function createDuplicateHandler({
  ackCache,
  isInFlight,
  requestResend,
  enqueueEnvelope,
  close,
  isClosed,
}) {
  return function handleDuplicate(verified) {
    if (isClosed() || verified.body.kind === "ack") {
      return;
    }
    const sequence = verified.body.sequence;
    if (isInFlight(sequence)) {
      requestResend(sequence);
      return;
    }
    const cached = ackCache.get(sequence);
    if (
      cached === undefined ||
      cached.messageId !== verified.body.messageId ||
      cached.bodyDigest !== verified.digest
    ) {
      close(
        new ControlChannelError(
          "duplicate_not_cached",
          "control channel received a duplicate request with no cached ACK",
        ),
      );
      return;
    }
    enqueueEnvelope(cached.envelope);
  };
}
