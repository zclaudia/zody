// 从已验证的 signed desktop-session app 生成可搬迁 stage + manifest。
// 只复制受控 app/pins/native manifest，不签名、不安装证书、不请求 TCC。
import { constants as fsConstants } from "node:fs";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  NARROW_APP_NAME,
  NARROW_EXECUTABLE_RELATIVE_PATH,
  NARROW_MANIFEST_KIND,
  NARROW_NODE_RELATIVE_PATH,
  NARROW_SLOT,
  NARROW_TARGET,
} from "./macos-cua-narrow-resources-constants.mjs";
import { NarrowResourceError, sha256File } from "./macos-cua-narrow-resources-base.mjs";
import {
  assertIdentityAgainstPins,
  assertIdentityMatches,
} from "./macos-cua-narrow-resources-policy.mjs";
import { loadIdentityPins } from "./macos-cua-narrow-resources-pins.mjs";
import { assertTreeMatches, inspectNarrowTree } from "./macos-cua-narrow-resources-tree.mjs";
import { validateNativeBuildManifest } from "./macos-cua-narrow-resources-native.mjs";
import { verifyNarrowApp } from "./macos-cua-narrow-resources-verify-app.mjs";

function requireAbsolute(label, value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new NarrowResourceError(
      "narrow-manifest-required-absolute",
      `cua-narrow ${label} must be an absolute path`,
    );
  }
}

async function pathExists(path) {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function comparePreparedIdentity(sourceIdentity, stageIdentity, nativeInfo, pins) {
  assertIdentityAgainstPins(sourceIdentity, pins);
  assertIdentityAgainstPins(stageIdentity, pins);
  assertIdentityMatches(stageIdentity, sourceIdentity);
  if (sourceIdentity.nativeUnsignedBinarySha256 !== nativeInfo.nativeUnsignedBinarySha256) {
    throw new NarrowResourceError(
      "narrow-native-manifest-mismatch",
      "signed Helper native manifest unsigned artifact hash mismatch",
    );
  }
  if (stageIdentity.signedBinarySha256 === stageIdentity.nativeUnsignedBinarySha256) {
    throw new NarrowResourceError(
      "narrow-signature-invalid",
      "signed Helper binary hash still equals the native unsigned artifact hash",
    );
  }
}

export async function createNarrowManifest({
  appPath,
  nativeBuildManifestPath,
  outputRoot,
  pinsPath,
  replace = false,
  deps = {},
}) {
  for (const [label, value] of [
    ["app", appPath],
    ["native-build-manifest", nativeBuildManifestPath],
    ["output", outputRoot],
    ["identity pins", pinsPath],
  ]) {
    requireAbsolute(label, value);
  }
  if (appPath.split(/[\\/]/).at(-1) !== NARROW_APP_NAME) {
    throw new NarrowResourceError(
      "narrow-helper-mismatch",
      `cua-narrow prepare only accepts ${NARROW_APP_NAME}, got ${appPath}`,
    );
  }
  const resolvedPinsPath = resolve(pinsPath);
  const pins = await loadIdentityPins({ path: resolvedPinsPath, deps });
  const verifyApp = deps.verifyNarrowApp ?? verifyNarrowApp;
  const sourceIdentity = await verifyApp({ appPath, pins, deps });
  const sourceNativeInfo = await validateNativeBuildManifest({
    appPath,
    nativeBuildManifestPath,
    pins,
    deps,
  });
  sourceIdentity.signedBinarySha256 = await sha256File(
    join(appPath, NARROW_EXECUTABLE_RELATIVE_PATH),
  );
  sourceIdentity.nativeUnsignedBinarySha256 = sourceNativeInfo.nativeUnsignedBinarySha256;

  const stageRoot = join(outputRoot, "stage");
  const stageAppPath = join(stageRoot, NARROW_APP_NAME);
  if (await pathExists(stageRoot)) {
    if (!replace) {
      throw new NarrowResourceError(
        "narrow-stage-exists",
        `cua-narrow stage already exists: ${stageAppPath}; pass --replace to rebuild it`,
      );
    }
    await rm(stageRoot, { recursive: true, force: true });
  }
  await mkdir(stageRoot, { recursive: true });
  await cp(appPath, stageAppPath, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  const stagePinsPath = join(stageRoot, "identity-pins.json");
  const stageNativePath = join(stageRoot, "native-build-manifest.json");
  await cp(resolvedPinsPath, stagePinsPath);
  await cp(nativeBuildManifestPath, stageNativePath);

  const stagePins = await loadIdentityPins({ path: stagePinsPath, deps });
  const stageIdentity = await verifyApp({ appPath: stageAppPath, pins: stagePins, deps });
  const stageNativeInfo = await validateNativeBuildManifest({
    appPath: stageAppPath,
    nativeBuildManifestPath: stageNativePath,
    pins: stagePins,
    deps,
  });
  stageIdentity.signedBinarySha256 = await sha256File(
    join(stageAppPath, NARROW_EXECUTABLE_RELATIVE_PATH),
  );
  stageIdentity.nativeUnsignedBinarySha256 = stageNativeInfo.nativeUnsignedBinarySha256;
  comparePreparedIdentity(sourceIdentity, stageIdentity, stageNativeInfo, stagePins);

  const sourceTree = await inspectNarrowTree(appPath, deps);
  const stageTree = await inspectNarrowTree(stageAppPath, deps);
  assertTreeMatches(stageTree, sourceTree, "prepared cua-narrow stage");

  const manifestPath = join(outputRoot, "manifest.json");
  const manifest = {
    schemaVersion: 1,
    kind: NARROW_MANIFEST_KIND,
    status: "pass",
    generatedAt: new Date().toISOString(),
    target: { ...NARROW_TARGET },
    slot: { resourcesRelativePath: NARROW_SLOT, appName: NARROW_APP_NAME },
    path: "manifest.json",
    source: {
      // 仅来源证据；validate 不读取这个绝对路径。
      appPath,
      treeSha256: sourceTree.treeSha256,
      signedBinarySha256: sourceIdentity.signedBinarySha256,
      executableRelativePath: NARROW_EXECUTABLE_RELATIVE_PATH,
      nodeRelativePath: NARROW_NODE_RELATIVE_PATH,
    },
    stage: {
      appPath: `stage/${NARROW_APP_NAME}`,
      treeSha256: stageTree.treeSha256,
    },
    nativeBuildManifest: {
      path: "stage/native-build-manifest.json",
      sha256: stageNativeInfo.sha256,
      kind: stageNativeInfo.kind,
      status: stageNativeInfo.status,
      nativeUnsignedBinarySha256: stageNativeInfo.nativeUnsignedBinarySha256,
    },
    identity: {
      ...stageIdentity,
      pinsPath: "stage/identity-pins.json",
      pinsSha256: stagePins.sha256,
    },
    tree: { treeSha256: stageTree.treeSha256, entries: stageTree.entries },
    audit: {
      symlinks: [],
      hardlinks: [],
      externalLinks: [],
      licenses: stageTree.licenses,
      entries: stageNativeInfo.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
      })),
      auxiliaryResources: stageNativeInfo.auxiliaryResources.map((entry) => ({
        name: entry.name,
        path: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
      })),
      nativeUnsignedBinarySha256: stageNativeInfo.nativeUnsignedBinarySha256,
      signedBinarySha256: stageIdentity.signedBinarySha256,
    },
    restrictions: {
      defaultDisabled: true,
      placeholderDefault: true,
      hostActivation: false,
      cuaHelperSlotReused: false,
      reSign: false,
      installCertificate: false,
      requestTcc: false,
    },
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifest, manifestPath, stageAppPath };
}
