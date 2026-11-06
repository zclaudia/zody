import {
  ControlProtocolError,
  admitControlSequence,
  verifyControlEnvelope,
} from "./control-protocol.js";
import { ControlChannelError, asError } from "./control-channel-errors.js";
import { readEnvelopeKindHint } from "./control-channel-codec.js";

export function createControlDispatcher({
  trustedKeys,
  binding,
  direction,
  getReplay,
  setReplay,
  onRequest,
  onAck,
  onDuplicate,
  close,
  isClosed,
}) {
  return Object.freeze({
    process(envelope) {
      if (isClosed()) {
        return;
      }
      try {
        const kind = readEnvelopeKindHint(envelope);
        if (kind === null) {
          throw new ControlProtocolError("invalid_schema", "control envelope has no known kind");
        }
        const verified = verifyControlEnvelope(envelope, {
          trustedKeys,
          expectedKind: kind,
          expectedDirection: direction,
          expectedBinding: binding,
        });
        const admitted = admitControlSequence(getReplay(), {
          sequence: verified.body.sequence,
          messageId: verified.body.messageId,
          bodyDigest: verified.digest,
          binding,
          direction,
        });
        if (admitted.decision === "exact") {
          setReplay(admitted.state);
          if (verified.body.kind === "request") {
            onRequest(verified);
          } else {
            onAck(verified);
          }
          return;
        }
        if (admitted.decision === "duplicate") {
          onDuplicate(verified);
          return;
        }
        close(
          new ControlChannelError(
            admitted.decision === "conflict" ? "sequence_conflict" : "sequence_stale",
            `control channel rejected ${admitted.decision} sequence ${verified.body.sequence}`,
          ),
        );
      } catch (error) {
        close(asError(error));
      }
    },
  });
}
