import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeReport, makeTempRoot, pkg, sha } from "./cua-driver-closure-comparison-fixtures.mjs";

export const REV = "2d2f99228d4d2508dc6fcc84c176b296e146714a";
export const SRC = "libs/cua-driver/rust";
export const TARGET = "aarch64-apple-darwin";
export const LEGACY_PACKAGE = "cua-driver-sdk";
export const VISUAL_PACKAGE = "cua-macos-visual";

export const LEGACY_PACKAGES = [
  pkg("cua-driver-core", "0.37.0", ["default", "yaml"], "crates/cua-driver-core"),
  pkg(
    "platform-macos",
    "0.37.0",
    ["default", "zody-dev-no-input", "zody-strict-frame-gate"],
    "crates/platform-macos",
  ),
  pkg("clipboard-rs", "0.37.0", ["default"], "crates/clipboard-rs"),
  pkg("cursor-overlay", "0.37.0", ["default"], "crates/cursor-overlay"),
  pkg("pip-preview", "0.37.0", ["default"], "crates/pip-preview"),
  pkg("cua-cursor-motion", "0.37.0", ["default"], "crates/cua-cursor-motion"),
  pkg("rquickjs", "0.14.0", ["default"], null),
  pkg("uniffi", "0.31.0", ["default"], null),
];

export const VISUAL_PACKAGES = [
  pkg("objc2", "0.6.3", ["default"], null),
  pkg("block2", "0.6.2", ["default"], null),
];

const VISUAL_SOURCE_FILES = [
  {
    path: "crates/cua-macos-visual/Cargo.toml",
    status: "added",
    candidateSha256: sha("visual-cargo"),
  },
  {
    path: "crates/cua-macos-visual/src/lib.rs",
    status: "added",
    candidateSha256: sha("visual-lib"),
  },
];

export const REMOVED_SCOPE = [
  LEGACY_PACKAGE,
  "cua-driver-core",
  "platform-macos",
  "clipboard-rs",
  "cursor-overlay",
  "pip-preview",
  "cua-cursor-motion",
  "rquickjs",
  "rquickjs-core",
  "rquickjs-sys",
  "quickjs",
  "quickjs-ng",
  "rego",
  "regorus",
  "uniffi",
];

export function makeTransitionPolicy(baseline, baselineSha) {
  return {
    schemaVersion: 2,
    kind: "zody-cua-driver-closure-comparison-policy",
    baseline: {
      reportPath: "baseline.json",
      sha256: baselineSha,
      revision: baseline.revision,
      sourceRoot: baseline.sourceRoot,
      target: baseline.dependencies.graph.target,
      package: LEGACY_PACKAGE,
      reviewConfigSha256: baseline.review.configSha256,
      sourceManifestSha256: baseline.review.manifestSha256,
      sourceFileCount: baseline.source.files.length,
      graphPackageCount: baseline.dependencies.graph.packageCount,
      lockEntryCount: baseline.dependencies.lock.entryCount,
      lockChecksumEntries: baseline.dependencies.lock.checksumEntries,
      license: {
        packageCount: baseline.licenses.packageCount,
        missing: baseline.licenses.missingMaterials.length,
        partial: baseline.licenses.incompleteCoverage.length,
        reviewRequired: baseline.licenses.reviewRequired.length,
        mpl: baseline.licenses.mplPackages.length,
      },
    },
    candidate: {
      revision: REV,
      sourceRoot: SRC,
      target: TARGET,
      package: VISUAL_PACKAGE,
    },
    rootTransition: {
      fromPackage: LEGACY_PACKAGE,
      toPackage: VISUAL_PACKAGE,
      revision: REV,
      sourceRoot: SRC,
      target: TARGET,
      functionalEquivalent: false,
      interfaceEquivalent: "not-established",
      abiEquivalent: "not-established",
      toolEquivalent: "not-established",
      legacyRootUncompiled: true,
      scopeChanges: {
        removedFromCandidateGraph: [...REMOVED_SCOPE],
        baselineOnlyFeaturePackages: ["cua-driver-core", "platform-macos"],
      },
    },
    excludedPackages: [...REMOVED_SCOPE],
    excludedPackagePrefixes: ["uniffi_"],
    forbiddenFeatures: ["zody-dev-probe", "zody-dev-no-input", "zody-strict-frame-gate"],
    featureScope: {
      baselineOnly: [
        {
          package: "cua-driver-core",
          required: ["yaml"],
          forbidden: ["script", "rego"],
        },
        {
          package: "platform-macos",
          required: ["zody-dev-no-input", "zody-strict-frame-gate"],
          forbidden: ["zody-dev-probe"],
        },
      ],
    },
    productAdoption: "blocked",
    legalConclusion: "not-made",
  };
}

export function buildTransitionSourceFiles(baselineFiles, options = {}) {
  const removed = new Set(options.removedPaths ?? []);
  const mutated = new Set(options.mutatedPaths ?? ["Cargo.toml", "Cargo.lock"]);
  const retained = baselineFiles
    .filter((entry) => !removed.has(entry.path))
    .map((entry) =>
      mutated.has(entry.path)
        ? { ...entry, candidateSha256: sha(`round8-change:${entry.path}`) }
        : { ...entry },
    );
  const added = options.addedFiles ?? VISUAL_SOURCE_FILES;
  return [...retained, ...added.map((entry) => ({ ...entry }))];
}

export async function writeTransitionFixture(options = {}) {
  const root = await makeTempRoot("zody-cua-round8-comparison-");
  const baseline = makeReport({
    packageName: LEGACY_PACKAGE,
    packages: options.baseline?.packages ?? LEGACY_PACKAGES,
    gaps: options.baseline?.gaps ?? {
      missing: ["cua-driver-core@0.37.0", "platform-macos@0.37.0", "rquickjs@0.14.0"],
      partial: ["clipboard-rs@0.37.0"],
      reviewRequired: ["uniffi@0.31.0"],
      mpl: ["uniffi@0.31.0"],
    },
    ...options.baseline,
  });
  const candidate = makeReport({
    packageName: VISUAL_PACKAGE,
    packages: options.candidate?.packages ?? VISUAL_PACKAGES,
    ...options.candidate,
    sourceFiles:
      options.candidate?.sourceFiles ??
      buildTransitionSourceFiles(baseline.source.files, {
        removedPaths: options.removedSourcePaths,
        mutatedPaths: options.mutatedSourcePaths,
        addedFiles: options.addedSourceFiles,
      }),
  });
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  await writeFile(baselinePath, JSON.stringify(baseline));
  await writeFile(candidatePath, JSON.stringify(candidate));
  const policy = makeTransitionPolicy(baseline, sha(JSON.stringify(baseline)));
  options.mutatePolicy?.(policy);
  const policyPath = join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify(policy));
  return {
    root,
    baseline,
    candidate,
    baselinePath,
    candidatePath,
    policyPath,
    baselineReportPath: baselinePath,
    candidateReportPath: candidatePath,
    outputDir: join(root, "out"),
  };
}
