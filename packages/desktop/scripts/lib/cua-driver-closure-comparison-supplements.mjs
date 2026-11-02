import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ClosureVerificationError,
  isPathInside,
  isRecord,
  isSafeRelativePath,
  isSha256,
  sha256Buffer,
} from "./cua-driver-closure-core.mjs";

export const SUPPLEMENTS_KIND = "zody-cua-driver-closure-license-supplements";

function fail(message) {
  throw new ClosureVerificationError(message);
}

function stringField(value, key, label) {
  if (!isRecord(value) || typeof value[key] !== "string" || value[key].length === 0) {
    fail(`invalid ${label}`);
  }
  return value[key];
}

function shaField(value, key, label) {
  const field = stringField(value, key, label);
  if (!isSha256(field)) fail(`invalid ${label}`);
  return field;
}

function key(name, version) {
  return `${name}@${version}`;
}

function identityName(value) {
  const index = value.lastIndexOf("@");
  return index < 0 ? value : value.slice(0, index);
}

async function readRegularInside(root, relativePath, label) {
  if (!isSafeRelativePath(relativePath)) fail(`invalid ${label} path`);
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    const metadata = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") fail(`missing ${label}: ${relativePath}`);
      throw error;
    });
    if (metadata.isSymbolicLink()) fail(`${label} must not contain a symlink: ${relativePath}`);
  }
  const resolved = await realpath(current);
  if (!isPathInside(root, resolved)) fail(`${label} escapes its root: ${relativePath}`);
  const bytes = await readFile(resolved);
  return bytes;
}

function validateEntryShape(entry, index) {
  if (!isRecord(entry)) fail(`invalid supplement entry ${index}`);
  const name = stringField(entry, "name", "supplement name");
  const version = stringField(entry, "version", "supplement version");
  if (entry.lockChecksum !== null)
    shaField(entry, "lockChecksum", `lock checksum for ${key(name, version)}`);
  shaField(entry, "cargoTomlSha256", `Cargo hash for ${key(name, version)}`);
  if (entry.cargoVcsSha1 !== null) {
    const value = stringField(entry, "cargoVcsSha1", `VCS commit for ${key(name, version)}`);
    if (!/^[a-f0-9]{40}$/.test(value)) fail(`invalid VCS commit for ${key(name, version)}`);
  }
  if (entry.cargoVcsInfoSha256 !== null) {
    shaField(entry, "cargoVcsInfoSha256", `VCS metadata hash for ${key(name, version)}`);
  }
  const source = entry.source;
  if (!isRecord(source)) fail(`invalid supplement source for ${key(name, version)}`);
  stringField(source, "repo", `source repo for ${key(name, version)}`);
  const commit = stringField(source, "commit", `source commit for ${key(name, version)}`);
  if (!/^[a-f0-9]{40}$/.test(commit)) fail(`invalid source commit for ${key(name, version)}`);
  if (!isSafeRelativePath(stringField(source, "path", `source path for ${key(name, version)}`))) {
    fail(`invalid source path for ${key(name, version)}`);
  }
  const text = entry.text;
  if (!isRecord(text)) fail(`invalid supplement text for ${key(name, version)}`);
  if (!isSafeRelativePath(stringField(text, "path", `text path for ${key(name, version)}`))) {
    fail(`invalid text path for ${key(name, version)}`);
  }
  shaField(text, "sha256", `text hash for ${key(name, version)}`);
  if (!Number.isInteger(text.bytes) || text.bytes < 1)
    fail(`invalid text bytes for ${key(name, version)}`);
  if (!isRecord(entry.relation)) fail(`invalid supplement relation for ${key(name, version)}`);
  stringField(entry.relation, "kind", `relation kind for ${key(name, version)}`);
  stringField(entry.relation, "evidence", `relation evidence for ${key(name, version)}`);
  stringField(entry.relation, "licenseExpression", `license expression for ${key(name, version)}`);
  return { name, version };
}

