import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { readFile } from "node:fs/promises";
import {
  ClosureVerificationError,
  REPORT_KIND,
  isRecord,
  isSafeRelativePath,
  sha256Buffer,
  sha256Text,
} from "./cua-driver-closure-core.mjs";
import {
  COMPARISON_POLICY_KIND,
  REQUIRED_EXCLUDED_PACKAGES,
  requireCount,
  requireRecord,
  requireRevision,
  requireSafeRelative,
  requireSha,
  requireString,
  requireStringSet,
  validateTransitionComparisonPolicy,
} from "./cua-driver-closure-comparison-transition-policy.mjs";

export { COMPARISON_POLICY_KIND, REQUIRED_EXCLUDED_PACKAGES };

const gunzipAsync = promisify(gunzip);
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const SOURCE_STATUSES = new Set(["modified", "added", "unchanged"]);

function fail(message) {
  throw new ClosureVerificationError(message);
}

async function readReportBytes(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) fail("report file exceeds size limit");
  return bytes;
}

export async function readClosureReportFile(path) {
  const bytes = await readReportBytes(path);
  const sha256 = sha256Buffer(bytes);
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let jsonBytes = bytes;
  if (gzip) {
    try {
      jsonBytes = await gunzipAsync(bytes, { maxOutputLength: MAX_JSON_BYTES });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE" || error?.code === "ERR_OUT_OF_RANGE") {
        fail("report JSON exceeds size limit");
      }
      fail("invalid gzip report");
    }
  }
  if (jsonBytes.byteLength > MAX_JSON_BYTES) fail("report JSON exceeds size limit");
  let report;
  try {
    report = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    fail("invalid report JSON");
  }
  return { path: String(path), sha256, bytes: bytes.byteLength, gzip, report };
}

export function validateComparisonPolicy(raw) {
  const policy = requireRecord(raw, "comparison policy");
  if (policy.schemaVersion === 2) return validateTransitionComparisonPolicy(policy);
  if (policy.schemaVersion !== 1 || policy.kind !== COMPARISON_POLICY_KIND) {
    fail("invalid comparison policy schema");
  }
  const baseline = requireRecord(policy.baseline, "baseline policy");
  requireSafeRelative(baseline.reportPath, "baseline.reportPath");
  requireSha(baseline.sha256, "baseline.sha256");
  requireRevision(baseline.revision, "baseline.revision");
  requireSafeRelative(baseline.sourceRoot, "baseline.sourceRoot");
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
  for (const key of ["packageCount", "missing", "partial", "reviewRequired", "mpl"]) {
    requireCount(baselineLicense[key], `baseline.license.${key}`);
  }
  if (baseline.supplements !== undefined) {
    const supplements = requireRecord(baseline.supplements, "baseline.supplements");
    requireSafeRelative(supplements.manifestPath, "baseline.supplements.manifestPath");
    requireSha(supplements.manifestSha256, "baseline.supplements.manifestSha256");
    requireCount(supplements.entryCount, "baseline.supplements.entryCount");
    requireRevision(supplements.sourceRevision, "baseline.supplements.sourceRevision");
  }
  const candidate = requireRecord(policy.candidate, "candidate policy");
  requireRevision(candidate.revision, "candidate.revision");
  requireSafeRelative(candidate.sourceRoot, "candidate.sourceRoot");
  if (candidate.revision !== baseline.revision) {
    fail("candidate revision must equal baseline revision");
  }
  if (candidate.sourceRoot !== baseline.sourceRoot) {
    fail("candidate sourceRoot must equal baseline sourceRoot");
  }
  requireString(candidate.target, "candidate.target");
  requireString(candidate.package, "candidate.package");
  const excludedPackages = requireStringSet(policy.excludedPackages, "excludedPackages");
  for (const name of REQUIRED_EXCLUDED_PACKAGES) {
    if (!excludedPackages.includes(name)) fail(`policy must exclude ${name}`);
  }
  const excludedPackagePrefixes = requireStringSet(
    policy.excludedPackagePrefixes,
    "excludedPackagePrefixes",
  );
  if (!excludedPackagePrefixes.includes("uniffi_")) fail("policy must exclude uniffi_ prefix");
  const forbiddenFeatures = requireStringSet(policy.forbiddenFeatures, "forbiddenFeatures");
  if (!forbiddenFeatures.includes("zody-dev-probe")) {
    fail("policy must forbid zody-dev-probe");
  }
  for (const [key, label] of [
    ["coreFeatures", "coreFeatures"],
    ["platformFeatures", "platformFeatures"],
  ]) {
    const feature = requireRecord(policy[key], label);
    requireString(feature.package, `${label}.package`);
    requireStringSet(feature.required, `${label}.required`);
    const forbidden = requireStringSet(feature.forbidden, `${label}.forbidden`, {
      allowEmpty: true,
    });
    const required = feature.required;
    if (required.some((entry) => forbidden.includes(entry))) {
      fail(`${label} requires and forbids the same feature`);
    }
  }
  if (policy.productAdoption !== "blocked") fail("policy must keep product adoption blocked");
  if (policy.legalConclusion !== "not-made") fail("policy must not make a legal conclusion");
  return {
    ...policy,
    excludedPackages,
    excludedPackagePrefixes,
    forbiddenFeatures,
  };
}

