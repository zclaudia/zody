import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  gitClosureEnvironment,
  runClosureCommand,
} from "../../scripts/lib/cua-driver-closure-command.mjs";
import {
  buildCandidateManifest,
  computeTreeSha256,
  scanTree,
} from "../../scripts/lib/cua-driver-round7-prepare-source.mjs";
import {
  PROBE_ROOT,
  REVISION,
  SOURCE_ROOT,
  VISUAL_ROOT,
  createBaseFiles,
  createCandidateFiles,
} from "./cua-driver-round9-prepare-tree-fixtures.mjs";

export { PROBE_ROOT, REVISION, SOURCE_ROOT, VISUAL_ROOT };

export function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeTree(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function baseManifestEntry(file) {
  if (file.path === "crates/platform-macos/Cargo.toml") {
    return {
      path: file.path,
      status: "modified",
      upstreamSha256: sha("round 8 upstream platform"),
      candidateSha256: file.sha256,
    };
  }
  if (
    file.path === "Cargo.toml" ||
    file.path === "Cargo.lock" ||
    file.path.startsWith(`${VISUAL_ROOT}/`)
  ) {
    return { path: file.path, status: "added", candidateSha256: file.sha256 };
  }
  return {
    path: file.path,
    status: "unchanged",
    upstreamSha256: file.sha256,
    candidateSha256: file.sha256,
  };
}

async function createBaseManifest(base) {
  const scanned = await scanTree(base);
  const files = scanned.files.map(baseManifestEntry);
  return {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-source-manifest",
    revision: REVISION,
    sourceRoot: SOURCE_ROOT,
    treeSha256: computeTreeSha256(files),
    files,
  };
}

function deltaBetween(baseManifest, candidateManifest) {
  const base = new Map(baseManifest.files.map((entry) => [entry.path, entry]));
  const candidate = new Map(candidateManifest.files.map((entry) => [entry.path, entry]));
  const modified = [];
  const added = [];
  const removed = [];
  for (const [path, entry] of base) {
    const next = candidate.get(path);
    if (!next) removed.push(path);
    else if (next.candidateSha256 !== entry.candidateSha256) modified.push(path);
  }
  for (const path of candidate.keys()) if (!base.has(path)) added.push(path);
  return {
    modified: modified.sort((left, right) => left.localeCompare(right)),
    added: added.sort((left, right) => left.localeCompare(right)),
    removed: removed.sort((left, right) => left.localeCompare(right)),
  };
}

function normalizePatchPaths(text) {
  return text
    .replace(/^diff --git a\/base\//gm, "diff --git a/")
    .replace(/^diff --git a\/expected\//gm, "diff --git a/")
    .replace(/^diff --git (a\/\S+) b\/expected\//gm, "diff --git $1 b/")
    .replace(/^diff --git (a\/\S+) b\/base\//gm, "diff --git $1 b/")
    .replace(/^--- a\/base\//gm, "--- a/")
    .replace(/^--- a\/expected\//gm, "--- a/")
    .replace(/^\+\+\+ b\/expected\//gm, "+++ b/")
    .replace(/^\+\+\+ b\/base\//gm, "+++ b/");
}

async function createRealPatch({ root }) {
  const result = await runClosureCommand(
    "git",
    ["diff", "--no-index", "--no-color", "--no-ext-diff", "--text", "--", "base", "expected"],
    {
      cwd: root,
      env: gitClosureEnvironment(),
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
      allowFailure: true,
    },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`fixture git diff failed with ${result.code}: ${result.stderr}`);
  }
  const text = normalizePatchPaths(result.stdout);
  if (text.includes("a/base/") || text.includes("b/expected/")) {
    throw new Error("fixture patch path normalization failed");
  }
  return text;
}

export async function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return { text, sha256: sha(text) };
}

export async function snapshotTree(root) {
  const scanned = await scanTree(root);
  return Object.fromEntries(scanned.files.map((file) => [file.path, file.sha256]));
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeReviewArtifacts(value) {
  const baseManifestWrite = await writeJson(value.baseManifestPath, value.baseManifest);
  const sourceManifestWrite = await writeJson(value.sourceManifestPath, value.candidateManifest);
  const patchText = await createRealPatch({ root: value.root });
  await writeFile(value.patchPath, patchText);
  value.config = {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-review",
    revision: REVISION,
    sourceRoot: SOURCE_ROOT,
    baseSourceManifest: "base-manifest.json",
    sourceManifest: "source-manifest.json",
    baseSourceManifestSha256: baseManifestWrite.sha256,
    candidateSourceManifestSha256: sourceManifestWrite.sha256,
    candidatePatch: {
      path: "candidate-source.patch",
      sha256: sha(patchText),
      bytes: Buffer.byteLength(patchText),
    },
    baseTreeSha256: value.baseManifest.treeSha256,
    candidateTreeSha256: value.candidateManifest.treeSha256,
    package: "cua-macos-visual",
    target: "aarch64-apple-darwin",
    toolchain: {
      upstreamDeclared: "1.97.1",
      auditedVersion: "1.97.1",
    },
    allowedDelta: deltaBetween(value.baseManifest, value.candidateManifest),
  };
  await writeJson(value.reviewConfigPath, value.config);
  value.patchText = patchText;
}

export async function refreshRound9Fixture(value) {
  value.candidateManifest = await buildCandidateManifest({
    baseManifest: value.baseManifest,
    candidateRoot: value.expected,
  });
  await writeReviewArtifacts(value);
  return value;
}

export async function createRound9PrepareFixture(root) {
  const base = join(root, "base");
  const expected = join(root, "expected");
  const work = join(root, "candidate-work");
  await mkdir(work);
  const baseTree = createBaseFiles();
  const nextFiles = createCandidateFiles(baseTree);
  await writeTree(base, baseTree);
  await writeTree(expected, nextFiles);

  const baseManifest = await createBaseManifest(base);
  const candidateManifest = await buildCandidateManifest({
    baseManifest,
    candidateRoot: expected,
  });
  const value = {
    root,
    base,
    expected,
    work,
    output: join(work, "full-source"),
    baseManifest,
    candidateManifest,
    baseManifestPath: join(root, "base-manifest.json"),
    sourceManifestPath: join(root, "source-manifest.json"),
    patchPath: join(root, "candidate-source.patch"),
    reviewConfigPath: join(root, "review-config.json"),
    config: null,
    patchText: "",
  };
  await writeReviewArtifacts(value);
  return value;
}
