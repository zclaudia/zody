import { KeyObject, createPrivateKey, createPublicKey } from "node:crypto";
import { Socket } from "node:net";

import { CONTROL_LIMITS, createControlReplayWindow } from "./control-protocol.js";
import { ControlChannelError } from "./control-channel-errors.js";
import { CONTROL_CHANNEL_LIMITS } from "./control-channel-limits.js";
import { readStrictEntries } from "./control-protocol-json.js";
import { readIdentifier } from "./control-protocol-schema.js";

const OPTION_KEYS = new Set([
  "duplex",
  "role",
  "binding",
  "keyId",
  "privateKey",
  "trustedKeys",
  "onRequest",
  "onClosed",
  "replayWindowSize",
  "maxPendingRequests",
  "maxIncomingRequests",
  "maxAckCache",
  "maxFrameBytes",
  "maxOutboundBytes",
  "requestTimeoutMs",
]);

function invalid(message) {
  throw new ControlChannelError("invalid_options", message);
}

function readOptions(value) {
  let entries;
  try {
    entries = readStrictEntries(value, "control channel options");
  } catch (error) {
    throw new ControlChannelError("invalid_options", "control channel options are not safe", {
      cause: error,
    });
  }
  const fields = Object.create(null);
  for (const [key, item] of entries) {
    if (!OPTION_KEYS.has(key)) {
      invalid(`control channel options has an unknown key: ${String(key)}`);
    }
    fields[key] = item;
  }
  return fields;
}

function readRole(value) {
  if (value !== "controller" && value !== "producer") {
    invalid("role must be controller or producer");
  }
  return value;
}

function readDuplex(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.on !== "function" ||
    typeof value.off !== "function" ||
    typeof value.write !== "function" ||
    typeof value.destroy !== "function"
  ) {
    invalid("duplex must be a connected Node Duplex");
  }
  const readableState = value._readableState;
  const writableState = value._writableState;
  const hasEmitClose = readableState?.emitClose === true && writableState?.emitClose === true;
  const isNetSocket = value instanceof Socket;
  if (
    readableState === null ||
    typeof readableState !== "object" ||
    writableState === null ||
    typeof writableState !== "object" ||
    (!hasEmitClose && !isNetSocket)
  ) {
    invalid("duplex must be a standard Node Duplex with emitClose enabled");
  }
  return value;
}

function readKeyId(value) {
  try {
    return readIdentifier(value, "keyId");
  } catch (error) {
    throw new ControlChannelError("invalid_options", "keyId is not a supported identifier", {
      cause: error,
    });
  }
}

function readPrivateKey(value) {
  let key;
  try {
    key = value instanceof KeyObject ? value : createPrivateKey(value);
  } catch (error) {
    throw new ControlChannelError("invalid_options", "privateKey is not an Ed25519 private key", {
      cause: error,
    });
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    invalid("privateKey must be an Ed25519 private key");
  }
  return key;
}

function readTrustedPublicKey(keyId, raw) {
  if (raw instanceof KeyObject) {
    if (raw.type !== "public" || raw.asymmetricKeyType !== "ed25519") {
      invalid(`trustedKeys.${keyId} must be an Ed25519 public key`);
    }
    return raw;
  }
  try {
    createPrivateKey(raw);
    invalid("trustedKeys must not contain private key material");
  } catch (error) {
    if (error instanceof ControlChannelError) {
      throw error;
    }
  }
  let key;
  try {
    key = createPublicKey(raw);
  } catch (error) {
    throw new ControlChannelError(
      "invalid_options",
      `trustedKeys.${keyId} is not a valid public key`,
      { cause: error },
    );
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    invalid(`trustedKeys.${keyId} must be an Ed25519 public key`);
  }
  return key;
}

function readTrustStore(value) {
  let entries;
  try {
    entries = readStrictEntries(value, "trustedKeys");
  } catch (error) {
    throw new ControlChannelError("invalid_options", "trustedKeys is not a safe record", {
      cause: error,
    });
  }
  if (entries.length === 0) {
    invalid("trustedKeys must not be empty");
  }
  const trusted = Object.create(null);
  for (const [keyId, raw] of entries) {
    let normalizedKeyId;
    try {
      normalizedKeyId = readIdentifier(keyId, "trustedKeys keyId");
    } catch (error) {
      throw new ControlChannelError("invalid_options", "trustedKeys has an invalid keyId", {
        cause: error,
      });
    }
    trusted[normalizedKeyId] = readTrustedPublicKey(normalizedKeyId, raw);
  }
  return Object.freeze(trusted);
}

