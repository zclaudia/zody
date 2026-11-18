// 发布身份只从仓库固定的信任根读取，pins 文件不能自行声明可信身份。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NarrowResourceError } from "./macos-cua-narrow-resources-base.mjs";
import {
  REPO_ROOT,
  PINNED_HELPER_IDENTIFIER,
  PINNED_NODE_IDENTIFIER,
  PINNED_LEAF_SHA256,
  PINNED_LEAF_SHA1,
  PINNED_DESIGNATED_REQUIREMENT,
  PINNED_NODE_DESIGNATED_REQUIREMENT,
  PINNED_NODE_CDHASH,
} from "./macos-cua-narrow-resources-constants.mjs";

export function developerIdRequirement(identifier, teamIdentifier) {
  return `identifier "${identifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${teamIdentifier}"`;
}

export function resolveIdentityProfileName(value = "local-self-signed") {
  if (value !== "local-self-signed" && value !== "developer-id") {
    throw new NarrowResourceError("narrow-identity-profile", `unknown identity profile: ${value}`);
  }
  return value;
}

export async function loadIdentityProfile({
  identityProfile = "local-self-signed",
  deps = {},
} = {}) {
  identityProfile = resolveIdentityProfileName(identityProfile);
  if (identityProfile === "local-self-signed")
    return {
      identityProfile,
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
  let policy;
  try {
    policy = JSON.parse(
      await (deps.readFile ?? readFile)(
        join(REPO_ROOT, "packages/desktop/build/cua-narrow-developer-id.json"),
        "utf8",
      ),
    );
  } catch {
    throw new NarrowResourceError("narrow-pins-mismatch", "Developer ID trust root cannot be read");
  }
  const valid =
    policy &&
    policy.schemaVersion === 1 &&
    policy.kind === "zody-cua-developer-id-trust" &&
    policy.status === "configured" &&
    // 发布标识不能经 RegExp 隐式转换类型，否则十位数字也会被当作 Team 字符串。
    typeof policy.teamIdentifier === "string" &&
    typeof policy.leafSha256 === "string" &&
    typeof policy.leafSha1 === "string" &&
    typeof policy.nodeCdhash === "string" &&
    /^[A-Z0-9]{10}$/.test(policy.teamIdentifier) &&
    /^[a-f0-9]{64}$/.test(policy.leafSha256) &&
    /^[a-f0-9]{40}$/.test(policy.leafSha1) &&
    /^[a-f0-9]{40}$/.test(policy.nodeCdhash) &&
    Object.keys(policy).every((key) =>
      [
        "schemaVersion",
        "kind",
        "status",
        "teamIdentifier",
        "leafSha256",
        "leafSha1",
        "nodeCdhash",
      ].includes(key),
    );
  if (!valid)
    throw new NarrowResourceError(
      "narrow-pins-mismatch",
      "Developer ID trust root is unconfigured or invalid",
    );
  return {
    identityProfile,
    teamIdentifier: policy.teamIdentifier,
    helperIdentifier: PINNED_HELPER_IDENTIFIER,
    leafSha256: policy.leafSha256,
    leafSha1: policy.leafSha1,
    designatedRequirement: developerIdRequirement(PINNED_HELPER_IDENTIFIER, policy.teamIdentifier),
    nodeIdentifier: PINNED_NODE_IDENTIFIER,
    nodeLeafSha256: policy.leafSha256,
    nodeLeafSha1: policy.leafSha1,
    nodeDesignatedRequirement: developerIdRequirement(
      PINNED_NODE_IDENTIFIER,
      policy.teamIdentifier,
    ),
    nodeCdhash: policy.nodeCdhash,
  };
}