async function readManifest(path, label) {
  const metadata = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") fail(`missing ${label}: ${path}`);
    throw error;
  });
  if (metadata.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (!metadata.isFile()) fail(`${label} is not a regular file`);
  const bytes = await readFile(path);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`invalid JSON in ${label}`);
  }
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== SUPPLEMENTS_KIND ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? "") ||
    !Array.isArray(manifest.entries)
  ) {
    fail(`invalid ${label} schema`);
  }
  const root = dirname(await realpath(path));
  const byKey = new Map();
  for (const [index, entry] of manifest.entries.entries()) {
    const identity = validateEntryShape(entry, index);
    const entryKey = key(identity.name, identity.version);
    if (byKey.has(entryKey)) fail(`duplicate supplement entry: ${entryKey}`);
    byKey.set(entryKey, entry);
  }
  return { path, root, bytes, sha256: sha256Buffer(bytes), manifest, byKey };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

function sourceHash(sourceFiles, path, label) {
  const entry = sourceFiles.find((candidate) => candidate.path === path);
  if (!entry) fail(`missing source hash for ${label}: ${path}`);
  if (!isSha256(entry.candidateSha256)) fail(`invalid source hash for ${label}: ${path}`);
  return entry.candidateSha256;
}

async function verifyText(manifest, entry) {
  const bytes = await readRegularInside(
    manifest.root,
    entry.text.path,
    `supplement text for ${key(entry.name, entry.version)}`,
  );
  if (sha256Buffer(bytes) !== entry.text.sha256) {
    fail(`supplement text hash mismatch: ${key(entry.name, entry.version)}`);
  }
  if (bytes.byteLength !== entry.text.bytes) {
    fail(`supplement text bytes mismatch: ${key(entry.name, entry.version)}`);
  }
  return sha256Buffer(bytes);
}

