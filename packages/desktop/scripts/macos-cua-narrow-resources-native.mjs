// 本轮 desktop-session native build manifest 的校验：只接受固定 kind/entry 集合，
// 并区分 unsigned Mach-O 摘要与签名后实际摘要。
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  NARROW_APP_NAME,
  NARROW_AUXILIARY_NAMES,
  NARROW_ENTRY_NAMES,
  NARROW_EXECUTABLE_RELATIVE_PATH,
  NARROW_NATIVE_MANIFEST_KIND,
  NARROW_NODE_RELATIVE_PATH,
  PINNED_HELPER_IDENTIFIER,
} from "./macos-cua-narrow-resources-constants.mjs";
import {
  NarrowResourceError,
  sha256Bytes,
  sha256File,
} from "./macos-cua-narrow-resources-base.mjs";

function assertPinValues(rawValues, pins) {
  if (!rawValues || typeof rawValues !== "object") {
    throw new NarrowResourceError(
      "narrow-native-manifest-mismatch",
      "desktop-session native build manifest is missing identityPins.values",
    );
  }
  for (const field of [
    "leafSha256",
    "nodeLeafSha256",
    "designatedRequirement",
    "nodeDesignatedRequirement",
    "nodeIdentifier",
    "nodeCdhash",
  ]) {
    if (rawValues[field] !== pins[field]) {
      throw new NarrowResourceError(
        "narrow-native-manifest-mismatch",
        `desktop-session native build manifest identity pin ${field} changed`,
      );
    }
  }
}

async function assertExpectedResources({ appPath, descriptors, expectedNames, kind }) {
  if (!Array.isArray(descriptors)) {
    throw new NarrowResourceError(
      "narrow-entry-mismatch",
      `desktop-session native build manifest is missing ${kind}`,
    );
  }
  const byName = new Map(descriptors.map((entry) => [entry.name, entry]));
  if (byName.size !== expectedNames.length || expectedNames.some((name) => !byName.has(name))) {
    throw new NarrowResourceError(
      "narrow-entry-mismatch",
      `desktop-session native build manifest ${kind} is not the expected entry set`,
      { actual: [...byName.keys()], expected: expectedNames },
    );
  }
  for (const name of expectedNames) {
    const descriptor = byName.get(name);
    if (descriptor.path !== `Contents/Resources/${name}`) {
      throw new NarrowResourceError(
        "narrow-entry-mismatch",
        `${kind} ${name} is not at its fixed resource path`,
      );
    }
    const absolutePath = join(appPath, descriptor.path);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new NarrowResourceError(
        "narrow-entry-mismatch",
        `${kind} ${name} is missing from the signed Helper`,
      );
    }
    const bytes = await readFile(absolutePath);
    if (descriptor.sha256 !== sha256Bytes(bytes) || descriptor.bytes !== bytes.length) {
      throw new NarrowResourceError(
        "narrow-entry-mismatch",
        `${kind} ${name} does not match the native build manifest`,
      );
    }
  }
}

export async function validateNativeBuildManifest({
  appPath,
  nativeBuildManifestPath,
  pins,
  deps = {},
}) {
  const read = deps.readFile ?? readFile;
  const bytes = await read(nativeBuildManifestPath);
  let nativeManifest;
  try {
    nativeManifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NarrowResourceError(
      "narrow-native-manifest-mismatch",
      `desktop-session native build manifest is not valid JSON: ${nativeBuildManifestPath}`,
    );
  }
  if (
    nativeManifest.kind !== NARROW_NATIVE_MANIFEST_KIND ||
    nativeManifest.status !== "pass" ||
    nativeManifest.app?.name !== NARROW_APP_NAME ||
    nativeManifest.app?.path !== `helper/${NARROW_APP_NAME}` ||
    nativeManifest.app?.bundleIdentifier !== PINNED_HELPER_IDENTIFIER
  ) {
    throw new NarrowResourceError(
      "narrow-native-manifest-mismatch",
      "native build manifest is not the verified desktop-session Helper",
    );
  }
  assertPinValues(nativeManifest.identityPins?.values, pins);
  await assertExpectedResources({
    appPath,
    descriptors: nativeManifest.entries,
    expectedNames: NARROW_ENTRY_NAMES,
    kind: "entries",
  });
  await assertExpectedResources({
    appPath,
    descriptors: nativeManifest.auxiliaryResources,
    expectedNames: NARROW_AUXILIARY_NAMES,
    kind: "auxiliaryResources",
  });

  const nodePath = join(appPath, NARROW_NODE_RELATIVE_PATH);
  const nodeSha256 = await sha256File(nodePath);
  if (nativeManifest.node?.sha256 !== nodeSha256) {
    throw new NarrowResourceError(
      "narrow-entry-mismatch",
      "cua-narrow Helper Node does not match the native build manifest",
      { actual: nodeSha256, expected: nativeManifest.node?.sha256 },
    );
  }
  if (
    nativeManifest.artifact?.path !==
      `helper/${NARROW_APP_NAME}/${NARROW_EXECUTABLE_RELATIVE_PATH}` ||
    typeof nativeManifest.artifact?.sha256 !== "string"
  ) {
    throw new NarrowResourceError(
      "narrow-native-manifest-mismatch",
      "native build manifest artifact path is not the fixed desktop-session executable",
    );
  }
  return {
    path: nativeBuildManifestPath,
    sha256: sha256Bytes(bytes),
    kind: nativeManifest.kind,
    status: nativeManifest.status,
    nativeUnsignedBinarySha256: nativeManifest.artifact.sha256,
    nodeSha256,
    entries: nativeManifest.entries,
    auxiliaryResources: nativeManifest.auxiliaryResources,
  };
}
