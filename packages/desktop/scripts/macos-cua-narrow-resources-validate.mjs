// 窄 CUA manifest 的可搬迁校验与打包后复核。固定代码 pins 是信任根；
// manifest 自报内容只用于一致性比对，不能替代代码/受控发布策略建立新身份。
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";

import {
  NARROW_APP_NAME,
  NARROW_EXECUTABLE_RELATIVE_PATH,
  NARROW_MANIFEST_KIND,
  NARROW_SLOT,
  NARROW_TARGET,
} from "./macos-cua-narrow-resources-constants.mjs";
import {
  NarrowResourceError,
  sha256Bytes,
  sha256File,
} from "./macos-cua-narrow-resources-base.mjs";
import { assertNoCandidateHostLaunchSeam } from "./macos-cua-narrow-resources-identity.mjs";
import { assertControlledFile, loadIdentityPins } from "./macos-cua-narrow-resources-pins.mjs";
import {
  assertIdentityAgainstPins,
  assertIdentityMatches,
} from "./macos-cua-narrow-resources-policy.mjs";
import { assertTreeMatches, inspectNarrowTree } from "./macos-cua-narrow-resources-tree.mjs";
import { validateNativeBuildManifest } from "./macos-cua-narrow-resources-native.mjs";
import { verifyNarrowApp } from "./macos-cua-narrow-resources-verify-app.mjs";
import { resolveIdentityProfileName } from "./macos-cua-narrow-identity-profile.mjs";

function resolveControlledPath(manifestDir, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.trim() || isAbsolute(relativePath)) {
    throw new NarrowResourceError(
      "narrow-manifest-path",
      `cua-narrow manifest ${label} must be a relative controlled path`,
    );
  }
  const root = resolve(manifestDir);
  const resolvedPath = resolve(root, relativePath);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
    throw new NarrowResourceError(
      "narrow-manifest-path",
      `cua-narrow manifest ${label} escapes the manifest directory`,
    );
  }
  return resolvedPath;
}

