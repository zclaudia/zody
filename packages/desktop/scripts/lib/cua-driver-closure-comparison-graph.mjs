import { ClosureVerificationError, isSafeRelativePath } from "./cua-driver-closure-core.mjs";

function fail(message) {
  throw new ClosureVerificationError(message);
}

export function normalizeGraphPath(value) {
  if (value === null) return { kind: "registry", path: null, comparable: true };
  if (typeof value !== "string" || value.length === 0) fail("invalid graph package path");
  let path = value.replaceAll("\\", "/");
  if (path.startsWith("/")) {
    const marker = "/full-source/";
    const index = path.lastIndexOf(marker);
    if (index < 0) return { kind: "path", path: null, comparable: false };
    path = path.slice(index + marker.length);
  }
  if (!isSafeRelativePath(path)) return { kind: "path", path: null, comparable: false };
  return { kind: "path", path, comparable: true };
}

function normalizedPackage(entry) {
  const source = normalizeGraphPath(entry.path);
  return {
    name: entry.name,
    version: entry.version,
    key: `${entry.name}@${entry.version}`,
    features: [...entry.features].sort(),
    kind: entry.kind ?? null,
    source,
  };
}

function identityName(key) {
  const index = key.lastIndexOf("@");
  return index < 0 ? key : key.slice(0, index);
}

