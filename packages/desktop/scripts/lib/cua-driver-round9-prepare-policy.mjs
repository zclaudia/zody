import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readTomlJson } from "./cua-driver-closure-dependencies.mjs";
import {
  PROBE_ROOT,
  Round9PrepareError,
  VISUAL_ROOT,
  failure,
} from "./cua-driver-round9-prepare-config.mjs";
import { scanTree } from "./cua-driver-round7-prepare-source.mjs";

const DEPENDENCY_TABLES = ["dependencies", "dev-dependencies", "build-dependencies"];
const SAFETY_FEATURES = ["zody-dev-no-input", "zody-strict-frame-gate"];
export const VISUAL_PACKAGE = "cua-macos-visual";
export const PROBE_PACKAGE = "cua-macos-visual-link-probe";

const FORBIDDEN_DEPENDENCIES = new Set(
  `cua-driver cua-driver-core cua-driver-sdk cua-driver-contract cua-driver-uia
   cua-driver-e2e cua-driver-testkit cua-driver-bindgen cua-perception
   platform-macos platform-windows platform-linux
   screencapturekit screencapturekit-sys apple-metal apple-cf
   clipboard-rs clipboard arboard accessibility accessibility-sys
   cursor-overlay pip-preview enigo rdev`
    .trim()
    .split(/\s+/),
);

function isRound9Error(error) {
  return error instanceof Round9PrepareError;
}

export async function readTomlFile(path, label) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      failure(`round 9 ${label} must be a regular non-symlink file`);
    }
  } catch (error) {
    if (isRound9Error(error)) throw error;
    if (error?.code === "ENOENT") failure(`round 9 ${label} is missing`);
    throw error;
  }
  try {
    return await readTomlJson(path);
  } catch (error) {
    failure(`round 9 ${label}: ${error instanceof Error ? error.message : "invalid TOML"}`);
  }
}

function toSpec(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  return {};
}

function addIdentityValue(names, value) {
  if (typeof value !== "string") return;
  for (const part of value.split(/[\\/]+/)) {
    const normalized = part.trim();
    if (normalized && normalized !== "." && normalized !== "..") names.add(normalized);
  }
}

function addSpecIdentity(names, spec) {
  if (typeof spec.package === "string") names.add(spec.package);
  addIdentityValue(names, spec.path);
  addIdentityValue(names, spec.git);
}

function dependencyEntries(cargo) {
  const entries = [];
  const add = (table, dependencies) => {
    for (const [key, value] of Object.entries(dependencies ?? {})) {
      entries.push({ table, key, value });
    }
  };
  for (const table of DEPENDENCY_TABLES) add(table, cargo?.[table]);
  for (const [target, tables] of Object.entries(cargo?.target ?? {})) {
    for (const table of DEPENDENCY_TABLES) {
      add(`target.${target}.${table}`, tables?.[table]);
    }
  }
  return entries;
}

function dependencyIdentityNames(entry, workspaceDependencies, label) {
  const names = new Set([entry.key]);
  const own = toSpec(entry.value);
  addSpecIdentity(names, own);
  if (own.workspace === true) {
    if (!Object.hasOwn(workspaceDependencies ?? {}, entry.key)) {
      if (label !== "probe root") {
        failure(`round 9 ${label} dependency ${entry.key} inherits a missing workspace dependency`);
      }
      return names;
    }
    addSpecIdentity(names, toSpec(workspaceDependencies[entry.key]));
  }
  return names;
}

function assertDependencyBoundary({ cargo, workspaceDependencies, label }) {
  for (const entry of dependencyEntries(cargo)) {
    const names = dependencyIdentityNames(entry, workspaceDependencies, label);
    for (const dependency of FORBIDDEN_DEPENDENCIES) {
      if (names.has(dependency)) {
        failure(`round 9 ${label} must stay independent from ${dependency} in ${entry.table}`);
      }
    }
  }
}

function assertVisualDoesNotDependOnProbe({ cargo, workspaceDependencies }) {
  for (const entry of dependencyEntries(cargo)) {
    const names = dependencyIdentityNames(entry, workspaceDependencies, "visual root");
    if (names.has(PROBE_PACKAGE)) {
      failure("round 9 visual root may not depend on the link probe");
    }
  }
}

function dependencyEntryKey(entry) {
  return `${entry.table}\0${entry.key}`;
}

function assertVisualDependencySet({ baseCargo, candidateCargo, workspaceDependencies }) {
  const baseEntries = dependencyEntries(baseCargo);
  const candidateEntries = dependencyEntries(candidateCargo);
  const baseByKey = new Map(baseEntries.map((entry) => [dependencyEntryKey(entry), entry]));
  const candidateByKey = new Map(
    candidateEntries.map((entry) => [dependencyEntryKey(entry), entry]),
  );
  for (const entry of baseEntries) {
    const names = dependencyIdentityNames(entry, workspaceDependencies, "base visual root");
    if (names.has("screencapturekit")) continue;
    const next = candidateByKey.get(dependencyEntryKey(entry));
    if (!next) {
      failure(`round 9 visual root removes preserved dependency ${entry.key}`);
    }
    if (!isDeepStrictEqual(next.value, entry.value)) {
      failure(`round 9 visual root changes preserved visual dependency ${entry.key}`);
    }
  }
  for (const entry of candidateEntries) {
    if (!baseByKey.has(dependencyEntryKey(entry))) {
      failure(
        `round 9 visual root may keep only image and core-foundation; unexpected ${entry.key} in ${entry.table}`,
      );
    }
  }
}

