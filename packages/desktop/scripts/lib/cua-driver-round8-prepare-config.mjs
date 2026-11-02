import { isSafeRelativePath, isSha256 } from "./cua-driver-round7-prepare-source.mjs";

export class Round8PrepareError extends Error {
  constructor(message) {
    super(message);
    this.name = "Round8PrepareError";
  }
}

export function failure(message) {
  throw new Round8PrepareError(message);
}

const ALLOWED_MODIFIED = new Set(["Cargo.toml", "Cargo.lock"]);

export function validateRound8ReviewConfig({
  config,
  baseManifest,
  candidateManifest,
  baseManifestSha256,
  candidateManifestSha256,
}) {
  if (config?.schemaVersion !== 1 || config?.kind !== "zody-cua-driver-closure-review") {
    failure("round 8 review config schema is invalid");
  }
  if (
    config.revision !== baseManifest?.revision ||
    candidateManifest?.revision !== baseManifest?.revision ||
    config.sourceRoot !== baseManifest?.sourceRoot ||
    candidateManifest?.sourceRoot !== baseManifest?.sourceRoot
  ) {
    failure("round 8 review config revision or source root differs from the R7 baseline");
  }
  if (typeof config.baseSourceManifest !== "string" || typeof config.sourceManifest !== "string")
    failure("round 8 review config must name its base and candidate source manifests");
  const pins = [
    config.baseSourceManifestSha256,
    config.candidateSourceManifestSha256,
    config.baseTreeSha256,
    config.candidateTreeSha256,
    config.candidatePatch?.sha256,
  ];
  if (!pins.every(isSha256)) failure("round 8 review config contains an invalid SHA-256 pin");
  if (!Number.isInteger(config.candidatePatch?.bytes) || config.candidatePatch.bytes <= 0) {
    failure("round 8 review config must pin the candidate patch byte count");
  }
  if (typeof config.candidatePatch?.path !== "string") {
    failure("round 8 review config must name the candidate patch");
  }
  if (config.baseSourceManifestSha256 !== baseManifestSha256) {
    failure("round 8 base source manifest hash differs from the review config");
  }
  if (config.candidateSourceManifestSha256 !== candidateManifestSha256) {
    failure("round 8 candidate source manifest hash differs from the review config");
  }
  if (
    config.baseTreeSha256 !== baseManifest.treeSha256 ||
    config.candidateTreeSha256 !== candidateManifest.treeSha256
  ) {
    failure("round 8 tree hash pin differs from its source manifest");
  }
}

function manifestMap(manifest, label) {
  if (!Array.isArray(manifest?.files)) failure(`round 8 ${label} manifest has no file list`);
  const result = new Map();
  for (const entry of manifest.files) {
    if (!isSafeRelativePath(entry?.path) || !isSha256(entry?.candidateSha256)) {
      failure(`round 8 ${label} manifest contains an invalid entry`);
    }
    if (result.has(entry.path)) failure(`round 8 ${label} manifest contains duplicate paths`);
    result.set(entry.path, entry);
  }
  return result;
}

export function assertRound8ManifestDelta({ baseManifest, candidateManifest }) {
  const base = manifestMap(baseManifest, "base");
  const candidate = manifestMap(candidateManifest, "candidate");
  const delta = { modified: [], added: [], removed: [] };
  for (const [path, entry] of base) {
    const next = candidate.get(path);
    if (!next) failure(`round 8 may not remove ${path}`);
    if (next.candidateSha256 === entry.candidateSha256) continue;
    if (!ALLOWED_MODIFIED.has(path)) failure(`round 8 may not modify ${path}`);
    delta.modified.push(path);
  }
  for (const path of candidate.keys()) {
    if (base.has(path)) continue;
    if (!path.startsWith("crates/cua-macos-visual/"))
      failure(`round 8 may not add ${path} outside crates/cua-macos-visual`);
    delta.added.push(path);
  }
  return {
    modified: delta.modified.sort((left, right) => left.localeCompare(right)),
    added: delta.added.sort((left, right) => left.localeCompare(right)),
    removed: [],
  };
}
