import { createHash } from "node:crypto";
import { supportedDistributionTargets } from "./targets.mjs";

const requiredDesktop = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];

export function assessReleaseAssets(names, version) {
  const failures = [];
  const has = (name) => names.includes(name);
  for (const target of supportedDistributionTargets) {
    const archive = `zody-cli-${version}-${target}.tar.gz`;
    if (!has(archive)) failures.push(`missing CLI archive for ${target}`);
    if (!has(`${archive}.sha256`)) failures.push(`missing CLI checksum for ${target}`);
  }
  for (const target of requiredDesktop) {
    if (!names.some((name) => name.startsWith(`zody-desktop-${version}-${target}.`))) {
      failures.push(`missing Desktop installer for ${target}`);
    }
  }
  for (const name of [
    "zody-android-" + version + ".apk",
    "SHA256SUMS.txt",
    "THIRD-PARTY-NOTICES.md",
    "RELEASE_NOTES.md",
  ]) {
    if (!has(name)) failures.push(`missing ${name}`);
  }
  const allowed = new Set([
    "SHA256SUMS.txt",
    "THIRD-PARTY-NOTICES.md",
    "RELEASE_NOTES.md",
    `zody-android-${version}.apk`,
    ...supportedDistributionTargets.flatMap((target) => {
      const archive = `zody-cli-${version}-${target}.tar.gz`;
      return [archive, `${archive}.sha256`];
    }),
    ...requiredDesktop.flatMap((target) => {
      const extensions = target.startsWith("darwin-")
        ? ["dmg", "zip"]
        : target === "win32-x64"
          ? ["exe"]
          : ["AppImage", "deb", "rpm", "pkg.tar.zst"];
      return extensions.map((extension) => `zody-desktop-${version}-${target}.${extension}`);
    }),
  ]);
  for (const name of names)
    if (!allowed.has(name)) failures.push(`unexpected release file ${name}`);
  return failures;
}

export function decideExistingAsset({ draft, existingDigest, incomingDigest }) {
  if (!draft) throw new Error("Release is already published; refusing to replace its assets");
  if (existingDigest === incomingDigest) return "skip";
  throw new Error(`Draft asset differs from retry input; refusing to replace ${existingDigest}`);
}

export function rejectUnexpectedExistingAssets(existingNames, incomingNames) {
  const incoming = new Set(incomingNames);
  const unexpected = existingNames.filter((name) => !incoming.has(name));
  if (unexpected.length) {
    throw new Error(
      `Draft contains stale assets absent from this candidate: ${unexpected.join(", ")}`,
    );
  }
}

export function verifyCliArchiveChecksum(name, bytes, sidecar) {
  const [expected, referencedName] = sidecar.trim().split(/\s+/u);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(expected) || expected !== actual || referencedName !== name) {
    throw new Error(`CLI archive checksum mismatch: ${name}`);
  }
  return actual;
}
