// 窄 CUA 资源装配的稳定 API：只负责构建请求、独立槽位和再导出。
// 默认无显式 manifest 时完全不改变正常 desktop bundle 行为。
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import {
  NARROW_APP_NAME,
  NARROW_MANIFEST_ENV,
  NARROW_SLOT,
  NARROW_TARGET,
} from "./macos-cua-narrow-resources-constants.mjs";
import { NarrowResourceError } from "./macos-cua-narrow-resources-base.mjs";
import { assertNoCandidateHostLaunchSeam } from "./macos-cua-narrow-resources-identity.mjs";
import { validateNarrowManifest } from "./macos-cua-narrow-resources-validate.mjs";

export * from "./macos-cua-narrow-resources-constants.mjs";
export {
  NarrowResourceError,
  sha1Bytes,
  sha256Bytes,
  sha256File,
  sha256Text,
} from "./macos-cua-narrow-resources-base.mjs";
export {
  assertNoCandidateHostLaunchSeam,
  readInfoPlist,
  readLeafCertificateDer,
  verifyCodeIdentity,
  verifyMachO,
} from "./macos-cua-narrow-resources-identity.mjs";
export { assertControlledFile, loadIdentityPins } from "./macos-cua-narrow-resources-pins.mjs";
export {
  assertIdentityAgainstPins,
  assertIdentityMatches,
  expectedIdentityFromPins,
} from "./macos-cua-narrow-resources-policy.mjs";
export { assertTreeMatches, inspectNarrowTree } from "./macos-cua-narrow-resources-tree.mjs";
export { validateNativeBuildManifest } from "./macos-cua-narrow-resources-native.mjs";
export {
  assertPackagedNarrowResource,
  createNarrowManifest,
  validateNarrowManifest,
  verifyNarrowApp,
  writeNarrowBuildAudit,
} from "./macos-cua-narrow-resources-manifest.mjs";

function normalizeTargetOs(value) {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "mac" || normalized === "macos" || normalized === "osx"
    ? "darwin"
    : normalized;
}

export function resolveNarrowBuildRequest({
  cliManifestPath = null,
  env = process.env,
  targetOs,
  targetArch,
}) {
  // 显式传入空 CLI 值不能退化成“未请求”，否则会静默漏装资源。
  const cliProvided = cliManifestPath !== undefined && cliManifestPath !== null;
  const cliPath = typeof cliManifestPath === "string" ? cliManifestPath.trim() : null;
  if (cliProvided && !cliPath) {
    throw new NarrowResourceError(
      "narrow-manifest-required-absolute",
      "cua-narrow manifest path must not be empty",
    );
  }
  const envPath = env[NARROW_MANIFEST_ENV]?.trim() || null;
  if (cliPath && envPath && resolve(cliPath) !== resolve(envPath)) {
    throw new NarrowResourceError(
      "narrow-manifest-conflict",
      `conflicting cua-narrow manifests: CLI=${cliPath} env=${envPath}`,
    );
  }
  const manifestPath = cliPath ?? envPath;
  if (!manifestPath) return null;
  assertNoCandidateHostLaunchSeam(env);
  if (!isAbsolute(manifestPath)) {
    throw new NarrowResourceError(
      "narrow-manifest-required-absolute",
      `cua-narrow manifest must be an absolute path: ${manifestPath}`,
    );
  }
  if (normalizeTargetOs(targetOs) !== NARROW_TARGET.os || targetArch !== NARROW_TARGET.arch) {
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      `cua-narrow resources require ${NARROW_TARGET.os}/${NARROW_TARGET.arch}, got ${targetOs}/${targetArch}`,
    );
  }
  return { manifestPath: resolve(manifestPath) };
}

export function createNarrowBuildEnv(request) {
  return request ? { [NARROW_MANIFEST_ENV]: request.manifestPath } : {};
}

export function getNarrowSignIgnorePatterns() {
  return ["[/\\\\]Contents[/\\\\]Resources[/\\\\]cua-narrow([/\\\\]|$)"];
}

export function buildNarrowExtraResource(validated) {
  if (!validated) return null;
  const appPath = validated.stageAppPath;
  if (typeof appPath !== "string" || !isAbsolute(appPath)) {
    throw new NarrowResourceError(
      "narrow-manifest-stage",
      "validated cua-narrow stageAppPath must be an absolute path",
    );
  }
  const manifestPath = validated.manifestPath;
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) {
    throw new NarrowResourceError(
      "narrow-manifest-path",
      "validated cua-narrow manifestPath must be an absolute path",
    );
  }
  // The manifest is copied byte-for-byte from the validated source. Do not rewrite or
  // regenerate it here: its sha256 is the build-profile pin checked after packaging.
  return [
    { from: appPath, to: `${NARROW_SLOT}/${NARROW_APP_NAME}` },
    { from: manifestPath, to: `${NARROW_SLOT}/manifest.json` },
  ];
}

export async function loadNarrowManifestForBuild({ manifestPath, targetPlatform, env, deps }) {
  return validateNarrowManifest({ manifestPath, targetPlatform, env, deps });
}
