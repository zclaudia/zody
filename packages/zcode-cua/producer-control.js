import { readStrictEntries } from "./control-protocol-json.js";
import { applyControlRevocation, createControlRevocation } from "./control-protocol-revocation.js";

const OPTION_KEYS = new Set(["maxLineages"]);
const OPERATIONS = new Set(["revoke_submission", "stop"]);
const UNKNOWN_STOP_FACTS = Object.freeze({
  nativeFenced: false,
  pending: true,
  ownedInputsReleased: false,
  leaseReleased: false,
});

export const PRODUCER_CONTROL_LIMITS = Object.freeze({
  minLineages: 1,
  defaultLineages: 256,
  maxLineages: 4096,
});

export class ProducerControlError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProducerControlError";
    this.code = code;
  }
}

function invalidOptions(message, cause) {
  throw new ProducerControlError("invalid_options", message, { cause });
}

function invalidRequest(message) {
  throw new ProducerControlError("invalid_request", message);
}

function readOptions(value) {
  if (value === undefined) {
    return {};
  }
  let entries;
  try {
    entries = readStrictEntries(value, "producer control options");
  } catch (error) {
    invalidOptions("producer control options are not safe", error);
  }
  const fields = Object.create(null);
  for (const [key, item] of entries) {
    if (!OPTION_KEYS.has(key)) {
      invalidOptions(`producer control options has an unknown key: ${String(key)}`);
    }
    fields[key] = item;
  }
  return fields;
}

function readMaxLineages(value) {
  if (value === undefined) {
    return PRODUCER_CONTROL_LIMITS.defaultLineages;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < PRODUCER_CONTROL_LIMITS.minLineages ||
    value > PRODUCER_CONTROL_LIMITS.maxLineages
  ) {
    invalidOptions(
      `maxLineages must be an integer in ${PRODUCER_CONTROL_LIMITS.minLineages}..${PRODUCER_CONTROL_LIMITS.maxLineages}`,
    );
  }
  return value;
}

function readRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    invalidRequest("producer control request must be an endpoint-verified request");
  }
  const body = request.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    invalidRequest("producer control request body is missing");
  }
  if (body.kind !== "request" || body.direction !== "controller_to_producer") {
    invalidRequest("producer control only accepts controller_to_producer requests");
  }
  const payload = body.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    invalidRequest("producer control request payload is missing");
  }
  const operation = payload.operation;
  if (!OPERATIONS.has(operation)) {
    invalidRequest("producer control only accepts revoke_submission or stop");
  }
  if (typeof body.submissionLineageId !== "string" || body.submissionLineageId.length === 0) {
    invalidRequest("producer control request lineage is invalid");
  }
  if (
    typeof body.authorizationRevision !== "number" ||
    !Number.isSafeInteger(body.authorizationRevision) ||
    body.authorizationRevision <= 0
  ) {
    invalidRequest("producer control request revision is invalid");
  }
  return { body, operation };
}

function stopFacts() {
  return { ...UNKNOWN_STOP_FACTS };
}

function result(phase, projection, revoked, operation) {
  return {
    phase,
    facts: {
      projection,
      revoked,
      stop: operation === "stop" ? stopFacts() : null,
    },
  };
}

