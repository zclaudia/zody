import {
  ClosureVerificationError,
  isRecord,
  isSafeRelativePath,
  isSha256,
} from "./cua-driver-closure-core.mjs";

export const COMPARISON_POLICY_KIND = "zody-cua-driver-closure-comparison-policy";
export const REQUIRED_EXCLUDED_PACKAGES = [
  "rquickjs",
  "rquickjs-core",
  "rquickjs-sys",
  "regorus",
  "uniffi",
];
const TRANSITION_EXCLUDED_PACKAGES = [
  "cua-driver-sdk",
  "cua-driver-core",
  "platform-macos",
  "clipboard-rs",
  "cursor-overlay",
  "pip-preview",
  "cua-cursor-motion",
  "quickjs",
  "quickjs-ng",
  "rego",
];
const TRANSITION_FORBIDDEN_FEATURES = [
  "zody-dev-probe",
  "zody-dev-no-input",
  "zody-strict-frame-gate",
];

function fail(message) {
  throw new ClosureVerificationError(message);
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

export function requireRecord(value, label) {
  if (!isRecord(value)) fail(`invalid ${label}`);
  return value;
}

export function requireCount(value, label) {
  if (!integer(value)) fail(`invalid ${label}`);
  return value;
}

export function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`invalid ${label}`);
  return value;
}

export function requireSafeRelative(value, label) {
  requireString(value, label);
  if (!isSafeRelativePath(value)) fail(`${label} must be a safe relative path`);
  return value;
}

export function requireSha(value, label) {
  requireString(value, label);
  if (!isSha256(value)) fail(`invalid ${label}`);
  return value;
}

export function requireRevision(value, label) {
  requireString(value, label);
  if (!/^[a-f0-9]{40}$/.test(value)) fail(`invalid ${label}`);
  return value;
}

function requireBoolean(value, label, expected) {
  if (value !== expected) fail(`invalid ${label}`);
  return value;
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`invalid ${label}`);
  return value;
}

function requireExactKeys(value, keys, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`invalid ${label} fields`);
  }
  return value;
}

function requireAllowedKeys(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(`invalid ${label} fields`);
  return value;
}

export function requireStringSet(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(`invalid ${label}`);
  if (!allowEmpty && value.length === 0) fail(`invalid ${label}`);
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail(`invalid ${label}`);
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
  return [...value];
}

