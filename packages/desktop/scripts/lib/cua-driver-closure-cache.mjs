import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  sha256File,
  walkRegularFiles,
  writeJsonFile,
} from "./cua-driver-closure-core.mjs";
import { baseClosureEnvironment, runClosureCommand } from "./cua-driver-closure-command.mjs";

const CACHE_AUDIT_SCRIPT = [
  "import hashlib, json, os, stat, sys, tarfile",
  "def sha(path):",
  "    value = hashlib.sha256()",
  "    with open(path, 'rb') as handle:",
  "        for chunk in iter(lambda: handle.read(1024 * 1024), b''):",
  "            value.update(chunk)",
  "    return value.hexdigest()",
  "items = json.load(open(sys.argv[1], 'r', encoding='utf-8'))",
  "output = []",
  "for item in items:",
  "    key = item['name'] + '@' + item['version']",
  "    try:",
  "        archive_sha = sha(item['archive'])",
  "        if archive_sha != item['checksum']:",
  "            output.append({'key': key, 'status': 'fail', 'reason': 'archive checksum mismatch'})",
  "            continue",
  "        archive_files = {}",
  "        prefix = item['name'] + '-' + item['version']",
  "        with tarfile.open(item['archive'], 'r:gz') as archive:",
  "            for member in archive:",
  "                name = member.name[2:] if member.name.startswith('./') else member.name",
  "                name = name.rstrip('/')",
  "                parts = name.split('/')",
  "                if name.startswith('/') or any(part in ('', '..') for part in parts):",
  "                    raise ValueError('archive path escape')",
  "                if parts[0] != prefix:",
  "                    raise ValueError('unexpected archive prefix')",
  "                if member.isdir():",
  "                    continue",
  "                if member.issym() or member.islnk() or not member.isfile():",
  "                    raise ValueError('archive contains a non-regular file')",
  "                relative = '/'.join(parts[1:])",
  "                if not relative or relative in archive_files:",
  "                    raise ValueError('archive contains a duplicate path')",
  "                handle = archive.extractfile(member)",
  "                archive_files[relative] = hashlib.sha256(handle.read()).hexdigest()",
  "        source_files = {}",
  "        source_root = item['source']",
  "        if not os.path.isdir(source_root):",
  "            output.append({'key': key, 'status': 'blocked', 'reason': 'source missing'})",
  "            continue",
  "        for directory, directories, files in os.walk(source_root):",
  "            for directory_name in directories:",
  "                if os.path.islink(os.path.join(directory, directory_name)):",
  "                    raise ValueError('source contains a symlink')",
  "            for filename in files:",
  "                full = os.path.join(directory, filename)",
  "                if os.path.islink(full) or not stat.S_ISREG(os.lstat(full).st_mode):",
  "                    raise ValueError('source contains a non-regular file')",
  "                relative = os.path.relpath(full, source_root).replace(os.sep, '/')",
  "                if relative == '.cargo-ok':",
  "                    continue",
  "                if relative in source_files:",
  "                    raise ValueError('source contains a duplicate path')",
  "                source_files[relative] = sha(full)",
  "        missing = sorted(set(archive_files) - set(source_files))",
  "        extra = sorted(set(source_files) - set(archive_files))",
  "        changed = sorted(path for path in set(archive_files) & set(source_files) if archive_files[path] != source_files[path])",
  "        if missing or extra or changed:",
  "            output.append({'key': key, 'status': 'fail', 'reason': 'source does not match archive', 'missing': missing[:10], 'extra': extra[:10], 'changed': changed[:10]})",
  "            continue",
  "        output.append({'key': key, 'status': 'pass', 'archiveSha256': archive_sha, 'sourceFileCount': len(source_files), 'archiveFileCount': len(archive_files)})",
  "    except Exception as error:",
  "        output.append({'key': key, 'status': 'fail', 'reason': type(error).__name__ + ': ' + str(error)})",
  "print(json.dumps(output, sort_keys=True))",
].join("\n");

