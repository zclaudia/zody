import { ControlChannelError } from "./control-channel-errors.js";
import { isAbortSignal } from "./control-channel-codec.js";
import { readStrictEntries } from "./control-protocol-json.js";

const REQUEST_INPUT_KEYS = new Set([
  "operation",
  "submissionLineageId",
  "authorizationRevision",
  "signal",
]);

function readRequestInput(input) {
  let entries;
  try {
    entries = readStrictEntries(input, "request input");
  } catch (error) {
    throw new ControlChannelError("invalid_request", "request input is not a plain object", {
      cause: error,
    });
  }
  const fields = Object.create(null);
  for (const [key, value] of entries) {
    if (!REQUEST_INPUT_KEYS.has(key)) {
      throw new ControlChannelError(
        "invalid_request",
        `request input has an unknown key: ${String(key)}`,
      );
    }
    fields[key] = value;
  }
  if (fields.signal !== undefined && !isAbortSignal(fields.signal)) {
    throw new ControlChannelError("invalid_request", "request signal is not an AbortSignal");
  }
  return fields;
}

export function createControlRequestSender({
  createRequest,
  privateKey,
  keyId,
  role,
  direction,
  binding,
  pending,
  maxPendingRequests,
  requestTimeoutMs,
  enqueueEnvelope,
  close,
  closedError,
  getSequence,
  commitSequence,
  isClosed,
}) {
  return function request(input) {
    return new Promise((resolve, reject) => {
      if (isClosed()) {
        reject(closedError());
        return;
      }
      let fields;
      try {
        fields = readRequestInput(input);
      } catch (error) {
        reject(error);
        return;
      }
      const signal = fields.signal;
      if (signal !== undefined && signal.aborted) {
        reject(new ControlChannelError("request_aborted", "request was aborted before sending"));
        return;
      }
      if (pending.size >= maxPendingRequests) {
        reject(
          new ControlChannelError(
            "pending_overflow",
            "control channel pending request budget is exhausted",
          ),
        );
        return;
      }
      const sequence = getSequence();
      if (!Number.isSafeInteger(sequence)) {
        reject(
          new ControlChannelError(
            "sequence_exhausted",
            "control channel outbound sequence is exhausted",
          ),
        );
        return;
      }
      let envelope;
      try {
        envelope = createRequest(
          {
            keyId,
            direction,
            binding,
            messageId: `${role}-request-${sequence}`,
            sequence,
            submissionLineageId: fields.submissionLineageId,
            authorizationRevision: fields.authorizationRevision,
            operation: fields.operation,
          },
          privateKey,
        );
      } catch (error) {
        reject(error);
        return;
      }
      commitSequence(sequence);
      const entry = {
        body: envelope.body,
        resolve,
        reject,
        signal: signal ?? null,
        onAbort: null,
        timer: null,
      };
      pending.set(envelope.body.messageId, entry);
      entry.timer = setTimeout(() => {
        close(
          "request_timeout",
          new ControlChannelError("request_timeout", "control channel request timed out"),
        );
      }, requestTimeoutMs);
      if (signal !== undefined) {
        entry.onAbort = () => {
          close(
            "request_aborted",
            new ControlChannelError("request_aborted", "control channel request was aborted"),
          );
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      if (!enqueueEnvelope(envelope) && !isClosed()) {
        close(
          "transport_error",
          new ControlChannelError("write_failed", "control channel could not write request"),
        );
      }
    });
  };
}