async function assertProbeDependencies({ candidateRoot, cargo, visualCargo }) {
  const entries = dependencyEntries(cargo);
  if (entries.length !== 1 || entries[0].table !== "dependencies") {
    failure("round 9 probe root must depend only on cua-macos-visual");
  }
  const entry = entries[0];
  const spec = toSpec(entry.value);
  if (spec.workspace === true) {
    failure("round 9 probe root must bind cua-macos-visual by an explicit path");
  }
  if (spec.git !== undefined || spec.registry !== undefined || spec.source !== undefined) {
    failure("round 9 probe root must not use an external source for cua-macos-visual");
  }
  if (typeof spec.path !== "string" || spec.path === "") {
    failure("round 9 probe root must bind cua-macos-visual by an explicit path");
  }
  if (isAbsolute(spec.path)) {
    failure("round 9 probe root visual path must be relative");
  }
  const pathSegments = spec.path.split(/[\\/]+/).filter(Boolean);
  if (pathSegments.some((segment) => !["..", ".", "cua-macos-visual"].includes(segment))) {
    failure("round 9 probe root visual path must be the direct sibling path");
  }
  if (spec.package !== undefined && typeof spec.package !== "string") {
    failure("round 9 probe root visual package rename is malformed");
  }
  const dependencyName = spec.package ?? entry.key;
  if (dependencyName !== VISUAL_PACKAGE) {
    failure("round 9 probe root must link cua-macos-visual");
  }
  if (spec.features !== undefined) {
    if (
      !Array.isArray(spec.features) ||
      spec.features.some((feature) => typeof feature !== "string")
    ) {
      failure("round 9 probe root visual features are malformed");
    }
    const declaredFeatures = visualCargo.features ?? {};
    for (const feature of spec.features) {
      if (!Object.hasOwn(declaredFeatures, feature)) {
        failure(`round 9 probe root enables undeclared visual feature ${feature}`);
      }
    }
  }
  const expectedVisual = await realpath(join(candidateRoot, VISUAL_ROOT));
  let resolvedPath;
  try {
    resolvedPath = await realpath(resolve(join(candidateRoot, PROBE_ROOT), spec.path));
  } catch {
    failure("round 9 probe root visual path does not resolve");
  }
  if (resolvedPath !== expectedVisual) {
    failure("round 9 probe root visual path must resolve to crates/cua-macos-visual");
  }
  return [VISUAL_PACKAGE];
}

function assertRootWorkspaceOnlyAddsProbe({ baseCargo, candidateCargo }) {
  const baseMembers = baseCargo?.workspace?.members;
  const candidateMembers = candidateCargo?.workspace?.members;
  if (!Array.isArray(baseMembers) || !Array.isArray(candidateMembers)) {
    failure("round 9 root workspace members are missing");
  }
  const baseSet = new Set(baseMembers);
  const candidateSet = new Set(candidateMembers);
  if (baseSet.has(PROBE_ROOT)) {
    failure("round 9 root workspace already contains the link probe member");
  }
  if (candidateMembers.length !== baseMembers.length + 1 || !candidateSet.has(PROBE_ROOT)) {
    failure(
      "round 9 root workspace only adds the link probe member; no other configuration may change",
    );
  }
  for (const member of baseMembers) {
    if (!candidateSet.has(member)) {
      failure(
        "round 9 root workspace only adds the link probe member; no other configuration may change",
      );
    }
  }
  for (const member of candidateMembers) {
    if (member !== PROBE_ROOT && !baseSet.has(member)) {
      failure(
        "round 9 root workspace only adds the link probe member; no other configuration may change",
      );
    }
  }
  const baseCopy = structuredClone(baseCargo);
  const candidateCopy = structuredClone(candidateCargo);
  baseCopy.workspace.members = [];
  candidateCopy.workspace.members = [];
  if (!isDeepStrictEqual(baseCopy, candidateCopy)) {
    failure(
      "round 9 root workspace only adds the link probe member; no other configuration may change",
    );
  }
}

