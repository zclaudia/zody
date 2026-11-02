// Build and verify the stop-worker visual staticlib for one explicit profile.
// Production and diagnostic share the same source/cancel patch; only the cargo
// feature (and matching Swift compiler define) differ.
import { copyFile, cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
} from "./cua-desktop-session-config.mjs";
import { run, sha256File } from "./cua-desktop-session-toolchain.mjs";
import {
  STOP_VISUAL_PROFILES,
  stopCancelImplementationDigests,
} from "./cua-desktop-stop-visual-config.mjs";
import {
  loadStopVisualBaseline,
  pathExists,
  prepareStopVisualSource,
  scanStopVisualTree,
} from "./cua-desktop-stop-visual-source.mjs";
import { stopBuildError } from "./cua-desktop-stop-visual-errors.mjs";
import {
  cargoArgs,
  cargoEnv,
  repoPath,
} from "./cua-desktop-stop-visual-toolchain.mjs";
import { verifyStaticlib } from "./cua-desktop-stop-visual-verify.mjs";

export {
  buildAndRunStopCaptureOwnerHarness,
  stopCaptureOwnerCompileArgs,
} from "./cua-desktop-stop-visual-harness.mjs";

export async function runStopVisualRustTests({
  profile = "diagnostic",
  outputRoot,
} = {}) {
  const profileSpec = STOP_VISUAL_PROFILES[profile];
  if (!profileSpec) {
    throw stopBuildError("profile", `unknown stop visual profile: ${profile}`, {
      profile,
    });
  }
  const baseline = await loadStopVisualBaseline();
  const prepared = await prepareStopVisualSource({ profile, outputRoot });
  const paths = {
    ...prepared,
    cargoHome: join(prepared.root, "work", "cargo-home"),
    targetDir: join(prepared.root, "work", "target"),
  };
  if (!(await pathExists(paths.cargoHome))) {
    await cp(repoPath(baseline.toolchain.cargoHome), paths.cargoHome, {
      recursive: true,
      dereference: false,
    }).catch(async (error) => {
      throw stopBuildError("cargo-home", "failed to copy pinned cargo home", {
        message: error.message,
      });
    });
  }
  const args = cargoArgs(paths, profileSpec, "test");
  const result = await run(repoPath(baseline.toolchain.cargo), args, {
    env: cargoEnv(baseline, paths),
    timeoutMs: 900_000,
  });
  await mkdir(paths.buildRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(paths.buildRoot, `rust-tests-${profile}.log`),
    `${result.stdout}\n${result.stderr}\n`,
    { mode: 0o600 },
  );
  if (result.code !== 0) {
    throw stopBuildError(
      "rust-tests",
      `visual Rust tests failed for ${profile}`,
      {
        stdout: result.stdout.slice(-8_000),
        stderr: result.stderr.slice(-16_000),
      },
    );
  }
  return {
    status: "pass",
    output: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

export async function buildStopVisual({
  profile,
  outputRoot,
  runRustTests = false,
} = {}) {
  const profileSpec = STOP_VISUAL_PROFILES[profile];
  if (!profileSpec) {
    throw stopBuildError("profile", `unknown stop visual profile: ${profile}`, {
      profile,
    });
  }
  const baseline = await loadStopVisualBaseline();
  const prepared = await prepareStopVisualSource({ profile, outputRoot });
  const paths = {
    ...prepared,
    cargoHome: join(prepared.root, "work", "cargo-home"),
    targetDir: join(prepared.root, "work", "target"),
  };
  const sourceCargoHome = repoPath(baseline.toolchain.cargoHome);
  if (!(await pathExists(paths.cargoHome))) {
    await cp(sourceCargoHome, paths.cargoHome, {
      recursive: true,
      dereference: false,
    });
  }
  const rustTests = runRustTests
    ? await runStopVisualRustTests({ profile, outputRoot: paths.root })
    : { status: "not-run" };
  const args = cargoArgs(paths, profileSpec, "build");
  const command = [repoPath(baseline.toolchain.cargo), ...args].join(" ");
  const build = await run(repoPath(baseline.toolchain.cargo), args, {
    env: cargoEnv(baseline, paths),
    timeoutMs: 900_000,
  });
  await mkdir(paths.buildRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(paths.buildRoot, `build-${profile}.log`),
    `${build.stdout}\n${build.stderr}\n`,
    {
      mode: 0o600,
    },
  );
  await writeFile(
    join(paths.buildRoot, `build-command-${profile}.txt`),
    `${command}\n`,
    {
      mode: 0o600,
    },
  );
  if (build.code !== 0) {
    throw stopBuildError(
      "build",
      `visual staticlib build failed for ${profile}`,
      {
        command,
        stdout: build.stdout.slice(-8_000),
        stderr: build.stderr.slice(-16_000),
      },
    );
  }
  const target = "aarch64-apple-darwin";
  const cargoArtifact = join(
    paths.targetDir,
    target,
    "release/libcua_macos_visual.a",
  );
  if (!(await stat(cargoArtifact)).isFile()) {
    throw stopBuildError(
      "artifact-missing",
      "visual staticlib artifact is missing",
      {
        cargoArtifact,
      },
    );
  }
  await copyFile(cargoArtifact, paths.staticlib);
  const verification = await verifyStaticlib(paths, profileSpec, baseline);
  const derived = await scanStopVisualTree(paths.sourceRoot);
  const cancelImplementation = await stopCancelImplementationDigests();
  const manifest = {
    schemaVersion: 1,
    kind: "zody-cua-desktop-stop-visual-build",
    status: "pass",
    generatedAt: new Date().toISOString(),
    profile: {
      name: profileSpec.name,
      gateEnabled: profileSpec.gateEnabled,
      cargoFeatures: [...profileSpec.cargoFeatures],
      cancelImplementation: profileSpec.cancelImplementation,
    },
    prepareManifestSha256: await sha256File(paths.prepareManifest),
    source: prepared.report.source,
    overlay: prepared.report.overlay,
    derived: {
      treeSha256: derived.treeSha256,
      files: derived.files.length,
      patches: prepared.report.patches,
    },
    cancelImplementation,
    build: {
      command,
      offline: true,
      locked: true,
      target,
      deploymentTarget: FIXED_DEPLOYMENT_TARGET,
    },
    artifact: {
      path: paths.staticlib,
      sha256: await sha256File(paths.staticlib),
      sizeBytes: (await stat(paths.staticlib)).size,
      architectures: [FIXED_ARCH],
      ...verification,
    },
    header: { path: paths.header, sha256: await sha256File(paths.header) },
    rustTests,
  };
  await writeFile(
    join(paths.buildRoot, `build-manifest-${profile}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { ...manifest, paths };
}