export function validateTransitionComparisonPolicy(policy) {
  if (!isRecord(policy.rootTransition)) fail("root transition is not declared");
  requireExactKeys(
    policy,
    [
      "schemaVersion",
      "kind",
      "baseline",
      "candidate",
      "rootTransition",
      "excludedPackages",
      "excludedPackagePrefixes",
      "forbiddenFeatures",
      "featureScope",
      "productAdoption",
      "legalConclusion",
    ],
    "comparison policy",
  );
  if (policy.kind !== COMPARISON_POLICY_KIND) fail("invalid comparison policy schema");
  const baseline = requireRecord(policy.baseline, "baseline policy");
  requireAllowedKeys(
    baseline,
    [
      "reportPath",
      "sha256",
      "revision",
      "sourceRoot",
      "target",
      "package",
      "reviewConfigSha256",
      "sourceManifestSha256",
      "sourceFileCount",
      "graphPackageCount",
      "lockEntryCount",
      "lockChecksumEntries",
      "license",
      "supplements",
    ],
    "baseline policy",
  );
  requireSafeRelative(baseline.reportPath, "baseline.reportPath");
  requireSha(baseline.sha256, "baseline.sha256");
  requireRevision(baseline.revision, "baseline.revision");
  requireSafeRelative(baseline.sourceRoot, "baseline.sourceRoot");
  requireString(baseline.target, "baseline.target");
  requireString(baseline.package, "baseline.package");
  requireSha(baseline.reviewConfigSha256, "baseline.reviewConfigSha256");
  requireSha(baseline.sourceManifestSha256, "baseline.sourceManifestSha256");
  for (const key of [
    "sourceFileCount",
    "graphPackageCount",
    "lockEntryCount",
    "lockChecksumEntries",
  ]) {
    requireCount(baseline[key], `baseline.${key}`);
  }
  const baselineLicense = requireRecord(baseline.license, "baseline.license");
  requireExactKeys(
    baselineLicense,
    ["packageCount", "missing", "partial", "reviewRequired", "mpl"],
    "baseline.license",
  );
  for (const key of ["packageCount", "missing", "partial", "reviewRequired", "mpl"]) {
    requireCount(baselineLicense[key], `baseline.license.${key}`);
  }
  let supplements;
  if (baseline.supplements !== undefined) {
    supplements = requireRecord(baseline.supplements, "baseline.supplements");
    requireExactKeys(
      supplements,
      ["manifestPath", "manifestSha256", "entryCount", "sourceRevision"],
      "baseline.supplements",
    );
    requireSafeRelative(supplements.manifestPath, "baseline.supplements.manifestPath");
    requireSha(supplements.manifestSha256, "baseline.supplements.manifestSha256");
    requireCount(supplements.entryCount, "baseline.supplements.entryCount");
    requireRevision(supplements.sourceRevision, "baseline.supplements.sourceRevision");
  }

  const candidate = requireRecord(policy.candidate, "candidate policy");
  requireExactKeys(candidate, ["revision", "sourceRoot", "target", "package"], "candidate policy");
  requireRevision(candidate.revision, "candidate.revision");
  requireSafeRelative(candidate.sourceRoot, "candidate.sourceRoot");
  requireString(candidate.target, "candidate.target");
  requireString(candidate.package, "candidate.package");

  const transition = requireRecord(policy.rootTransition, "root transition");
  requireExactKeys(
    transition,
    [
      "fromPackage",
      "toPackage",
      "revision",
      "sourceRoot",
      "target",
      "functionalEquivalent",
      "interfaceEquivalent",
      "abiEquivalent",
      "toolEquivalent",
      "legacyRootUncompiled",
      "scopeChanges",
    ],
    "root transition",
  );
  requireString(transition.fromPackage, "rootTransition.fromPackage");
  requireString(transition.toPackage, "rootTransition.toPackage");
  requireRevision(transition.revision, "rootTransition.revision");
  requireSafeRelative(transition.sourceRoot, "rootTransition.sourceRoot");
  requireString(transition.target, "rootTransition.target");
  if (transition.fromPackage === transition.toPackage) {
    fail("root transition package identities must differ");
  }
  if (baseline.package !== transition.fromPackage)
    fail("baseline package does not match root transition");
  if (candidate.package !== transition.toPackage)
    fail("candidate package does not match root transition");
  for (const [field, value, label] of [
    ["revision", transition.revision, "revision"],
    ["sourceRoot", transition.sourceRoot, "sourceRoot"],
    ["target", transition.target, "target"],
  ]) {
    if (baseline[field] !== value || candidate[field] !== value) {
      fail(`root transition ${label} does not match baseline and candidate`);
    }
  }
  requireBoolean(transition.functionalEquivalent, "rootTransition.functionalEquivalent", false);
  for (const key of ["interfaceEquivalent", "abiEquivalent", "toolEquivalent"]) {
    requireOneOf(transition[key], [false, "not-established"], `rootTransition.${key}`);
  }
  requireBoolean(transition.legacyRootUncompiled, "rootTransition.legacyRootUncompiled", true);
  const scopeChanges = requireRecord(transition.scopeChanges, "rootTransition.scopeChanges");
  requireExactKeys(
    scopeChanges,
    ["removedFromCandidateGraph", "baselineOnlyFeaturePackages"],
    "rootTransition.scopeChanges",
  );
  const removedFromCandidateGraph = requireStringSet(
    scopeChanges.removedFromCandidateGraph,
    "rootTransition.scopeChanges.removedFromCandidateGraph",
  );
  const baselineOnlyFeaturePackages = requireStringSet(
    scopeChanges.baselineOnlyFeaturePackages,
    "rootTransition.scopeChanges.baselineOnlyFeaturePackages",
  );
  if (!removedFromCandidateGraph.includes(transition.fromPackage)) {
    fail("root transition must remove the baseline package from the candidate graph");
  }
  for (const name of baselineOnlyFeaturePackages) {
    if (!removedFromCandidateGraph.includes(name)) {
      fail(`root transition must remove baseline-only feature package ${name}`);
    }
  }

  const excludedPackages = requireStringSet(policy.excludedPackages, "excludedPackages");
  for (const name of [...REQUIRED_EXCLUDED_PACKAGES, ...TRANSITION_EXCLUDED_PACKAGES]) {
    if (!excludedPackages.includes(name)) fail(`policy must exclude ${name}`);
  }
  for (const name of excludedPackages) {
    if (!removedFromCandidateGraph.includes(name)) {
      fail(`root transition must declare excluded package ${name}`);
    }
  }
  for (const name of removedFromCandidateGraph) {
    if (!excludedPackages.includes(name)) {
      fail(`root transition scope package must be excluded: ${name}`);
    }
  }
  const excludedPackagePrefixes = requireStringSet(
    policy.excludedPackagePrefixes,
    "excludedPackagePrefixes",
  );
  if (!excludedPackagePrefixes.includes("uniffi_")) fail("policy must exclude uniffi_ prefix");
  const forbiddenFeatures = requireStringSet(policy.forbiddenFeatures, "forbiddenFeatures");
  for (const feature of TRANSITION_FORBIDDEN_FEATURES) {
    if (!forbiddenFeatures.includes(feature)) fail(`policy must forbid ${feature}`);
  }

  const featureScope = requireRecord(policy.featureScope, "featureScope");
  requireExactKeys(featureScope, ["baselineOnly"], "featureScope");
  if (!Array.isArray(featureScope.baselineOnly) || featureScope.baselineOnly.length === 0) {
    fail("invalid featureScope.baselineOnly");
  }
  const featurePackages = new Set();
  const baselineOnly = featureScope.baselineOnly.map((entry) => {
    const feature = requireRecord(entry, "featureScope.baselineOnly entry");
    requireExactKeys(
      feature,
      ["package", "required", "forbidden"],
      "featureScope.baselineOnly entry",
    );
    const name = requireString(feature.package, "featureScope.baselineOnly.package");
    if (featurePackages.has(name)) fail(`duplicate baseline-only feature package: ${name}`);
    featurePackages.add(name);
    const required = requireStringSet(feature.required, `featureScope.${name}.required`);
    const forbidden = requireStringSet(feature.forbidden, `featureScope.${name}.forbidden`, {
      allowEmpty: true,
    });
    if (required.some((value) => forbidden.includes(value))) {
      fail(`featureScope.${name} requires and forbids the same feature`);
    }
    return { package: name, required, forbidden };
  });
  if (
    JSON.stringify([...featurePackages].sort()) !==
    JSON.stringify([...baselineOnlyFeaturePackages].sort())
  ) {
    fail("root transition baseline-only feature packages do not match featureScope");
  }
  if (policy.productAdoption !== "blocked") fail("policy must keep product adoption blocked");
  if (policy.legalConclusion !== "not-made") fail("policy must not make a legal conclusion");
  return {
    ...policy,
    baseline: { ...baseline, license: baselineLicense, supplements },
    candidate,
    rootTransition: {
      ...transition,
      scopeChanges: { removedFromCandidateGraph, baselineOnlyFeaturePackages },
    },
    excludedPackages,
    excludedPackagePrefixes,
    forbiddenFeatures,
    featureScope: { baselineOnly },
  };
}
