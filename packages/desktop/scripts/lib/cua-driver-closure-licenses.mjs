import { copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  isPathInside,
  isSafeRelativePath,
  sha256File,
  walkRegularFiles,
  writeJsonFile,
} from "./cua-driver-closure-core.mjs";
import { baseClosureEnvironment, runClosureCommand } from "./cua-driver-closure-command.mjs";
import { loadLicenseSupplements } from "./cua-driver-closure-license-supplements.mjs";
import {
  isStrictLicenseMaterialPath,
  readLicenseMaterial,
} from "./cua-driver-closure-license-text.mjs";
import { summarizeLicenseMaterials } from "./cua-driver-closure-license-summary.mjs";

export {
  classifyLicenseExpression,
  summarizeLicenseMaterials,
} from "./cua-driver-closure-license-summary.mjs";

const LICENSE_SCRIPT = [
  "import json, os, sys, tomllib",
  "items = json.load(open(sys.argv[1], 'r', encoding='utf-8'))",
  "output = []",
  "for root in items:",
  "    entry = {'root': root}",
  "    try:",
  "        with open(os.path.join(root, 'Cargo.toml'), 'rb') as handle:",
  "            data = tomllib.load(handle)",
  "        package = data.get('package', {})",
  "        entry.update({",
  "            'name': package.get('name'),",
  "            'version': package.get('version'),",
  "            'license': package.get('license'),",
  "            'licenseFile': package.get('license-file'),",
  "        })",
  "    except Exception as error:",
  "        entry['error'] = type(error).__name__",
  "    output.append(entry)",
  "print(json.dumps(output, sort_keys=True))",
].join("\n");

