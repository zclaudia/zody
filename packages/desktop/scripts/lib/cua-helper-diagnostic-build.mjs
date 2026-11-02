import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertSupportedHost,
  createBuildEnvironment,
  probeSdk,
  probeToolchain,
} from "./cua-helper-diagnostic-toolchain.mjs";
import { boundedCommandFailure, runCommand } from "./cua-helper-diagnostic-command.mjs";
import {
  DEFAULT_ARTIFACT_ROOT,
  DiagnosticVerificationError,
  MANIFEST_KIND,
  NATIVE_ROOT,
  NATIVE_SOURCE_RELATIVE_FILES,
  OUTPUT_PARENT,
  PRODUCT,
  REPO_ROOT,
  TARGET,
  isPathInside,
  validateManifestSchema,
} from "./cua-helper-diagnostic-core.mjs";
import {
  assertBundleInfo,
  assertMachOFacts,
  inspectMachO,
  parseCargoTree,
  readInfoPlist,
} from "./cua-helper-diagnostic-artifacts.mjs";
import { validateArtifactBeforeExecution } from "./cua-helper-diagnostic-verify.mjs";
import { createDiagnosticManifest } from "./cua-helper-diagnostic-manifest.mjs";

const BINARY_STEM = "zody-computer-use-diagnostic";
const BUILD_TIMEOUT_MS = 240_000;
const CARGO_SOURCE_FILES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs"];

async function pathFacts(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertDirectoryNotSymlink(path, label) {
  const stats = await pathFacts(path);
  if (!stats) return false;
  if (stats.isSymbolicLink()) throw new DiagnosticVerificationError(`${label} is a symlink`);
  if (!stats.isDirectory()) throw new DiagnosticVerificationError(`${label} is not a directory`);
  return true;
}

async function prepareOutputRoot() {
  const outputDir = join(REPO_ROOT, "output");
  await mkdir(outputDir, { recursive: true });
  if (!(await assertDirectoryNotSymlink(outputDir, "output directory"))) {
    throw new DiagnosticVerificationError("output directory is unavailable");
  }
  if (!(await assertDirectoryNotSymlink(OUTPUT_PARENT, "diagnostic output parent"))) {
    await mkdir(OUTPUT_PARENT, { recursive: false });
  }
  if (!(await assertDirectoryNotSymlink(OUTPUT_PARENT, "diagnostic output parent"))) {
    throw new DiagnosticVerificationError("diagnostic output parent is unavailable");
  }
  const existing = await pathFacts(DEFAULT_ARTIFACT_ROOT);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new DiagnosticVerificationError("diagnostic output root is not a safe directory");
  }
}

async function assertSourceFilesPlain() {
  for (const relativePath of NATIVE_SOURCE_RELATIVE_FILES) {
    const stats = await pathFacts(join(NATIVE_ROOT, relativePath));
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw new DiagnosticVerificationError(`source file is missing or unsafe: ${relativePath}`);
    }
  }
  const rootLicense = await pathFacts(join(REPO_ROOT, "LICENSE"));
  if (!rootLicense || rootLicense.isSymbolicLink() || !rootLicense.isFile()) {
    throw new DiagnosticVerificationError("root LICENSE is missing or unsafe");
  }
}

