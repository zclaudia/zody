import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  failure,
  isSafeRelativePath,
  isSha256,
  sha256Buffer,
} from "./cua-driver-round7-prepare-source.mjs";

function key(entry) {
  return `${entry.name}@${entry.version}`;
}

async function readRegular(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    failure(`${label} must be a regular non-symlink file`);
  }
  return await readFile(path);
}

export async function buildLicenseSupplementSubset({
  supplementsRoot,
  graph,
  workspaceCargoTomlSha256,
  workspacePackageCargoHashes = {},
}) {
  if (!isSha256(workspaceCargoTomlSha256)) failure("workspace Cargo.toml hash is invalid");
  if (!Array.isArray(graph?.packages)) failure("cargo graph packages are missing");
  const graphKeys = new Set(graph.packages.map(key));
  if (graphKeys.size === 0) failure("cargo graph is empty");
  const manifestPath = join(supplementsRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(
      (await readRegular(manifestPath, "license supplement manifest")).toString("utf8"),
    );
  } catch (error) {
    if (error?.name === "Round7PrepareError") throw error;
    failure("license supplement manifest is invalid JSON");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "zody-cua-driver-closure-license-supplements" ||
    !Array.isArray(manifest.entries)
  ) {
    failure("invalid license supplement manifest schema");
  }
  const entries = [];
  const texts = new Map();
  for (const original of manifest.entries) {
    if (!graphKeys.has(key(original))) continue;
    const entry = structuredClone(original);
    if (!isSafeRelativePath(entry.text?.path) || !isSha256(entry.text?.sha256)) {
      failure(`invalid license supplement text metadata: ${key(entry)}`);
    }
    const bytes = await readRegular(
      join(supplementsRoot, entry.text.path),
      `license text ${entry.text.path}`,
    );
    if (bytes.byteLength !== entry.text.bytes || sha256Buffer(bytes) !== entry.text.sha256) {
      failure(`license supplement text drift: ${entry.text.path}`);
    }
    const existing = texts.get(entry.text.path);
    if (existing && !existing.equals(bytes)) {
      failure(`license supplement text has conflicting bytes: ${entry.text.path}`);
    }
    texts.set(entry.text.path, bytes);
    if (entry.relation?.kind === "workspace-root-license") {
      const cargoHash = workspacePackageCargoHashes[entry.name];
      if (!isSha256(cargoHash)) failure(`invalid workspace package Cargo.toml hash: ${entry.name}`);
      entry.cargoTomlSha256 = cargoHash;
      entry.relation.workspaceCargoTomlSha256 = workspaceCargoTomlSha256;
    }
    entries.push(entry);
  }
  if (entries.length === 0) failure("new cargo graph has no matching license supplement entries");
  entries.sort((left, right) => key(left).localeCompare(key(right)));
  return {
    manifest: {
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
      sourceRevision: manifest.sourceRevision,
      entries,
    },
    texts,
  };
}

export async function writeLicenseSupplementSubset({ outputRoot, manifest, texts }) {
  const existing = await lstat(outputRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) failure(`license supplement output already exists: ${outputRoot}`);
  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot, { recursive: false });
  for (const [path, bytes] of [...texts].sort(([left], [right]) => left.localeCompare(right))) {
    if (!isSafeRelativePath(path)) failure(`unsafe license text path: ${path}`);
    const target = join(outputRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { entryCount: manifest.entries.length, textCount: texts.size };
}