export async function readLicenseMetadata(roots, inputPath) {
  await writeJsonFile(inputPath, roots);
  const result = await runClosureCommand("python3", ["-c", LICENSE_SCRIPT, inputPath], {
    env: baseClosureEnvironment(),
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ClosureVerificationError("license metadata reader returned invalid JSON");
  }
}

export async function collectLicenseFiles(root, label) {
  const { root: rootReal, files } = await walkRegularFiles(root);
  const materials = [];
  for (const path of files.filter(isStrictLicenseMaterialPath)) {
    let material;
    try {
      material = await readLicenseMaterial(join(rootReal, path));
    } catch {
      continue;
    }
    if (!material.isLicense && !material.notice) continue;
    materials.push({
      path: `${label}/${path}`,
      sha256: material.sha256,
      bytes: material.bytes,
      licenseIdentifiers: material.identifiers,
      materialKind: material.isLicense ? "license" : "notice",
      sourceKind: "package",
    });
  }
  return materials;
}

export async function auditLicenseClosure({
  packageRoots,
  upstreamLicense,
  workRoot,
  supplementsManifestPath,
  lockPackages,
  sourceRevision,
}) {
  if (!Array.isArray(packageRoots) || packageRoots.length === 0) {
    throw new ClosureBlockedError(
      "license-packages-missing",
      "license audit requires graph packages",
    );
  }
  if (typeof workRoot !== "string" || workRoot.length === 0) {
    throw new ClosureBlockedError(
      "license-work-root-missing",
      "license audit requires an isolated work root",
    );
  }
  const roots = packageRoots.map((entry) => entry.root);
  const supplements = supplementsManifestPath
    ? await loadLicenseSupplements({
        manifestPath: supplementsManifestPath,
        packageRoots,
        lockPackages,
        sourceRevision,
      })
    : null;
  const inputPath = join(workRoot, "license-roots.json");
  const metadata = await readLicenseMetadata(roots, inputPath);
  const byRoot = new Map(metadata.map((entry) => [entry.root, entry]));
  const packages = [];
  for (const entry of packageRoots) {
    const manifest = byRoot.get(entry.root);
    if (!manifest || manifest.error) {
      throw new ClosureVerificationError(`license metadata unavailable: ${entry.package}`);
    }
    const expression =
      entry.expression ??
      (typeof manifest.license === "string" ? manifest.license : null) ??
      (typeof manifest.licenseFile === "string" ? `LicenseRef-${manifest.licenseFile}` : null);
    const files = await collectLicenseFiles(entry.root, entry.label);
    const supplement = supplements?.byPackage.get(entry.package);
    const packageEntry = {
      package: entry.package,
      expression,
      files,
      workspaceRootLicenseApplicable: entry.workspaceRootLicenseApplicable === true,
    };
    if (supplement) packageEntry.supplementalFiles = supplement.files;
    packages.push(packageEntry);
  }
  const summary = summarizeLicenseMaterials(packages, upstreamLicense);
  if (supplements) {
    summary.supplements = {
      manifestPath: supplements.manifestPath,
      manifestSha256: supplements.manifestSha256,
      sourceRevision: supplements.sourceRevision,
      entryCount: supplements.byPackage.size,
    };
  }
  return summary;
}

export async function archiveLicenseMaterials({ summary, packageRoots, outputDir }) {
  const roots = new Map(packageRoots.map((entry) => [entry.package, entry]));
  const licensesRoot = join(outputDir, "licenses");
  const archivePaths = new Map();
  let fileCount = 0;
  for (const entry of summary.entries) {
    const root = roots.get(entry.package);
    if (!root) throw new ClosureVerificationError(`license package root missing: ${entry.package}`);
    if (!isSafeRelativePath(root.label)) {
      throw new ClosureVerificationError(`unsafe license archive label: ${root.label}`);
    }
    const prefix = `${root.label}/`;
    for (const file of entry.files) {
      if (!file.path.startsWith(prefix)) {
        throw new ClosureVerificationError(
          `license material path is outside package: ${file.path}`,
        );
      }
      const relativePath = file.path.slice(prefix.length);
      if (!isSafeRelativePath(relativePath)) {
        throw new ClosureVerificationError(`unsafe license archive path: ${file.path}`);
      }
      const sourcePath = join(root.root, relativePath);
      if (!isPathInside(root.root, sourcePath)) {
        throw new ClosureVerificationError(`license material path escapes package: ${file.path}`);
      }
      const destination = join(licensesRoot, root.label, relativePath);
      if (!isPathInside(outputDir, destination) || !isPathInside(licensesRoot, destination)) {
        throw new ClosureVerificationError(
          `license archive destination escapes output: ${file.path}`,
        );
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
      if ((await sha256File(destination)) !== file.sha256) {
        throw new ClosureVerificationError(`archived license material hash mismatch: ${file.path}`);
      }
      archivePaths.set(`${entry.package}\0${file.path}`, relative(outputDir, destination));
      fileCount += 1;
    }
    for (const file of entry.supplementalFiles ?? []) {
      const prefix = `${root.label}/`;
      if (!isSafeRelativePath(file.sourcePath) || !file.path.startsWith(prefix)) {
        throw new ClosureVerificationError(`invalid supplemental license path: ${file.path}`);
      }
      if (
        typeof file.sourceRoot !== "string" ||
        !isPathInside(file.sourceRoot, join(file.sourceRoot, file.sourcePath))
      ) {
        throw new ClosureVerificationError(
          `supplemental license path escapes source: ${file.path}`,
        );
      }
      const sourcePath = join(file.sourceRoot, file.sourcePath);
      const sourceMetadata = await lstat(sourcePath);
      if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
        throw new ClosureVerificationError(`invalid supplemental license source: ${file.path}`);
      }
      const relativePath = file.path.slice(prefix.length);
      if (!isSafeRelativePath(relativePath)) {
        throw new ClosureVerificationError(
          `unsafe supplemental license archive path: ${file.path}`,
        );
      }
      const destination = join(licensesRoot, root.label, relativePath);
      if (!isPathInside(outputDir, destination) || !isPathInside(licensesRoot, destination)) {
        throw new ClosureVerificationError(
          `supplemental license archive destination escapes output: ${file.path}`,
        );
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
      if ((await sha256File(destination)) !== file.sha256) {
        throw new ClosureVerificationError(
          `archived supplemental license hash mismatch: ${file.path}`,
        );
      }
      archivePaths.set(`${entry.package}\0${file.path}`, relative(outputDir, destination));
      fileCount += 1;
    }
  }
  const indexed = {
    ...summary,
    entries: summary.entries.map((entry) => {
      const indexedEntry = {
        ...entry,
        files: entry.files.map((file) => ({
          ...file,
          archivePath: archivePaths.get(`${entry.package}\0${file.path}`) ?? null,
        })),
      };
      if (entry.supplementalFiles) {
        indexedEntry.supplementalFiles = entry.supplementalFiles.map((file) => ({
          ...file,
          archivePath: archivePaths.get(`${entry.package}\0${file.path}`) ?? null,
        }));
      }
      return indexedEntry;
    }),
  };
  const indexPath = join(outputDir, "licenses-index.json");
  await writeJsonFile(indexPath, indexed);
  return {
    indexPath: relative(outputDir, indexPath),
    sha256: await sha256File(indexPath),
    fileCount,
  };
}
