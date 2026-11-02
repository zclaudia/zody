import { asError } from "./control-channel-errors.js";

export function createInboundRequestController({
  onRequest,
  buildAck,
  enqueueEnvelope,
  cacheAck,
  close,
  isClosed,
  getSignal,
  maxIncomingRequests,
}) {
  let active = 0;
  const inFlight = new Set();
  const resendAfterAck = new Set();

  async function run(verified) {
    const sequence = verified.body.sequence;
    try {
      const result = await onRequest(
        Object.freeze({
          body: verified.body,
          keyId: verified.keyId,
          digest: verified.digest,
          signal: getSignal(),
        }),
      );
      if (isClosed()) {
        return;
      }
      let envelope;
      try {
        envelope = buildAck(verified.body, result);
      } catch (error) {
        close("handler_error", asError(error));
        return;
      }
      if (isClosed()) {
        return;
      }
      if (!enqueueEnvelope(envelope)) {
        if (!isClosed()) {
          close("transport_error", asError(new Error("control channel could not write ACK")));
        }
        return;
      }
      cacheAck(sequence, verified.body.messageId, verified.digest, envelope);
      if (!isClosed() && resendAfterAck.delete(sequence)) {
        enqueueEnvelope(envelope);
      }
    } catch (error) {
      if (!isClosed()) {
        close("handler_error", asError(error));
      }
    } finally {
      active -= 1;
      inFlight.delete(sequence);
    }
  }

  return Object.freeze({
    handle(verified) {
      if (isClosed()) {
        return;
      }
      if (active >= maxIncomingRequests) {
        close(
          "incoming_overflow",
          asError(new Error("control channel concurrent handler budget is exhausted")),
        );
        return;
      }
      active += 1;
      inFlight.add(verified.body.sequence);
      void run(verified);
    },
    isInFlight(sequence) {
      return inFlight.has(sequence);
    },
    requestResend(sequence) {
      if (inFlight.has(sequence)) {
        resendAfterAck.add(sequence);
      }
    },
    clear() {
      inFlight.clear();
      resendAfterAck.clear();
    },
  });
}