function treeDigest(entries) {
  const hash = createHash("sha256");
  for (const [path, digest] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path);
    hash.update("\0");
    hash.update(digest);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function evaluateTreeHashes(root) {
  const { root: rootReal, files } = await walkRegularFiles(root);
  const hashes = new Map();
  for (const path of files) hashes.set(path, await sha256File(join(rootReal, path)));
  return { files: files.length, treeSha256: treeDigest(hashes), hashes };
}

export async function verifyExternalMember({ root, expectedFiles, manifestSha256, treeSha256 }) {
  const actual = await evaluateTreeHashes(root);
  if (actual.files !== expectedFiles) {
    throw new ClosureVerificationError("external workspace member file count drift");
  }
  if (actual.treeSha256 !== treeSha256) {
    throw new ClosureVerificationError("external workspace member tree hash drift");
  }
  if (actual.hashes.get("Cargo.toml") !== manifestSha256) {
    throw new ClosureVerificationError("external workspace member Cargo.toml hash drift");
  }
  return { status: "pass", files: actual.files, treeSha256: actual.treeSha256, manifestSha256 };
}

async function childDirectories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

export async function auditRegistryCache({ graph, lockPackages, cargoHome, workRoot }) {
  if (typeof workRoot !== "string" || workRoot.length === 0) {
    throw new ClosureVerificationError("cache audit requires an explicit isolated work root");
  }
  const lock = new Map();
  for (const entry of lockPackages) {
    const key = `${entry.name}@${entry.version}`;
    if (lock.has(key)) throw new ClosureVerificationError(`ambiguous lock entry: ${key}`);
    lock.set(key, entry);
  }
  const cacheDirectories = await childDirectories(join(cargoHome, "registry", "cache"));
  const sourceDirectories = await childDirectories(join(cargoHome, "registry", "src"));
  const archives = new Map();
  const sources = new Map();
  for (const directory of cacheDirectories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".crate")) {
        const key = entry.name.slice(0, -6);
        if (archives.has(key)) throw new ClosureVerificationError(`ambiguous cached crate: ${key}`);
        archives.set(key, join(directory, entry.name));
      }
    }
  }
  for (const directory of sourceDirectories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (sources.has(entry.name))
          throw new ClosureVerificationError(`ambiguous cached source: ${entry.name}`);
        sources.set(entry.name, join(directory, entry.name));
      }
    }
  }
  const items = [];
  for (const packageEntry of graph) {
    if (packageEntry.path) continue;
    const key = `${packageEntry.name}@${packageEntry.version}`;
    const locked = lock.get(key);
    if (!locked) throw new ClosureVerificationError(`graph package missing lock entry: ${key}`);
    if (!locked.source?.startsWith("registry+")) continue;
    if (typeof locked.checksum !== "string" || !/^[a-f0-9]{64}$/.test(locked.checksum)) {
      throw new ClosureVerificationError(`registry package lacks a checksum: ${key}`);
    }
    const artifactKey = `${packageEntry.name}-${packageEntry.version}`;
    const archive = archives.get(artifactKey);
    if (!archive)
      throw new ClosureBlockedError("missing-crate-cache", `missing cached crate: ${key}`);
    const source = sources.get(artifactKey);
    if (!source)
      throw new ClosureBlockedError("missing-source-cache", `missing cached source: ${key}`);
    items.push({
      name: packageEntry.name,
      version: packageEntry.version,
      archive,
      source,
      checksum: locked.checksum,
    });
  }
  const inputPath = join(workRoot, "cache-audit-input.json");
  await writeJsonFile(inputPath, items);
  const audit = await runClosureCommand("python3", ["-c", CACHE_AUDIT_SCRIPT, inputPath], {
    env: baseClosureEnvironment(),
    timeoutMs: 120_000,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  let results;
  try {
    results = JSON.parse(audit.stdout);
  } catch {
    throw new ClosureVerificationError("cache audit returned invalid JSON");
  }
  if (!Array.isArray(results) || results.length !== items.length) {
    throw new ClosureVerificationError("cache audit result count mismatch");
  }
  const byKey = new Map(results.map((entry) => [entry.key, entry]));
  const packages = items.map((item) => {
    const key = `${item.name}@${item.version}`;
    const result = byKey.get(key);
    if (!result || result.status !== "pass") {
      const reason = result?.reason ?? "missing cache audit result";
      const details = [
        result?.missing?.length ? `missing=${result.missing.join(",")}` : "",
        result?.extra?.length ? `extra=${result.extra.join(",")}` : "",
        result?.changed?.length ? `changed=${result.changed.join(",")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      if (reason === "source missing") {
        throw new ClosureBlockedError("missing-source-cache", `missing cached source: ${key}`);
      }
      throw new ClosureBlockedError(
        "cache-source-drift",
        `cached source verification failed: ${key}: ${reason}${details ? ` (${details})` : ""}`,
      );
    }
    return {
      name: item.name,
      version: item.version,
      checksum: item.checksum,
      archiveSha256: result.archiveSha256,
      archiveChecksumMatchesLock: true,
      sourceMatchesArchive: true,
      sourceFileCount: result.sourceFileCount,
      archiveFileCount: result.archiveFileCount,
    };
  });
  return { status: "pass", checked: packages.length, packages };
}