function validateSource(report) {
  const source = requireRecord(report.source, "source");
  if (source.status !== "pass") fail("source audit did not pass");
  if (!Array.isArray(source.files) || source.files.length === 0) fail("source files are missing");
  const counts = requireRecord(source.counts, "source.counts");
  requireCount(counts.candidate, "source.counts.candidate");
  if (counts.candidate !== source.files.length) fail("source candidate count does not match files");
  const seen = new Set();
  const files = [];
  for (const entry of source.files) {
    requireRecord(entry, "source file");
    const path = requireSafeRelative(entry.path, "source file path");
    if (seen.has(path)) fail(`duplicate source file: ${path}`);
    seen.add(path);
    if (!SOURCE_STATUSES.has(entry.status)) fail(`invalid source status: ${path}`);
    requireSha(entry.candidateSha256, `candidate hash for ${path}`);
    if (entry.status === "added") {
      if (entry.upstreamSha256 !== undefined && entry.upstreamSha256 !== null) {
        fail(`added source file has an upstream hash: ${path}`);
      }
    } else {
      requireSha(entry.upstreamSha256, `upstream hash for ${path}`);
    }
    files.push({
      path,
      status: entry.status,
      upstreamSha256: entry.status === "added" ? null : entry.upstreamSha256,
      candidateSha256: entry.candidateSha256,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { source, files, fingerprint: sha256Text(JSON.stringify(files)) };
}

function identityForRole(policy, role) {
  if (policy.schemaVersion === 2) {
    return role === "baseline" ? policy.baseline : policy.candidate;
  }
  return {
    revision: policy.baseline.revision,
    sourceRoot: policy.baseline.sourceRoot,
    target: policy.candidate.target,
    package: policy.candidate.package,
  };
}

function validateGraph(report, policy, role) {
  const identity = identityForRole(policy, role);
  const dependencies = requireRecord(report.dependencies, "dependencies");
  if (dependencies.status !== "pass") fail("dependencies did not pass");
  const registry = requireRecord(dependencies.registry, "dependencies.registry");
  if (registry.status !== "pass") fail("registry cache did not pass");
  const targetGraph = requireRecord(report.targetGraph, "targetGraph");
  if (targetGraph.status !== "pass") fail("target graph did not pass");
  const graph = requireRecord(dependencies.graph, "dependencies.graph");
  if (graph.target !== identity.target) fail("target does not match policy");
  if (graph.package !== identity.package) fail("package does not match policy");
  requireCount(graph.packageCount, "graph.packageCount");
  if (!Array.isArray(graph.packages)) fail("graph packages are missing");
  if (graph.packages.length === 0) fail("graph packages are missing");
  if (graph.packageCount !== graph.packages.length)
    fail("graph package count does not match packages");
  const seen = new Set();
  const packages = graph.packages.map((entry) => {
    requireRecord(entry, "graph package");
    const name = requireString(entry.name, "graph package name");
    const version = requireString(entry.version, "graph package version");
    const features = requireStringSet(entry.features, `features for ${name}@${version}`, {
      allowEmpty: true,
    });
    if (entry.path !== null && typeof entry.path !== "string") fail(`invalid path for ${name}`);
    if (entry.kind !== null && typeof entry.kind !== "string") fail(`invalid kind for ${name}`);
    const key = `${name}@${version}`;
    if (seen.has(key)) fail(`duplicate graph identity: ${key}`);
    seen.add(key);
    return { name, version, features, path: entry.path, kind: entry.kind };
  });
  packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  if (typeof graph.root !== "string" || !graph.root.startsWith(`${identity.package}@`)) {
    fail("graph root does not match package");
  }
  const rootEntry = packages.find((entry) => `${entry.name}@${entry.version}` === graph.root);
  if (!rootEntry) fail("graph root is not present in actual packages");
  if (typeof rootEntry.path !== "string" || !isSafeRelativePath(rootEntry.path)) {
    fail("graph root has no safe relative path");
  }
  return { dependencies, graph, packages };
}

function validateLicenseCoverage(licenses, packages, role) {
  if (licenses.status === "fail" || licenses.error) fail(`${role} license audit is unavailable`);
  const identities = new Set(packages.map((entry) => `${entry.name}@${entry.version}`));
  const packageCount = requireCount(licenses.packageCount, `${role} license packageCount`);
  if (packageCount !== packages.length) fail(`${role} license coverage does not match graph`);
  if (!Array.isArray(licenses.entries) || licenses.entries.length !== packages.length) {
    fail(`${role} license entries do not match graph`);
  }
  const entryIds = new Set(
    licenses.entries.map((entry) => requireString(entry.package, `${role} license package`)),
  );
  if (entryIds.size !== identities.size || [...identities].some((key) => !entryIds.has(key))) {
    fail(`${role} license entries do not match graph`);
  }
  const coverage = licenses.materialCoverage;
  if (coverage !== undefined && coverage !== null) {
    requireRecord(coverage, `${role} license materialCoverage`);
    if (coverage.packageCount !== undefined && coverage.packageCount !== packages.length) {
      fail(`${role} license material coverage does not match graph`);
    }
  }
  for (const key of ["missingMaterials", "reviewRequired", "mplPackages"]) {
    if (!Array.isArray(licenses[key])) fail(`${role} ${key} is missing`);
    if (new Set(licenses[key]).size !== licenses[key].length) {
      fail(`${role} ${key} contains duplicates`);
    }
    for (const value of licenses[key]) {
      requireString(value, `${role} ${key} entry`);
      if (!identities.has(value)) fail(`${role} license gap is outside the graph: ${value}`);
    }
  }
  if (!Array.isArray(licenses.incompleteCoverage)) {
    fail(`${role} incompleteCoverage is missing`);
  }
  if (
    new Set(licenses.incompleteCoverage.map((entry) => entry?.package)).size !==
    licenses.incompleteCoverage.length
  ) {
    fail(`${role} incompleteCoverage contains duplicates`);
  }
  for (const entry of licenses.incompleteCoverage) {
    requireRecord(entry, `${role} partial coverage`);
    const key = requireString(entry.package, `${role} partial package`);
    if (!identities.has(key)) fail(`${role} partial gap is outside the graph: ${key}`);
  }
}

export function validateClosureReport(report, { policy, role }) {
  const value = requireRecord(report, `${role} report`);
  if (value.schemaVersion !== 1 || value.kind !== REPORT_KIND) {
    fail(`invalid ${role} report schema`);
  }
  const identity = identityForRole(policy, role);
  if (value.revision !== identity.revision) fail(`${role} revision does not match policy`);
  if (value.sourceRoot !== identity.sourceRoot) fail(`${role} sourceRoot does not match policy`);
  const review = requireRecord(value.review, `${role} review`);
  requireSha(review.configSha256, `${role} review config hash`);
  requireSha(review.manifestSha256, `${role} source manifest hash`);
  if (role === "baseline") {
    if (review.configSha256 !== policy.baseline.reviewConfigSha256) {
      fail("baseline review config hash does not match policy");
    }
    if (review.manifestSha256 !== policy.baseline.sourceManifestSha256) {
      fail("baseline source manifest hash does not match policy");
    }
  }
  const gates = requireRecord(value.gates, `${role} gates`);
  if (gates.source !== "pass" || gates.sourceAuditComplete !== true)
    fail(`${role} source gate is not pass`);
  if (gates.dependencies !== "pass") fail(`${role} dependency gate is not pass`);
  if (gates.verificationFailed !== false) {
    fail(`${role} verificationFailed must be explicitly false`);
  }
  const source = validateSource(value);
  const { dependencies, graph, packages } = validateGraph(value, policy, role);
  if (!isRecord(value.licenses)) fail(`${role} license evidence is missing`);
  validateLicenseCoverage(value.licenses, packages, role);
  if (role === "candidate" && gates.productAdoption !== "blocked") {
    fail("candidate cannot claim product adoption");
  }
  const lock = requireRecord(dependencies.lock, `${role} lock`);
  requireCount(lock.entryCount, `${role} lock entryCount`);
  requireCount(lock.checksumEntries, `${role} lock checksumEntries`);
  if (role === "baseline") {
    if (source.files.length !== policy.baseline.sourceFileCount)
      fail("baseline source file count mismatch");
    if (packages.length !== policy.baseline.graphPackageCount)
      fail("baseline graph package count mismatch");
    if (lock.entryCount !== policy.baseline.lockEntryCount)
      fail("baseline lock entry count mismatch");
    if (lock.checksumEntries !== policy.baseline.lockChecksumEntries) {
      fail("baseline lock checksum count mismatch");
    }
    const licenses = value.licenses;
    if (licenses.packageCount !== policy.baseline.license.packageCount)
      fail("baseline license package count mismatch");
    if (licenses.missingMaterials.length !== policy.baseline.license.missing)
      fail("baseline missing license count mismatch");
    if (licenses.incompleteCoverage.length !== policy.baseline.license.partial)
      fail("baseline partial license count mismatch");
    if (licenses.reviewRequired.length !== policy.baseline.license.reviewRequired)
      fail("baseline review license count mismatch");
    if (licenses.mplPackages.length !== policy.baseline.license.mpl)
      fail("baseline MPL license count mismatch");
  }
  return { role, report: value, review, gates, source, graph, packages, lock, identity };
}

export { fail };
