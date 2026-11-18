import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  assertPackagedNarrowResource,
  readLeafCertificateDer,
} from "./macos-cua-narrow-resources.mjs";
import {
  PINNED_LEAF_SHA1,
  PINNED_LEAF_SHA256,
  REPO_ROOT,
} from "./macos-cua-narrow-resources-constants.mjs";

const exec = promisify(execFile);
const failure = () =>
  new Error(
    "Private macOS signing failed; ensure the pinned signing identity is available in the selected keychain.",
  );

export function resolvePrivateMacSigning({ targetPlatform, validated, env = process.env }) {
  const setting = env.ZODY_MAC_PRIVATE_SIGN;
  if (setting !== undefined && setting !== "0" && setting !== "1")
    throw new Error("Invalid ZODY_MAC_PRIVATE_SIGN; expected 0 or 1.");
  if (setting === "0") return null;
  const eligible =
    targetPlatform?.os === "darwin" &&
    targetPlatform?.arch === "arm64" &&
    validated?.pins?.identityProfile === "local-self-signed";
  if (!eligible) {
    if (setting === "1")
      throw new Error(
        "Private macOS signing requires darwin/arm64 and validated local-self-signed CUA resources.",
      );
    return null;
  }
  const keychain = env.ZODY_MAC_PRIVATE_KEYCHAIN || undefined;
  if (keychain && !isAbsolute(keychain))
    throw new Error("ZODY_MAC_PRIVATE_KEYCHAIN must be an absolute path.");
  return {
    leafSha1: PINNED_LEAF_SHA1,
    leafSha256: PINNED_LEAF_SHA256,
    keychain,
  };
}

export async function signPrivateMacApp({
  appPath,
  bundleId,
  manifestPath,
  env = process.env,
  deps = {},
}) {
  if (
    !isAbsolute(appPath ?? "") ||
    !isAbsolute(manifestPath ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleId ?? "")
  )
    throw failure();
  const keychain = env.ZODY_MAC_PRIVATE_KEYCHAIN;
  if (keychain && !isAbsolute(keychain)) throw failure();
  const run = deps.run ?? (async (command, args) => exec(command, args));
  const verify = deps.verify ?? assertPackagedNarrowResource;
  const readLeaf =
    deps.readLeaf ??
    // reader已返回证书DER与摘要，不能将整个结果对象当成待hash的bytes。
    (async (path) => (await (deps.readLeafCertificateDer ?? readLeafCertificateDer)(path)).sha256);
  const resourcesDir = join(appPath, "Contents", "Resources");
  const frameworks = join(appPath, "Contents", "Frameworks");
  const requirement = `identifier "${bundleId}" and certificate leaf = H"${PINNED_LEAF_SHA1}"`;
  const common = [
    "--force",
    "--sign",
    PINNED_LEAF_SHA1,
    "--options",
    "runtime",
    "--timestamp=none",
    ...(keychain ? ["--keychain", keychain] : []),
  ];
  const entitlements = join(REPO_ROOT, "packages/desktop/build");
  try {
    await verify({ resourcesDir, manifestPath, env });
    const entries = await (deps.readdir ?? readdir)(frameworks, {
      withFileTypes: true,
    });
    // 修复依据：仅签已验收的 Frameworks 直接子项，不能递归重签可信 CUA 资源。
    for (const suffix of [".app", ".framework"]) {
      for (const entry of entries
        .filter((item) => item.isDirectory() && item.name.endsWith(suffix))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const extra =
          suffix === ".app"
            ? ["--entitlements", join(entitlements, "entitlements.mac.inherit.plist")]
            : [];
        await run("/usr/bin/codesign", [...common, ...extra, join(frameworks, entry.name)]);
      }
    }
    await run("/usr/bin/codesign", [
      ...common,
      "--identifier",
      bundleId,
      "--requirements",
      `=designated => ${requirement}`,
      "--entitlements",
      join(entitlements, "entitlements.mac.plist"),
      appPath,
    ]);
    await run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      `=${requirement}`,
      appPath,
    ]);
    if ((await readLeaf(appPath)) !== PINNED_LEAF_SHA256) throw failure();
    await verify({ resourcesDir, manifestPath, env });
  } catch {
    throw failure();
  }
}
