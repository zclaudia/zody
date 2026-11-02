import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const CLOSURE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-driver-closure",
);
export const DEFAULT_REVIEW_CONFIG = join(CLOSURE_ROOT, "review-config.json");
export const DEFAULT_SOURCE_MANIFEST = join(CLOSURE_ROOT, "source-manifest.json");
export const REVIEW_CONFIG_KIND = "zody-cua-driver-closure-review";
export const SOURCE_MANIFEST_KIND = "zody-cua-driver-closure-source-manifest";
export const REPORT_KIND = "zody-cua-driver-closure-report";

export class ClosureVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClosureVerificationError";
  }
}

export class ClosureBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClosureBlockedError";
    this.code = code;
  }
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  return sha256Buffer(Buffer.from(value, "utf8"));
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function isSafeExternalMemberPath(value) {
  if (typeof value !== "string" || !value.startsWith("../")) return false;
  const parts = value.slice(3).split("/");
  return (
    parts.length > 0 &&
    parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\"))
  );
}

export function isPathInside(rootPath, candidatePath) {
  const result = relative(rootPath, candidatePath);
  return (
    result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result))
  );
}

export async function readJsonFile(path, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const metadata = await stat(path);
  if (metadata.size > maxBytes) throw new ClosureVerificationError("JSON input exceeds size limit");
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes)
    throw new ClosureVerificationError("JSON input changed while reading");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ClosureVerificationError("invalid JSON input");
  }
}

export async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeBufferFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function requireString(object, key, label = key) {
  if (!isRecord(object) || typeof object[key] !== "string" || object[key].length === 0) {
    throw new ClosureVerificationError(`invalid ${label}`);
  }
}

function requireSafePath(object, key) {
  requireString(object, key);
  if (!isSafeRelativePath(object[key])) {
    throw new ClosureVerificationError(`${key} must be a safe relative path`);
  }
}

function requireCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ClosureVerificationError(`invalid ${label}`);
  }
}

function sortedUnique(values, label) {
  if (!Array.isArray(values)) throw new ClosureVerificationError(`invalid ${label}`);
  if (values.some((value) => !isSafeRelativePath(value))) {
    throw new ClosureVerificationError(`${label} must contain safe relative paths`);
  }
  if (new Set(values).size !== values.length) {
    throw new ClosureVerificationError(`${label} contains duplicates`);
  }
  return [...values].sort();
}

export function validateReviewConfig(config) {
  if (!isRecord(config) || config.schemaVersion !== 1 || config.kind !== REVIEW_CONFIG_KIND) {
    throw new ClosureVerificationError("invalid review configuration schema");
  }
  if (typeof config.revision !== "string" || !/^[a-f0-9]{40}$/.test(config.revision)) {
    throw new ClosureVerificationError("invalid fixed upstream revision");
  }
  requireSafePath(config, "sourceRoot");
  requireSafePath(config, "sourceManifest");
  requireSafePath(config, "upstreamLicensePath");
  if (!isRecord(config.expected)) throw new ClosureVerificationError("invalid expected counts");
  for (const key of ["selectedFiles", "changedFiles", "addedFiles", "candidateFiles"]) {
    requireCount(config.expected[key], `expected.${key}`);
  }
  if (!isRecord(config.allowedDelta)) throw new ClosureVerificationError("invalid allowedDelta");
  const modified = sortedUnique(config.allowedDelta.modified, "allowedDelta.modified");
  const added = sortedUnique(config.allowedDelta.added, "allowedDelta.added");
  const removed = sortedUnique(config.allowedDelta.removed, "allowedDelta.removed");
  if (removed.length > 0) {
    throw new ClosureVerificationError("source removals are not supported by this audit version");
  }
  const allDelta = [...modified, ...added, ...removed];
  if (new Set(allDelta).size !== allDelta.length) {
    throw new ClosureVerificationError("allowedDelta paths must not overlap");
  }
  const expectedCandidateFiles = config.expected.selectedFiles + added.length - removed.length;
  if (
    modified.length !== config.expected.changedFiles ||
    added.length !== config.expected.addedFiles ||
    removed.length !== 0 ||
    expectedCandidateFiles !== config.expected.candidateFiles
  ) {
    throw new ClosureVerificationError("allowedDelta does not match expected counts");
  }
  if (typeof config.package !== "string" || !/^[a-z0-9_-]+$/.test(config.package)) {
    throw new ClosureVerificationError("invalid audit package");
  }
  if (config.target !== "aarch64-apple-darwin") {
    throw new ClosureVerificationError("unsupported audit target");
  }
  const toolchain = config.toolchain;
  requireString(toolchain, "upstreamDeclared", "toolchain.upstreamDeclared");
  requireString(toolchain, "auditedVersion", "toolchain.auditedVersion");
  const policy = config.licensePolicy;
  if (
    !isRecord(policy) ||
    policy.selection !== "driver-required-mit-core-and-audited-dependency-closure" ||
    policy.automaticPolicyDecision !== false ||
    policy.mplHandling !== "record-materials-and-obligations-without-legal-determination"
  ) {
    throw new ClosureVerificationError("license policy must remain evidence-only");
  }
  if (config.workspaceExternalMembers !== undefined) {
    if (!Array.isArray(config.workspaceExternalMembers)) {
      throw new ClosureVerificationError("invalid workspaceExternalMembers");
    }
    for (const member of config.workspaceExternalMembers) {
      if (
        !isRecord(member) ||
        !isSafeExternalMemberPath(member.path) ||
        !Number.isInteger(member.expectedFiles) ||
        member.expectedFiles < 0 ||
        !isSha256(member.manifestSha256) ||
        !isSha256(member.treeSha256)
      ) {
        throw new ClosureVerificationError("invalid workspace external member");
      }
    }
  }
  return { ...config, allowedDelta: { modified, added, removed } };
}

