import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const NATIVE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-helper-diagnostic",
);
export const OUTPUT_PARENT = join(REPO_ROOT, "output", "cua-helper-diagnostic");
export const DEFAULT_ARTIFACT_ROOT = join(OUTPUT_PARENT, "darwin-arm64");
export const MANIFEST_KIND = "zody-cua-helper-diagnostic-manifest";
export const HEALTH_KIND = "zody-cua-helper-diagnostic-health";
export const TARGET = "aarch64-apple-darwin";
export const DEPLOYMENT_TARGET = "12.0";

export const PRODUCT = Object.freeze({
  name: "Zody Computer Use Diagnostic",
  appName: "Zody Computer Use Diagnostic.app",
  bundleId: "io.github.zclaudia.zody.cua-helper-diagnostic",
  shortVersion: "0.1.0",
  bundleVersion: "1",
  minimumMacOSVersion: "12.0",
});

export const EXPECTED_TOOLCHAIN = Object.freeze({
  rustVersion: "1.93.1",
  rustCommit: "01f6ddf7588f42ae2d7eb0a2f21d44e8e96674cf",
  cargoVersion: "1.93.1",
  cargoCommit: "083ac5135f967fd9dc906ab057a2315861c7a80d",
  upstreamRustVersion: "1.97.1",
});

export const ACCEPTED_ARGUMENTS = Object.freeze(["--health", "--help", "--version"]);
export const EXIT_CODES = Object.freeze({ success: 0, invalidArguments: 2 });
export const NATIVE_SOURCE_RELATIVE_FILES = Object.freeze([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "Info.plist",
  "src/main.rs",
  "README.md",
]);

export class DiagnosticBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiagnosticBlockedError";
    this.code = code;
  }
}

export class DiagnosticVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiagnosticVerificationError";
  }
}

