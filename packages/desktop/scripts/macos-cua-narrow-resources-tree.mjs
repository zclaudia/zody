// 窄 CUA 资源树清点：拒绝 symlink/hardlink/特殊文件，生成可复核内容摘要。
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { NARROW_NODE_RELATIVE_PATH } from "./macos-cua-narrow-resources-constants.mjs";
import { NarrowResourceError, sha256Bytes, sha256Text } from "./macos-cua-narrow-resources-base.mjs";

function licenseAssociation(relativePath) {
  if (/^Contents\/Resources\/licenses\/node-LICENSE(?:\.[^.]+)?$/.test(relativePath)) {
    return NARROW_NODE_RELATIVE_PATH;
  }
  const match = relativePath.match(/^Contents\/Resources\/licenses\/([^/]+)\//);
  return match ? `package:${match[1]}` : "bundle";
}

function canonicalEntries(entries) {
  return entries.map((entry) =>
    entry.type === "file"
      ? {
          type: entry.type,
          path: entry.path,
          sha256: entry.sha256,
          bytes: entry.bytes,
          executable: entry.executable,
        }
      : { type: entry.type, path: entry.path },
  );
}

export async function inspectNarrowTree(appPath, deps = {}) {
  const lstatFn = deps.lstat ?? lstat;
  const readFileFn = deps.readFile ?? readFile;
  const readdirFn = deps.readdir ?? readdir;
  const rootInfo = await lstatFn(appPath);
  if (!rootInfo.isDirectory()) {
    throw new NarrowResourceError(
      "narrow-non-regular",
      `cua-narrow app is not a directory: ${appPath}`,
    );
  }

  const entries = [];
  const visit = async (directory, relativeDirectory) => {
    const names = (await readdirFn(directory)).sort();
    for (const name of names) {
      const absolutePath = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const info = await lstatFn(absolutePath);
      if (info.isSymbolicLink()) {
        throw new NarrowResourceError(
          "narrow-symlink",
          `cua-narrow resources may not contain symlinks: ${relativePath}`,
        );
      }
      if (info.isDirectory()) {
        entries.push({ type: "directory", path: relativePath, mode: info.mode & 0o777 });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!info.isFile()) {
        throw new NarrowResourceError(
          "narrow-non-regular",
          `cua-narrow resources may only contain regular files and directories: ${relativePath}`,
        );
      }
      if (info.nlink > 1) {
        throw new NarrowResourceError(
          "narrow-hardlink",
          `cua-narrow resources may not contain hardlinks: ${relativePath}`,
        );
      }
      const bytes = await readFileFn(absolutePath);
      entries.push({
        type: "file",
        path: relativePath,
        sha256: sha256Bytes(bytes),
        bytes: bytes.length,
        mode: info.mode & 0o777,
        executable: Boolean(info.mode & 0o111),
      });
    }
  };
  await visit(appPath, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const files = entries.filter((entry) => entry.type === "file");
  const licenses = files
    .filter((entry) => entry.path.startsWith("Contents/Resources/licenses/"))
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
      associatedResource: licenseAssociation(entry.path),
    }));
  return {
    appPath,
    treeSha256: sha256Text(JSON.stringify(canonicalEntries(entries))),
    entries,
    files,
    licenses,
  };
}

function compareTreeEntries(actualEntries, expectedEntries, label) {
  if (!Array.isArray(expectedEntries)) {
    throw new NarrowResourceError(
      "narrow-content-mismatch",
      `${label} entries are missing from the cua-narrow manifest`,
    );
  }
  const actual = JSON.stringify(canonicalEntries(actualEntries));
  const expected = JSON.stringify(canonicalEntries(expectedEntries));
  if (actual !== expected) {
    throw new NarrowResourceError(
      "narrow-content-mismatch",
      `${label} content does not match the cua-narrow manifest`,
    );
  }
}

export function assertTreeMatches(actualTree, expectedTree, label = "cua-narrow app") {
  if (!expectedTree || typeof expectedTree !== "object") {
    throw new NarrowResourceError("narrow-content-mismatch", `${label} tree is missing`);
  }
  if (actualTree.treeSha256 !== expectedTree.treeSha256) {
    throw new NarrowResourceError(
      "narrow-content-mismatch",
      `${label} tree digest mismatch`,
      { actual: actualTree.treeSha256, expected: expectedTree.treeSha256 },
    );
  }
  compareTreeEntries(actualTree.entries, expectedTree.entries, label);
}