export function validateSourceManifest(manifest, config) {
  validateReviewConfig(config);
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== SOURCE_MANIFEST_KIND ||
    manifest.revision !== config.revision ||
    manifest.sourceRoot !== config.sourceRoot ||
    !Array.isArray(manifest.files)
  ) {
    throw new ClosureVerificationError("invalid source manifest schema");
  }
  if (manifest.files.length !== config.expected.candidateFiles) {
    throw new ClosureVerificationError(
      "source manifest file count does not match review configuration",
    );
  }
  const seen = new Set();
  const counts = { modified: 0, added: 0, unchanged: 0 };
  for (const entry of manifest.files) {
    if (!isRecord(entry) || !isSafeRelativePath(entry.path) || seen.has(entry.path)) {
      throw new ClosureVerificationError("source manifest has an invalid or duplicate path");
    }
    seen.add(entry.path);
    if (!["modified", "added", "unchanged"].includes(entry.status)) {
      throw new ClosureVerificationError(`invalid source status for ${entry.path}`);
    }
    counts[entry.status] += 1;
    if (entry.status !== "added" && !isSha256(entry.upstreamSha256)) {
      throw new ClosureVerificationError(`missing upstream hash for ${entry.path}`);
    }
    if (!isSha256(entry.candidateSha256)) {
      throw new ClosureVerificationError(`missing candidate hash for ${entry.path}`);
    }
    if (entry.status === "added" && entry.upstreamSha256 !== undefined) {
      throw new ClosureVerificationError(`added file has upstream hash: ${entry.path}`);
    }
  }
  if (counts.modified !== config.expected.changedFiles) {
    throw new ClosureVerificationError(
      "source manifest changed count does not match review configuration",
    );
  }
  if (counts.added !== config.expected.addedFiles) {
    throw new ClosureVerificationError(
      "source manifest added count does not match review configuration",
    );
  }
  const byStatus = (status) =>
    manifest.files
      .filter((entry) => entry.status === status)
      .map((entry) => entry.path)
      .sort();
  for (const [status, allowed] of [
    ["modified", config.allowedDelta.modified],
    ["added", config.allowedDelta.added],
  ]) {
    if (JSON.stringify(byStatus(status)) !== JSON.stringify(allowed)) {
      throw new ClosureVerificationError(
        `source manifest ${status} paths do not match allowedDelta`,
      );
    }
  }
  return { ...manifest, files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function walkRegularFiles(rootPath) {
  const root = await realpath(rootPath);
  if (!(await lstat(root)).isDirectory())
    throw new ClosureVerificationError("source root is not a directory");
  const files = [];
  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new ClosureVerificationError(`symlink is not allowed: ${relativePath}`);
      }
      const absolutePath = join(directory, entry.name);
      if (!isPathInside(root, absolutePath)) {
        throw new ClosureVerificationError(`path escapes root: ${relativePath}`);
      }
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new ClosureVerificationError(`unsupported file type: ${relativePath}`);
    }
  }
  await walk(root, "");
  return { root, files: files.sort() };
}

export function sourceOnlyExitCode(sourceStatus) {
  return sourceStatus === "pass" ? 0 : 1;
}