export function isPathInside(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export function isSafeComponent(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

export function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function readJsonFile(path, { maxBytes = 1024 * 1024 } = {}) {
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new DiagnosticVerificationError("JSON file exceeds size limit");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new DiagnosticVerificationError("invalid JSON");
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(object, key) {
  return isRecord(object) && typeof object[key] === "string" && object[key].length > 0;
}

function hasBoolean(object, key, expected) {
  return isRecord(object) && object[key] === expected;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNullableString(value) {
  return value === null || (typeof value === "string" && value.length > 0);
}

function schemaError(path) {
  return { ok: false, error: `manifest schema: ${path}` };
}

export function validateManifestSchema(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1) return schemaError("schemaVersion");
  if (manifest.kind !== MANIFEST_KIND || manifest.status !== "pass")
    return schemaError("kind/status");
  if (!hasBoolean(manifest, "diagnosticOnly", true)) return schemaError("diagnosticOnly");
  if (!hasBoolean(manifest, "driverLinked", false)) return schemaError("driverLinked");
  if (!hasString(manifest, "generatedAt")) return schemaError("generatedAt");

  const product = manifest.product;
  for (const key of ["name", "bundleId", "shortVersion", "bundleVersion", "minimumMacOSVersion"]) {
    if (!hasString(product, key)) return schemaError(`product.${key}`);
  }
  if (product.runtimeSupportVerified !== false) {
    return schemaError("product.runtimeSupportVerified");
  }
  const artifact = manifest.artifact;
  for (const key of ["relativePath", "infoPlistRelativePath", "executableRelativePath"]) {
    if (!isSafeRelativePath(artifact?.[key])) return schemaError(`artifact.${key}`);
  }
  for (const key of ["infoPlistSha256", "executableSha256"]) {
    if (!isSha256(artifact?.[key])) return schemaError(`artifact.${key}`);
  }
  if (artifact.architecture !== "arm64" || artifact.minimumMacOS !== DEPLOYMENT_TARGET) {
    return schemaError("artifact architecture/minimumMacOS");
  }

  const build = manifest.build;
  if (build?.target !== TARGET || build?.deploymentTarget !== DEPLOYMENT_TARGET) {
    return schemaError("build target/deploymentTarget");
  }
  if (!Array.isArray(build.cargoArguments) || !build.cargoArguments.includes("--locked")) {
    return schemaError("build.cargoArguments");
  }
  if (!build.cargoArguments.includes("--offline") || build.isolatedCargoHome !== true) {
    return schemaError("build isolation");
  }
  const configIsolation = build.cargoConfigIsolation;
  if (
    configIsolation?.sourceCopyOutsideRepo !== true ||
    configIsolation?.cwdOutsideRepo !== true ||
    configIsolation?.cargoHomeConfigPresent !== false ||
    !Array.isArray(configIsolation?.ancestorConfigFilesFound) ||
    configIsolation.ancestorConfigFilesFound.length !== 0
  ) {
    return schemaError("build.cargoConfigIsolation");
  }
  if (
    manifest.arguments?.exitCodes?.success !== 0 ||
    manifest.arguments?.exitCodes?.invalidArguments !== 2
  ) {
    return schemaError("arguments.exitCodes");
  }
  if (JSON.stringify(manifest.arguments?.accepted) !== JSON.stringify(ACCEPTED_ARGUMENTS)) {
    return schemaError("arguments.accepted");
  }

  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    return schemaError("sources");
  }
  for (const source of manifest.sources) {
    if (!isSafeRelativePath(source?.path) || !isSha256(source?.sha256))
      return schemaError("sources[]");
  }
  const actualSourcePaths = manifest.sources.map((source) => source.path).sort();
  const expectedSourcePaths = [...NATIVE_SOURCE_RELATIVE_FILES].sort();
  if (JSON.stringify(actualSourcePaths) !== JSON.stringify(expectedSourcePaths)) {
    return schemaError("sources frozen list");
  }
  const toolchain = manifest.toolchain;
  if (!isRecord(toolchain) || !hasString(toolchain, "sysroot")) return schemaError("toolchain");
  for (const [name, expected] of [
    ["rustc", [EXPECTED_TOOLCHAIN.rustVersion, EXPECTED_TOOLCHAIN.rustCommit]],
    ["cargo", [EXPECTED_TOOLCHAIN.cargoVersion, EXPECTED_TOOLCHAIN.cargoCommit]],
  ]) {
    if (toolchain[name]?.release !== expected[0] || toolchain[name]?.commit !== expected[1]) {
      return schemaError(`toolchain.${name}`);
    }
  }
  if (
    !isRecord(manifest.sdk) ||
    !hasString(manifest.sdk, "path") ||
    !hasString(manifest.sdk, "version")
  ) {
    return schemaError("sdk");
  }

  const dependencies = manifest.dependencies;
  if (
    !hasBoolean(dependencies, "stdOnly", true) ||
    !hasBoolean(dependencies, "driverLinked", false)
  ) {
    return schemaError("dependencies");
  }
  if (
    !Array.isArray(dependencies.crateDependencies) ||
    dependencies.crateDependencies.length !== 0 ||
    !Array.isArray(dependencies.linkedDynamicLibraries)
  ) {
    return schemaError("dependencies arrays");
  }

  const licenses = manifest.licenses;
  for (const [key, path] of [
    ["firstParty", "Contents/Resources/LICENSE"],
    ["rustStandardLibrary", "Contents/Resources/COPYRIGHT-library.html"],
  ]) {
    const entry = licenses?.[key];
    if (!hasString(entry, "spdx") || entry.path !== path || !isSha256(entry.sha256)) {
      return schemaError(`licenses.${key}`);
    }
  }
  if (
    licenses.firstParty.spdx !== "Apache-2.0" ||
    licenses.rustStandardLibrary.spdx !== "Apache-2.0 OR MIT"
  ) {
    return schemaError("licenses spdx");
  }
  if (
    licenses.closureComplete !== false ||
    !Array.isArray(licenses.thirdPartyCrates) ||
    licenses.thirdPartyCrates.length !== 0 ||
    !hasString(licenses, "thirdPartyCratesMeaning")
  ) {
    return schemaError("licenses closure scope");
  }

  const upstream = manifest.upstreamComparison;
  if (
    upstream?.declaredRustVersion !== EXPECTED_TOOLCHAIN.upstreamRustVersion ||
    upstream?.buildRustVersion !== EXPECTED_TOOLCHAIN.rustVersion ||
    upstream?.driverSourceIncluded !== false ||
    upstream?.patchIncluded !== false ||
    upstream?.licenseClosureComplete !== false ||
    upstream?.status !== "delta-not-closed"
  ) {
    return schemaError("upstreamComparison");
  }

  if (
    manifest.signature?.localSelfSignedClaim !== false ||
    manifest.signature?.signingPerformed !== false
  ) {
    return schemaError("signature claims");
  }
  for (const key of ["binary", "app"]) {
    const signature = manifest.signature?.[key];
    if (
      !isRecord(signature) ||
      !hasString(signature, "kind") ||
      typeof signature.verified !== "boolean" ||
      !isNullableString(signature.identifier) ||
      !isNullableString(signature.teamIdentifier) ||
      !isNullableString(signature.cdhash) ||
      !Array.isArray(signature.authorities) ||
      signature.authorities.some((authority) => typeof authority !== "string")
    ) {
      return schemaError(`signature.${key}`);
    }
  }
  for (const key of ["inputCapable", "driverLinked", "tccRequested", "nativeCapabilityProven"]) {
    if (!hasBoolean(manifest.health, key, false)) return schemaError(`health.${key}`);
  }
  const limits = manifest.limits;
  if (
    limits?.minosIsBuildTargetOnly !== true ||
    limits?.nativeCapabilityProven !== false ||
    limits?.d06IsolationProven !== false ||
    limits?.defaultLauncherWired !== false
  ) {
    return schemaError("limits");
  }
  return { ok: true };
}
