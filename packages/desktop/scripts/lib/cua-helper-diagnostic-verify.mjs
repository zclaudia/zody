import { lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ACCEPTED_ARGUMENTS,
  DEFAULT_ARTIFACT_ROOT,
  DiagnosticVerificationError,
  HEALTH_KIND,
  NATIVE_ROOT,
  PRODUCT,
  REPO_ROOT,
  isPathInside,
  isSafeComponent,
  readJsonFile,
  sha256File,
  validateManifestSchema,
} from "./cua-helper-diagnostic-core.mjs";
import { baseEnvironment, runCommand } from "./cua-helper-diagnostic-command.mjs";
import {
  assertBundleInfo,
  assertMachOFacts,
  inspectMachO,
  probeSignature,
  readInfoPlist,
} from "./cua-helper-diagnostic-artifacts.mjs";

const MANIFEST_NAME = "manifest.json";
const DIAGNOSTIC_TIMEOUT_MS = 10_000;

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertPlainPath(root, target, label) {
  const parts = relative(root, target).split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stats = await lstatOrNull(current);
    if (!stats) throw new DiagnosticVerificationError(`${label} is missing`);
    if (stats.isSymbolicLink()) throw new DiagnosticVerificationError(`${label} is a symlink`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new DiagnosticVerificationError(`${label} does not match`);
}

async function assertFileHash(path, expected, label) {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new DiagnosticVerificationError(`${label} sha256 mismatch`);
  }
}

function assertManifestProduct(manifest) {
  assertEqual(manifest.product.name, PRODUCT.name, "product name");
  assertEqual(manifest.product.bundleId, PRODUCT.bundleId, "bundle id");
  assertEqual(manifest.product.shortVersion, PRODUCT.shortVersion, "short version");
  assertEqual(manifest.product.bundleVersion, PRODUCT.bundleVersion, "bundle version");
  assertEqual(
    manifest.product.minimumMacOSVersion,
    PRODUCT.minimumMacOSVersion,
    "minimum macOS version",
  );
  assertEqual(manifest.artifact.relativePath, PRODUCT.appName, "app relative path");
  assertEqual(manifest.artifact.infoPlistRelativePath, "Contents/Info.plist", "Info path");
  assertEqual(
    manifest.artifact.executableRelativePath,
    `Contents/MacOS/${PRODUCT.name}`,
    "executable relative path",
  );
}

async function assertSourceHashes(manifest) {
  const seen = new Set();
  for (const source of manifest.sources) {
    const path = join(NATIVE_ROOT, source.path);
    if (!isPathInside(NATIVE_ROOT, path) || seen.has(source.path)) {
      throw new DiagnosticVerificationError("manifest source path is invalid");
    }
    seen.add(source.path);
    await assertPlainPath(NATIVE_ROOT, path, "source file");
    await assertFileHash(path, source.sha256, `source ${source.path}`);
  }
  for (const required of ["Cargo.toml", "Cargo.lock", "Info.plist", "src/main.rs"]) {
    if (!seen.has(required)) {
      throw new DiagnosticVerificationError(`manifest source list lacks ${required}`);
    }
  }
}

function signatureFactsMatch(manifestSignature, actual) {
  const fields = ["kind", "verified", "identifier", "teamIdentifier", "cdhash", "authorities"];
  return fields.every(
    (field) => JSON.stringify(manifestSignature[field]) === JSON.stringify(actual[field]),
  );
}