export async function validateNarrowManifest({
  manifestPath,
  targetPlatform,
  env = process.env,
  identityProfile = env.ZODY_CUA_NARROW_IDENTITY_PROFILE,
  deps = {},
}) {
  assertNoCandidateHostLaunchSeam(env);
  identityProfile = resolveIdentityProfileName(identityProfile);
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) {
    throw new NarrowResourceError(
      "narrow-manifest-required-absolute",
      `cua-narrow manifest must be an absolute path: ${manifestPath}`,
    );
  }
  if (targetPlatform?.os !== NARROW_TARGET.os || targetPlatform?.arch !== NARROW_TARGET.arch) {
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      `cua-narrow resources require ${NARROW_TARGET.os}/${NARROW_TARGET.arch}`,
    );
  }
  const read = deps.readFile ?? readFile;
  const bytes = await read(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NarrowResourceError("narrow-manifest-kind", "cua-narrow manifest is invalid JSON");
  }
  if (
    manifest.kind !== NARROW_MANIFEST_KIND ||
    manifest.status !== "pass" ||
    manifest.schemaVersion !== 1
  ) {
    throw new NarrowResourceError(
      "narrow-manifest-kind",
      "cua-narrow manifest kind/status/schema is not accepted",
    );
  }
  if (
    manifest.target?.os !== NARROW_TARGET.os ||
    manifest.target?.arch !== NARROW_TARGET.arch ||
    manifest.target?.minimumMacOSVersion !== NARROW_TARGET.minimumMacOSVersion
  ) {
    throw new NarrowResourceError(
      "narrow-manifest-target",
      "cua-narrow manifest target is not darwin/arm64/14.2",
    );
  }
  if (
    manifest.slot?.resourcesRelativePath !== NARROW_SLOT ||
    manifest.slot?.appName !== NARROW_APP_NAME
  ) {
    throw new NarrowResourceError(
      "narrow-manifest-slot",
      "cua-narrow manifest slot is not the independent cua-narrow slot",
    );
  }

  const manifestDir = dirname(resolve(manifestPath));
  const stageAppPath = resolveControlledPath(manifestDir, manifest.stage?.appPath, "stage.appPath");
  const nativeBuildManifestPath = resolveControlledPath(
    manifestDir,
    manifest.nativeBuildManifest?.path,
    "nativeBuildManifest.path",
  );
  const pinsPath = resolveControlledPath(
    manifestDir,
    manifest.identity?.pinsPath,
    "identity.pinsPath",
  );
  await assertControlledFile(pinsPath, "cua-narrow identity pins", deps);
  await assertControlledFile(nativeBuildManifestPath, "cua-narrow native build manifest", deps);

  const pins = await loadIdentityPins({ path: pinsPath, identityProfile, deps });
  const verifyApp = deps.verifyNarrowApp ?? verifyNarrowApp;
  const liveIdentity = await verifyApp({ appPath: stageAppPath, pins, deps });
  const tree = await inspectNarrowTree(stageAppPath, deps);
  if (manifest.stage?.treeSha256 !== tree.treeSha256) {
    throw new NarrowResourceError(
      "narrow-content-mismatch",
      "cua-narrow stage tree digest does not match the manifest",
    );
  }
  assertTreeMatches(tree, manifest.tree, "cua-narrow stage");
  const nativeInfo = await validateNativeBuildManifest({
    appPath: stageAppPath,
    nativeBuildManifestPath,
    pins,
    deps,
  });
  if (
    nativeInfo.sha256 !== manifest.nativeBuildManifest?.sha256 ||
    nativeInfo.kind !== manifest.nativeBuildManifest?.kind ||
    nativeInfo.status !== manifest.nativeBuildManifest?.status
  ) {
    throw new NarrowResourceError(
      "narrow-native-manifest-mismatch",
      "cua-narrow manifest native build manifest record changed",
    );
  }

  liveIdentity.signedBinarySha256 = await sha256File(
    join(stageAppPath, NARROW_EXECUTABLE_RELATIVE_PATH),
  );
  liveIdentity.nativeUnsignedBinarySha256 = nativeInfo.nativeUnsignedBinarySha256;
  assertIdentityAgainstPins(liveIdentity, pins);
  assertIdentityMatches(manifest.identity, liveIdentity);
  if (manifest.identity?.pinsSha256 !== pins.sha256) {
    throw new NarrowResourceError(
      "narrow-pins-mismatch",
      "cua-narrow manifest was not prepared from the fixed identity pins file",
    );
  }
  if (manifest.identity?.nativeUnsignedBinarySha256 !== nativeInfo.nativeUnsignedBinarySha256) {
    throw new NarrowResourceError(
      "narrow-native-manifest-mismatch",
      "native unsigned binary hash record does not match the source native build manifest",
    );
  }
  if (manifest.source?.treeSha256 !== tree.treeSha256) {
    throw new NarrowResourceError(
      "narrow-content-mismatch",
      "cua-narrow source and stage tree digests differ",
    );
  }
  return {
    manifest,
    manifestPath: resolve(manifestPath),
    manifestSha256: sha256Bytes(bytes),
    stageAppPath,
    tree,
    identity: liveIdentity,
    nativeBuildManifest: nativeInfo,
    nativeBuildManifestPath,
    pins,
    pinsPath,
  };
}