export function createProducerControlOwner(rawOptions) {
  const options = readOptions(rawOptions);
  const maxLineages = readMaxLineages(options.maxLineages);
  const lineages = new Map();
  let closed = false;
  let admissionClosed = false;

  function latchAdmissionClosed() {
    admissionClosed = true;
    for (const record of lineages.values()) {
      record.admissionClosed = true;
    }
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    latchAdmissionClosed();
  }

  function rejectedClosed(body) {
    const record = lineages.get(body.submissionLineageId);
    return result(
      "rejected",
      { admissionClosed: true, projectionApplied: false },
      {
        authorizationRevoked:
          record?.revocation.revoked === true &&
          record.revocation.authorizationRevision === body.authorizationRevision,
      },
      body.payload.operation,
    );
  }

  function rejectedCapacity(operation) {
    latchAdmissionClosed();
    return result(
      "rejected",
      { admissionClosed: true, projectionApplied: false },
      { authorizationRevoked: false },
      operation,
    );
  }

  function rejectedRevision(record, body) {
    return result(
      "rejected",
      {
        admissionClosed: record.admissionClosed,
        projectionApplied: record.admissionClosed,
      },
      {
        authorizationRevoked:
          record.revocation.revoked &&
          record.revocation.authorizationRevision === body.authorizationRevision,
      },
      body.payload.operation,
    );
  }

  function createRecord(body) {
    return {
      revocation: createControlRevocation({
        submissionLineageId: body.submissionLineageId,
        authorizationRevision: body.authorizationRevision,
      }),
      admissionClosed: false,
      stopPending: false,
      observedRevision: body.authorizationRevision,
    };
  }

  function handleRevoke(body) {
    let record = lineages.get(body.submissionLineageId);
    const isNew = record === undefined;
    if (isNew) {
      if (lineages.size >= maxLineages) {
        return rejectedCapacity("revoke_submission");
      }
      record = createRecord(body);
    } else if (body.authorizationRevision < record.observedRevision) {
      return rejectedRevision(record, body);
    }

    const applied = applyControlRevocation(record.revocation, {
      submissionLineageId: body.submissionLineageId,
      authorizationRevision: body.authorizationRevision,
    });
    record.revocation = applied.state;
    record.observedRevision = Math.max(record.observedRevision, body.authorizationRevision);
    if (applied.reason !== "stale_revision") {
      record.admissionClosed = true;
    }
    if (isNew) {
      lineages.set(body.submissionLineageId, record);
    }

    const phase = applied.reason === "stale_revision" ? "rejected" : "revoked";
    return result(
      phase,
      {
        admissionClosed: record.admissionClosed,
        projectionApplied: record.admissionClosed,
      },
      {
        authorizationRevoked:
          record.revocation.revoked &&
          record.revocation.authorizationRevision === body.authorizationRevision,
      },
      "revoke_submission",
    );
  }

  function handleStop(body) {
    let record = lineages.get(body.submissionLineageId);
    if (record === undefined) {
      if (lineages.size >= maxLineages) {
        return rejectedCapacity("stop");
      }
      record = {
        revocation: createControlRevocation({
          submissionLineageId: body.submissionLineageId,
          authorizationRevision: body.authorizationRevision,
        }),
        admissionClosed: true,
        stopPending: true,
        observedRevision: body.authorizationRevision,
      };
      lineages.set(body.submissionLineageId, record);
    } else {
      if (body.authorizationRevision < record.observedRevision) {
        return rejectedRevision(record, body);
      }
      record.observedRevision = Math.max(record.observedRevision, body.authorizationRevision);
      record.admissionClosed = true;
      record.stopPending = true;
    }

    return result(
      "stop_pending",
      { admissionClosed: true, projectionApplied: true },
      {
        authorizationRevoked:
          record.revocation.revoked &&
          record.revocation.authorizationRevision === body.authorizationRevision,
      },
      "stop",
    );
  }

  return Object.freeze({
    get closed() {
      return closed;
    },
    onRequest(request) {
      const { body, operation } = readRequest(request);
      if (closed) {
        return rejectedClosed(body);
      }
      return operation === "revoke_submission" ? handleRevoke(body) : handleStop(body);
    },
    close,
    dispose: close,
    diagnostics() {
      const lineagesSnapshot = [];
      let revokedLineageCount = 0;
      let stopPendingLineageCount = 0;
      for (const [submissionLineageId, record] of lineages) {
        const authorizationRevoked = record.revocation.revoked;
        if (authorizationRevoked) {
          revokedLineageCount += 1;
        }
        if (record.stopPending) {
          stopPendingLineageCount += 1;
        }
        lineagesSnapshot.push(
          Object.freeze({
            submissionLineageId,
            authorizationRevision: record.revocation.authorizationRevision,
            observedRevision: record.observedRevision,
            authorizationRevoked,
            admissionClosed: record.admissionClosed,
            stopPending: record.stopPending,
            nativeFence: "unknown",
          }),
        );
      }
      return Object.freeze({
        closed,
        admissionClosed,
        executableAdmission: false,
        nativeHelper: "unavailable",
        nativeFence: "unknown",
        candidateIsGrant: false,
        maxLineages,
        lineageCount: lineages.size,
        revokedLineageCount,
        stopPendingLineageCount,
        lineages: Object.freeze(lineagesSnapshot),
      });
    },
  });
}
