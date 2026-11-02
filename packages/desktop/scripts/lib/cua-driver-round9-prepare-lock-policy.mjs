import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { failure } from "./cua-driver-round9-prepare-config.mjs";
import {
  PROBE_PACKAGE,
  VISUAL_PACKAGE,
  readTomlFile,
} from "./cua-driver-round9-prepare-policy.mjs";

const VISUAL_LOCK_BASE_DEPS = ["core-foundation", "image", "screencapturekit"];
const VISUAL_LOCK_CANDIDATE_DEPS = ["core-foundation", "image"];
const PROBE_LOCK_DEPS = ["cua-macos-visual"];

function validateLockPackage(entry, label) {
  if (typeof entry?.name !== "string" || entry.name === "") {
    failure(`round 9 ${label} contains a package without a name`);
  }
  if (typeof entry.version !== "string" || entry.version === "") {
    failure(`round 9 ${label} package ${entry.name} has no version`);
  }
  if (entry.source !== undefined && typeof entry.source !== "string") {
    failure(`round 9 ${label} package ${entry.name} has an invalid source`);
  }
  if (entry.checksum !== undefined && typeof entry.checksum !== "string") {
    failure(`round 9 ${label} package ${entry.name} has an invalid checksum`);
  }
  if (
    entry.dependencies !== undefined &&
    (!Array.isArray(entry.dependencies) ||
      entry.dependencies.some((dependency) => typeof dependency !== "string"))
  ) {
    failure(`round 9 ${label} package ${entry.name} has invalid dependencies`);
  }
}

function lockPackageKey(entry) {
  return `${entry.name}\0${entry.version}\0${entry.source ?? ""}`;
}

function lockPackageLabel(entry) {
  return `${entry.name} ${entry.version}`;
}

function normalizedLockPackage(entry) {
  const copy = structuredClone(entry);
  if (Array.isArray(copy.dependencies)) {
    copy.dependencies = [...copy.dependencies].sort((left, right) => left.localeCompare(right));
  }
  return copy;
}

function lockPackages(lock, label) {
  if (!Array.isArray(lock?.package)) failure(`round 9 ${label} has no package list`);
  const result = new Map();
  for (const entry of lock.package) {
    validateLockPackage(entry, label);
    const key = lockPackageKey(entry);
    if (result.has(key)) {
      failure(`round 9 ${label} contains duplicate package ${lockPackageLabel(entry)}`);
    }
    result.set(key, entry);
  }
  return result;
}

function normalizedDependencies(entry) {
  return [...(entry.dependencies ?? [])].sort((left, right) => left.localeCompare(right));
}

export async function assertRound9LockPolicy({ baseRoot, candidateRoot }) {
  const baseLock = await readTomlFile(join(baseRoot, "Cargo.lock"), "R8 Cargo.lock");
  const candidateLock = await readTomlFile(
    join(candidateRoot, "Cargo.lock"),
    "candidate Cargo.lock",
  );
  const baseTopLevel = structuredClone(baseLock);
  const candidateTopLevel = structuredClone(candidateLock);
  delete baseTopLevel.package;
  delete candidateTopLevel.package;
  if (!isDeepStrictEqual(baseTopLevel, candidateTopLevel)) {
    failure("round 9 lock top-level metadata changed");
  }
  const basePackages = lockPackages(baseLock, "R8 Cargo.lock");
  const candidatePackages = lockPackages(candidateLock, "candidate Cargo.lock");
  const baseVisual = [...basePackages.values()].find((entry) => entry.name === VISUAL_PACKAGE);
  if (!baseVisual) failure("round 9 R8 lock is missing cua-macos-visual");
  let visualDependencies = null;
  let visualVersion = null;
  for (const [key, entry] of basePackages) {
    const next = candidatePackages.get(key);
    if (!next) failure(`round 9 lock removes ${lockPackageLabel(entry)}`);
    if (entry.name === VISUAL_PACKAGE) {
      if (!isDeepStrictEqual(normalizedDependencies(entry), VISUAL_LOCK_BASE_DEPS)) {
        failure("round 9 base visual lock dependencies are not the accepted R8 set");
      }
      if (!isDeepStrictEqual(normalizedDependencies(next), VISUAL_LOCK_CANDIDATE_DEPS)) {
        failure(
          "round 9 visual lock dependencies must change from core-foundation,image,screencapturekit to core-foundation,image",
        );
      }
      const baseOther = normalizedLockPackage(entry);
      const candidateOther = normalizedLockPackage(next);
      delete baseOther.dependencies;
      delete candidateOther.dependencies;
      if (!isDeepStrictEqual(baseOther, candidateOther)) {
        failure(`round 9 lock changes existing ${lockPackageLabel(entry)}`);
      }
      visualDependencies = normalizedDependencies(next);
      visualVersion = next.version;
    } else if (!isDeepStrictEqual(normalizedLockPackage(entry), normalizedLockPackage(next))) {
      failure(`round 9 lock changes existing ${lockPackageLabel(entry)}`);
    }
  }
  const addedPathPackages = [];
  for (const [key, entry] of candidatePackages) {
    if (basePackages.has(key)) continue;
    if (entry.source !== undefined || entry.checksum !== undefined) {
      if (entry.name === PROBE_PACKAGE) {
        failure(`round 9 lock probe entry ${PROBE_PACKAGE} must not carry source or checksum`);
      }
      failure(`round 9 lock adds a non-path package ${lockPackageLabel(entry)}`);
    }
    if (entry.name !== PROBE_PACKAGE) {
      failure(`round 9 lock adds an unexpected path package ${entry.name}`);
    }
    addedPathPackages.push(entry.name);
  }
  const probeEntries = [...candidatePackages.values()].filter(
    (entry) => entry.name === PROBE_PACKAGE,
  );
  if (probeEntries.length !== 1) {
    failure(`round 9 probe crate requires a path lock entry for ${PROBE_PACKAGE}`);
  }
  const probe = probeEntries[0];
  if (probe.source !== undefined || probe.checksum !== undefined) {
    failure(`round 9 lock probe entry ${PROBE_PACKAGE} must not carry source or checksum`);
  }
  if (!isDeepStrictEqual(normalizedDependencies(probe), PROBE_LOCK_DEPS)) {
    failure("round 9 probe lock dependencies must be exactly cua-macos-visual");
  }
  if (probe.version !== visualVersion) {
    failure("round 9 probe lock version must match cua-macos-visual");
  }
  if (!isDeepStrictEqual([...addedPathPackages].sort(), [PROBE_PACKAGE])) {
    failure("round 9 lock may add only the link probe path package");
  }
  return {
    lockVersion: baseLock.version,
    visualDependencies,
    probeDependencies: PROBE_LOCK_DEPS,
    addedPathPackages: [PROBE_PACKAGE],
    existingPackagesRetained: basePackages.size,
    unchangedPackages: basePackages.size - 1,
    modifiedPackages: [VISUAL_PACKAGE],
  };
}
