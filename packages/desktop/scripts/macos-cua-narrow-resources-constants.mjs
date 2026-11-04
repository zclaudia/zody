// 窄 CUA 资源装配的固定常量。只描述本轮 desktop-session Helper 资源槽位，
// 不包含任何 runtime 激活、Host 路由或签名信任逻辑。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const NARROW_MANIFEST_ENV = "ZODY_CUA_NARROW_MANIFEST";
export const CANDIDATE_HOST_LAUNCH_ENV = "ZODY_CANDIDATE_NATIVE_HOST_LAUNCH_JSON";
export const NARROW_SLOT = "cua-narrow";
export const NARROW_APP_NAME = "Zody CUA Desktop Session.app";
export const NARROW_EXECUTABLE_NAME = "macos-cua-desktop-session";
export const NARROW_EXECUTABLE_RELATIVE_PATH = `Contents/MacOS/${NARROW_EXECUTABLE_NAME}`;
export const NARROW_NODE_RELATIVE_PATH = "Contents/Resources/node";
export const NARROW_NATIVE_MANIFEST_KIND = "zody-cua-desktop-session-native-candidate";
export const NARROW_MANIFEST_KIND = "zody-cua-narrow-resource-manifest";
export const NARROW_ENTRY_NAMES = Object.freeze([
  "host-entry.mjs",
  "cli-entry.mjs",
  "session-entry.mjs",
]);
export const NARROW_AUXILIARY_NAMES = Object.freeze(["node-repl-server.mjs"]);
export const NARROW_TARGET = Object.freeze({
  os: "darwin",
  arch: "arm64",
  minimumMacOSVersion: "14.2",
});

// 唯一信任根：固定 local-self-signed 证书 leaf 与对应 designated requirement。
export const PINNED_HELPER_IDENTIFIER = "io.github.zclaudia.zody.cua-helper";
export const PINNED_NODE_IDENTIFIER = "io.github.zclaudia.zody.cua-helper.node";
export const PINNED_LEAF_SHA256 =
  "a7f7afa6a507b71c996f4a9bfbf6eef908d67054acdca93833bcd4c94c13ef0b";
export const PINNED_LEAF_SHA1 = "d2ad8f4bb39ad7dd13ceba3892cadb16659a4732";
export const PINNED_DESIGNATED_REQUIREMENT =
  'identifier "io.github.zclaudia.zody.cua-helper" and certificate leaf = H"d2ad8f4bb39ad7dd13ceba3892cadb16659a4732"';
export const PINNED_NODE_DESIGNATED_REQUIREMENT =
  'identifier "io.github.zclaudia.zody.cua-helper.node" and certificate leaf = H"d2ad8f4bb39ad7dd13ceba3892cadb16659a4732"';
export const PINNED_NODE_CDHASH = "3c57a9bb9f4e8b748ac80d60bc78cdde14767218";
export const DEFAULT_IDENTITY_PINS_PATH = join(
  REPO_ROOT,
  "output",
  "cua-helper-round11",
  "controller-signed",
  "identity-pins.json",
);
export const DEFAULT_OUTPUT_ROOT = join(
  REPO_ROOT,
  "output",
  "cua-phase1-closeout",
  "a-worker",
  "narrow-resources",
);