async function inspectCargoConfigAncestors(startDirectory) {
  const found = [];
  let current = resolve(startDirectory);
  let checked = 0;
  while (true) {
    checked += 1;
    const cargoDirectory = join(current, ".cargo");
    const cargoStats = await pathFacts(cargoDirectory);
    if (cargoStats) {
      for (const name of ["config", "config.toml"]) {
        if (await pathFacts(join(cargoDirectory, name))) found.push(join(".cargo", name));
      }
      if (cargoStats.isSymbolicLink()) found.push(".cargo");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (found.length > 0) {
    throw new DiagnosticVerificationError("Cargo config exists in build directory ancestry");
  }
  return { checkedAncestorDirectories: checked, ancestorConfigFilesFound: [] };
}

async function copyCargoSource(staging) {
  const sourceRoot = join(staging, "source");
  for (const relativePath of CARGO_SOURCE_FILES) {
    const destination = join(sourceRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(NATIVE_ROOT, relativePath), destination);
  }
  return sourceRoot;
}

async function cargoTree({ toolchain, sourceRoot, cwd, env }) {
  try {
    const result = await runCommand(
      toolchain.cargoPath,
      [
        "tree",
        "--manifest-path",
        join(sourceRoot, "Cargo.toml"),
        "--locked",
        "--offline",
        "--target",
        TARGET,
      ],
      { cwd, env, timeoutMs: 30_000, maxOutputBytes: 128 * 1024 },
    );
    return parseCargoTree(result.stdout);
  } catch (error) {
    throw new DiagnosticVerificationError(
      `Cargo dependency inspection failed: ${boundedCommandFailure(error)}`,
    );
  }
}

async function buildBinary({ toolchain, sdkPath, sourceRoot, staging, env, configEvidence }) {
  const cargoHome = join(staging, "cargo-home");
  const targetDir = join(staging, "target");
  const buildEnv = createBuildEnvironment({ toolchain, cargoHome, sdkPath }, env);
  const cargoArguments = [
    "build",
    "--manifest-path",
    join(sourceRoot, "Cargo.toml"),
    "--locked",
    "--offline",
    "--release",
    "--target",
    TARGET,
    "--target-dir",
    targetDir,
  ];
  await mkdir(cargoHome, { recursive: true });
  if (await pathFacts(join(cargoHome, "config.toml"))) {
    throw new DiagnosticVerificationError("isolated CARGO_HOME unexpectedly contains config");
  }
  try {
    await runCommand(toolchain.cargoPath, cargoArguments, {
      cwd: staging,
      env: buildEnv,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`diagnostic compile failed: ${boundedCommandFailure(error)}`);
  }
  const tree = (await cargoTree({ toolchain, sourceRoot, cwd: staging, env: buildEnv })).map(
    (line) => line.split(sourceRoot).join("<system-temp-source>"),
  );
  return {
    binary: join(targetDir, TARGET, "release", BINARY_STEM),
    buildEnv,
    cargoTree: tree,
    cargoArguments: cargoArguments.map((value) => {
      if (value === targetDir) return "<system-temp-target-dir>";
      if (value === join(sourceRoot, "Cargo.toml")) return "<system-temp-source>/Cargo.toml";
      return value;
    }),
    cargoConfigIsolation: {
      sourceCopyOutsideRepo: true,
      cwdOutsideRepo: true,
      cargoHomeConfigPresent: false,
      ...configEvidence,
    },
  };
}

async function stageApp({ artifactRoot, binary, toolchain, buildEnv }) {
  const appPath = join(artifactRoot, PRODUCT.appName);
  const contents = join(appPath, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await copyFile(join(NATIVE_ROOT, "Info.plist"), join(contents, "Info.plist"));
  await copyFile(binary, join(macos, PRODUCT.name));
  await chmod(join(macos, PRODUCT.name), 0o755);
  await copyFile(join(REPO_ROOT, "LICENSE"), join(resources, "LICENSE"));
  await copyFile(
    toolchain.rustStandardLibraryLicensePath,
    join(resources, "COPYRIGHT-library.html"),
  );
  const info = await readInfoPlist(join(contents, "Info.plist"), buildEnv);
  assertBundleInfo(info);
  const machO = await inspectMachO(join(macos, PRODUCT.name), buildEnv);
  assertMachOFacts(machO);
  return { appPath, contents, macos, resources, machO };
}

async function commitArtifact(stagedArtifact) {
  const existing = await pathFacts(DEFAULT_ARTIFACT_ROOT);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new DiagnosticVerificationError("diagnostic output root changed to an unsafe path");
  }
  const backup = `${DEFAULT_ARTIFACT_ROOT}.previous-${process.pid}-${Date.now()}`;
  try {
    if (existing) await rename(DEFAULT_ARTIFACT_ROOT, backup);
    await rename(stagedArtifact, DEFAULT_ARTIFACT_ROOT);
  } catch (error) {
    if (existing && !(await pathFacts(DEFAULT_ARTIFACT_ROOT))) {
      await rename(backup, DEFAULT_ARTIFACT_ROOT).catch(() => undefined);
    }
    throw error;
  }
  if (existing) await rm(backup, { recursive: true, force: true });
}

export async function buildDiagnosticArtifact({
  selectedToolchain = "stable",
  sourceEnv = process.env,
} = {}) {
  assertSupportedHost();
  await prepareOutputRoot();
  await assertSourceFilesPlain();
  const toolchain = await probeToolchain({ selected: selectedToolchain, sourceEnv });
  const sdk = await probeSdk({ sourceEnv });
  const staging = await mkdtemp(join(tmpdir(), "zody-cua-helper-diagnostic-"));
  try {
    const [repoReal, stagingReal] = await Promise.all([realpath(REPO_ROOT), realpath(staging)]);
    if (isPathInside(repoReal, stagingReal)) {
      throw new DiagnosticVerificationError("temporary build staging is inside the repository");
    }
    const configEvidence = await inspectCargoConfigAncestors(stagingReal);
    const sourceRoot = await copyCargoSource(staging);
    const cargoBuild = await buildBinary({
      toolchain,
      sdkPath: sdk.path,
      sourceRoot,
      staging,
      env: sourceEnv,
      configEvidence,
    });
    const artifact = join(staging, "artifact");
    await mkdir(artifact, { recursive: true });
    const staged = await stageApp({
      artifactRoot: artifact,
      binary: cargoBuild.binary,
      toolchain,
      buildEnv: cargoBuild.buildEnv,
    });
    const manifest = await createDiagnosticManifest({ staged, toolchain, sdk, cargoBuild });
    const schema = validateManifestSchema(manifest);
    if (!schema.ok) throw new DiagnosticVerificationError(schema.error);
    await writeFile(join(artifact, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await validateArtifactBeforeExecution({ artifactRoot: artifact });

    const commitStaging = await mkdtemp(join(OUTPUT_PARENT, "commit-"));
    try {
      const committedArtifact = join(commitStaging, "artifact");
      await cp(artifact, committedArtifact, { recursive: true, errorOnExist: true, force: false });
      await validateArtifactBeforeExecution({ artifactRoot: committedArtifact });
      await commitArtifact(committedArtifact);
    } finally {
      await rm(commitStaging, { recursive: true, force: true });
    }
    return { artifactRoot: DEFAULT_ARTIFACT_ROOT, manifestKind: MANIFEST_KIND };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
