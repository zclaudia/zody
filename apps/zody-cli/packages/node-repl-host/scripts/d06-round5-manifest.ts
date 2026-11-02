import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { sha256Bytes, sha256File } from "./d06-round5-resources.js";

export interface D06ResourceManifestEntry {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface D06ResourceManifest {
  root: string;
  entries: D06ResourceManifestEntry[];
}

export interface D06ResourceIssue {
  id: string;
  path: string;
  issue:
    | "empty-manifest"
    | "invalid-entry"
    | "duplicate-id"
    | "duplicate-path"
    | "missing"
    | "lstat-error"
    | "symlink"
    | "not-file"
    | "path-escape"
    | "hash-mismatch"
    | "size-mismatch";
  expected?: string;
  actual?: string;
}

export async function snapshotResources(
  root: string,
  specs: readonly { id: string; path: string }[],
): Promise<D06ResourceManifest> {
  const entries: D06ResourceManifestEntry[] = [];
  for (const spec of specs) entries.push(await snapshotResource(root, spec.id, spec.path));
  return { root, entries };
}

export async function snapshotResource(
  root: string,
  id: string,
  path: string,
): Promise<D06ResourceManifestEntry> {
  const contents = await readFile(path);
  return { id, path, sha256: sha256Bytes(contents), bytes: contents.byteLength };
}

export async function verifyResourceManifest(
  manifest: D06ResourceManifest,
): Promise<D06ResourceIssue[]> {
  const issues = validateManifest(manifest);
  if (issues.length > 0) return issues;
  const canonicalRoot = await realpath(manifest.root).catch(() => manifest.root);
  for (const entry of manifest.entries) {
    const issue = await verifyResourceEntry(manifest.root, canonicalRoot, entry);
    if (issue) issues.push(issue);
  }
  return issues;
}

export async function verifyThenExecute<T>(
  manifest: D06ResourceManifest,
  execute: () => Promise<T>,
): Promise<{ executed: boolean; issues: D06ResourceIssue[]; result?: T }> {
  const issues = await verifyResourceManifest(manifest);
  if (issues.length > 0) return { executed: false, issues };
  return { executed: true, issues: [], result: await execute() };
}

export async function runIntegrityPrecheck(
  root: string,
  manifest: D06ResourceManifest,
): Promise<{
  checks: Record<string, boolean>;
  issues: D06ResourceIssue[];
  baseline: D06ResourceIssue[];
  guard: {
    executed: boolean;
    executeCalls: number;
    canaryUnchanged: boolean;
    issues: D06ResourceIssue[];
  };
}> {
  const wrongHash = "0".repeat(64);
  const baseline = await verifyResourceManifest(manifest);
  const dir = join(root, "integrity-counterexamples");
  await mkdir(dir);
  const missingPath = join(dir, "missing.txt");
  const mismatchPath = join(dir, "mismatch.txt");
  const symlinkTarget = join(dir, "symlink-target.txt");
  const symlinkPath = join(dir, "symlink.txt");
  const tamperPath = join(dir, "tamper.txt");
  const tamperCanaryPath = join(dir, "tamper-canary.txt");
  const escapeChildRoot = join(dir, "escape-child-root");
  const escapePath = join(root, "escape-outside-child-root.txt");
  await mkdir(escapeChildRoot);
  await Promise.all([
    writeFile(mismatchPath, "mismatch", "utf8"),
    writeFile(symlinkTarget, "symlink-target", "utf8"),
    writeFile(tamperPath, "original", "utf8"),
    writeFile(tamperCanaryPath, "tamper-canary", "utf8"),
    writeFile(escapePath, "escape", "utf8"),
  ]);
  await symlink(symlinkTarget, symlinkPath);
  const target = await snapshotResource(dir, "target", symlinkTarget);
  const tamper = await snapshotResource(dir, "tamper", tamperPath);
  await writeFile(tamperPath, "tampered", "utf8");
  const missing = await verifyResourceManifest({
    root,
    entries: [{ id: "missing", path: missingPath, sha256: wrongHash, bytes: 0 }],
  });
  const mismatch = await verifyResourceManifest({
    root,
    entries: [{ id: "mismatch", path: mismatchPath, sha256: wrongHash, bytes: 8 }],
  });
  const symlinked = await verifyResourceManifest({
    root,
    entries: [{ ...target, id: "symlink", path: symlinkPath }],
  });
  const escaped = await verifyResourceManifest({
    root: escapeChildRoot,
    entries: [{ id: "escape", path: escapePath, sha256: wrongHash, bytes: 0 }],
  });
  let tamperExecuteCalls = 0;
  const tamperGuard = await verifyThenExecute({ root, entries: [tamper] }, async () => {
    tamperExecuteCalls += 1;
    await writeFile(tamperCanaryPath, "tamper-executed", "utf8");
    return true;
  });
  const tampered = tamperGuard.issues;
  const tamperCanaryUnchanged = (await readFile(tamperCanaryPath, "utf8")) === "tamper-canary";
  return {
    baseline,
    issues: [...missing, ...mismatch, ...symlinked, ...escaped, ...tampered],
    guard: {
      executed: tamperGuard.executed,
      executeCalls: tamperExecuteCalls,
      canaryUnchanged: tamperCanaryUnchanged,
      issues: tampered,
    },
    checks: {
      "manifest verified before execution": baseline.length === 0,
      "missing rejected": missing.some((issue) => issue.issue === "missing"),
      "hash mismatch rejected":
        mismatch.some((issue) => issue.issue === "hash-mismatch") &&
        tampered.some((issue) => issue.issue === "hash-mismatch"),
      "symlink rejected": symlinked.some((issue) => issue.issue === "symlink"),
      "path escape rejected": escaped.some((issue) => issue.issue === "path-escape"),
      "tamper rejected": tampered.some((issue) => issue.issue === "hash-mismatch"),
      "tamper execute refused":
        tamperGuard.executed === false &&
        tamperExecuteCalls === 0 &&
        tampered.some((issue) => issue.issue === "hash-mismatch"),
      "tamper canary unchanged": tamperCanaryUnchanged,
    },
  };
}

async function verifyResourceEntry(
  root: string,
  canonicalRoot: string,
  entry: D06ResourceManifestEntry,
): Promise<D06ResourceIssue | undefined> {
  const relativePath = relative(root, entry.path);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { id: entry.id, path: entry.path, issue: "path-escape" };
  }
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    const ancestor = await lstatIssue(current);
    if (ancestor === "missing" || ancestor === "lstat-error") {
      return { id: entry.id, path: entry.path, issue: ancestor };
    }
    if (ancestor === "symlink") return { id: entry.id, path: entry.path, issue: "symlink" };
    if (ancestor !== "directory") return { id: entry.id, path: entry.path, issue: "not-file" };
  }
  const leaf = await lstatIssue(entry.path);
  if (leaf === "missing" || leaf === "lstat-error") {
    return { id: entry.id, path: entry.path, issue: leaf };
  }
  if (leaf === "symlink") return { id: entry.id, path: entry.path, issue: "symlink" };
  if (leaf !== "file") return { id: entry.id, path: entry.path, issue: "not-file" };
  const resolved = await realpath(entry.path);
  if (!isInside(canonicalRoot, resolved)) {
    return { id: entry.id, path: entry.path, issue: "path-escape" };
  }
  const actual = await sha256File(entry.path);
  if (actual.sha256 !== entry.sha256) {
    return {
      id: entry.id,
      path: entry.path,
      issue: "hash-mismatch",
      expected: entry.sha256,
      actual: actual.sha256,
    };
  }
  if (actual.bytes !== entry.bytes) {
    return {
      id: entry.id,
      path: entry.path,
      issue: "size-mismatch",
      expected: String(entry.bytes),
      actual: String(actual.bytes),
    };
  }
  return undefined;
}

function validateManifest(manifest: D06ResourceManifest): D06ResourceIssue[] {
  if (manifest.entries.length === 0) {
    return [{ id: "manifest", path: manifest.root, issue: "empty-manifest" }];
  }
  const issues: D06ResourceIssue[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    const valid =
      entry.id.trim().length > 0 &&
      entry.path.startsWith("/") &&
      /^[a-f0-9]{64}$/u.test(entry.sha256) &&
      Number.isInteger(entry.bytes) &&
      entry.bytes >= 0;
    if (!valid) issues.push({ id: entry.id, path: entry.path, issue: "invalid-entry" });
    if (ids.has(entry.id)) issues.push({ id: entry.id, path: entry.path, issue: "duplicate-id" });
    if (paths.has(entry.path)) {
      issues.push({ id: entry.id, path: entry.path, issue: "duplicate-path" });
    }
    ids.add(entry.id);
    paths.add(entry.path);
  }
  return issues;
}

async function lstatIssue(
  path: string,
): Promise<"file" | "directory" | "symlink" | "missing" | "lstat-error"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    return info.isFile() ? "file" : "lstat-error";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "lstat-error";
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
