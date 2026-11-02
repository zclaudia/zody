import { dirname, resolve } from "node:path";
import { isSafeRelativePath, isSha256 } from "./cua-driver-round7-prepare-source.mjs";

export const ROUND8_BASE_TREE_SHA256 =
  "4cbad8776947504f9883bf5370d6802177090d7a01075c5640b64a730950d9de";
export const VISUAL_ROOT = "crates/cua-macos-visual";
export const PROBE_ROOT = "crates/cua-macos-visual-link-probe";

const ALLOWED_MODIFIED = new Set(["Cargo.toml", "Cargo.lock"]);

export class Round9PrepareError extends Error {
  constructor(message) {
    super(message);
    this.name = "Round9PrepareError";
  }
}

export function failure(message) {
  throw new Round9PrepareError(message);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function isAllowedModified(path) {
  return ALLOWED_MODIFIED.has(path) || path.startsWith(`${VISUAL_ROOT}/`);
}

function isAllowedAdded(path) {
  return path.startsWith(`${VISUAL_ROOT}/`) || path.startsWith(`${PROBE_ROOT}/`);
}

export function validateRound9ReviewConfig({
  config,
  baseManifest,
  candidateManifest,
  baseManifestSha256,
  candidateManifestSha256,
  expectedBaseTreeSha256 = ROUND8_BASE_TREE_SHA256,
}) {
  if (config?.schemaVersion !== 1 || config?.kind !== "zody-cua-driver-closure-review") {
    failure("round 9 review config schema is invalid");
  }
  if (
    config.revision !== baseManifest?.revision ||
    candidateManifest?.revision !== baseManifest?.revision ||
    config.sourceRoot !== baseManifest?.sourceRoot ||
    candidateManifest?.sourceRoot !== baseManifest?.sourceRoot
  ) {
    failure("round 9 review config revision or source root differs from the R8 baseline");
  }
  if (!isNonEmptyString(config.baseSourceManifest))
    failure("round 9 review config must name the base source manifest");
  if (!isNonEmptyString(config.sourceManifest))
    failure("round 9 review config must name the candidate source manifest");
  if (!isNonEmptyString(config.candidatePatch?.path))
    failure("round 9 review config must name the candidate patch");
  const pins = [
    config.baseSourceManifestSha256,
    config.candidateSourceManifestSha256,
    config.baseTreeSha256,
    config.candidateTreeSha256,
    config.candidatePatch?.sha256,
  ];
  if (!pins.every(isSha256)) failure("round 9 review config contains an invalid SHA-256 pin");
  if (!Number.isInteger(config.candidatePatch?.bytes) || config.candidatePatch.bytes <= 0) {
    failure("round 9 review config must pin the candidate patch byte count");
  }
  if (!isSha256(expectedBaseTreeSha256)) {
    failure("round 9 expected base tree pin is invalid");
  }
  if (config.baseTreeSha256 !== expectedBaseTreeSha256) {
    failure("round 9 base source tree pin differs from the accepted R8 tree");
  }
  if (baseManifest?.treeSha256 !== expectedBaseTreeSha256) {
    failure("round 9 base source manifest tree hash differs from the accepted R8 tree");
  }
  if (config.baseSourceManifestSha256 !== baseManifestSha256) {
    failure("round 9 base source manifest hash differs from the review config");
  }
  if (config.candidateSourceManifestSha256 !== candidateManifestSha256) {
    failure("round 9 candidate source manifest hash differs from the review config");
  }
  if (config.candidateTreeSha256 !== candidateManifest?.treeSha256) {
    failure("round 9 candidate tree hash pin differs from its source manifest");
  }
  if (config.allowedDelta !== undefined) {
    const delta = config.allowedDelta;
    if (
      typeof delta !== "object" ||
      delta === null ||
      !Array.isArray(delta.modified) ||
      !Array.isArray(delta.added) ||
      !Array.isArray(delta.removed)
    ) {
      failure("round 9 review config allowedDelta is malformed");
    }
  }
  if (config.package !== undefined && config.package !== "cua-macos-visual") {
    failure("round 9 review config package must remain cua-macos-visual");
  }
  if (config.target !== "aarch64-apple-darwin") {
    failure("round 9 review config target must remain aarch64-apple-darwin");
  }
  if (
    config.toolchain?.upstreamDeclared !== "1.97.1" ||
    config.toolchain?.auditedVersion !== "1.97.1"
  ) {
    failure("round 9 review config toolchain must remain 1.97.1");
  }
}

function assertConfigPathMatches({ value, label, configDir, actualPath }) {
  if (!isNonEmptyString(value)) failure(`round 9 review config must name the ${label}`);
  if (resolve(configDir, value) !== resolve(actualPath)) {
    failure(`round 9 review config names a different ${label}`);
  }
}

export function assertRound9InputPins({
  config,
  configPath,
  baseManifestPath,
  sourceManifestPath,
  patchPath,
}) {
  const configDir = dirname(resolve(configPath));
  assertConfigPathMatches({
    value: config.baseSourceManifest,
    label: "base source manifest",
    configDir,
    actualPath: baseManifestPath,
  });
  assertConfigPathMatches({
    value: config.sourceManifest,
    label: "candidate source manifest",
    configDir,
    actualPath: sourceManifestPath,
  });
  assertConfigPathMatches({
    value: config.candidatePatch?.path,
    label: "candidate patch",
    configDir,
    actualPath: patchPath,
  });
}

function manifestMap(manifest, label) {
  if (!Array.isArray(manifest?.files)) failure(`round 9 ${label} manifest has no file list`);
  const result = new Map();
  for (const entry of manifest.files) {
    if (!isSafeRelativePath(entry?.path) || !isSha256(entry?.candidateSha256)) {
      failure(`round 9 ${label} manifest contains an invalid entry`);
    }
    if (!["modified", "added", "unchanged"].includes(entry.status)) {
      failure(`round 9 ${label} manifest contains an invalid status: ${entry.path}`);
    }
    if (entry.status !== "added" && !isSha256(entry.upstreamSha256)) {
      failure(`round 9 ${label} manifest is missing the upstream hash: ${entry.path}`);
    }
    if (result.has(entry.path)) failure(`round 9 ${label} manifest contains duplicate paths`);
    result.set(entry.path, entry);
  }
  return result;
}

export function assertRound9ManifestDelta({ baseManifest, candidateManifest }) {
  if (
    candidateManifest?.revision !== baseManifest?.revision ||
    candidateManifest?.sourceRoot !== baseManifest?.sourceRoot
  ) {
    failure("round 9 candidate manifest revision or source root differs from the R8 baseline");
  }
  const base = manifestMap(baseManifest, "base");
  const candidate = manifestMap(candidateManifest, "candidate");
  const delta = { modified: [], added: [], removed: [] };
  for (const [path, entry] of base) {
    const next = candidate.get(path);
    if (!next) failure(`round 9 may not remove ${path}`);
    if (entry.status === "added") {
      if (next.status !== "added") {
        failure(`round 9 ${path} must remain status added`);
      }
      if (next.upstreamSha256 !== undefined) {
        failure(`round 9 added ${path} must not carry an upstream hash`);
      }
    } else {
      if (next.upstreamSha256 !== entry.upstreamSha256) {
        failure(`round 9 ${path} changes upstream provenance`);
      }
      const expectedStatus =
        next.candidateSha256 === next.upstreamSha256 ? "unchanged" : "modified";
      if (next.status !== expectedStatus) {
        failure(`round 9 ${path} status must be ${expectedStatus}`);
      }
    }
    if (next.candidateSha256 === entry.candidateSha256) continue;
    if (!isAllowedModified(path)) failure(`round 9 may not modify ${path}`);
    delta.modified.push(path);
  }
  for (const [path, entry] of candidate) {
    if (base.has(path)) continue;
    if (entry.status !== "added") failure(`round 9 new ${path} must be status added`);
    if (entry.upstreamSha256 !== undefined) {
      failure(`round 9 added ${path} must not carry an upstream hash`);
    }
    if (!isAllowedAdded(path)) {
      failure(`round 9 may not add ${path} outside ${VISUAL_ROOT} or ${PROBE_ROOT}`);
    }
    delta.added.push(path);
  }
  return {
    modified: delta.modified.sort((left, right) => left.localeCompare(right)),
    added: delta.added.sort((left, right) => left.localeCompare(right)),
    removed: [],
  };
}
