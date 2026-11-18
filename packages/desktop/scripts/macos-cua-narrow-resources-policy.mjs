// 窄 CUA 资源的身份对照策略：manifest/pins 只能描述固定身份，不能自报新身份。
import {
  NARROW_EXECUTABLE_RELATIVE_PATH,
  NARROW_NODE_RELATIVE_PATH,
  NARROW_TARGET,
  PINNED_HELPER_IDENTIFIER,
  PINNED_LEAF_SHA1,
} from "./macos-cua-narrow-resources-constants.mjs";
import { NarrowResourceError } from "./macos-cua-narrow-resources-base.mjs";

function assertIdentityField(actual, expected, field) {
  if (expected !== undefined && actual !== expected) {
    throw new NarrowResourceError(
      "narrow-identity-mismatch",
      `cua-narrow identity ${field} mismatch`,
      { actual, expected },
    );
  }
}

export function expectedIdentityFromPins(pins) {
  return {
    ...(pins.identityProfile === "developer-id"
      ? { identityProfile: pins.identityProfile, teamIdentifier: pins.teamIdentifier }
      : {}),
    helperIdentifier: PINNED_HELPER_IDENTIFIER,
    nodeIdentifier: pins.nodeIdentifier,
    leafSha256: pins.leafSha256,
    leafSha1: pins.leafSha1 ?? PINNED_LEAF_SHA1,
    nodeLeafSha256: pins.nodeLeafSha256,
    nodeLeafSha1: pins.nodeLeafSha1 ?? PINNED_LEAF_SHA1,
    designatedRequirement: pins.designatedRequirement,
    nodeDesignatedRequirement: pins.nodeDesignatedRequirement,
    nodeCdhash: pins.nodeCdhash,
    hardenedRuntime: true,
    entitlementsEmpty: true,
    executableRelativePath: NARROW_EXECUTABLE_RELATIVE_PATH,
    nodeRelativePath: NARROW_NODE_RELATIVE_PATH,
    minimumMacOSVersion: NARROW_TARGET.minimumMacOSVersion,
  };
}

export function assertIdentityAgainstPins(identity, pins) {
  const expected = expectedIdentityFromPins(pins);
  for (const [field, value] of Object.entries(expected)) {
    assertIdentityField(identity[field], value, field);
  }
  if (!Array.isArray(identity.architectures) || !identity.architectures.includes("arm64")) {
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      "cua-narrow Helper architecture is not arm64",
    );
  }
}

export function assertIdentityMatches(actual, expected) {
  for (const field of [
    "identityProfile",
    "teamIdentifier",
    "helperIdentifier",
    "nodeIdentifier",
    "leafSha256",
    "leafSha1",
    "nodeLeafSha256",
    "nodeLeafSha1",
    "designatedRequirement",
    "nodeDesignatedRequirement",
    "nodeCdhash",
    "hardenedRuntime",
    "entitlementsEmpty",
    "executableRelativePath",
    "nodeRelativePath",
    "minimumMacOSVersion",
    "signedBinarySha256",
    "nativeUnsignedBinarySha256",
  ]) {
    assertIdentityField(actual[field], expected[field], field);
  }
}