function sortedKeys(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function compareGraphs(baselinePackages, candidatePackages) {
  const baseline = new Map(
    baselinePackages.map((entry) => [`${entry.name}@${entry.version}`, normalizedPackage(entry)]),
  );
  const candidate = new Map(
    candidatePackages.map((entry) => [`${entry.name}@${entry.version}`, normalizedPackage(entry)]),
  );
  const removed = sortedKeys([...baseline.keys()].filter((key) => !candidate.has(key))).map((key) =>
    baseline.get(key),
  );
  const added = sortedKeys([...candidate.keys()].filter((key) => !baseline.has(key))).map((key) =>
    candidate.get(key),
  );
  const featureChanged = [];
  const sourceChanged = [];
  for (const key of sortedKeys([...baseline.keys()].filter((entry) => candidate.has(entry)))) {
    const before = baseline.get(key);
    const after = candidate.get(key);
    if (JSON.stringify(before.features) !== JSON.stringify(after.features)) {
      featureChanged.push({
        name: before.name,
        version: before.version,
        baseline: before.features,
        candidate: after.features,
      });
    }
    const sourceDiff =
      before.source.kind !== after.source.kind ||
      (before.source.comparable &&
        after.source.comparable &&
        before.source.path !== after.source.path);
    if (sourceDiff) {
      sourceChanged.push({
        name: before.name,
        version: before.version,
        baseline: before.source,
        candidate: after.source,
      });
    }
  }
  const byName = new Map();
  for (const entry of baseline.values()) {
    if (!byName.has(entry.name)) byName.set(entry.name, { from: [], to: [] });
    byName.get(entry.name).from.push(entry.version);
  }
  for (const entry of candidate.values()) {
    if (!byName.has(entry.name)) byName.set(entry.name, { from: [], to: [] });
    byName.get(entry.name).to.push(entry.version);
  }
  const versionChanged = [];
  const versionSetChanged = [];
  for (const name of [...byName.keys()].sort()) {
    const versions = byName.get(name);
    if (versions.from.length === 0 || versions.to.length === 0) continue;
    const from = [...versions.from].sort();
    const to = [...versions.to].sort();
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    const common = versions.from.filter((version) => versions.to.includes(version));
    if (common.length === 0) {
      versionChanged.push({ name, from, to });
    } else {
      versionSetChanged.push({
        name,
        from,
        to,
        removed: from.filter((version) => !to.includes(version)),
        added: to.filter((version) => !from.includes(version)),
      });
    }
  }
  return {
    baselinePackageCount: baseline.size,
    candidatePackageCount: candidate.size,
    delta: candidate.size - baseline.size,
    removed,
    added,
    versionChanged,
    versionSetChanged,
    featureChanged,
    sourceChanged,
  };
}

export function compareGapSet(baselineSet, candidateSet, baselineIdentities, candidateIdentities) {
  const baseline = new Set(baselineSet);
  const candidate = new Set(candidateSet);
  const baselineNames = new Set([...baselineIdentities].map(identityName));
  const candidateNames = new Set([...candidateIdentities].map(identityName));
  const exactRetained = [...baseline].filter((key) => candidate.has(key));
  const baselineOnly = [...baseline].filter((key) => !candidate.has(key));
  const candidateOnly = [...candidate].filter((key) => !baseline.has(key));
  const materialEvidenceChanged = [];
  const clearedByGraphRemoval = [];
  const versionReplacement = [];
  for (const key of baselineOnly) {
    if (candidateIdentities.has(key)) {
      materialEvidenceChanged.push({ package: key, direction: "gap-removed" });
    } else if (candidateNames.has(identityName(key))) {
      versionReplacement.push(key);
    } else {
      clearedByGraphRemoval.push(key);
    }
  }
  const newExact = [];
  const newVersionReplacement = [];
  for (const key of candidateOnly) {
    if (baselineIdentities.has(key)) {
      materialEvidenceChanged.push({ package: key, direction: "gap-added" });
    } else if (baselineNames.has(identityName(key))) {
      newVersionReplacement.push(key);
    } else {
      newExact.push(key);
    }
  }
  return {
    baselineCount: baseline.size,
    candidateCount: candidate.size,
    delta: candidate.size - baseline.size,
    retained: sortedKeys(exactRetained),
    retainedExact: sortedKeys(exactRetained),
    materialEvidenceChanged: materialEvidenceChanged.sort((left, right) =>
      left.package.localeCompare(right.package),
    ),
    versionReplacement: sortedKeys(versionReplacement),
    clearedByGraphRemoval: sortedKeys(clearedByGraphRemoval),
    new: sortedKeys(candidateOnly),
    newExact: sortedKeys(newExact),
    newVersionReplacement: sortedKeys(newVersionReplacement),
  };
}

function gapSet(values) {
  return values.map((entry) => (typeof entry === "string" ? entry : entry.package));
}

export function compareLicenseEvidence(baseline, candidate) {
  const baselineIdentities = new Set(
    baseline.packages.map((entry) => `${entry.name}@${entry.version}`),
  );
  const candidateIdentities = new Set(
    candidate.packages.map((entry) => `${entry.name}@${entry.version}`),
  );
  const baselineLicenses = baseline.report.licenses;
  const candidateLicenses = candidate.report.licenses;
  const build = (read) =>
    compareGapSet(
      read(baselineLicenses),
      read(candidateLicenses),
      baselineIdentities,
      candidateIdentities,
    );
  return {
    baseline: {
      packageCount: baselineLicenses.packageCount,
      missing: baselineLicenses.missingMaterials.length,
      partial: baselineLicenses.incompleteCoverage.length,
      reviewRequired: baselineLicenses.reviewRequired.length,
      mpl: baselineLicenses.mplPackages.length,
    },
    candidate: {
      packageCount: candidateLicenses.packageCount,
      missing: candidateLicenses.missingMaterials.length,
      partial: candidateLicenses.incompleteCoverage.length,
      reviewRequired: candidateLicenses.reviewRequired.length,
      mpl: candidateLicenses.mplPackages.length,
    },
    missing: build((entry) => entry.missingMaterials),
    partial: build((entry) => gapSet(entry.incompleteCoverage)),
    reviewRequired: build((entry) => entry.reviewRequired),
    mpl: build((entry) => entry.mplPackages),
    residualGaps: {
      missing: sortedKeys(candidateLicenses.missingMaterials),
      partial: sortedKeys(gapSet(candidateLicenses.incompleteCoverage)),
      reviewRequired: sortedKeys(candidateLicenses.reviewRequired),
      mpl: sortedKeys(candidateLicenses.mplPackages),
    },
    legalConclusion: "not-made",
    legalReviewCompleted: false,
  };
}

function packageNames(packages) {
  return new Set(packages.map((entry) => entry.name));
}

export function evaluateDependencyPolicy(packages, policy) {
  const names = packageNames(packages);
  const excludedPresent = [];
  for (const name of names) {
    if (
      policy.excludedPackages.includes(name) ||
      policy.excludedPackagePrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      excludedPresent.push(name);
    }
  }
  if (excludedPresent.length > 0) {
    fail(`excluded package present in actual graph: ${[...excludedPresent].sort().join(", ")}`);
  }
  for (const entry of packages) {
    for (const feature of policy.forbiddenFeatures) {
      if (entry.features.includes(feature)) {
        fail(`forbidden graph feature ${feature} is active for ${entry.name}`);
      }
    }
  }
  const features = {};
  for (const [key, spec] of [
    ["core", policy.coreFeatures],
    ["platform", policy.platformFeatures],
  ]) {
    const matches = packages.filter((entry) => entry.name === spec.package);
    if (matches.length === 0) fail(`required package is missing: ${spec.package}`);
    for (const entry of matches) {
      for (const feature of spec.required) {
        if (!entry.features.includes(feature)) {
          fail(`required feature ${feature} is missing for ${spec.package}`);
        }
      }
      for (const feature of spec.forbidden) {
        if (entry.features.includes(feature)) {
          fail(`forbidden feature ${feature} is active for ${spec.package}`);
        }
      }
    }
    features[key] = {
      package: spec.package,
      required: spec.required,
      forbidden: spec.forbidden,
      actual: matches.map((entry) => ({
        version: entry.version,
        features: [...entry.features].sort(),
      })),
    };
  }
  return { excludedPresent: [], features };
}

export { identityName, sortedKeys };
