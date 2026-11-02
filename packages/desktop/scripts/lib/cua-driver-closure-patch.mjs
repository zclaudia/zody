import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  ClosureVerificationError,
  sha256Buffer,
  sha256File,
  walkRegularFiles,
  writeBufferFile,
} from "./cua-driver-closure-core.mjs";
import {
  copyTreeSafe,
  gitClosureEnvironment,
  runClosureCommand,
} from "./cua-driver-closure-command.mjs";

function normalizePatch(raw, baselineRoot, candidateRoot) {
  const baselinePrefix = `${baselineRoot}/`;
  const candidatePrefix = `${candidateRoot}/`;
  return raw
    .replaceAll(baselinePrefix, "a/")
    .replaceAll(candidatePrefix, "b/")
    .replaceAll(`a${baselineRoot}/`, "a/")
    .replaceAll(`b${candidateRoot}/`, "b/");
}

export async function createSourcePatch({ baselineRoot, candidateRoot, patchPath, workRoot }) {
  const baseline = await realpath(baselineRoot);
  const candidate = await realpath(candidateRoot);
  const workRootReal = await realpath(workRoot);
  const baselineRelative = relative(workRootReal, baseline);
  const candidateRelative = relative(workRootReal, candidate);
  if (
    isAbsolute(baselineRelative) ||
    isAbsolute(candidateRelative) ||
    baselineRelative.startsWith("..") ||
    candidateRelative.startsWith("..")
  ) {
    throw new ClosureVerificationError("patch source roots must be inside the isolated work root");
  }
  const result = await runClosureCommand(
    "git",
    [
      "diff",
      "--no-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--no-prefix",
      "--",
      baselineRelative,
      candidateRelative,
    ],
    {
      cwd: workRootReal,
      env: gitClosureEnvironment(),
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024 * 1024,
      allowFailure: true,
    },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new ClosureVerificationError("could not generate the candidate source patch");
  }
  const normalized = normalizePatch(result.stdout, baseline, candidate)
    .replaceAll(`${baselineRelative}/`, "a/")
    .replaceAll(`${candidateRelative}/`, "b/");
  if (normalized.includes(baseline) || normalized.includes(candidate)) {
    throw new ClosureVerificationError("source patch leaked an audit temporary path");
  }
  const bytes = Buffer.from(normalized, "utf8");
  await writeBufferFile(patchPath, bytes);
  return {
    path: patchPath,
    sha256: sha256Buffer(bytes),
    bytes: bytes.byteLength,
    empty: bytes.length === 0,
  };
}

export async function reconstructCandidateFromPatch({
  baselineRoot,
  patchPath,
  outputRoot,
  workRoot,
}) {
  await copyTreeSafe(baselineRoot, outputRoot);
  await runClosureCommand("git", ["apply", "--whitespace=nowarn", patchPath], {
    cwd: outputRoot,
    env: gitClosureEnvironment(),
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
  });
  const { files } = await walkRegularFiles(outputRoot);
  const hashes = new Map();
  for (const path of files) hashes.set(path, await sha256File(join(outputRoot, path)));
  return { root: outputRoot, workRoot, hashes };
}

export async function assertReconstructedTree({ reconstructed, expectedEntries }) {
  const actualPaths = [...reconstructed.hashes.keys()].sort();
  const expectedPaths = [...expectedEntries.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const extra = actualPaths.find((path) => !expectedEntries.has(path));
    const missing = expectedPaths.find((path) => !reconstructed.hashes.has(path));
    throw new ClosureVerificationError(
      extra
        ? `patch reconstruction added unknown file: ${extra}`
        : `patch reconstruction missed file: ${missing}`,
    );
  }
  for (const path of expectedPaths) {
    const expected = expectedEntries.get(path);
    if (reconstructed.hashes.get(path) !== (expected.sha256 ?? expected.candidateSha256)) {
      throw new ClosureVerificationError(`patch reconstruction hash mismatch: ${path}`);
    }
  }
  return { status: "pass", files: expectedPaths.length };
}

export async function readPatchText(path) {
  return await readFile(path, "utf8");
}
