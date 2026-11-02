import { ClosureVerificationError } from "./cua-driver-closure-core.mjs";
import { compareGraphs, compareLicenseEvidence } from "./cua-driver-closure-comparison-graph.mjs";

function fail(message) {
  throw new ClosureVerificationError(message);
}

function packageKey(entry) {
  return `${entry.name}@${entry.version}`;
}

function packageNames(packages) {
  return new Set(packages.map((entry) => entry.name));
}

const ALLOWED_ADDITION_ROOT = "crates/cua-macos-visual/";
const BYTE_EXEMPT_PATHS = new Set(["Cargo.toml", "Cargo.lock"]);

export function compareTransitionGraphs(baselinePackages, candidatePackages) {
  const delta = compareGraphs(baselinePackages, candidatePackages);
  return {
    baselinePackageCount: delta.baselinePackageCount,
    candidatePackageCount: delta.candidatePackageCount,
    delta: delta.delta,
    inventoryDelta: {
      removedFromCandidateGraph: delta.removed.map(packageKey),
      addedToCandidateGraph: delta.added.map(packageKey),
      versionChanged: delta.versionChanged,
      versionSetChanged: delta.versionSetChanged,
      featureChanged: delta.featureChanged,
      sourceChanged: delta.sourceChanged,
    },
    semantics:
      "removedFromCandidateGraph means absent from the candidate build root graph; baseline evidence and legacy source remain",
  };
}

function mapGapInventory(delta) {
  return {
    removedFromCandidateGraph: delta.clearedByGraphRemoval,
    retainedInCandidateGraph: delta.retained,
    newInCandidateGraph: delta.new,
    versionReplacement: delta.versionReplacement,
    sameIdentityEvidenceChanged: delta.materialEvidenceChanged,
  };
}

export function compareTransitionLicenses(baseline, candidate) {
  const evidence = compareLicenseEvidence(baseline, candidate);
  const legacyGapEntries =
    evidence.baseline.missing +
    evidence.baseline.partial +
    evidence.baseline.reviewRequired +
    evidence.baseline.mpl;
  return {
    baseline: evidence.baseline,
    candidate: evidence.candidate,
    inventoryDelta: {
      missing: mapGapInventory(evidence.missing),
      partial: mapGapInventory(evidence.partial),
      reviewRequired: mapGapInventory(evidence.reviewRequired),
      mpl: mapGapInventory(evidence.mpl),
    },
    residualGaps: evidence.residualGaps,
    legacyGapEntries,
    legacyGapsStillExist: legacyGapEntries > 0,
    resolvedByTransition: false,
    legalConclusion: "not-made",
    legalReviewCompleted: false,
    semantics:
      "inventory removal only narrows the candidate graph; it does not resolve old R7 license gaps and is not license completion",
  };
}

export function verifySourceRetention(baseline, candidate) {
  const baselineFiles = baseline.source.files;
  const candidateFiles = candidate.source.files;
  const candidateByPath = new Map(candidateFiles.map((entry) => [entry.path, entry]));
  const baselinePaths = new Set(baselineFiles.map((entry) => entry.path));
  const missing = baselineFiles
    .filter((entry) => !candidateByPath.has(entry.path))
    .map((entry) => entry.path);
  if (missing.length > 0) fail(`source retention missing baseline files: ${missing.join(", ")}`);
  const changed = baselineFiles
    .filter((entry) => {
      if (BYTE_EXEMPT_PATHS.has(entry.path)) return false;
      return candidateByPath.get(entry.path).candidateSha256 !== entry.candidateSha256;
    })
    .map((entry) => entry.path);
  if (changed.length > 0) fail(`source retention changed legacy files: ${changed.join(", ")}`);
  const added = candidateFiles.filter((entry) => !baselinePaths.has(entry.path));
  const outside = added.filter((entry) => !entry.path.startsWith(ALLOWED_ADDITION_ROOT));
  if (outside.length > 0) {
    fail(
      `source retention additions outside ${ALLOWED_ADDITION_ROOT}: ${outside.map((entry) => entry.path).join(", ")}`,
    );
  }
  const changedExempt = [...BYTE_EXEMPT_PATHS].filter((path) => {
    const before = baselineFiles.find((entry) => entry.path === path);
    const after = candidateByPath.get(path);
    return before && after && before.candidateSha256 !== after.candidateSha256;
  });
  return {
    status: "verified",
    baselineFileCount: baselineFiles.length,
    candidateFileCount: candidateFiles.length,
    retainedFileCount: baselineFiles.length,
    exemptPaths: [...BYTE_EXEMPT_PATHS],
    changedExemptPaths: changedExempt,
    allowedAdditionRoot: ALLOWED_ADDITION_ROOT,
    addedPaths: added.map((entry) => entry.path),
    evidence:
      "every baseline source.files path exists in candidate source.files; non-exempt bytes are identical; additions stay under the visual crate root",
  };
}

