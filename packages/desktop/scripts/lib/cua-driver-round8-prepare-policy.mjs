import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readTomlJson } from "./cua-driver-closure-dependencies.mjs";
import { failure } from "./cua-driver-round8-prepare-config.mjs";

const VISUAL_ROOT = "crates/cua-macos-visual";
const FORBIDDEN_DEPENDENCIES = `cua-driver-core cua-driver-sdk cua-driver-contract platform-macos
clipboard-rs arboard accessibility accessibility-sys cursor-overlay pip-preview enigo rdev`
  .trim()
  .split(/\s+/);
const SAFETY_FEATURES = ["zody-dev-no-input", "zody-strict-frame-gate"];
const DEPENDENCY_TABLES = ["dependencies", "dev-dependencies", "build-dependencies"];

function addDependencies(entries, table, dependencies) {
  for (const [key, value] of Object.entries(dependencies ?? {}))
    entries.push({ table, key, value });
}

function dependencyEntries(cargo) {
  const entries = [];
  for (const table of DEPENDENCY_TABLES) addDependencies(entries, table, cargo[table]);
  for (const [target, tables] of Object.entries(cargo.target ?? {}))
    for (const table of DEPENDENCY_TABLES)
      addDependencies(entries, `target.${target}.${table}`, tables?.[table]);
  return entries;
}

function identityMatches(entry, name, workspace) {
  const own = typeof entry.value === "object" && entry.value !== null ? entry.value : {};
  const inherits = entry.value?.workspace === true;
  if (inherits && !Object.hasOwn(workspace, entry.key)) {
    failure(`round 8 visual dependency ${entry.key} inherits a missing workspace dependency`);
  }
  const inherited = inherits ? workspace[entry.key] : {};
  const specs = [own, typeof inherited === "object" && inherited !== null ? inherited : {}];
  const names = specs.flatMap(({ package: packageName, path }) => [
    packageName,
    ...(typeof path === "string" ? path.split(/[\\/]+/) : []),
  ]);
  return entry.key === name || names.includes(name);
}

function assertDependencyBoundary(cargo, workspace) {
  for (const entry of dependencyEntries(cargo)) {
    for (const name of FORBIDDEN_DEPENDENCIES) {
      if (identityMatches(entry, name, workspace)) {
        failure(`round 8 visual root must stay independent from ${name} in ${entry.table}`);
      }
    }
  }
}

async function readCargoToml(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) failure(`round 8 ${label} must be a file`);
  try {
    return await readTomlJson(path);
  } catch (error) {
    failure(`round 8 ${label}: ${error instanceof Error ? error.message : "invalid TOML"}`);
  }
}

export async function assertRound8DependencyPolicy({ baseRoot, candidateRoot }) {
  const visualCargoPath = join(candidateRoot, VISUAL_ROOT, "Cargo.toml");
  const visualCargo = await readCargoToml(visualCargoPath, "visual Cargo.toml");
  if (visualCargo.package?.name !== "cua-macos-visual") {
    failure("round 8 visual root must be package cua-macos-visual");
  }
  if (visualCargo.workspace !== undefined) {
    failure("round 8 visual root must join the full-source workspace, not declare its own");
  }
  const rootCargo = await readCargoToml(join(candidateRoot, "Cargo.toml"), "root Cargo.toml");
  if (!rootCargo.workspace?.members?.includes(VISUAL_ROOT)) {
    failure(`round 8 root workspace members must include ${VISUAL_ROOT}`);
  }
  if (rootCargo.workspace.exclude?.includes(VISUAL_ROOT)) {
    failure(`round 8 root workspace may not exclude ${VISUAL_ROOT}`);
  }
  for (const feature of SAFETY_FEATURES) {
    if (visualCargo.features?.[feature] !== undefined) {
      failure(`round 8 visual root may not redefine ${feature}`);
    }
  }
  assertDependencyBoundary(visualCargo, rootCargo.workspace?.dependencies ?? {});

  const platformPath = join("crates", "platform-macos", "Cargo.toml");
  const baseFeatures = (await readCargoToml(join(baseRoot, platformPath), "R7 platform Cargo.toml"))
    .features;
  const candidateFeatures = (
    await readCargoToml(join(candidateRoot, platformPath), "candidate platform Cargo.toml")
  ).features;
  if (!baseFeatures || !candidateFeatures) failure("round 8 old platform features are missing");
  const baseDefault = baseFeatures.default;
  const candidateDefault = candidateFeatures.default;
  if (!baseDefault || !candidateDefault)
    failure("round 8 old platform default features are missing");
  for (const feature of SAFETY_FEATURES) {
    const baseDefinition = baseFeatures[feature];
    const candidateDefinition = candidateFeatures[feature];
    if (!baseDefinition || !candidateDefinition) failure(`round 8 removes ${feature}`);
    if (JSON.stringify(baseDefinition) !== JSON.stringify(candidateDefinition)) {
      failure(`round 8 changes the old safety feature ${feature}`);
    }
  }
  if (JSON.stringify(baseDefault) !== JSON.stringify(candidateDefault)) {
    failure("round 8 changes the old platform default safety features");
  }
  return { visualRoot: VISUAL_ROOT, preservedFeatures: SAFETY_FEATURES };
}
