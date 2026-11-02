import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCEPTED_ARGUMENTS,
  DEPLOYMENT_TARGET,
  EXIT_CODES,
  EXPECTED_TOOLCHAIN,
  MANIFEST_KIND,
  NATIVE_ROOT,
  NATIVE_SOURCE_RELATIVE_FILES,
  PRODUCT,
  TARGET,
  sha256File,
} from "./cua-helper-diagnostic-core.mjs";
import { BUILD_FORBIDDEN_ENVIRONMENT } from "./cua-helper-diagnostic-toolchain.mjs";
import { probeSignature } from "./cua-helper-diagnostic-artifacts.mjs";

async function sourceHashes() {
  return await Promise.all(
    NATIVE_SOURCE_RELATIVE_FILES.map(async (path) => ({
      path,
      sha256: await sha256File(join(NATIVE_ROOT, path)),
    })),
  );
}

export async function createDiagnosticManifest({ staged, toolchain, sdk, cargoBuild }) {
  const executablePath = join(staged.macos, PRODUCT.name);
  const infoPath = join(staged.contents, "Info.plist");
  return {
    schemaVersion: 1,
    kind: MANIFEST_KIND,
    status: "pass",
    diagnosticOnly: true,
    driverLinked: false,
    generatedAt: new Date().toISOString(),
    product: {
      name: PRODUCT.name,
      bundleId: PRODUCT.bundleId,
      shortVersion: PRODUCT.shortVersion,
      bundleVersion: PRODUCT.bundleVersion,
      minimumMacOSVersion: PRODUCT.minimumMacOSVersion,
      runtimeSupportVerified: false,
    },
    artifact: {
      relativePath: PRODUCT.appName,
      infoPlistRelativePath: "Contents/Info.plist",
      executableRelativePath: `Contents/MacOS/${PRODUCT.name}`,
      infoPlistSha256: await sha256File(infoPath),
      executableSha256: await sha256File(executablePath),
      executableSize: (await lstat(executablePath)).size,
      architecture: staged.machO.architectures[0],
      minimumMacOS: staged.machO.minimumMacOS,
    },
    build: {
      target: TARGET,
      deploymentTarget: DEPLOYMENT_TARGET,
      cargoArguments: cargoBuild.cargoArguments,
      isolatedCargoHome: true,
      cargoHome: "<system-temp-staging>/cargo-home",
      source: "<system-temp-staging>/source",
      targetDirectory: "<system-temp-staging>/target",
      environmentPolicy: "allowlist-no-rust-or-cargo-overrides",
      forbiddenInheritedEnvironment: [...BUILD_FORBIDDEN_ENVIRONMENT],
      cargoConfigIsolation: cargoBuild.cargoConfigIsolation,
    },
    arguments: { accepted: [...ACCEPTED_ARGUMENTS], exitCodes: { ...EXIT_CODES } },
    sources: await sourceHashes(),
    toolchain: {
      selected: toolchain.selected,
      rustc: {
        release: toolchain.rustc.version,
        commit: toolchain.rustc.commit,
        host: toolchain.rustc.host,
      },
      cargo: {
        release: toolchain.cargo.version,
        commit: toolchain.cargo.commit,
        host: toolchain.cargo.host,
      },
      sysroot: toolchain.sysroot,
      target: TARGET,
    },
    sdk: { path: sdk.path, version: sdk.version },
    dependencies: {
      stdOnly: true,
      driverLinked: false,
      crateDependencies: [],
      cargoTree: cargoBuild.cargoTree,
      linkedDynamicLibraries: staged.machO.linkedDynamicLibraries,
    },
    licenses: {
      firstParty: {
        spdx: "Apache-2.0",
        source: "LICENSE",
        path: "Contents/Resources/LICENSE",
        sha256: await sha256File(join(staged.resources, "LICENSE")),
      },
      rustStandardLibrary: {
        spdx: "Apache-2.0 OR MIT",
        source: "rustc --print sysroot/share/doc/rust/COPYRIGHT-library.html",
        path: "Contents/Resources/COPYRIGHT-library.html",
        sha256: await sha256File(join(staged.resources, "COPYRIGHT-library.html")),
        scope: "Rust standard library and compiler runtime linked into the diagnostic binary",
      },
      thirdPartyCrates: [],
      thirdPartyCratesMeaning:
        "Cargo dependencies only; Rust standard library is reported separately.",
      closureComplete: false,
    },
    upstreamComparison: {
      declaredRustVersion: EXPECTED_TOOLCHAIN.upstreamRustVersion,
      buildRustVersion: EXPECTED_TOOLCHAIN.rustVersion,
      driverSourceIncluded: false,
      patchIncluded: false,
      licenseClosureComplete: false,
      status: "delta-not-closed",
      note: "Diagnostic skeleton only; no Driver source, patch, peer, TCC or input capability.",
    },
    signature: {
      binary: await probeSignature(executablePath, cargoBuild.buildEnv),
      app: await probeSignature(staged.appPath, cargoBuild.buildEnv),
      localSelfSignedClaim: false,
      signingPerformed: false,
    },
    health: {
      inputCapable: false,
      driverLinked: false,
      tccRequested: false,
      nativeCapabilityProven: false,
    },
    limits: {
      minosIsBuildTargetOnly: true,
      nativeCapabilityProven: false,
      d06IsolationProven: false,
      defaultLauncherWired: false,
    },
  };
}