function readBoundedInteger(value, fallback, min, max, name) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function readCallback(value, name, required) {
  if (value === undefined && !required) {
    return null;
  }
  if (typeof value !== "function") {
    invalid(`${name} must be a function`);
  }
  return value;
}

export function directionsForRole(role) {
  if (role === "controller") {
    return { outgoing: "controller_to_producer", incoming: "producer_to_controller" };
  }
  return { outgoing: "producer_to_controller", incoming: "controller_to_producer" };
}

export function normalizeControlChannelOptions(value) {
  const fields = readOptions(value);
  const role = readRole(fields.role);
  const directions = directionsForRole(role);
  const replayWindowSize = readBoundedInteger(
    fields.replayWindowSize,
    CONTROL_LIMITS.defaultReplayWindow,
    CONTROL_LIMITS.minReplayWindow,
    CONTROL_LIMITS.maxReplayWindow,
    "replayWindowSize",
  );
  const maxPendingRequests = readBoundedInteger(
    fields.maxPendingRequests,
    CONTROL_CHANNEL_LIMITS.defaultPendingRequests,
    CONTROL_CHANNEL_LIMITS.minPendingRequests,
    CONTROL_CHANNEL_LIMITS.maxPendingRequests,
    "maxPendingRequests",
  );
  const maxIncomingRequests = readBoundedInteger(
    fields.maxIncomingRequests,
    CONTROL_CHANNEL_LIMITS.defaultIncomingRequests,
    CONTROL_CHANNEL_LIMITS.minIncomingRequests,
    CONTROL_CHANNEL_LIMITS.maxIncomingRequests,
    "maxIncomingRequests",
  );
  const maxAckCache = readBoundedInteger(
    fields.maxAckCache,
    Math.min(CONTROL_CHANNEL_LIMITS.defaultAckCache, replayWindowSize),
    CONTROL_CHANNEL_LIMITS.minAckCache,
    CONTROL_CHANNEL_LIMITS.maxAckCache,
    "maxAckCache",
  );
  const maxFrameBytes = readBoundedInteger(
    fields.maxFrameBytes,
    CONTROL_CHANNEL_LIMITS.defaultFrameBytes,
    CONTROL_CHANNEL_LIMITS.minFrameBytes,
    CONTROL_CHANNEL_LIMITS.maxFrameBytes,
    "maxFrameBytes",
  );
  const maxOutboundBytes = readBoundedInteger(
    fields.maxOutboundBytes,
    Math.max(CONTROL_CHANNEL_LIMITS.defaultOutboundBytes, maxFrameBytes),
    CONTROL_CHANNEL_LIMITS.minOutboundBytes,
    CONTROL_CHANNEL_LIMITS.maxOutboundBytes,
    "maxOutboundBytes",
  );
  if (maxOutboundBytes < maxFrameBytes) {
    invalid("maxOutboundBytes must be at least maxFrameBytes");
  }
  const requestTimeoutMs = readBoundedInteger(
    fields.requestTimeoutMs,
    CONTROL_CHANNEL_LIMITS.defaultRequestTimeoutMs,
    CONTROL_CHANNEL_LIMITS.minRequestTimeoutMs,
    CONTROL_CHANNEL_LIMITS.maxRequestTimeoutMs,
    "requestTimeoutMs",
  );
  let replay;
  try {
    replay = createControlReplayWindow({
      windowSize: replayWindowSize,
      binding: fields.binding,
      direction: directions.incoming,
    });
  } catch (error) {
    throw new ControlChannelError("invalid_options", "binding is not a valid control binding", {
      cause: error,
    });
  }
  return Object.freeze({
    duplex: readDuplex(fields.duplex),
    role,
    directions: Object.freeze(directions),
    binding: replay.binding,
    keyId: readKeyId(fields.keyId),
    privateKey: readPrivateKey(fields.privateKey),
    trustedKeys: readTrustStore(fields.trustedKeys),
    onRequest: readCallback(fields.onRequest, "onRequest", true),
    onClosed: readCallback(fields.onClosed, "onClosed", false),
    replayWindowSize,
    maxPendingRequests,
    maxIncomingRequests,
    maxAckCache,
    maxFrameBytes,
    maxOutboundBytes,
    requestTimeoutMs,
  });
}
