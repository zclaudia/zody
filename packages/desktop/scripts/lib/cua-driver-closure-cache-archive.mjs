import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  isSha256,
} from "./cua-driver-closure-core.mjs";

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

export const ARCHIVE_SCRIPT = String.raw`
import hashlib, json, os, stat, sys, tarfile
tasks = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
limits = tasks['limits']
output = []
def fail(message):
    raise ValueError(message)
def digest(handle):
    value = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b''):
        value.update(chunk)
    return value.hexdigest()
def normalize(name, prefix):
    normalized = name[2:] if name.startswith('./') else name
    normalized = normalized.rstrip('/')
    if not normalized or normalized.startswith('/') or '\\' in normalized:
        fail('unsafe archive path')
    parts = normalized.split('/')
    if any(part in ('', '.', '..') for part in parts):
        fail('archive path escape')
    if parts[0] != prefix:
        fail('unexpected archive prefix')
    return normalized, parts
def read_source(root):
    files = {}
    marker = False
    if not os.path.isdir(root):
        return None, marker
    for directory, directories, names in os.walk(root):
        for name in list(directories):
            path = os.path.join(directory, name)
            if os.path.islink(path):
                fail('source contains a symlink')
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                fail('source contains an unsupported directory entry')
        for name in names:
            path = os.path.join(directory, name)
            metadata = os.lstat(path)
            if os.path.islink(path) or not stat.S_ISREG(metadata.st_mode):
                fail('source contains a non-regular file')
            rel = os.path.relpath(path, root).replace(os.sep, '/')
            if rel == '.cargo-ok':
                marker = True
                continue
            if rel in files:
                fail('source contains a duplicate path')
            files[rel] = {'sha256': digest(open(path, 'rb')), 'size': metadata.st_size, 'mode': stat.S_IMODE(metadata.st_mode)}
    return files, marker
for task in tasks['archives']:
    key = task['key']
    prefix = key
    archive_files = {}
    seen = set()
    total = 0
    members = 0
    with tarfile.open(task['archive'], 'r:gz') as archive:
        for member in archive:
            members += 1
            if members > limits['maxMembersPerArchive']:
                fail('archive exceeds the member count limit')
            normalized, parts = normalize(member.name, prefix)
            if normalized in seen:
                fail('archive contains a duplicate path')
            seen.add(normalized)
            if member.isdir():
                continue
            if member.issym():
                fail('archive contains a symlink')
            if member.islnk():
                fail('archive contains a hardlink')
            if not member.isfile():
                fail('archive contains a non-regular file')
            rel = '/'.join(parts[1:])
            if not rel:
                fail('empty archive path')
            if rel == '.cargo-ok':
                fail('archive must not contain the Cargo marker')
            if member.size > limits['maxFileBytes']:
                fail('archive file exceeds the size limit')
            total += member.size
            if total > limits['maxArchiveBytes']:
                fail('archive exceeds the total size limit')
            mode = member.mode & 0o7777
            if mode == 0 or (mode & 0o7000):
                fail('archive file has an unsupported permission mode')
            handle = archive.extractfile(member)
            archive_files[rel] = {'sha256': digest(handle), 'size': member.size, 'mode': mode}
    source_files, marker = read_source(task['source'])
    if source_files is None:
        source = {'status': 'missing', 'missing': sorted(archive_files), 'extra': [], 'changed': [], 'changedMetadata': [], 'fileCount': 0, 'cargoOkMarker': marker}
    else:
        missing = sorted(set(archive_files) - set(source_files))
        extra = sorted(set(source_files) - set(archive_files))
        changed = sorted(path for path in set(archive_files) & set(source_files) if any(archive_files[path][field] != source_files[path][field] for field in ('sha256', 'size', 'mode')))
        changed_metadata = sorted(path for path in set(archive_files) & set(source_files) if archive_files[path]['sha256'] == source_files[path]['sha256'] and any(archive_files[path][field] != source_files[path][field] for field in ('size', 'mode')))
        source = {'status': 'present', 'missing': missing, 'extra': extra, 'changed': changed, 'changedMetadata': changed_metadata, 'fileCount': len(source_files), 'cargoOkMarker': marker}
    extract_root = task['extractRoot']
    if extract_root:
        with tarfile.open(task['archive'], 'r:gz') as archive:
            for member in archive:
                normalized, parts = normalize(member.name, prefix)
                if member.isdir():
                    continue
                rel = '/'.join(parts[1:])
                destination = os.path.join(extract_root, rel)
                if not os.path.abspath(destination).startswith(os.path.abspath(extract_root) + os.sep):
                    fail('extraction path escape')
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                metadata = archive_files[rel]
                handle = archive.extractfile(member)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, 'O_NOFOLLOW'):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(destination, flags, metadata['mode'])
                with os.fdopen(descriptor, 'wb') as target:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                        target.write(chunk)
                os.chmod(destination, metadata['mode'])
    output.append({'key': key, 'archiveFiles': [{'path': path, **metadata} for path, metadata in sorted(archive_files.items())], 'source': source})
print(json.dumps(output, sort_keys=True))
`;

