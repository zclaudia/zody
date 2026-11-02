import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const NATIVE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-peer-diagnostic",
);
export const OUTPUT_ROOT = join(REPO_ROOT, "output", "cua-helper-round10", "native-work");
export const FIXED_SDK = "macosx27.0";
export const FIXED_SDK_VERSION = "27.0";
export const FIXED_ARCH = "arm64";
export const FIXED_DEPLOYMENT_TARGET = "14.2";
export const NATIVE_BINARY_NAME = "macos-cua-peer-diagnostic";
export const BUILD_MANIFEST_KIND = "zody-cua-peer-diagnostic-build";
export const TEST_REPORT_KIND = "zody-cua-peer-diagnostic-test";
export const SYNTHETIC_BUNDLE_ID = "io.github.zclaudia.zody.cua-peer-diagnostic-test";
export const PROFILE_MAX_BYTES = 1024 * 1024;

export const NATIVE_SOURCE_FILES = Object.freeze([
  "README.md",
  "PROVENANCE.md",
  "LICENSE",
  "src/main.mm",
  "src/cli_common.h",
  "src/cli_common.mm",
  "src/serve_mode.mm",
  "src/client_modes.mm",
  "src/pure_mode.mm",
  "src/peer_socket.h",
  "src/peer_socket.mm",
  "src/peer_internal.h",
  "src/peer_frame.mm",
  "src/profile.h",
  "src/profile.mm",
  "src/calibration_profile.h",
  "src/calibration_profile.mm",
  "src/policy.h",
  "src/policy.mm",
  "src/pure_policy.h",
  "src/pure_policy.mm",
  "src/security_identity.h",
  "src/security_identity.mm",
  "src/macho_artifact.h",
  "src/macho_artifact.mm",
  "src/static_artifact.h",
  "src/static_artifact.mm",
  "src/report.h",
  "src/report.mm",
]);

export class PeerDiagnosticBlockedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PeerDiagnosticBlockedError";
    this.code = code;
    this.details = details;
  }
}

export class PeerDiagnosticFailureError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "PeerDiagnosticFailureError";
    this.details = details;
  }
}

export function diagnosticSafetyFields() {
  return {
    diagnosticOnly: true,
    grant: false,
    nativeCapabilityProven: false,
    runtimeConsumable: false,
    productHook: false,
  };
}

export function isPathInside(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export function toHex(buffer) {
  return Buffer.from(buffer).toString("hex");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function ensureOwnedDirectory(path, mode = 0o700) {
  await mkdir(path, { recursive: true, mode });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`not an owned directory: ${path}`);
  }
  if (info.uid !== process.geteuid()) {
    throw new Error(`directory is not owned by the current user: ${path}`);
  }
  return info;
}

export async function writeJsonAtomic(path, value, mode = 0o600) {
  await ensureOwnedDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function writeTextAtomic(path, text, mode = 0o600) {
  await ensureOwnedDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function parseVersionParts(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){0,2}$/.test(value)) {
    return null;
  }
  return value.split(".").map((part) => Number(part));
}

export function compareVersions(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) {
    return null;
  }
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function normalizeVersion(value) {
  const parts = parseVersionParts(value);
  if (!parts) {
    return null;
  }
  while (parts.length > 2 && parts[parts.length - 1] === 0) {
    parts.pop();
  }
  return parts.join(".");
}

export function summarizeCommand(command, args) {
  return [command, ...args].join(" ");
}

export function nowIso() {
  return new Date().toISOString();
}
