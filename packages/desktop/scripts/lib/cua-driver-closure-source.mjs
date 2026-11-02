import { join } from "node:path";
import {
  ClosureVerificationError,
  isSha256,
  sha256Buffer,
  sha256File,
  validateReviewConfig,
  validateSourceManifest,
  walkRegularFiles,
} from "./cua-driver-closure-core.mjs";
import { gitClosureEnvironment } from "./cua-driver-closure-command.mjs";

export async function scanCandidateTree(rootPath) {
  const { root, files } = await walkRegularFiles(rootPath);
  const entries = new Map();
  for (const relativePath of files) {
    entries.set(relativePath, {
      path: relativePath,
      sha256: await sha256File(join(root, relativePath)),
    });
  }
  return { root, entries };
}

function requireSameSet(actual, expected, label) {
  const actualValues = [...actual];
  const expectedValues = [...expected];
  const actualSorted = actualValues.sort();
  const expectedSorted = expectedValues.sort();
  if (JSON.stringify(actualSorted) === JSON.stringify(expectedSorted)) return;
  const actualSet = new Set(actualValues);
  const expectedSet = new Set(expectedValues);
  const missing = expectedSorted.filter((path) => !actualSet.has(path));
  const extra = actualSorted.filter((path) => !expectedSet.has(path));
  if (missing.length > 0) throw new ClosureVerificationError(`missing ${label}: ${missing[0]}`);
  throw new ClosureVerificationError(`unexpected ${label}: ${extra[0]}`);
}

export async function auditSourceFiles({ config, manifest, candidateRoot, readBlob }) {
  const reviewed = validateReviewConfig(config);
  const frozen = validateSourceManifest(manifest, reviewed);
  const candidate = await scanCandidateTree(candidateRoot);
  const expectedPaths = frozen.files.map((entry) => entry.path);
  requireSameSet(candidate.entries.keys(), expectedPaths, "candidate file");

  const results = [];
  for (const entry of frozen.files) {
    const actual = candidate.entries.get(entry.path);
    if (!actual) throw new ClosureVerificationError(`missing candidate file: ${entry.path}`);
    if (actual.sha256 !== entry.candidateSha256) {
      throw new ClosureVerificationError(`candidate hash drift: ${entry.path}`);
    }
    if (entry.status === "added") {
      results.push({ ...entry, upstreamSha256: null });
      continue;
    }
    const upstream = await readBlob(entry.path);
    if (!upstream) throw new ClosureVerificationError(`missing fixed upstream blob: ${entry.path}`);
    const upstreamSha256 = sha256Buffer(upstream);
    if (upstreamSha256 !== entry.upstreamSha256) {
      throw new ClosureVerificationError(`upstream hash drift: ${entry.path}`);
    }
    if (entry.status === "unchanged" && actual.sha256 !== entry.upstreamSha256) {
      throw new ClosureVerificationError(`unreviewed change: ${entry.path}`);
    }
    if (entry.status === "modified") {
      if (actual.sha256 === entry.upstreamSha256) {
        throw new ClosureVerificationError(
          `reviewed modification no longer differs: ${entry.path}`,
        );
      }
      if (!reviewed.allowedDelta.modified.includes(entry.path)) {
        throw new ClosureVerificationError(`unreviewed change: ${entry.path}`);
      }
    }
    results.push({ ...entry, upstreamSha256 });
  }
  for (const entry of results) {
    if (entry.status === "added" && !reviewed.allowedDelta.added.includes(entry.path)) {
      throw new ClosureVerificationError(`unreviewed addition: ${entry.path}`);
    }
    if (!isSha256(entry.candidateSha256)) {
      throw new ClosureVerificationError(`invalid candidate hash: ${entry.path}`);
    }
  }
  const counts = {
    selected: frozen.files.length - reviewed.allowedDelta.added.length,
    candidate: frozen.files.length,
    modified: results.filter((entry) => entry.status === "modified").length,
    added: results.filter((entry) => entry.status === "added").length,
    unchanged: results.filter((entry) => entry.status === "unchanged").length,
    removed: results.filter((entry) => entry.status === "removed").length,
  };
  return { status: "pass", counts, files: results, candidateRoot: candidate.root };
}

export async function loadBaselineBlobs({ manifest, readBlob }) {
  const blobs = new Map();
  for (const entry of manifest.files) {
    if (entry.status === "added") continue;
    const blob = await readBlob(entry.path);
    if (!blob) throw new ClosureVerificationError(`missing fixed upstream blob: ${entry.path}`);
    if (sha256Buffer(blob) !== entry.upstreamSha256) {
      throw new ClosureVerificationError(`upstream hash drift: ${entry.path}`);
    }
    blobs.set(entry.path, blob);
  }
  return blobs;
}

export function createGitBlobReader({ sourceRepo, revision, sourceRoot, runCommand }) {
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new ClosureVerificationError("invalid fixed revision");
  }
  const environment = gitClosureEnvironment();
  return async (relativePath) => {
    if (!relativePath || relativePath.includes("\0")) {
      throw new ClosureVerificationError("invalid source path for git blob");
    }
    const object = `${revision}:${sourceRoot}/${relativePath}`;
    const result = await runCommand("git", ["-C", sourceRepo, "cat-file", "blob", object], {
      env: environment,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024 * 1024,
      allowFailure: true,
    });
    if (result.code === 0) {
      if (!Buffer.isBuffer(result.stdoutBuffer)) {
        throw new ClosureVerificationError("git blob reader must preserve raw bytes");
      }
      return result.stdoutBuffer;
    }
    return null;
  };
}