export async function validateArtifactBeforeExecution({
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
} = {}) {
  const rootStats = await lstatOrNull(artifactRoot);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new DiagnosticVerificationError("artifact root is missing or unsafe");
  }
  if (artifactRoot === DEFAULT_ARTIFACT_ROOT) {
    await assertPlainPath(REPO_ROOT, artifactRoot, "artifact root");
  }
  const manifestPath = join(artifactRoot, MANIFEST_NAME);
  try {
    await assertPlainPath(artifactRoot, manifestPath, "manifest.json");
  } catch (error) {
    if (error instanceof DiagnosticVerificationError) {
      throw new DiagnosticVerificationError("manifest.json is missing or unsafe");
    }
    throw error;
  }
  const manifest = await readJsonFile(manifestPath);
  const schema = validateManifestSchema(manifest);
  if (!schema.ok) throw new DiagnosticVerificationError(schema.error);
  assertManifestProduct(manifest);
  if (manifest.licenses.thirdPartyCrates === undefined) {
    throw new DiagnosticVerificationError("manifest schema lacks explicit third-party scope");
  }

  const env = baseEnvironment(process.env);
  const appPath = join(artifactRoot, PRODUCT.appName);
  await assertPlainPath(artifactRoot, appPath, "app bundle");
  const infoPath = join(appPath, manifest.artifact.infoPlistRelativePath);
  await assertPlainPath(artifactRoot, infoPath, "Info.plist");
  const info = await readInfoPlist(infoPath, env);
  assertBundleInfo(info);
  const executableName = info.CFBundleExecutable;
  if (!isSafeComponent(executableName) || executableName !== PRODUCT.name) {
    throw new DiagnosticVerificationError("Info.plist executable name is unsafe or unexpected");
  }
  const executablePath = join(appPath, "Contents", "MacOS", executableName);
  await assertPlainPath(artifactRoot, executablePath, "diagnostic executable");
  const executableStats = await lstat(executablePath);
  if (!executableStats.isFile()) {
    throw new DiagnosticVerificationError("diagnostic executable is not a regular file");
  }

  await assertFileHash(infoPath, manifest.artifact.infoPlistSha256, "Info.plist");
  await assertFileHash(executablePath, manifest.artifact.executableSha256, "diagnostic executable");
  const firstPartyPath = join(appPath, manifest.licenses.firstParty.path);
  const rustStdLicensePath = join(appPath, manifest.licenses.rustStandardLibrary.path);
  await assertPlainPath(artifactRoot, firstPartyPath, "first-party license");
  await assertPlainPath(artifactRoot, rustStdLicensePath, "Rust standard library license");
  await assertFileHash(firstPartyPath, manifest.licenses.firstParty.sha256, "first-party license");
  await assertFileHash(
    rustStdLicensePath,
    manifest.licenses.rustStandardLibrary.sha256,
    "Rust standard library license",
  );
  await assertSourceHashes(manifest);

  const machO = await inspectMachO(executablePath, env);
  assertMachOFacts(machO);
  assertEqual(machO.architectures[0], manifest.artifact.architecture, "Mach-O architecture");
  assertEqual(machO.minimumMacOS, manifest.artifact.minimumMacOS, "Mach-O minos");
  if (
    JSON.stringify(machO.linkedDynamicLibraries) !==
    JSON.stringify(manifest.dependencies.linkedDynamicLibraries)
  ) {
    throw new DiagnosticVerificationError("Mach-O dynamic dependency list does not match");
  }
  const binarySignature = await probeSignature(executablePath, env);
  const appSignature = await probeSignature(appPath, env);
  if (!signatureFactsMatch(manifest.signature.binary, binarySignature)) {
    throw new DiagnosticVerificationError("binary signature facts do not match");
  }
  if (!signatureFactsMatch(manifest.signature.app, appSignature)) {
    throw new DiagnosticVerificationError("app signature facts do not match");
  }
  if (manifest.driverLinked !== false || manifest.dependencies.driverLinked !== false) {
    throw new DiagnosticVerificationError("manifest driverLinked must be false");
  }
  return {
    manifest,
    artifactRoot,
    appPath,
    executablePath,
    info,
    machO,
    signatures: { binary: binarySignature, app: appSignature },
    env,
  };
}

export function parseHealthOutput(text) {
  let health;
  try {
    health = JSON.parse(text.trim());
  } catch {
    throw new DiagnosticVerificationError("health output is not valid JSON");
  }
  if (health === null || typeof health !== "object" || Array.isArray(health)) {
    throw new DiagnosticVerificationError("health output root is invalid");
  }
  const expected = {
    schemaVersion: 1,
    kind: HEALTH_KIND,
    diagnosticOnly: true,
    inputCapable: false,
    driverLinked: false,
    tccRequested: false,
    stdinRead: false,
    networkUsed: false,
    applicationFileIoUsed: false,
    subprocessSpawned: false,
    systemInputUsed: false,
    nativeCapabilityProven: false,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (health[key] !== value) {
      throw new DiagnosticVerificationError(`health ${key} must be ${String(value)}`);
    }
  }
  return health;
}

function runDiagnostic(executablePath, args, run) {
  return run(executablePath, args, {
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    maxOutputBytes: 32 * 1024,
    allowFailure: true,
  });
}

export async function runDiagnosticProcessChecks(executablePath, { run = runCommand } = {}) {
  const healthRun = await runDiagnostic(executablePath, ["--health"], run);
  if (healthRun.code !== 0) throw new DiagnosticVerificationError("health exit is not 0");
  const health = parseHealthOutput(healthRun.stdout);

  for (const argument of ["--help", "--version"]) {
    const result = await runDiagnostic(executablePath, [argument], run);
    if (result.code !== 0) {
      throw new DiagnosticVerificationError(`diagnostic ${argument} exit is not 0`);
    }
  }

  const canary = `--untrusted-${Date.now().toString(36)}`;
  const invalidCases = [[], [canary], ["--health", "--help"]];
  for (const args of invalidCases) {
    const result = await runDiagnostic(executablePath, args, run);
    if (result.code !== 2) {
      throw new DiagnosticVerificationError("invalid diagnostic arguments did not exit 2");
    }
    if (`${result.stdout}${result.stderr}`.includes(canary)) {
      throw new DiagnosticVerificationError("invalid argument output echoed an untrusted value");
    }
  }
  return { health, acceptedArguments: [...ACCEPTED_ARGUMENTS] };
}

export async function verifyDiagnosticArtifact(options = {}) {
  const inspected = await validateArtifactBeforeExecution(options);
  const processChecks = await runDiagnosticProcessChecks(inspected.executablePath, {
    run: options.run,
  });
  const signatureIdentityVerified =
    inspected.signatures.binary.verified && inspected.signatures.app.verified;
  return {
    status: "pass",
    artifactRoot: inspected.artifactRoot,
    bundleId: inspected.manifest.product.bundleId,
    executableSha256: inspected.manifest.artifact.executableSha256,
    architecture: inspected.machO.architectures[0],
    minimumMacOS: inspected.machO.minimumMacOS,
    signature: inspected.signatures,
    signatureIdentityVerified,
    health: processChecks.health,
  };
}
