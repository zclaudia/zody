// Shared normalization primitives for the normal Host candidate build profile.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { NarrowResourceError } from "../macos-cua-narrow-resources-base.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new NarrowResourceError("normal-host-profile-digest", `${label} must be sha256`);
  }
  return value;
}

export function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(nonEmptyString).filter((entry) => entry !== null);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function readJsonFile(path, label) {
  if (!isAbsolute(path)) {
    throw new NarrowResourceError(`${label}-path`, `${label} must be an absolute path`);
  }
  let parsed;
  try {
    parsed = JSON.parse((await readFile(path)).toString("utf8"));
  } catch (error) {
    throw new NarrowResourceError(
      `${label}-json`,
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NarrowResourceError(`${label}-shape`, `${label} must be a JSON object`);
  }
  return parsed;
}