export async function validateSupplementSubset({
  baselineManifestPath,
  candidateManifestPath,
  baselineManifestSha256,
  baselineEntryCount,
  baselineGraph,
  candidateGraph,
  _baselineSourceFiles,
  candidateSourceFiles,
  candidateRevision = null,
}) {
  if (!isSha256(baselineManifestSha256)) fail("invalid baseline supplement manifest hash");
  if (!Number.isInteger(baselineEntryCount) || baselineEntryCount < 1) {
    fail("invalid baseline supplement entry count");
  }
  const baseline = await readManifest(baselineManifestPath, "baseline supplement manifest");
  const candidate = await readManifest(candidateManifestPath, "candidate supplement manifest");
  if (baseline.sha256 !== baselineManifestSha256)
    fail("baseline supplement manifest sha256 mismatch");
  if (baseline.manifest.entries.length !== baselineEntryCount) {
    fail("baseline supplement entry count mismatch");
  }
  if (candidate.manifest.sourceRevision !== baseline.manifest.sourceRevision) {
    fail("candidate supplement source revision mismatch");
  }
  if (candidateRevision && candidate.manifest.sourceRevision !== candidateRevision) {
    fail("candidate supplement revision does not match candidate report");
  }
  const baselinePackages = new Map(
    baselineGraph.packages.map((entry) => [key(entry.name, entry.version), entry]),
  );
  const candidatePackages = new Map(
    candidateGraph.packages.map((entry) => [key(entry.name, entry.version), entry]),
  );
  for (const entryKey of baseline.byKey.keys()) {
    if (!baselinePackages.has(entryKey))
      fail(`baseline supplement is outside baseline graph: ${entryKey}`);
  }
  for (const [entryKey, entry] of candidate.byKey) {
    if (!candidatePackages.has(entryKey))
      fail(`candidate supplement is outside candidate graph: ${entryKey}`);
    if (!baseline.byKey.has(entryKey)) fail(`unknown supplement identity or version: ${entryKey}`);
    const baselineEntry = baseline.byKey.get(entryKey);
    if (baselineEntry.name !== entry.name || baselineEntry.version !== entry.version) {
      fail(`unknown supplement identity or version: ${entryKey}`);
    }
    if (stable(baselineEntry.source) !== stable(entry.source)) {
      fail(`supplement source drift: ${entryKey}`);
    }
    if (stable(baselineEntry.text) !== stable(entry.text)) {
      fail(`supplement text evidence drift: ${entryKey}`);
    }
    const candidateTextHash = await verifyText(candidate, entry);
    const baselineTextHash = await verifyText(baseline, baselineEntry);
    if (candidateTextHash !== baselineTextHash) fail(`supplement text content drift: ${entryKey}`);
    const workspace = baselineEntry.lockChecksum === null;
    if (workspace) {
      if (entry.lockChecksum !== null) {
        fail(`workspace supplement cannot become a registry entry: ${entryKey}`);
      }
      if (
        stable({ ...baselineEntry.relation, workspaceCargoTomlSha256: null }) !==
        stable({ ...entry.relation, workspaceCargoTomlSha256: null })
      ) {
        fail(`workspace supplement relation drift: ${entryKey}`);
      }
      if (
        baselineEntry.cargoVcsSha1 !== entry.cargoVcsSha1 ||
        baselineEntry.cargoVcsInfoSha256 !== entry.cargoVcsInfoSha256
      ) {
        fail(`workspace supplement evidence drift: ${entryKey}`);
      }
      const graphEntry = candidatePackages.get(entryKey);
      if (typeof graphEntry.path !== "string" || !isSafeRelativePath(graphEntry.path)) {
        fail(`workspace supplement has no candidate path: ${entryKey}`);
      }
      const expectedCargo = sourceHash(
        candidateSourceFiles,
        `${graphEntry.path}/Cargo.toml`,
        entryKey,
      );
      if (entry.cargoTomlSha256 !== expectedCargo) {
        fail(`workspace Cargo hash does not match candidate source: ${entryKey}`);
      }
      const expectedRoot = sourceHash(candidateSourceFiles, "Cargo.toml", entryKey);
      if (entry.relation.workspaceCargoTomlSha256 !== expectedRoot) {
        fail(`workspace root Cargo hash does not match candidate source: ${entryKey}`);
      }
    } else {
      if (
        baselineEntry.lockChecksum !== entry.lockChecksum ||
        baselineEntry.cargoTomlSha256 !== entry.cargoTomlSha256 ||
        baselineEntry.cargoVcsSha1 !== entry.cargoVcsSha1 ||
        baselineEntry.cargoVcsInfoSha256 !== entry.cargoVcsInfoSha256 ||
        stable(baselineEntry.relation) !== stable(entry.relation)
      ) {
        fail(`registry supplement evidence drift: ${entryKey}`);
      }
    }
  }
  const missingMappings = [...baseline.byKey.keys()]
    .filter((entryKey) => candidatePackages.has(entryKey) && !candidate.byKey.has(entryKey))
    .sort();
  if (missingMappings.length > 0) {
    fail(`missing old mapping for package still in graph: ${missingMappings.join(", ")}`);
  }
  const droppedOutsideGraph = [...baseline.byKey.keys()]
    .filter((entryKey) => !candidatePackages.has(entryKey))
    .sort();
  const workspaceCargoHashesUpdated = [...candidate.byKey.keys()]
    .filter((entryKey) => {
      const before = baseline.byKey.get(entryKey);
      const after = candidate.byKey.get(entryKey);
      return (
        before &&
        before.lockChecksum === null &&
        (before.cargoTomlSha256 !== after.cargoTomlSha256 ||
          before.relation.workspaceCargoTomlSha256 !== after.relation.workspaceCargoTomlSha256)
      );
    })
    .sort();
  return {
    status: "pass",
    baseline: {
      manifestPath: baselineManifestPath,
      manifestSha256: baseline.sha256,
      entryCount: baseline.manifest.entries.length,
      sourceRevision: baseline.manifest.sourceRevision,
    },
    candidate: {
      manifestPath: candidateManifestPath,
      manifestSha256: candidate.sha256,
      entryCount: candidate.manifest.entries.length,
      sourceRevision: candidate.manifest.sourceRevision,
    },
    retained: [...candidate.byKey.keys()].sort(),
    droppedOutsideGraph,
    workspaceCargoHashesUpdated,
    unknownIdentity: [],
    textDrift: [],
  };
}

export { identityName };