export function evaluateTransitionFeatures(baselinePackages, candidatePackages, policy) {
  const names = packageNames(candidatePackages);
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
  for (const entry of candidatePackages) {
    for (const feature of policy.forbiddenFeatures) {
      if (entry.features.includes(feature)) {
        fail(`forbidden graph feature ${feature} is active for ${entry.name}`);
      }
    }
  }
  const baselineOnly = policy.featureScope.baselineOnly.map((spec) => {
    const matches = baselinePackages.filter((entry) => entry.name === spec.package);
    if (matches.length === 0) fail(`required baseline-only package is missing: ${spec.package}`);
    if (candidatePackages.some((entry) => entry.name === spec.package)) {
      fail(`baseline-only feature package entered candidate graph: ${spec.package}`);
    }
    for (const entry of matches) {
      for (const feature of spec.required) {
        if (!entry.features.includes(feature)) {
          fail(`required baseline feature ${feature} is missing for ${spec.package}`);
        }
      }
      for (const feature of spec.forbidden) {
        if (entry.features.includes(feature)) {
          fail(`forbidden baseline feature ${feature} is active for ${spec.package}`);
        }
      }
    }
    return {
      package: spec.package,
      required: [...spec.required],
      forbidden: [...spec.forbidden],
      actual: matches.map((entry) => ({
        version: entry.version,
        features: [...entry.features].sort(),
      })),
      appliesTo: "baseline",
      candidateApplicability:
        "not-applicable: package absent from candidate graph; legacy source retained and uncompiled",
    };
  });
  return {
    applicability:
      "legacy safety features are checked only on the R7 baseline graph; the visual root does not synthesize them",
    baselineOnly,
    candidate: {
      required: [],
      forbidden: [...policy.forbiddenFeatures],
      applicability: "no candidate package-level feature is required by the root transition",
    },
    excludedPresent: [],
  };
}

function transitionIdentity(policy, baseline, candidate, sourceRetention) {
  const declared = policy.rootTransition;
  return {
    declared: true,
    from: {
      package: declared.fromPackage,
      revision: declared.revision,
      sourceRoot: declared.sourceRoot,
      target: declared.target,
      root: baseline.graph.root,
    },
    to: {
      package: declared.toPackage,
      revision: declared.revision,
      sourceRoot: declared.sourceRoot,
      target: declared.target,
      root: candidate.graph.root,
    },
    functionalEquivalent: declared.functionalEquivalent,
    interfaceEquivalent: declared.interfaceEquivalent,
    abiEquivalent: declared.abiEquivalent,
    toolEquivalent: declared.toolEquivalent,
    legacyRootUncompiled: declared.legacyRootUncompiled,
    scopeChanges: {
      removedFromCandidateGraph: [...declared.scopeChanges.removedFromCandidateGraph],
      baselineOnlyFeaturePackages: [...declared.scopeChanges.baselineOnlyFeaturePackages],
      sourceRetention: {
        status: sourceRetention.status,
        baselineFileCount: sourceRetention.baselineFileCount,
        candidateFileCount: sourceRetention.candidateFileCount,
        evidence: "verified from baseline and candidate source.files",
      },
    },
  };
}

export function buildRootTransitionComparison({ policy, baseline, candidate }) {
  const sourceRetention = verifySourceRetention(baseline, candidate);
  return {
    rootTransition: transitionIdentity(policy, baseline, candidate, sourceRetention),
    graph: compareTransitionGraphs(baseline.packages, candidate.packages),
    features: evaluateTransitionFeatures(baseline.packages, candidate.packages, policy),
    licenses: compareTransitionLicenses(baseline, candidate),
    sourceRetention,
  };
}
