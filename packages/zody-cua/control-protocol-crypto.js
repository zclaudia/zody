import { KeyObject, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import {
  CONTROL_DIGEST_DOMAIN,
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SIGNATURE_DOMAIN,
  ControlProtocolError,
  fail,
} from "./control-protocol-limits.js";
import {
  canonicalizeControlJson,
  immutableControlValue,
  readStrictEntries,
  readStrictObject,
  sha256Hex,
} from "./control-protocol-json.js";
import {
  DIRECTIONS,
  KINDS,
  OPERATIONS,
  OPERATION_DIRECTIONS,
  normalizeBinding,
  normalizeBody,
  readEnum,
  readIdentifier,
  readPositiveSafeInteger,
} from "./control-protocol-schema.js";

const ENVELOPE_KEYS = ["protocol", "version", "body", "signature"];
const VERIFY_OPTION_KEYS = ["trustedKeys", "expectedKind", "expectedDirection", "expectedBinding"];
const CREATE_REQUEST_KEYS = [
  "keyId",
  "direction",
  "binding",
  "messageId",
  "sequence",
  "submissionLineageId",
  "authorizationRevision",
  "operation",
];
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

function readSignature(value, path) {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) {
    fail("invalid_schema", `${path} must be a base64url Ed25519 signature`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== value) {
    fail("invalid_schema", `${path} is not a canonical 64-byte signature`);
  }
  return value;
}

function normalizeEnvelope(value, path) {
  const fields = readStrictObject(value, ENVELOPE_KEYS, path);
  if (fields.protocol !== CONTROL_PROTOCOL) {
    fail("invalid_schema", `${path}.protocol is unsupported`);
  }
  if (fields.version !== CONTROL_PROTOCOL_VERSION) {
    fail("invalid_schema", `${path}.version is unsupported`);
  }
  return {
    protocol: CONTROL_PROTOCOL,
    version: CONTROL_PROTOCOL_VERSION,
    body: normalizeBody(fields.body, `${path}.body`),
    signature: readSignature(fields.signature, `${path}.signature`),
  };
}

function toPrivateKey(raw) {
  let key;
  try {
    key = raw instanceof KeyObject ? raw : createPrivateKey(raw);
  } catch {
    fail("invalid_signing_key", "signing key is not an Ed25519 private key");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("invalid_signing_key", "signing key must be an Ed25519 private key");
  }
  return key;
}

function toPublicKey(raw) {
  if (raw instanceof KeyObject) {
    if (raw.type !== "public" || raw.asymmetricKeyType !== "ed25519") {
      fail("invalid_trust_store", "trusted key must be an Ed25519 public key");
    }
    return raw;
  }
  try {
    createPrivateKey(raw);
    fail("invalid_trust_store", "trustedKeys must not contain private key material");
  } catch (error) {
    if (error instanceof ControlProtocolError) {
      throw error;
    }
  }
  let key;
  try {
    key = createPublicKey(raw);
  } catch {
    fail("invalid_trust_store", "trusted key is not a valid public key");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("invalid_trust_store", "trusted key must be an Ed25519 public key");
  }
  return key;
}

function readTrustStore(value) {
  const entries = readStrictEntries(value, "trustedKeys");
  if (entries.length === 0) {
    fail("invalid_trust_store", "trustedKeys must not be empty");
  }
  const trusted = new Map();
  for (const [key, raw] of entries) {
    readIdentifier(key, "trustedKeys keyId");
    trusted.set(key, toPublicKey(raw));
  }
  return trusted;
}

function signatureInput(digest) {
  return Buffer.concat([
    Buffer.from(`${CONTROL_SIGNATURE_DOMAIN}\0`, "utf8"),
    Buffer.from(digest, "utf8"),
  ]);
}

function bodyDigest(body) {
  return sha256Hex(CONTROL_DIGEST_DOMAIN, canonicalizeControlJson(body));
}

export function signControlBody(body, privateKey) {
  const key = toPrivateKey(privateKey);
  const normalized = normalizeBody(body, "body");
  const digest = bodyDigest(normalized);
  let signature;
  try {
    signature = sign(null, signatureInput(digest), key).toString("base64url");
  } catch {
    fail("invalid_signing_key", "signing key could not sign the body");
  }
  return Object.freeze({
    protocol: CONTROL_PROTOCOL,
    version: CONTROL_PROTOCOL_VERSION,
    body: immutableControlValue(normalized),
    signature,
  });
}

export function createControlRequest(input, privateKey) {
  const fields = readStrictObject(input, CREATE_REQUEST_KEYS, "request input");
  const direction = readEnum(fields.direction, DIRECTIONS, "request input.direction");
  const payload = {
    operation: readEnum(fields.operation, OPERATIONS, "request input.operation"),
  };
  if (!OPERATION_DIRECTIONS.get(payload.operation).has(direction)) {
    fail("invalid_schema", `request input.direction is not valid for ${payload.operation}`);
  }
  const body = {
    keyId: readIdentifier(fields.keyId, "request input.keyId"),
    kind: "request",
    direction,
    binding: normalizeBinding(fields.binding, "request input.binding"),
    messageId: readIdentifier(fields.messageId, "request input.messageId"),
    sequence: readPositiveSafeInteger(fields.sequence, "request input.sequence"),
    submissionLineageId: readIdentifier(
      fields.submissionLineageId,
      "request input.submissionLineageId",
    ),
    authorizationRevision: readPositiveSafeInteger(
      fields.authorizationRevision,
      "request input.authorizationRevision",
    ),
    payload,
    payloadDigest: sha256Hex(CONTROL_DIGEST_DOMAIN, canonicalizeControlJson(payload)),
  };
  return signControlBody(body, privateKey);
}

export function verifyControlEnvelope(envelope, options) {
  const fields = readStrictObject(options, VERIFY_OPTION_KEYS, "options");
  const trustedKeys = readTrustStore(fields.trustedKeys);
  const expectedKind = readEnum(fields.expectedKind, KINDS, "options.expectedKind");
  const expectedDirection = readEnum(
    fields.expectedDirection,
    DIRECTIONS,
    "options.expectedDirection",
  );
  const expectedBinding = normalizeBinding(fields.expectedBinding, "options.expectedBinding");
  const normalized = normalizeEnvelope(envelope, "envelope");
  const publicKey = trustedKeys.get(normalized.body.keyId);
  if (!publicKey) {
    fail("untrusted_key", "envelope keyId is not present in trustedKeys");
  }
  const digest = bodyDigest(normalized.body);
  let valid = false;
  try {
    valid = verify(
      null,
      signatureInput(digest),
      publicKey,
      Buffer.from(normalized.signature, "base64url"),
    );
  } catch {
    fail("invalid_signature", "signature could not be verified");
  }
  if (!valid) {
    fail("invalid_signature", "signature does not match the signed body");
  }
  if (normalized.body.kind !== expectedKind) {
    fail("binding_mismatch", "message kind does not match the expected kind");
  }
  if (normalized.body.direction !== expectedDirection) {
    fail("binding_mismatch", "message direction does not match the expected direction");
  }
  if (
    canonicalizeControlJson(normalized.body.binding) !== canonicalizeControlJson(expectedBinding)
  ) {
    fail("binding_mismatch", "message binding does not match the expected binding");
  }
  return Object.freeze({
    body: immutableControlValue(normalized.body),
    keyId: normalized.body.keyId,
    digest,
  });
}
