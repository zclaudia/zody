import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { commandFailureSummary } from "./cua-helper-local-commands.mjs";

export function addCheck(checks, id, status, message, details) {
  const check = { id, status, message };
  if (details !== undefined) {
    check.details = details;
  }
  checks.push(check);
}

export function isSafeAbsolutePath(value) {
  return (
    typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value)
  );
}

export function isSafeExecutableName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== "." &&
    value !== ".."
  );
}

export function isPathInside(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export async function statSafe(path) {
  try {
    return { ok: true, stats: await stat(path) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function readText(path) {
  try {
    return { ok: true, text: await readFile(path, "utf8") };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function safeRealpath(path) {
  try {
    return { ok: true, path: await realpath(path) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function blockedForMissing(result, command) {
  return result.status === "missing"
    ? `missing required command: ${command}`
    : commandFailureSummary(result, command);
}

export async function hashFile(path) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    return { ok: true, sha256: hash.digest("hex") };
  } catch (error) {
    return { ok: false, error };
  }
}

export function parseJsonObject(text, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof text !== "string") {
    return { ok: false, error: "JSON text is not a string" };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, error: `JSON text exceeds ${maxBytes} bytes` };
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "JSON root is not an object" };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${errorMessage(error)}` };
  }
}
