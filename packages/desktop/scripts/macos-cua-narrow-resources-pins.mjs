// 固定 identity pins 的读取与受控文件检查。pins 只提供来源证据，
// local 使用固定常量，Developer ID 使用仓库受控策略；两者均不信任资源自报身份。
import { lstat, readFile } from "node:fs/promises";

import { loadIdentityProfile } from "./macos-cua-narrow-identity-profile.mjs";
import { NarrowResourceError, sha256Bytes } from "./macos-cua-narrow-resources-base.mjs";

function assertFixedPin(actual, expected, field) {
  if (actual !== expected) {
    throw new NarrowResourceError(
      "narrow-pins-mismatch",
      `identity pins ${field} does not match the selected trusted profile`,
      { field, actual, expected },
    );
  }
}

export async function loadIdentityPins({ path, identityProfile = "local-self-signed", deps = {} }) {
  const read = deps.readFile ?? readFile;
  const bytes = await read(path);
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NarrowResourceError(
      "narrow-pins-mismatch",
      `identity pins are not valid JSON: ${path}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new NarrowResourceError("narrow-pins-mismatch", "identity pins must be a JSON object");
  const expected = await loadIdentityProfile({ identityProfile, deps });
  for (const [field, value] of Object.entries(expected)) {
    // 旧 local pins 未保存这些派生字段；若提供则仍须匹配。
    if (
      identityProfile === "local-self-signed" &&
      raw[field] === undefined &&
      ["identityProfile", "helperIdentifier", "leafSha1", "nodeLeafSha1"].includes(field)
    )
      continue;
    assertFixedPin(raw[field], value, field);
  }
  return { ...expected, path, sha256: sha256Bytes(bytes) };
}

export async function assertControlledFile(path, label, deps = {}) {
  const info = await (deps.lstat ?? lstat)(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new NarrowResourceError("narrow-non-regular", `${label} must be a regular file: ${path}`);
  }
  if (info.nlink > 1) {
    throw new NarrowResourceError("narrow-hardlink", `${label} may not be a hardlink: ${path}`);
  }
}
