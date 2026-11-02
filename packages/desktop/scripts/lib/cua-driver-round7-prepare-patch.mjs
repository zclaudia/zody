import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  copyTreeSafe,
  gitClosureEnvironment,
  runClosureCommand,
} from "./cua-driver-closure-command.mjs";
import {
  computeTreeSha256,
  failure,
  isSafeRelativePath,
  isSha256,
  scanTree,
  sha256File,
} from "./cua-driver-round7-prepare-source.mjs";
function patchPath(value) {
  if (value === "/dev/null") return null;
  if (!value.startsWith("a/") && !value.startsWith("b/")) {
    failure(`patch path lacks an a/ or b/ prefix: ${value}`);
  }
  const path = value.slice(2);
  if (!isSafeRelativePath(path)) failure(`unsafe path in candidate patch: ${value}`);
  return path;
}

export function assertPatchPaths(patchText) {
  if (typeof patchText !== "string" || patchText.trim() === "") {
    failure("candidate patch is empty");
  }
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("deleted file mode"))
      failure("candidate patch may not contain a file deletion");
    if (line.startsWith("new file mode 120000") || line.startsWith("old mode 120000")) {
      failure("candidate patch may not create or modify symlinks");
    }
    if (/^(rename|copy) (from|to) /.test(line)) {
      failure("candidate patch may not rename or copy files");
    }
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (a\/\S+) (b\/\S+)$/.exec(line);
      if (!match) failure(`unsupported diff header: ${line}`);
      const left = patchPath(match[1]);
      const right = patchPath(match[2]);
      if (left !== right) failure(`patch sides disagree: ${left} !== ${right}`);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      patchPath(line.slice(4).split("\t", 1)[0]);
    }
  }
  return true;
}

export async function verifyPatchIdentity({ patchPath, sha256, bytes }) {
  const metadata = await lstat(patchPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    failure("candidate patch must be a regular non-symlink file");
  }
  if (!isSha256(sha256)) failure("candidate patch SHA-256 is not pinned");
  const actualSha256 = await sha256File(patchPath);
  if (actualSha256 !== sha256) failure("candidate patch hash mismatch");
  if (bytes !== undefined && bytes !== metadata.size) {
    failure("candidate patch byte count mismatch");
  }
  assertPatchPaths(await readFile(patchPath, "utf8"));
  return { path: patchPath, sha256: actualSha256, bytes: metadata.size };
}

export async function applyCandidatePatch({ baseRoot, patchPath, stagingRoot, expected }) {
  const metadata = await lstat(stagingRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (metadata) failure(`patch staging path already exists: ${stagingRoot}`);
  await copyTreeSafe(baseRoot, stagingRoot);
  const environment = {
    ...gitClosureEnvironment(),
    GIT_CEILING_DIRECTORIES: dirname(resolve(stagingRoot)),
  };
  const absolutePatchPath = resolve(patchPath);
  await runClosureCommand("git", ["apply", "--check", "--whitespace=nowarn", absolutePatchPath], {
    cwd: stagingRoot,
    env: environment,
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
  });
  await runClosureCommand("git", ["apply", "--whitespace=nowarn", absolutePatchPath], {
    cwd: stagingRoot,
    env: environment,
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
  });
  const scanned = await scanTree(stagingRoot);
  if (expected) {
    const byPath = new Map(expected.map((entry) => [entry.path, entry]));
    if (byPath.size !== scanned.files.length) failure("patched tree file count mismatch");
    for (const file of scanned.files) {
      const entry = byPath.get(file.path);
      if (!entry) failure(`patched tree added an undeclared file: ${file.path}`);
      if (file.sha256 !== entry.candidateSha256) {
        failure(`patched tree hash mismatch: ${file.path}`);
      }
    }
  }
  return { files: scanned.files, treeSha256: computeTreeSha256(scanned.files) };
}
