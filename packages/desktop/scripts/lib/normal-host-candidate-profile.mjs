// Build-time startup profile for the normal utility Host candidate.
// The profile stores only normalized public facts and digests; provider credentials,
// provider headers, and raw proxy/CA inputs are never archived.
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  NarrowResourceError,
  sha256Bytes,
  sha256File,
} from "../macos-cua-narrow-resources-base.mjs";
import {
  readNetworkProfile,
  readProviderProfile,
} from "./normal-host-candidate-provider-profile.mjs";
import { readStartupSnapshot } from "./normal-host-candidate-startup-snapshot.mjs";

export const NARROW_PROFILE_KIND = "zody-cua-narrow-agent-profile";
export const NARROW_PROFILE_SCHEMA_VERSION = 1;
export const NARROW_CAPABILITY = "screenshot.single-window";
export const NARROW_RESOURCES_SLOT = "cua-narrow";
export const NARROW_APP_NAME = "Zody CUA Desktop Session.app";
export const NARROW_LAUNCHER_RELATIVE_PATH = "Contents/MacOS/macos-cua-desktop-session";
export const NARROW_MANIFEST_KIND = "zody-cua-narrow-resource-manifest";
export const NARROW_MINIMUM_MACOS_VERSION = "14.2";

// Runtime/source naming aliases kept explicit so candidate assembly and Host runtime
// review the same contract without importing desktop source into a build script.
export const CUA_NARROW_PROFILE_KIND = NARROW_PROFILE_KIND;
export const CUA_NARROW_CAPABILITY = NARROW_CAPABILITY;
export const CUA_NARROW_RESOURCES_SLOT = NARROW_RESOURCES_SLOT;
export const CUA_NARROW_APP_NAME = NARROW_APP_NAME;
export const CUA_NARROW_LAUNCHER_RELATIVE_PATH = NARROW_LAUNCHER_RELATIVE_PATH;

export {
  digestNormalHostNetwork,
  digestNormalHostProviderSnapshot,
  normalizeNormalHostNetwork,
  normalizeNormalHostSelection,
  projectNormalHostProviderSnapshot,
  readNetworkProfile,
  readProviderProfile,
} from "./normal-host-candidate-provider-profile.mjs";
export {
  parseNormalHostStartupSnapshot,
  readStartupSnapshot,
} from "./normal-host-candidate-startup-snapshot.mjs";
export {
  NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME,
  NORMAL_HOST_CANDIDATE_BUNDLE_ID,
  NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
  NORMAL_HOST_CANDIDATE_PACKAGE_NAME,
  NORMAL_HOST_CANDIDATE_RELEASE_FLAGS,
  rewriteNormalHostCandidateAppIdentity,
} from "./normal-host-candidate-identity.mjs";

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new NarrowResourceError("normal-host-profile-digest", `${label} must be sha256`);
  }
  return value;
}

