import { createHash } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  sha256File,
  walkRegularFiles,
} from "./cua-driver-closure-core.mjs";
import { copyTreeSafe, runClosureCommand } from "./cua-driver-closure-command.mjs";
import {
  ARCHIVE_SCRIPT,
  artifactKey,
  classifyLockPackages,
  scanArchives,
} from "./cua-driver-closure-cache-archive.mjs";

export { assertTargetArchiveCoverage } from "./cua-driver-closure-cache-archive.mjs";

const CARGO_OK = '{"v":1}';
export const DEFAULT_CACHE_LIMITS = Object.freeze({
  maxMembersPerArchive: 20_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxArchiveBytes: 512 * 1024 * 1024,
});

function digestEntries(entries) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${entry.path}\0${entry.sha256}\0${entry.size}\0${entry.mode}\n`);
  }
  return hash.digest("hex");
}

export async function snapshotTree(root) {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ClosureVerificationError(`cache input is not a regular directory: ${root}`);
  }
  const { root: rootReal, files } = await walkRegularFiles(root);
  const entries = [];
  for (const path of files) {
    const file = join(rootReal, path);
    const fileStat = await lstat(file);
    entries.push({
      path,
      sha256: await sha256File(file),
      size: fileStat.size,
      mode: fileStat.mode & 0o777,
    });
  }
  return {
    root: rootReal,
    fileCount: entries.length,
    treeSha256: digestEntries(entries),
    files: entries,
  };
}

export async function prepareReconstructedCache({
  cargoHome,
  lockPackages,
  stagingRoot,
  candidateRoot,
  limits = DEFAULT_CACHE_LIMITS,
}) {
  const locked = classifyLockPackages(lockPackages);
  for (const key of ["maxMembersPerArchive", "maxFileBytes", "maxArchiveBytes"]) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0)
      throw new ClosureVerificationError("invalid cache limit");
  }
  const inputBefore = await snapshotTree(cargoHome);
  const ownRoot = join(stagingRoot, "cargo-home");
  try {
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(ownRoot);
  } catch {
    throw new ClosureVerificationError("cache staging root must be empty and owned by this audit");
  }
  try {
    try {
      if (!(await lstat(join(cargoHome, "registry", "index"))).isDirectory()) {
        throw new ClosureVerificationError("cache index is not a directory");
      }
    } catch {
      throw new ClosureBlockedError("cache-index-missing", "cache input is missing registry/index");
    }
    await copyTreeSafe(join(cargoHome, "registry", "cache"), join(ownRoot, "registry", "cache"));
    await copyTreeSafe(join(cargoHome, "registry", "index"), join(ownRoot, "registry", "index"));
    const archives = await scanArchives(ownRoot);
    const packages = [];
    const tasks = [];
    const unlockedArchives = [];
    const checksumFailures = [];
    for (const [key, archive] of archives) {
      const packageName = key.slice(0, key.lastIndexOf("-"));
      const lockedEntry = [...locked.values()].find(
        (entry) => artifactKey(entry.name, entry.version) === key,
      );
      if (!lockedEntry) {
        const vendorPath = candidateRoot ? join(candidateRoot, "vendor", packageName) : null;
        let vendorReplacement = null;
        if (vendorPath) {
          try {
            if (
              (await lstat(vendorPath)).isDirectory() &&
              !(await lstat(vendorPath)).isSymbolicLink()
            ) {
              vendorReplacement = relative(candidateRoot, vendorPath);
            }
          } catch {
            vendorReplacement = null;
          }
        }
        unlockedArchives.push({
          key,
          status: "excluded-not-in-lock",
          extracted: false,
          vendorReplacement,
        });
        continue;
      }
      const checksum = await sha256File(archive.path);
      const checksumMatchesLock = checksum === lockedEntry.checksum;
      if (!checksumMatchesLock)
        checksumFailures.push({
          key: `${lockedEntry.name}@${lockedEntry.version}`,
          archiveSha256: checksum,
        });
      const source = join(cargoHome, "registry", "src", archive.directory, key);
      const extractRoot = join(ownRoot, "registry", "src", archive.directory, key);
      const record = {
        key: `${lockedEntry.name}@${lockedEntry.version}`,
        artifact: key,
        checksum: lockedEntry.checksum,
        archiveSha256: checksum,
        checksumMatchesLock,
        sourceStatus: "unknown",
        cargoOkMarker: false,
        differences: { missing: [], extra: [], changed: [] },
        reconstructed: false,
      };
      if (checksumMatchesLock) {
        tasks.push({
          key,
          archive: archive.path,
          source,
          extractRoot,
          directory: archive.directory,
        });
      }
      packages.push(record);
    }
    let inspected = [];
    if (tasks.length > 0) {
      const workRoot = join(stagingRoot, "work");
      await mkdir(workRoot, { recursive: true });
      const inputPath = join(workRoot, "archive-tasks.json");
      await writeFile(inputPath, JSON.stringify({ limits, archives: tasks }), "utf8");
      const result = await runClosureCommand("python3", ["-c", ARCHIVE_SCRIPT, inputPath], {
        timeoutMs: 600_000,
        maxOutputBytes: 256 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      });
      inspected = JSON.parse(result.stdout);
    }
    const byKey = new Map(inspected.map((entry) => [entry.key, entry]));
    const reconstructedKeys = new Set();
    for (const record of packages) {
      const entry = byKey.get(record.artifact);
      if (!entry) continue;
      record.sourceStatus = entry.source.status;
      record.cargoOkMarker = entry.source.cargoOkMarker;
      record.differences = {
        missing: entry.source.missing,
        extra: entry.source.extra,
        changed: entry.source.changed,
        changedMetadata: entry.source.changedMetadata ?? [],
      };
      const extractRoot = join(
        ownRoot,
        "registry",
        "src",
        archives.get(record.artifact).directory,
        record.artifact,
      );
      const actual = await snapshotTree(extractRoot);
      const expected = entry.archiveFiles;
      const expectedPaths = expected.map((file) => file.path).sort();
      const actualPaths = actual.files.map((file) => file.path).sort();
      if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
        throw new ClosureVerificationError(
          `reconstructed archive file set mismatch: ${record.key}`,
        );
      }
      for (const file of expected) {
        const found = actual.files.find((candidate) => candidate.path === file.path);
        if (
          !found ||
          found.sha256 !== file.sha256 ||
          found.size !== file.size ||
          found.mode !== file.mode
        ) {
          throw new ClosureVerificationError(
            `reconstructed archive byte/metadata mismatch: ${record.key}/${file.path}`,
          );
        }
      }
      await writeFile(join(extractRoot, ".cargo-ok"), CARGO_OK);
      record.reconstructed = true;
      record.treeSha256 = digestEntries(expected);
      record.fileCount = expected.length;
      record.files = expected;
      reconstructedKeys.add(record.artifact);
    }
    const inputAfter = await snapshotTree(cargoHome);
    if (inputBefore.treeSha256 !== inputAfter.treeSha256) {
      throw new ClosureVerificationError("original cache input changed during reconstruction");
    }
    const originalSourceDrift = packages.some(
      (entry) =>
        entry.sourceStatus !== "present" ||
        entry.differences.missing.length > 0 ||
        entry.differences.extra.length > 0 ||
        entry.differences.changed.length > 0 ||
        (entry.differences.changedMetadata?.length ?? 0) > 0,
    );
    // 原始 cache 与重建结果分开判定：缺 Cargo.lock 只让原始来源进入 blocked，
    // 不能反过来抹掉本次重建或目标图的通过状态。
    const archivesChecksumStatus = checksumFailures.length === 0 ? "pass" : "blocked";
    const originalSourceStatus = originalSourceDrift ? "blocked" : "pass";
    const reconstructedStatus =
      checksumFailures.length === 0 && reconstructedKeys.size > 0 ? "pass" : "blocked";
    return {
      status: reconstructedStatus,
      cargoHome: ownRoot,
      checksumFailures,
      unlockedArchives,
      reconstructedKeys,
      originalCache: {
        status:
          archivesChecksumStatus === "pass" && originalSourceStatus === "pass" ? "pass" : "blocked",
        archivesChecksumStatus,
        originalSourceStatus,
        driftReason:
          archivesChecksumStatus !== "pass"
            ? "one or more cached archives do not match Cargo.lock checksums"
            : originalSourceStatus !== "pass"
              ? "original registry sources differ from their verified archives (including Cargo.lock)"
              : null,
        inputBefore,
        inputAfter,
        archives: archives.size,
        lockedArchives: packages.filter((entry) => entry.checksumMatchesLock).length,
        missingLockArchives: locked.size - packages.length,
        packages,
      },
      reconstructedCache: {
        status: reconstructedStatus,
        packageCount: reconstructedKeys.size,
        packages: packages.filter((entry) => entry.reconstructed),
      },
    };
  } catch (error) {
    await rm(ownRoot, { recursive: true, force: true });
    throw error;
  }
}
