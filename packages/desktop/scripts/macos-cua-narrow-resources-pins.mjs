// 固定 identity pins 的读取与受控文件检查。pins 只提供来源证据，
// 实际信任根始终是模块内的固定证书 leaf / DR 常量。
import { lstat, readFile } from "node:fs/promises";

import {
  PINNED_DESIGNATED_REQUIREMENT,
  PINNED_HELPER_IDENTIFIER,
  PINNED_LEAF_SHA1,
  PINNED_LEAF_SHA256,
  PINNED_NODE_CDHASH,
  PINNED_NODE_DESIGNATED_REQUIREMENT,
  PINNED_NODE_IDENTIFIER,
} from "./macos-cua-narrow-resources-constants.mjs";
import { NarrowResourceError, sha256Bytes } from "./macos-cua-narrow-resources-base.mjs";

function assertFixedPin(actual, expected, field) {
  if (actual !== expected) {
    throw new NarrowResourceError(
      "narrow-pins-mismatch",
      `identity pins ${field} does not match the fixed local-self-signed pin`,
      { field, actual, expected },
    );
  }
}

export async function loadIdentityPins({ path, deps = {} }) {
  const read = deps.readFile ?? readFile;
  const bytes = await read(path);
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NarrowResourceError("narrow-pins-mismatch", `identity pins are not valid JSON: ${path}`);
  }
  assertFixedPin(raw.leafSha256, PINNED_LEAF_SHA256, "leafSha256");
  assertFixedPin(raw.nodeLeafSha256, PINNED_LEAF_SHA256, "nodeLeafSha256");
  assertFixedPin(raw.designatedRequirement, PINNED_DESIGNATED_REQUIREMENT, "designatedRequirement");
  assertFixedPin(
    raw.nodeDesignatedRequirement,
    PINNED_NODE_DESIGNATED_REQUIREMENT,
    "nodeDesignatedRequirement",
  );
  assertFixedPin(raw.nodeIdentifier, PINNED_NODE_IDENTIFIER, "nodeIdentifier");
  assertFixedPin(raw.nodeCdhash, PINNED_NODE_CDHASH, "nodeCdhash");
  return {
    path,
    sha256: sha256Bytes(bytes),
    helperIdentifier: PINNED_HELPER_IDENTIFIER,
    leafSha256: PINNED_LEAF_SHA256,
    leafSha1: PINNED_LEAF_SHA1,
    designatedRequirement: PINNED_DESIGNATED_REQUIREMENT,
    nodeIdentifier: PINNED_NODE_IDENTIFIER,
    nodeLeafSha256: PINNED_LEAF_SHA256,
    nodeLeafSha1: PINNED_LEAF_SHA1,
    nodeDesignatedRequirement: PINNED_NODE_DESIGNATED_REQUIREMENT,
    nodeCdhash: PINNED_NODE_CDHASH,
  };
}

export async function assertControlledFile(path, label, deps = {}) {
  const info = await (deps.lstat ?? lstat)(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new NarrowResourceError(
      "narrow-non-regular",
      `${label} must be a regular file: ${path}`,
    );
  }
  if (info.nlink > 1) {
    throw new NarrowResourceError(
      "narrow-hardlink",
      `${label} may not be a hardlink: ${path}`,
    );
  }
}
