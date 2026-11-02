import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export class Round7PrepareError extends Error {
  constructor(message) {
    super(message);
    this.name = "Round7PrepareError";
  }
}

export function failure(message) {
  throw new Round7PrepareError(message);
}

export function isSafeRelativePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !isAbsolute(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeTreeSha256(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const digest = file.sha256 ?? file.candidateSha256;
    if (!isSafeRelativePath(file.path) || !isSha256(digest)) {
      failure(`invalid tree entry: ${file.path ?? "unknown"}`);
    }
    hash.update(`${file.path}\0${digest}\n`);
  }
  return hash.digest("hex");
}

export async function scanTree(rootPath) {
  const requestedRoot = resolve(rootPath);
  const rootStat = await lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    failure("source root must be a real directory");
  }
  const root = await realpath(requestedRoot);
  const files = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) failure(`symlink is not allowed: ${path}`);
      if (!isSafeRelativePath(path)) failure(`unsafe source path: ${path}`);
      if (entry.isDirectory()) {
        await walk(absolute, path);
      } else if (entry.isFile()) {
        const metadata = await lstat(absolute);
        files.push({ path, sha256: await sha256File(absolute), bytes: metadata.size });
      } else {
        failure(`unsupported source file type: ${path}`);
      }
    }
  }
  await walk(root, "");
  return { root, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

async function assertNoSymlinkAncestors(root, target) {
  const relativePath = relative(root, target);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    failure("output must be inside the round 7 candidate-work root");
  }
  let current = root;
  for (const part of relativePath.split(sep).slice(0, -1)) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) failure(`output path contains a symlink: ${current}`);
      if (!metadata.isDirectory()) failure(`output ancestor is not a directory: ${current}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function relativeWithin(root, target) {
  const relativePath = relative(root, target);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null;
  }
  return relativePath;
}

export async function assertFreshOutputPath({ output, candidateWorkRoot }) {
  const requestedOutput = resolve(output);
  const requestedWorkRoot = resolve(candidateWorkRoot);
  if (basename(requestedOutput) !== "full-source") {
    failure("output must be named full-source");
  }
  try {
    const metadata = await lstat(requestedOutput);
    failure(`output already exists${metadata.isSymbolicLink() ? " as a symlink" : ""}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const workStat = await lstat(requestedWorkRoot);
  if (workStat.isSymbolicLink() || !workStat.isDirectory()) {
    failure("candidate-work root must be a real directory");
  }
  const workRoot = await realpath(requestedWorkRoot);
  // macOS 的 /tmp、/var 常通过 symlink 指向 /private，发布前第二次校验会同时
  // 看到请求路径与第一次返回的 realpath。两者都映射到同一真实 candidate-work
  // 根即可，但最终仍对 canonical 路径逐段拒绝 symlink。
  const relativeOutput =
    relativeWithin(requestedWorkRoot, requestedOutput) ?? relativeWithin(workRoot, requestedOutput);
  if (!relativeOutput) failure("output must be inside the round 7 candidate-work root");
  const resolvedOutput = join(workRoot, relativeOutput);
  await assertNoSymlinkAncestors(workRoot, resolvedOutput);
  return resolvedOutput;
}

function validateManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.kind !== "zody-cua-driver-closure-source-manifest" ||
    typeof manifest.revision !== "string" ||
    typeof manifest.sourceRoot !== "string" ||
    !Array.isArray(manifest.files)
  ) {
    failure("invalid source manifest schema");
  }
  for (const entry of manifest.files) {
    if (!isSafeRelativePath(entry?.path) || !isSha256(entry?.candidateSha256)) {
      failure(`invalid source manifest entry: ${entry?.path ?? "unknown"}`);
    }
    if (!["modified", "added", "unchanged"].includes(entry.status)) {
      failure(`invalid source manifest status: ${entry.path}`);
    }
    if (entry.status !== "added" && !isSha256(entry.upstreamSha256)) {
      failure(`missing upstream hash: ${entry.path}`);
    }
  }
}

export async function verifyTreeAgainstManifest({ scanned, manifest, treeSha256 }) {
  validateManifest(manifest);
  if (new Set(manifest.files.map((entry) => entry.path)).size !== manifest.files.length) {
    failure("source manifest contains duplicate paths");
  }
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const actual = new Map(scanned.files.map((entry) => [entry.path, entry]));
  for (const path of expected.keys()) {
    if (!actual.has(path)) failure(`missing candidate file: ${path}`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) failure(`unexpected candidate file: ${path}`);
  }
  for (const [path, entry] of expected) {
    if (actual.get(path).sha256 !== entry.candidateSha256) {
      failure(`candidate hash drift: ${path}`);
    }
  }
  const actualTreeSha256 = computeTreeSha256(scanned.files);
  if (manifest.treeSha256 !== undefined && manifest.treeSha256 !== actualTreeSha256) {
    failure("source manifest tree hash does not match the candidate");
  }
  if (treeSha256 !== undefined && treeSha256 !== actualTreeSha256) {
    failure("pinned tree hash does not match the candidate");
  }
  return { fileCount: scanned.files.length, treeSha256: actualTreeSha256 };
}

export async function buildCandidateManifest({ baseManifest, candidateRoot }) {
  validateManifest(baseManifest);
  const scanned = await scanTree(candidateRoot);
  const base = new Map(baseManifest.files.map((entry) => [entry.path, entry]));
  const paths = new Set(scanned.files.map((entry) => entry.path));
  for (const path of base.keys()) {
    if (!paths.has(path)) failure(`round 7 may not remove a source file: ${path}`);
  }
  const files = scanned.files.map((file) => {
    const previous = base.get(file.path);
    if (!previous) {
      return { path: file.path, status: "added", candidateSha256: file.sha256 };
    }
    if (previous.status === "added") {
      return { path: file.path, status: "added", candidateSha256: file.sha256 };
    }
    return {
      path: file.path,
      status: file.sha256 === previous.upstreamSha256 ? "unchanged" : "modified",
      upstreamSha256: previous.upstreamSha256,
      candidateSha256: file.sha256,
    };
  });
  return {
    schemaVersion: baseManifest.schemaVersion,
    kind: baseManifest.kind,
    revision: baseManifest.revision,
    sourceRoot: baseManifest.sourceRoot,
    treeSha256: computeTreeSha256(files),
    files,
  };
}

export async function readJsonFile(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    failure(`JSON input must be a regular file: ${path}`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Round7PrepareError) throw error;
    failure(`invalid JSON input: ${path}`);
  }
}