export async function assertPackagedNarrowResource({
  resourcesDir,
  manifestPath,
  env = process.env,
  identityProfile = env.ZODY_CUA_NARROW_IDENTITY_PROFILE,
  deps = {},
}) {
  const validated = await validateNarrowManifest({
    manifestPath,
    targetPlatform: { os: NARROW_TARGET.os, arch: NARROW_TARGET.arch },
    env,
    identityProfile,
    deps,
  });
  const packagedManifestPath = join(resourcesDir, NARROW_SLOT, "manifest.json");
  let packagedManifestBytes;
  try {
    packagedManifestBytes = await readFile(packagedManifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new NarrowResourceError(
        "narrow-packaged-manifest-missing",
        "packaged cua-narrow manifest is missing at the fixed slot",
        { path: packagedManifestPath },
      );
    }
    throw error;
  }
  const packagedManifestSha256 = sha256Bytes(packagedManifestBytes);
  if (packagedManifestSha256 !== validated.manifestSha256) {
    throw new NarrowResourceError(
      "narrow-packaged-manifest-mismatch",
      "packaged cua-narrow manifest bytes differ from the validated source",
      { observed: packagedManifestSha256, expected: validated.manifestSha256 },
    );
  }
  const packagedAppPath = join(resourcesDir, NARROW_SLOT, NARROW_APP_NAME);
  const tree = await inspectNarrowTree(packagedAppPath, deps);
  assertTreeMatches(tree, validated.manifest.tree, "packaged cua-narrow app");
  if (tree.treeSha256 !== validated.manifest.stage?.treeSha256) {
    throw new NarrowResourceError(
      "narrow-content-mismatch",
      "packaged cua-narrow app differs from the prepared stage",
    );
  }
  const verifyApp = deps.verifyNarrowApp ?? verifyNarrowApp;
  const identity = await verifyApp({ appPath: packagedAppPath, pins: validated.pins, deps });
  identity.signedBinarySha256 = await sha256File(
    join(packagedAppPath, NARROW_EXECUTABLE_RELATIVE_PATH),
  );
  identity.nativeUnsignedBinarySha256 = validated.nativeBuildManifest.nativeUnsignedBinarySha256;
  assertIdentityAgainstPins(identity, validated.pins);
  assertIdentityMatches(identity, validated.manifest.identity);
  return {
    ...validated,
    packagedManifestPath,
    packagedManifestSha256,
    packagedAppPath,
    packagedTree: tree,
    packagedIdentity: identity,
  };
}

export async function writeNarrowBuildAudit({
  appOutDir,
  validated,
  packagedAppPath,
  outputPath = join(appOutDir, "cua-narrow-build-audit.json"),
}) {
  const audit = {
    kind: "zody-cua-narrow-build-audit",
    generatedAt: new Date().toISOString(),
    manifestPath: validated.manifestPath,
    manifestSha256: validated.manifestSha256,
    packagedAppPath,
    slot: `${NARROW_SLOT}/${NARROW_APP_NAME}`,
    target: { ...NARROW_TARGET },
    treeSha256: validated.tree.treeSha256,
    signedBinarySha256: validated.identity.signedBinarySha256,
    nativeUnsignedBinarySha256: validated.identity.nativeUnsignedBinarySha256,
    identity: {
      ...(validated.pins.identityProfile === "developer-id"
        ? { identityProfile: "developer-id", teamIdentifier: validated.pins.teamIdentifier }
        : {}),
      helperIdentifier: validated.identity.helperIdentifier,
      nodeIdentifier: validated.identity.nodeIdentifier,
      leafSha256: validated.identity.leafSha256,
      leafSha1: validated.identity.leafSha1,
      designatedRequirement: validated.identity.designatedRequirement,
      nodeDesignatedRequirement: validated.identity.nodeDesignatedRequirement,
      nodeCdhash: validated.identity.nodeCdhash,
      hardenedRuntime: validated.identity.hardenedRuntime,
      entitlementsEmpty: validated.identity.entitlementsEmpty,
    },
    licenses: validated.manifest.audit?.licenses ?? [],
    restrictions: validated.manifest.restrictions,
    verification: {
      source: "fixed identity pins plus live codesign; manifest is not a trust root",
      strictSignature: true,
      hardenedRuntime: true,
      emptyEntitlements: true,
      noSymlinksOrHardlinks: true,
      contentManifestMatched: true,
      reSigned: false,
      installedCertificate: false,
      requestedTcc: false,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
  return { path: outputPath, audit };
}