export async function childDirectories(path) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function scanArchives(cargoHome) {
  const root = join(cargoHome, "registry", "cache");
  const archives = [];
  for (const directory of await childDirectories(root)) {
    const absoluteDirectory = join(root, directory);
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new ClosureVerificationError(
          `cache archive directory contains a symlink: ${entry.name}`,
        );
      }
      if (!entry.isFile() || !entry.name.endsWith(".crate")) continue;
      archives.push({
        key: entry.name.slice(0, -6),
        directory,
        path: join(absoluteDirectory, entry.name),
      });
    }
  }
  const seen = new Map();
  for (const archive of archives) {
    if (seen.has(archive.key))
      throw new ClosureVerificationError(`ambiguous cached crate: ${archive.key}`);
    seen.set(archive.key, archive);
  }
  return seen;
}

export function classifyLockPackages(lockPackages) {
  if (!Array.isArray(lockPackages))
    throw new ClosureVerificationError("lock packages are required");
  const registry = new Map();
  for (const entry of lockPackages) {
    if (!entry || typeof entry.name !== "string" || typeof entry.version !== "string") {
      throw new ClosureVerificationError("invalid lock package");
    }
    if (entry.source === undefined) continue;
    if (entry.source !== CRATES_IO) {
      throw new ClosureVerificationError(`unknown lock source: ${entry.source}`);
    }
    const key = `${entry.name}@${entry.version}`;
    if (registry.has(key)) throw new ClosureVerificationError(`ambiguous lock entry: ${key}`);
    if (!isSha256(entry.checksum))
      throw new ClosureVerificationError(`registry package lacks a checksum: ${key}`);
    registry.set(key, entry);
  }
  return registry;
}

export function artifactKey(name, version) {
  return `${name}-${version}`;
}

export function assertTargetArchiveCoverage({ graph, lockPackages, reconstructedKeys }) {
  if (!Array.isArray(graph) || graph.length === 0) {
    throw new ClosureBlockedError("target-graph-missing", "target graph is empty");
  }
  if (!(reconstructedKeys instanceof Set)) {
    throw new ClosureBlockedError("reconstructed-cache-empty", "reconstructed cache is empty");
  }
  const locked = classifyLockPackages(lockPackages);
  let registryPackages = 0;
  for (const entry of graph) {
    if (entry.path) continue;
    const key = `${entry.name}@${entry.version}`;
    if (!locked.get(key)) {
      throw new ClosureVerificationError(`target graph package is absent from Cargo.lock: ${key}`);
    }
    if (!reconstructedKeys.has(artifactKey(entry.name, entry.version))) {
      throw new ClosureBlockedError(
        "target-archive-missing",
        `target graph archive missing: ${key}`,
      );
    }
    registryPackages += 1;
  }
  if (registryPackages === 0) {
    throw new ClosureBlockedError(
      "target-graph-no-registry",
      "target graph has no registry packages",
    );
  }
  if (reconstructedKeys.size === 0) {
    throw new ClosureBlockedError("reconstructed-cache-empty", "reconstructed cache is empty");
  }
  return { status: "pass", registryPackages };
}
