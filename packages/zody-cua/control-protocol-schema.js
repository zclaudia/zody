import { CONTROL_LIMITS, fail } from "./control-protocol-limits.js";
import {
  assertWellFormedString,
  descriptorOf,
  digestControlPayload,
  readStrictObject,
} from "./control-protocol-json.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const HEX64_PATTERN = /^[a-f0-9]{64}$/;

const BINDING_KEYS = [
  "channelId",
  "controllerIncarnation",
  "producerIncarnation",
  "appIncarnation",
];
const REQUEST_KEYS = [
  "keyId",
  "kind",
  "direction",
  "binding",
  "messageId",
  "sequence",
  "submissionLineageId",
  "authorizationRevision",
  "payload",
  "payloadDigest",
];
const ACK_KEYS = [
  "keyId",
  "kind",
  "direction",
  "binding",
  "messageId",
  "sequence",
  "replyToMessageId",
  "replyToSequence",
  "replyToPayloadDigest",
  "submissionLineageId",
  "authorizationRevision",
  "phase",
  "facts",
];
const PROJECTION_KEYS = ["admissionClosed", "projectionApplied"];
const REVOKED_KEYS = ["authorizationRevoked"];
const STOP_FACT_KEYS = ["nativeFenced", "pending", "ownedInputsReleased", "leaseReleased"];
const FACTS_KEYS = ["projection", "revoked", "stop"];

export const OPERATIONS = new Set(["revoke_submission", "stop"]);
export const DIRECTIONS = new Set(["controller_to_producer", "producer_to_controller"]);
export const KINDS = new Set(["request", "ack"]);
export const OPERATION_DIRECTIONS = new Map([
  ["revoke_submission", new Set(["controller_to_producer", "producer_to_controller"])],
  ["stop", new Set(["controller_to_producer"])],
]);
export const OPPOSITE_DIRECTION = new Map([
  ["controller_to_producer", "producer_to_controller"],
  ["producer_to_controller", "controller_to_producer"],
]);
export const PHASES = new Set([
  "admission_closed",
  "projection_applied",
  "revoked",
  "stop_pending",
  "fenced",
  "drained",
  "unknown",
  "rejected",
  "retained_fault",
]);

export function readIdentifier(value, path) {
  if (typeof value !== "string") {
    fail("invalid_schema", `${path} must be a string`);
  }
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > CONTROL_LIMITS.maxIdentifierBytes) {
    fail("limit_exceeded", `${path} has an unsupported length`);
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    fail("invalid_schema", `${path} has unsupported characters`);
  }
  return value;
}

export function readOpaqueString(value, path) {
  if (typeof value !== "string") {
    fail("invalid_schema", `${path} must be a string`);
  }
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > CONTROL_LIMITS.maxIdentifierBytes) {
    fail("limit_exceeded", `${path} has an unsupported length`);
  }
  assertWellFormedString(value, path);
  if (value.includes("\0")) {
    fail("invalid_schema", `${path} must not contain NUL`);
  }
  return value;
}