async function assertPlatformFeatures({ baseRoot, candidateRoot }) {
  const platformPath = join("crates", "platform-macos", "Cargo.toml");
  const baseFeatures = (await readTomlFile(join(baseRoot, platformPath), "R8 platform Cargo.toml"))
    .features;
  const candidateFeatures = (
    await readTomlFile(join(candidateRoot, platformPath), "candidate platform Cargo.toml")
  ).features;
  if (!baseFeatures || !candidateFeatures) failure("round 9 old platform features are missing");
  if (!baseFeatures.default || !candidateFeatures.default) {
    failure("round 9 old platform default features are missing");
  }
  for (const feature of SAFETY_FEATURES) {
    if (!baseFeatures[feature]) failure(`round 9 base platform is missing ${feature}`);
    if (!candidateFeatures[feature]) failure(`round 9 removes ${feature}`);
    if (!isDeepStrictEqual(baseFeatures[feature], candidateFeatures[feature])) {
      failure(`round 9 changes the old safety feature ${feature}`);
    }
  }
  if (!isDeepStrictEqual(baseFeatures.default, candidateFeatures.default)) {
    failure("round 9 changes the old platform default safety features");
  }
  return SAFETY_FEATURES;
}

async function assertSwiftBridge({ candidateRoot }) {
  const scanned = await scanTree(candidateRoot);
  const swiftFiles = scanned.files
    .filter((file) => file.path.endsWith(".swift"))
    .sort((left, right) => left.path.localeCompare(right.path));
  const outsideVisual = swiftFiles.filter((file) => !file.path.startsWith(`${VISUAL_ROOT}/`));
  if (outsideVisual.length > 0) {
    failure(`round 9 Swift source must live under ${VISUAL_ROOT}: ${outsideVisual[0].path}`);
  }
  if (swiftFiles.length === 0) {
    failure(`round 9 ${VISUAL_ROOT} must contain at least one Swift bridge source`);
  }
  for (const file of swiftFiles) {
    const text = await readFile(join(candidateRoot, file.path), "utf8");
    if (text.trim() === "") failure(`round 9 Swift source must not be empty: ${file.path}`);
  }
  return swiftFiles.map((file) => file.path);
}

export async function assertRound9DependencyPolicy({ baseRoot, candidateRoot }) {
  const baseCargo = await readTomlFile(join(baseRoot, "Cargo.toml"), "R8 root Cargo.toml");
  const candidateCargo = await readTomlFile(
    join(candidateRoot, "Cargo.toml"),
    "candidate root Cargo.toml",
  );
  const baseVisualCargo = await readTomlFile(
    join(baseRoot, VISUAL_ROOT, "Cargo.toml"),
    "R8 visual Cargo.toml",
  );
  const candidateVisualCargo = await readTomlFile(
    join(candidateRoot, VISUAL_ROOT, "Cargo.toml"),
    "visual Cargo.toml",
  );
  if (candidateVisualCargo.package?.name !== VISUAL_PACKAGE) {
    failure("round 9 visual root must be package cua-macos-visual");
  }
  if (candidateVisualCargo.workspace !== undefined) {
    failure("round 9 visual root must join the full-source workspace, not declare its own");
  }
  const candidateProbeCargo = await readTomlFile(
    join(candidateRoot, PROBE_ROOT, "Cargo.toml"),
    "probe Cargo.toml",
  );
  if (candidateProbeCargo.package?.name !== PROBE_PACKAGE) {
    failure("round 9 probe root must be package cua-macos-visual-link-probe");
  }
  if (candidateProbeCargo.workspace !== undefined) {
    failure("round 9 probe root must join the full-source workspace, not declare its own");
  }
  const workspaceDependencies = candidateCargo.workspace.dependencies ?? {};
  assertDependencyBoundary({
    cargo: candidateVisualCargo,
    workspaceDependencies,
    label: "visual root",
  });
  assertVisualDoesNotDependOnProbe({
    cargo: candidateVisualCargo,
    workspaceDependencies,
  });
  assertVisualDependencySet({
    baseCargo: baseVisualCargo,
    candidateCargo: candidateVisualCargo,
    workspaceDependencies,
  });
  assertDependencyBoundary({
    cargo: candidateProbeCargo,
    workspaceDependencies,
    label: "probe root",
  });
  const probeDependencies = await assertProbeDependencies({
    candidateRoot,
    cargo: candidateProbeCargo,
    visualCargo: candidateVisualCargo,
  });
  assertRootWorkspaceOnlyAddsProbe({ baseCargo, candidateCargo });
  const members = candidateCargo.workspace.members;
  if (!members.includes(VISUAL_ROOT)) {
    failure(`round 9 root workspace members must include ${VISUAL_ROOT}`);
  }
  if (candidateCargo.workspace.exclude?.includes(VISUAL_ROOT)) {
    failure(`round 9 root workspace may not exclude ${VISUAL_ROOT}`);
  }
  if (candidateCargo.workspace.exclude?.includes(PROBE_ROOT)) {
    failure(`round 9 root workspace may not exclude ${PROBE_ROOT}`);
  }
  const preservedFeatures = await assertPlatformFeatures({ baseRoot, candidateRoot });
  const swiftBridgeFiles = await assertSwiftBridge({ candidateRoot });
  return {
    visualRoot: VISUAL_ROOT,
    probeRoot: PROBE_ROOT,
    preservedFeatures,
    swiftBridgeFiles,
    visualDependencies: dependencyEntries(candidateVisualCargo)
      .map((entry) => entry.key)
      .sort((left, right) => left.localeCompare(right)),
    probeDependencies,
  };
}
