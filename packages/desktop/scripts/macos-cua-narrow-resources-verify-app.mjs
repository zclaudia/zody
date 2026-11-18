// 对 signed desktop-session Helper.app 做完整身份与资源入口检查。
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  NARROW_APP_NAME,
  NARROW_LEGACY_AUXILIARY_NAMES,
  NARROW_SDK_NAMES,
  NARROW_ENTRY_NAMES,
  NARROW_EXECUTABLE_NAME,
  NARROW_EXECUTABLE_RELATIVE_PATH,
  NARROW_NODE_RELATIVE_PATH,
  NARROW_TARGET,
  PINNED_HELPER_IDENTIFIER,
} from "./macos-cua-narrow-resources-constants.mjs";
import { NarrowResourceError, sha256File } from "./macos-cua-narrow-resources-base.mjs";
import {
  readInfoPlist,
  verifyCodeIdentity,
  verifyMachO,
} from "./macos-cua-narrow-resources-identity.mjs";

export async function verifyNarrowApp({ appPath, pins, deps = {} }) {
  if (appPath.split(/[\\/]/).at(-1) !== NARROW_APP_NAME) {
    throw new NarrowResourceError(
      "narrow-helper-mismatch",
      `cua-narrow only accepts ${NARROW_APP_NAME}, got ${appPath}`,
    );
  }
  const info = await readInfoPlist(appPath, deps);
  if (
    info.CFBundleIdentifier !== PINNED_HELPER_IDENTIFIER ||
    info.CFBundleExecutable !== NARROW_EXECUTABLE_NAME ||
    info.LSMinimumSystemVersion !== NARROW_TARGET.minimumMacOSVersion
  ) {
    throw new NarrowResourceError(
      "narrow-helper-mismatch",
      "cua-narrow Helper Info.plist is not the fixed desktop-session assembly",
      {
        bundleIdentifier: info.CFBundleIdentifier,
        executable: info.CFBundleExecutable,
        minimumMacOSVersion: info.LSMinimumSystemVersion,
      },
    );
  }

  const executablePath = join(appPath, NARROW_EXECUTABLE_RELATIVE_PATH);
  const nodePath = join(appPath, NARROW_NODE_RELATIVE_PATH);
  const helper = await verifyCodeIdentity({
    path: executablePath,
    label: "cua-narrow Helper executable",
    expectedIdentifier: PINNED_HELPER_IDENTIFIER,
    expectedDesignatedRequirement: pins.designatedRequirement,
    expectedLeafSha256: pins.leafSha256,
    expectedLeafSha1: pins.leafSha1,
    expectedIdentityProfile: pins.identityProfile,
    expectedTeamIdentifier: pins.teamIdentifier,
    deps,
  });
  const node = await verifyCodeIdentity({
    path: nodePath,
    label: "cua-narrow Helper Node",
    expectedIdentifier: pins.nodeIdentifier,
    expectedDesignatedRequirement: pins.nodeDesignatedRequirement,
    expectedLeafSha256: pins.nodeLeafSha256,
    expectedLeafSha1: pins.nodeLeafSha1,
    expectedCdhash: pins.nodeCdhash,
    expectedIdentityProfile: pins.identityProfile,
    expectedTeamIdentifier: pins.teamIdentifier,
    deps,
  });
  const helperMachO = await verifyMachO(executablePath, {
    label: "cua-narrow Helper executable",
    requireMinimumMacOS: true,
    deps,
  });
  // Node 的真实 minOS 是 13.5/sdk15；这里只要求 arm64，不误套 Helper 的 14.2。
  const nodeMachO = await verifyMachO(nodePath, {
    label: "cua-narrow Helper Node",
    requireMinimumMacOS: false,
    deps,
  });

  const resources = {};
  // 签名校验先接受旧包或完整 SDK 对；清单与摘要由随后 native audit 精确验证。
  const sdkPresent = await Promise.all(
    NARROW_SDK_NAMES.map(async (name) => {
      try {
        await (deps.lstat ?? lstat)(join(appPath, "Contents", "Resources", name));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  if (sdkPresent.some(Boolean) && !sdkPresent.every(Boolean))
    throw new NarrowResourceError(
      "narrow-entry-mismatch",
      "cua-narrow Helper SDK resource pair is incomplete",
    );
  const auxiliary = sdkPresent.every(Boolean)
    ? [...NARROW_LEGACY_AUXILIARY_NAMES, ...NARROW_SDK_NAMES]
    : NARROW_LEGACY_AUXILIARY_NAMES;
  for (const name of [...NARROW_ENTRY_NAMES, ...auxiliary]) {
    const path = join(appPath, "Contents", "Resources", name);
    const fileInfo = await (deps.lstat ?? lstat)(path);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new NarrowResourceError(
        "narrow-entry-mismatch",
        `cua-narrow Helper is missing regular entry resource ${name}`,
      );
    }
    resources[name] = {
      path: `Contents/Resources/${name}`,
      sha256: await sha256File(path),
      bytes: fileInfo.size,
    };
  }

  return {
    ...(pins.identityProfile === "developer-id"
      ? { identityProfile: pins.identityProfile, teamIdentifier: pins.teamIdentifier }
      : {}),
    helperIdentifier: helper.identifier,
    nodeIdentifier: node.identifier,
    leafSha256: helper.leafSha256,
    leafSha1: helper.leafSha1,
    nodeLeafSha256: node.leafSha256,
    nodeLeafSha1: node.leafSha1,
    designatedRequirement: helper.designatedRequirement,
    nodeDesignatedRequirement: node.designatedRequirement,
    nodeCdhash: node.cdhash,
    hardenedRuntime: helper.hardenedRuntime && node.hardenedRuntime,
    entitlementsEmpty: helper.entitlementsEmpty && node.entitlementsEmpty,
    architectures: helperMachO.architectures,
    minimumMacOSVersion: helperMachO.minos[0],
    nodeMinimumMacOSVersion: nodeMachO.minos[0],
    executableRelativePath: NARROW_EXECUTABLE_RELATIVE_PATH,
    nodeRelativePath: NARROW_NODE_RELATIVE_PATH,
    signedBinarySha256: await sha256File(executablePath),
    nodeSha256: await sha256File(nodePath),
    resources,
  };
}
