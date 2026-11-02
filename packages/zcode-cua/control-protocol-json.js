import { createHash } from "node:crypto";

import { CONTROL_DIGEST_DOMAIN, CONTROL_LIMITS, fail } from "./control-protocol-limits.js";

const FORBIDDEN_KEYS = new Set(["__proto__"]);

export function descriptorOf(value, key, path) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("unsafe_object", `${path}.${key} could not be inspected`);
  }
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    fail("unsafe_object", `${path}.${key} must be an enumerable data property`);
  }
  return descriptor;
}

export function ownKeysOf(value, path, maxKeys = CONTROL_LIMITS.maxObjectKeys) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 0) {
    fail("invalid_schema", `${path} has an invalid key budget`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("unsafe_object", `${path} could not be inspected`);
  }
  if (keys.length > maxKeys) {
    fail("limit_exceeded", `${path} has too many own keys`);
  }
  return keys;
}

export function assertPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_schema", `${path} must be a plain object`);
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("unsafe_object", `${path} has no inspectable prototype`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("unsafe_object", `${path} must not use a custom prototype`);
  }
}

export function readStrictEntries(value, path) {
  assertPlainObject(value, path);
  const keys = ownKeysOf(value, path);
  const entries = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      fail("unsafe_object", `${path} must not contain symbol keys`);
    }
    if (FORBIDDEN_KEYS.has(key)) {
      fail("unsafe_object", `${path}.${key} is forbidden`);
    }
    entries.push([key, descriptorOf(value, key, path).value]);
  }
  return entries;
}

export function readStrictObject(value, expectedKeys, path) {
  const entries = readStrictEntries(value, path);
  const actual = entries.map(([key]) => key).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("invalid_schema", `${path} has unexpected or missing keys`);
  }
  const result = Object.create(null);
  for (const [key, item] of entries) {
    result[key] = item;
  }
  return result;
}

export function readStrictArray(value, path, maxLength = CONTROL_LIMITS.maxArrayLength) {
  if (!Array.isArray(value)) {
    fail("invalid_schema", `${path} must be an array`);
  }
  if (
    !Number.isSafeInteger(maxLength) ||
    maxLength < 0 ||
    maxLength > CONTROL_LIMITS.maxReplayRecords
  ) {
    fail("invalid_schema", `${path} has an invalid array budget`);
  }
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > maxLength) {
    fail("limit_exceeded", `${path} has an unsupported length`);
  }
  const keys = ownKeysOf(value, path, maxLength + 1);
  const result = Array.from({ length });
  const seen = new Set();
  for (const key of keys) {
    if (key === "length") {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.value !== length) {
        fail("unsafe_object", `${path}.length is inconsistent`);
      }
      continue;
    }
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
      fail("unsafe_object", `${path} has a non-index own property`);
    }
    const index = Number(key);
    if (index >= length) {
      fail("unsafe_object", `${path} has an out-of-range index`);
    }
    result[index] = descriptorOf(value, key, path).value;
    seen.add(index);
  }
  if (seen.size !== length) {
    fail("unsafe_object", `${path} must be dense`);
  }
  return result;
}

export function assertWellFormedString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("invalid_schema", `${path} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("invalid_schema", `${path} contains an unpaired surrogate`);
    }
  }
}

function assertStringBounds(value, path) {
  assertWellFormedString(value, path);
  if (Buffer.byteLength(value, "utf8") > CONTROL_LIMITS.maxStringBytes) {
    fail("limit_exceeded", `${path} is too long`);
  }
}

class CanonicalWriter {
  constructor() {
    this.parts = [];
    this.bytes = 0;
    this.nodes = 0;
  }

  add(text, nodeCount = 0) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.bytes + bytes > CONTROL_LIMITS.maxCanonicalBytes) {
      fail("limit_exceeded", "canonical JSON exceeds its byte budget");
    }
    if (this.nodes + nodeCount > CONTROL_LIMITS.maxCanonicalNodes) {
      fail("limit_exceeded", "canonical JSON exceeds its node budget");
    }
    this.bytes += bytes;
    this.nodes += nodeCount;
    this.parts.push(text);
  }

  toString() {
    return this.parts.join("");
  }
}

function writeCanonicalValue(value, depth, stack, path, writer) {
  if (depth > CONTROL_LIMITS.maxDepth) {
    fail("limit_exceeded", `${path} exceeds the maximum depth`);
  }
  if (value === null) {
    writer.add("null", 1);
    return;
  }
  switch (typeof value) {
    case "boolean":
      writer.add(value ? "true" : "false", 1);
      return;
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        fail("invalid_schema", `${path} must be a safe integer other than -0`);
      }
      writer.add(String(value), 1);
      return;
    case "string":
      assertStringBounds(value, path);
      writer.add(JSON.stringify(value), 1);
      return;
    case "object":
      break;
    default:
      fail("invalid_schema", `${path} has an unsupported value type`);
  }
  if (stack.has(value)) {
    fail("unsafe_object", `${path} contains a cycle`);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items = readStrictArray(value, path);
      writer.add("[", 1);
      for (let index = 0; index < items.length; index += 1) {
        if (index > 0) {
          writer.add(",");
        }
        writeCanonicalValue(items[index], depth + 1, stack, `${path}[${index}]`, writer);
      }
      writer.add("]");
      return;
    }
    const keys = ownKeysOf(value, path);
    const fields = readStrictObject(value, keys, path);
    const sorted = Object.keys(fields).sort();
    writer.add("{", 1);
    for (let index = 0; index < sorted.length; index += 1) {
      const key = sorted[index];
      assertStringBounds(key, `${path} key`);
      if (index > 0) {
        writer.add(",");
      }
      writer.add(`${JSON.stringify(key)}:`, 1);
      writeCanonicalValue(fields[key], depth + 1, stack, `${path}.${key}`, writer);
    }
    writer.add("}");
  } finally {
    stack.delete(value);
  }
}

export function canonicalizeControlJson(value) {
  const writer = new CanonicalWriter();
  writeCanonicalValue(value, 0, new Set(), "value", writer);
  return writer.toString();
}

export function sha256Hex(domain, canonical) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}

export function digestControlPayload(value) {
  return sha256Hex(CONTROL_DIGEST_DOMAIN, canonicalizeControlJson(value));
}

function cloneControlValue(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneControlValue);
  }
  const result = {};
  for (const key of Object.keys(value)) {
    result[key] = cloneControlValue(value[key]);
  }
  return result;
}

function freezeControlValue(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      freezeControlValue(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function immutableControlValue(value) {
  return freezeControlValue(cloneControlValue(value));
}
