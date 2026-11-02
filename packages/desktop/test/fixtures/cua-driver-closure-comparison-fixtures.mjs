import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REV = "2d2f99228d4d2508dc6fcc84c176b296e146714a";
export const SRC = "libs/cua-driver/rust";
export const TARGET = "aarch64-apple-darwin";
export const PKG = "cua-driver-sdk";
const tempDirs = [];

export function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function makeTempRoot(prefix, base = tmpdir()) {
  const root = await mkdtemp(join(base, prefix));
  tempDirs.push(root);
  return root;
}

export async function cleanupTempDirs() {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
}

export function pkg(name, version, features = [], path = null) {
  return { name, version, features, path, kind: null };
}

function licenseEntry(name, version) {
  return { package: `${name}@${version}`, expression: "MIT", files: [], status: "recorded" };
}

export function makeReport(options = {}) {
  const packageName = options.packageName ?? PKG;
  const packages = recordPackages(options, packageName);
  const files = options.sourceFiles ?? [
    { path: "Cargo.toml", status: "added", candidateSha256: sha("cargo") },
    {
      path: "crates/cua-driver-core/Cargo.toml",
      status: "modified",
      upstreamSha256: sha("upstream"),
      candidateSha256: sha("candidate"),
    },
  ];
  const gaps = options.gaps ?? {};
  return {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-report",
    generatedAt: "2026-10-28T00:00:00.000Z",
    revision: options.revision ?? REV,
    sourceRoot: options.sourceRoot ?? SRC,
    review: { configSha256: sha("config"), manifestSha256: sha("manifest") },
    source: {
      status: options.sourceStatus ?? "pass",
      counts: { selected: files.length, modified: 1, added: 1, candidate: files.length },
      files,
    },
    dependencies: {
      status: options.dependenciesStatus ?? "pass",
      graph:
        options.graph === false
          ? null
          : {
              target: options.target ?? TARGET,
              package: packageName,
              packageCount: packages.length,
              root: options.graphRoot ?? `${packageName}@0.37.0`,
              packages,
            },
      registry: { status: options.registryStatus ?? "pass", checked: packages.length },
      lock: { entryCount: 2, checksumEntries: 1 },
    },
    targetGraph: { status: options.targetGraphStatus ?? "pass", registryPackages: packages.length },
    licenses: {
      status: "blocked",
      packageCount: packages.length,
      entries: packages.map((entry) => licenseEntry(entry.name, entry.version)),
      missingMaterials: gaps.missing ?? [],
      incompleteCoverage: (gaps.partial ?? []).map((entry) => ({
        package: entry,
        coverage: "partial",
      })),
      reviewRequired: gaps.reviewRequired ?? [],
      mplPackages: gaps.mpl ?? [],
      materialCoverage: { packageCount: packages.length },
      legalConclusion: "not-made",
      productAdoption: "blocked",
      ...(options.supplements ? { supplements: options.supplements } : {}),
    },
    gates: {
      source: options.sourceStatus ?? "pass",
      dependencies: options.dependenciesStatus ?? "pass",
      licenses: "blocked",
      toolchain: "pass",
      build: "not-requested",
      sourceAuditComplete: (options.sourceStatus ?? "pass") === "pass",
      verificationFailed: false,
      productAdoption: options.productAdoption ?? "blocked",
      exitCode: 0,
    },
  };
}

function recordPackages(options, packageName) {
  const packages = [
    ...(options.packages ?? [
      pkg("cua-driver-core", "0.37.0", ["default", "yaml"], "crates/cua-driver-core"),
    ]),
  ];
  if (
    !options.skipRoot &&
    !packages.some((entry) => entry.name === packageName && entry.version === "0.37.0")
  ) {
    packages.unshift(pkg(packageName, "0.37.0", ["default"], `crates/${packageName}`));
  }
  return packages;
}

export function makePolicy(baseline, baselineSha) {
  return {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-comparison-policy",
    baseline: {
      reportPath: "baseline.json",
      sha256: baselineSha,
      revision: REV,
      sourceRoot: SRC,
      reviewConfigSha256: baseline.review.configSha256,
      sourceManifestSha256: baseline.review.manifestSha256,
      sourceFileCount: baseline.source.files.length,
      graphPackageCount: baseline.dependencies.graph.packageCount,
      lockEntryCount: 2,
      lockChecksumEntries: 1,
      license: {
        packageCount: baseline.licenses.packageCount,
        missing: baseline.licenses.missingMaterials.length,
        partial: baseline.licenses.incompleteCoverage.length,
        reviewRequired: baseline.licenses.reviewRequired.length,
        mpl: baseline.licenses.mplPackages.length,
      },
    },
    candidate: { revision: REV, sourceRoot: SRC, target: TARGET, package: PKG },
    excludedPackages: ["rquickjs", "rquickjs-core", "rquickjs-sys", "regorus", "uniffi"],
    excludedPackagePrefixes: ["uniffi_"],
    forbiddenFeatures: ["zody-dev-probe"],
    coreFeatures: { package: "cua-driver-core", required: ["yaml"], forbidden: ["script", "rego"] },
    platformFeatures: {
      package: "platform-macos",
      required: ["zody-dev-no-input", "zody-strict-frame-gate"],
      forbidden: ["zody-dev-probe"],
    },
    productAdoption: "blocked",
    legalConclusion: "not-made",
  };
}

export async function writeFixture(options) {
  const root = await makeTempRoot("zody-cua-round7-comparison-");
  const baseline = makeReport(options.baseline);
  const candidate = makeReport(options.candidate);
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  await writeFile(baselinePath, JSON.stringify(baseline));
  await writeFile(candidatePath, JSON.stringify(candidate));
  const policy = makePolicy(baseline, sha(JSON.stringify(baseline)));
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

export function supplementEntry(name, version, options) {
  const textPath = "texts/LICENSE";
  return {
    name,
    version,
    lockChecksum: options.workspace ? null : (options.lockChecksum ?? "4".repeat(64)),
    cargoTomlSha256: options.cargoHash ?? sha(`${name}-cargo`),
    cargoVcsSha1: options.workspace ? null : "a".repeat(40),
    cargoVcsInfoSha256: options.workspace ? null : sha(`${name}-vcs`),
    source: {
      repo: options.workspace ? "https://github.com/trycua/cua" : "https://github.com/example/repo",
      commit: REV,
      path: "LICENSE",
    },
    text: {
      path: textPath,
      sha256: sha("MIT License\n"),
      bytes: Buffer.byteLength("MIT License\n"),
    },
    relation: options.workspace
      ? {
          kind: "workspace-root-license",
          licenseExpression: "MIT",
          workspaceCargoTomlSha256: options.rootHash,
          evidence: "workspace root",
        }
      : { kind: "repository-root-license", licenseExpression: "MIT", evidence: "repository root" },
  };
}

export async function writeSupplementTree(root, manifest, text) {
  await mkdir(join(root, "texts"), { recursive: true });
  await writeFile(join(root, "texts", "LICENSE"), text);
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
}