export function readHex64(value, path) {
  if (typeof value !== "string" || !HEX64_PATTERN.test(value)) {
    fail("invalid_schema", `${path} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

export function readPositiveSafeInteger(value, path) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("invalid_schema", `${path} must be a positive safe integer`);
  }
  return value;
}

export function readNonNegativeSafeInteger(value, path) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid_schema", `${path} must be a non-negative safe integer`);
  }
  return value;
}

export function readBoolean(value, path) {
  if (typeof value !== "boolean") {
    fail("invalid_schema", `${path} must be a boolean`);
  }
  return value;
}

export function readEnum(value, allowed, path) {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail("invalid_schema", `${path} is not an allowed value`);
  }
  return value;
}

export function normalizeBinding(value, path) {
  const fields = readStrictObject(value, BINDING_KEYS, path);
  return {
    channelId: readIdentifier(fields.channelId, `${path}.channelId`),
    controllerIncarnation: readOpaqueString(
      fields.controllerIncarnation,
      `${path}.controllerIncarnation`,
    ),
    producerIncarnation: readOpaqueString(
      fields.producerIncarnation,
      `${path}.producerIncarnation`,
    ),
    appIncarnation: readOpaqueString(fields.appIncarnation, `${path}.appIncarnation`),
  };
}

function normalizeRequestPayload(value, path) {
  const fields = readStrictObject(value, ["operation"], path);
  return { operation: readEnum(fields.operation, OPERATIONS, `${path}.operation`) };
}

export function normalizeRequest(value, path) {
  const fields = readStrictObject(value, REQUEST_KEYS, path);
  const direction = readEnum(fields.direction, DIRECTIONS, `${path}.direction`);
  const payload = normalizeRequestPayload(fields.payload, `${path}.payload`);
  if (!OPERATION_DIRECTIONS.get(payload.operation).has(direction)) {
    fail("invalid_schema", `${path}.direction is not valid for ${payload.operation}`);
  }
  const request = {
    keyId: readIdentifier(fields.keyId, `${path}.keyId`),
    kind: readEnum(fields.kind, new Set(["request"]), `${path}.kind`),
    direction,
    binding: normalizeBinding(fields.binding, `${path}.binding`),
    messageId: readIdentifier(fields.messageId, `${path}.messageId`),
    sequence: readPositiveSafeInteger(fields.sequence, `${path}.sequence`),
    submissionLineageId: readIdentifier(fields.submissionLineageId, `${path}.submissionLineageId`),
    authorizationRevision: readPositiveSafeInteger(
      fields.authorizationRevision,
      `${path}.authorizationRevision`,
    ),
    payload,
    payloadDigest: readHex64(fields.payloadDigest, `${path}.payloadDigest`),
  };
  if (request.payloadDigest !== digestControlPayload(request.payload)) {
    fail("invalid_schema", `${path}.payloadDigest does not match payload`);
  }
  return request;
}

function normalizeStopFacts(value, path) {
  if (value === null) {
    return null;
  }
  const fields = readStrictObject(value, STOP_FACT_KEYS, path);
  return {
    nativeFenced: readBoolean(fields.nativeFenced, `${path}.nativeFenced`),
    pending: readBoolean(fields.pending, `${path}.pending`),
    ownedInputsReleased: readBoolean(fields.ownedInputsReleased, `${path}.ownedInputsReleased`),
    leaseReleased: readBoolean(fields.leaseReleased, `${path}.leaseReleased`),
  };
}

function normalizeAckFacts(value, path) {
  const fields = readStrictObject(value, FACTS_KEYS, path);
  const projection = readStrictObject(fields.projection, PROJECTION_KEYS, `${path}.projection`);
  const revoked = readStrictObject(fields.revoked, REVOKED_KEYS, `${path}.revoked`);
  return {
    projection: {
      admissionClosed: readBoolean(
        projection.admissionClosed,
        `${path}.projection.admissionClosed`,
      ),
      projectionApplied: readBoolean(
        projection.projectionApplied,
        `${path}.projection.projectionApplied`,
      ),
    },
    revoked: {
      authorizationRevoked: readBoolean(
        revoked.authorizationRevoked,
        `${path}.revoked.authorizationRevoked`,
      ),
    },
    stop: normalizeStopFacts(fields.stop, `${path}.stop`),
  };
}

export function normalizeAck(value, path) {
  const fields = readStrictObject(value, ACK_KEYS, path);
  return {
    keyId: readIdentifier(fields.keyId, `${path}.keyId`),
    kind: readEnum(fields.kind, new Set(["ack"]), `${path}.kind`),
    direction: readEnum(fields.direction, DIRECTIONS, `${path}.direction`),
    binding: normalizeBinding(fields.binding, `${path}.binding`),
    messageId: readIdentifier(fields.messageId, `${path}.messageId`),
    sequence: readPositiveSafeInteger(fields.sequence, `${path}.sequence`),
    replyToMessageId: readIdentifier(fields.replyToMessageId, `${path}.replyToMessageId`),
    replyToSequence: readPositiveSafeInteger(fields.replyToSequence, `${path}.replyToSequence`),
    replyToPayloadDigest: readHex64(fields.replyToPayloadDigest, `${path}.replyToPayloadDigest`),
    submissionLineageId: readIdentifier(fields.submissionLineageId, `${path}.submissionLineageId`),
    authorizationRevision: readPositiveSafeInteger(
      fields.authorizationRevision,
      `${path}.authorizationRevision`,
    ),
    phase: readEnum(fields.phase, PHASES, `${path}.phase`),
    facts: normalizeAckFacts(fields.facts, `${path}.facts`),
  };
}

function readBodyKind(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_schema", `${path} must be a plain object`);
  }
  const descriptor = descriptorOf(value, "kind", path);
  return descriptor.value;
}

export function normalizeBody(value, path) {
  const kind = readBodyKind(value, path);
  if (kind === "request") {
    return normalizeRequest(value, path);
  }
  if (kind === "ack") {
    return normalizeAck(value, path);
  }
  fail("invalid_schema", `${path}.kind must be request or ack`);
}