function readManifestShape(manifest, manifestPath) {
  if (manifest?.kind !== NARROW_MANIFEST_KIND || manifest?.status !== "pass") {
    throw new NarrowResourceError(
      "normal-host-manifest-kind",
      `cua-narrow manifest kind/status is not accepted: ${manifestPath}`,
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target?.os !== "darwin" ||
    manifest.target?.arch !== "arm64"
  ) {
    throw new NarrowResourceError(
      "normal-host-manifest-target",
      `cua-narrow manifest target is not darwin/arm64: ${manifestPath}`,
    );
  }
  if (
    manifest.slot?.resourcesRelativePath !== NARROW_RESOURCES_SLOT ||
    manifest.slot?.appName !== NARROW_APP_NAME
  ) {
    throw new NarrowResourceError(
      "normal-host-manifest-slot",
      `cua-narrow manifest slot is not ${NARROW_RESOURCES_SLOT}/${NARROW_APP_NAME}`,
    );
  }
  assertSha256(manifest.identity?.signedBinarySha256, "manifest.identity.signedBinarySha256");
  const stageAppPath = manifest.stage?.appPath;
  if (typeof stageAppPath !== "string" || isAbsolute(stageAppPath)) {
    throw new NarrowResourceError(
      "normal-host-manifest-stage",
      "cua-narrow manifest stage.appPath must be a relative path",
    );
  }
  const manifestDir = resolve(dirname(manifestPath));
  const resolvedStageApp = resolve(manifestDir, stageAppPath);
  const relativeStageApp = relative(manifestDir, resolvedStageApp);
  if (
    isAbsolute(relativeStageApp) ||
    relativeStageApp === ".." ||
    relativeStageApp.startsWith(`..${sep}`)
  ) {
    throw new NarrowResourceError(
      "normal-host-manifest-stage",
      "cua-narrow stage app escapes the manifest directory",
    );
  }
  return {
    manifestDir,
    stageAppPath: resolvedStageApp,
    launcherSha256: manifest.identity.signedBinarySha256,
    minimumMacOSVersion: manifest.target.minimumMacOSVersion,
  };
}

export async function createNormalHostNarrowProfile(options) {
  const manifestBytes = await readFile(options.narrowManifest);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new NarrowResourceError(
      "normal-host-manifest-json",
      `cua-narrow manifest is not valid JSON: ${options.narrowManifest}`,
    );
  }
  const shape = readManifestShape(manifest, options.narrowManifest);
  const hasStartupSnapshot = options.startupSnapshot !== undefined;
  const hasProviderOrNetworkProfile =
    options.providerProfile !== undefined || options.networkProfile !== undefined;
  if (hasStartupSnapshot === hasProviderOrNetworkProfile) {
    throw new NarrowResourceError(
      "normal-host-profile-source",
      "provide exactly one of startupSnapshot or providerProfile+networkProfile",
    );
  }
  let provider;
  let networkDigestSha256;
  if (hasStartupSnapshot) {
    const snapshot = await readStartupSnapshot(options.startupSnapshot);
    provider = {
      revisionSha256: snapshot.revisionSha256,
      selection: snapshot.selection,
    };
    networkDigestSha256 = snapshot.networkDigestSha256;
  } else {
    if (options.providerProfile === undefined || options.networkProfile === undefined) {
      throw new NarrowResourceError(
        "normal-host-profile-source",
        "providerProfile and networkProfile must be provided together",
      );
    }
    provider = await readProviderProfile(options.providerProfile);
    networkDigestSha256 = (await readNetworkProfile(options.networkProfile)).digestSha256;
  }
  const profile = {
    kind: NARROW_PROFILE_KIND,
    schemaVersion: NARROW_PROFILE_SCHEMA_VERSION,
    capability: NARROW_CAPABILITY,
    testedTarget: {
      os: "darwin",
      arch: "arm64",
      macOSVersion: options.testedMacOSVersion,
    },
    workspaceAllowlist: [...options.workspaceAllowlist],
    resourceManifest: {
      sha256: sha256Bytes(manifestBytes),
      launcherSha256: shape.launcherSha256,
    },
    provider: {
      revisionSha256: provider.revisionSha256,
      selection: provider.selection,
    },
    network: { digestSha256: networkDigestSha256 },
  };
  return {
    profile,
    manifest,
    manifestSha256: profile.resourceManifest.sha256,
    launcherSha256: shape.launcherSha256,
    stageAppPath: shape.stageAppPath,
    manifestDir: shape.manifestDir,
    minimumMacOSVersion: shape.minimumMacOSVersion,
    networkDigestSha256,
    profileSource: hasStartupSnapshot ? "host-startup-snapshot" : "provider-network-profile",
  };
}

export function resolveShellLayout(appShell) {
  if (!isAbsolute(appShell)) {
    throw new NarrowResourceError("normal-host-app-shell", "app shell must be absolute");
  }
  const resourcesDir = join(appShell, "Contents", "Resources");
  return {
    appShell,
    resourcesDir,
    appAsarPath: join(resourcesDir, "app.asar"),
    appAsarUnpackedPath: join(resourcesDir, "app.asar.unpacked"),
    appDir: join(resourcesDir, "app"),
    narrowAppPath: join(resourcesDir, NARROW_RESOURCES_SLOT, NARROW_APP_NAME),
    narrowManifestPath: join(resourcesDir, NARROW_RESOURCES_SLOT, "manifest.json"),
    launcherPath: join(
      resourcesDir,
      NARROW_RESOURCES_SLOT,
      NARROW_APP_NAME,
      NARROW_LAUNCHER_RELATIVE_PATH,
    ),
  };
}

export async function assertShellNarrowLauncherMatches(layout, launcherSha256) {
  const observed = await sha256File(layout.launcherPath);
  if (observed !== launcherSha256) {
    throw new NarrowResourceError(
      "normal-host-shell-launcher",
      "app shell cua-narrow launcher does not match the prepared manifest",
      { observed, expected: launcherSha256 },
    );
  }
  return observed;
}
