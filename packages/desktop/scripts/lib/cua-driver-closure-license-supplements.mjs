import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ClosureVerificationError,
  isPathInside,
  isRecord,
  isSafeRelativePath,
  isSha256,
  sha256Buffer,
} from "./cua-driver-closure-core.mjs";
import { readLicenseMaterial } from "./cua-driver-closure-license-text.mjs";

export const LICENSE_SUPPLEMENTS_KIND = "zody-cua-driver-closure-license-supplements";
const RELATION_KINDS = new Set([
  "package-root-license",
  "workspace-root-license",
  "repository-root-license",
]);

function fail(message) {
  throw new ClosureVerificationError(message);
}

function stringField(object, key, label = key) {
  if (!isRecord(object) || typeof object[key] !== "string" || object[key].length === 0) {
    fail(`invalid ${label}`);
  }
  return object[key];
}

function shaField(object, key, label = key) {
  const value = stringField(object, key, label);
  if (!isSha256(value)) fail(`invalid ${label}`);
  return value;
}

function gitUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`invalid ${label}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    fail(`invalid ${label}`);
  }
  return value.replace(/\.git$/, "").replace(/\/$/, "");
}

function packageKey(name, version) {
  return `${name}@${version}`;
}

function section(text, name) {
  const start = new RegExp(`(?:^|\\n)\\[${name.replaceAll(".", "\\.")}\\]\\s*\\n`).exec(text);
  if (!start) return null;
  const bodyStart = start.index + start[0].length;
  const next = /\n\[[^\]]+\]\s*(?:\n|$)/g;
  next.lastIndex = bodyStart;
  const end = next.exec(text);
  return text.slice(bodyStart, end ? end.index : text.length);
}

function tomlString(body, key) {
  const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`).exec(body ?? "");
  return match?.[1] ?? null;
}

function usesWorkspaceValue(body, key) {
  return new RegExp(`(?:^|\\n)\\s*${key}\\s*\\.\\s*workspace\\s*=\\s*true\\b`).test(body ?? "");
}

function packageMetadata(text) {
  const packageSection = section(text, "package");
  return {
    name: tomlString(packageSection, "name"),
    version: tomlString(packageSection, "version"),
    versionWorkspace: usesWorkspaceValue(packageSection, "version"),
    license: tomlString(packageSection, "license"),
    licenseWorkspace: usesWorkspaceValue(packageSection, "license"),
    repository: tomlString(packageSection, "repository"),
  };
}

async function readRegular(path, label) {
  const metadata = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") fail(`missing ${label}`);
    throw error;
  });
  if (metadata.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (!metadata.isFile()) fail(`${label} is not a regular file`);
  return readFile(path);
}

async function assertNoSymlinkSegments(root, relativePath) {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    const metadata = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") fail(`missing supplement path: ${relativePath}`);
      throw error;
    });
    if (metadata.isSymbolicLink())
      fail(`supplement path must not contain a symlink: ${relativePath}`);
  }
  const resolved = await realpath(current);
  if (!isPathInside(root, resolved)) fail(`supplement path escapes root: ${relativePath}`);
  return current;
}

async function findWorkspace(packageRoot) {
  let directory = await realpath(packageRoot);
  for (;;) {
    const parent = dirname(directory);
    if (parent === directory) fail("workspace root manifest not found");
    directory = parent;
    const path = join(directory, "Cargo.toml");
    const bytes = await readFile(path).catch(() => null);
    if (bytes && /(?:^|\n)\[workspace\]\s*(?:\n|$)/.test(bytes.toString("utf8"))) {
      return { root: directory, path, text: bytes.toString("utf8") };
    }
  }
}

function normalizeRepo(value) {
  return value?.replace(/\.git$/, "").replace(/\/$/, "") ?? null;
}

async function validateRelation({
  entry,
  packageRoot,
  packageRootText,
  metadata,
  vcs,
  sourceRevision,
}) {
  const relation = entry.relation;
  const source = entry.source;
  // 关系校验只使用当前 entry；曾经把总 manifest 传进来导致 relation/source
  // 读错对象，这里显式以 entry 为准，packageRoot/metadata 仅来自实际输入。
  if (!isRecord(relation) || !RELATION_KINDS.has(relation.kind))
    fail("invalid supplement relation");
  stringField(relation, "evidence", "supplement relation evidence");
  const expression = stringField(relation, "licenseExpression", "relation license expression");
  const actualExpression = packageRoot.expression ?? metadata.license;
  if (actualExpression && actualExpression !== expression) {
    fail(`supplement relation expression mismatch: ${packageRoot.package}`);
  }
  if (relation.kind === "workspace-root-license") {
    if (!metadata.licenseWorkspace)
      fail(`package does not inherit a workspace license: ${packageRoot.package}`);
    if (sourceRevision && source.commit !== sourceRevision) {
      fail(`workspace supplement source commit differs from revision: ${packageRoot.package}`);
    }
    if (source.path.includes("/")) fail("workspace root license must be a repository-root file");
    const workspace = await findWorkspace(packageRoot.root);
    if (
      sha256Buffer(await readFile(workspace.path)) !==
      shaField(relation, "workspaceCargoTomlSha256")
    ) {
      fail(`workspace Cargo.toml hash mismatch: ${packageRoot.package}`);
    }
    const workspacePackage = section(workspace.text, "workspace.package");
    const workspaceLicense = tomlString(workspacePackage, "license");
    if (workspaceLicense !== expression)
      fail(`workspace license expression mismatch: ${packageRoot.package}`);
    const workspaceVersion = tomlString(workspacePackage, "version");
    if (metadata.versionWorkspace && workspaceVersion !== entry.version) {
      fail(`workspace package version mismatch: ${packageRoot.package}`);
    }
    const workspaceRepo = normalizeRepo(tomlString(workspacePackage, "repository"));
    if (workspaceRepo && workspaceRepo !== normalizeRepo(source.repo)) {
      fail(`workspace repository mismatch: ${packageRoot.package}`);
    }
  } else if (relation.kind === "package-root-license") {
    if (!vcs?.sha1 || !vcs.pathInVcs) fail(`package vcs metadata missing: ${packageRoot.package}`);
    // registry 正文必须绑定实际 .cargo_vcs_info.json 的 commit，且 path 位于
    // path_in_vcs 目录内；外层还会校验仓库地址与 VCS 原文件摘要。
    if (vcs.sha1 !== source.commit) fail(`package vcs commit mismatch: ${packageRoot.package}`);
    if (!source.path.startsWith(`${vcs.pathInVcs}/`)) {
      fail(`package root license path mismatch: ${packageRoot.package}`);
    }
  } else {
    if (source.path.includes("/")) fail("repository root license must be a repository-root file");
    if (!actualExpression || actualExpression !== expression) {
      fail(`repository root relation lacks a matching package expression: ${packageRoot.package}`);
    }
    if (!metadata.repository || normalizeRepo(metadata.repository) !== normalizeRepo(source.repo)) {
      fail(`repository root relation repository mismatch: ${packageRoot.package}`);
    }
  }
  if (metadata.versionWorkspace) {
    if (relation.kind !== "workspace-root-license")
      fail(`workspace version requires workspace relation: ${packageRoot.package}`);
  }
  // 这里必须校验包内 Cargo.toml 原文的摘要，不能用许可正文 hash 代替；
  // 否则正文未变但 Cargo.toml 漂移时会漏检。
  if (sha256Buffer(Buffer.from(packageRootText, "utf8")) !== entry.cargoTomlSha256) {
    fail(`Cargo.toml hash mismatch: ${packageRoot.package}`);
  }
}

function validateEntryShape(entry) {
  if (!isRecord(entry)) fail("invalid supplement entry");
  const name = stringField(entry, "name", "supplement package name");
  const version = stringField(entry, "version", "supplement package version");
  if (entry.lockChecksum !== null && !isSha256(entry.lockChecksum))
    fail(`invalid lock checksum: ${name}`);
  shaField(entry, "cargoTomlSha256", `Cargo.toml hash for ${name}`);
  if (entry.cargoVcsSha1 !== null && !/^[a-f0-9]{40}$/.test(entry.cargoVcsSha1 ?? "")) {
    fail(`invalid cargo vcs sha1: ${name}`);
  }
  if (entry.cargoVcsInfoSha256 !== null && !isSha256(entry.cargoVcsInfoSha256)) {
    fail(`invalid cargo vcs info hash: ${name}`);
  }
  const source = entry.source;
  if (!isRecord(source)) fail(`invalid supplement source: ${name}`);
  gitUrl(stringField(source, "repo", `repository for ${name}`), `repository for ${name}`);
  if (!/^[a-f0-9]{40}$/.test(stringField(source, "commit", `source commit for ${name}`))) {
    fail(`invalid source commit for ${name}`);
  }
  if (!isSafeRelativePath(stringField(source, "path", `source path for ${name}`))) {
    fail(`source path must be safe relative path for ${name}`);
  }
  const text = entry.text;
  if (!isRecord(text)) fail(`invalid supplement text: ${name}`);
  if (!isSafeRelativePath(stringField(text, "path", `text path for ${name}`))) {
    fail(`text.path must be a safe relative path: ${name}`);
  }
  shaField(text, "sha256", `text hash for ${name}`);
  if (!Number.isInteger(text.bytes) || text.bytes < 1) fail(`invalid text bytes: ${name}`);
  if (!isRecord(entry.relation)) fail(`invalid supplement relation: ${name}`);
  return { name, version };
}

export async function loadLicenseSupplements({
  manifestPath,
  packageRoots,
  lockPackages,
  sourceRevision,
}) {
  if (!Array.isArray(packageRoots) || packageRoots.length === 0)
    fail("supplement package roots missing");
  const manifestMetadata = await lstat(manifestPath).catch((error) => {
    if (error?.code === "ENOENT") fail(`license supplements manifest missing: ${manifestPath}`);
    throw error;
  });
  if (manifestMetadata.isSymbolicLink()) fail("license supplements manifest must not be a symlink");
  if (!manifestMetadata.isFile()) fail("license supplements manifest is not a regular file");
  const supplementsRoot = await realpath(dirname(manifestPath));
  const manifestBytes = await readRegular(manifestPath, "license supplements manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("license supplements manifest is invalid JSON");
  }
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== LICENSE_SUPPLEMENTS_KIND ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? "") ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0
  ) {
    fail("invalid license supplements manifest schema");
  }
  if (sourceRevision && manifest.sourceRevision !== sourceRevision)
    fail("license supplements source revision mismatch");

  const roots = new Map();
  for (const packageRoot of packageRoots) {
    if (!isRecord(packageRoot) || typeof packageRoot.package !== "string")
      fail("invalid package root");
    if (roots.has(packageRoot.package)) fail(`duplicate package root: ${packageRoot.package}`);
    roots.set(packageRoot.package, packageRoot);
  }
  const locks = new Map();
  if (lockPackages !== undefined && !Array.isArray(lockPackages))
    fail("lockPackages must be an array");
  for (const locked of lockPackages ?? []) {
    if (
      !isRecord(locked) ||
      typeof locked.name !== "string" ||
      typeof locked.version !== "string"
    ) {
      fail("invalid lock package");
    }
    const key = packageKey(locked.name, locked.version);
    if (locks.has(key)) fail(`duplicate lock package: ${key}`);
    locks.set(key, locked);
  }

  const seen = new Set();
  const byPackage = new Map();
  for (const entry of manifest.entries) {
    const { name, version } = validateEntryShape(entry);
    const key = packageKey(name, version);
    if (seen.has(key)) fail(`duplicate supplement entry: ${key}`);
    seen.add(key);
    const packageRoot = roots.get(key);
    if (!packageRoot) fail(`supplement package is unknown or not in graph: ${key}`);
    if (typeof packageRoot.root !== "string" || typeof packageRoot.label !== "string") {
      fail(`invalid package root: ${key}`);
    }
    const packageRootBytes = await readRegular(
      join(packageRoot.root, "Cargo.toml"),
      `Cargo.toml for ${key}`,
    );
    const packageRootText = packageRootBytes.toString("utf8");
    const metadata = packageMetadata(packageRootText);
    if (metadata.name !== name) fail(`Cargo.toml package name mismatch: ${key}`);
    if (metadata.version !== null && metadata.version !== version)
      fail(`Cargo.toml version mismatch: ${key}`);
    if (metadata.version === null && !metadata.versionWorkspace)
      fail(`Cargo.toml version missing: ${key}`);

    let vcs = null;
    let vcsInfoSha256 = null;
    const vcsBytes = await readFile(join(packageRoot.root, ".cargo_vcs_info.json")).catch(
      () => null,
    );
    if (vcsBytes) {
      const vcsPath = join(packageRoot.root, ".cargo_vcs_info.json");
      if ((await lstat(vcsPath)).isSymbolicLink())
        fail(`VCS metadata must not be a symlink: ${key}`);
      vcsInfoSha256 = sha256Buffer(vcsBytes);
      try {
        const parsed = JSON.parse(vcsBytes.toString("utf8"));
        vcs = { sha1: parsed?.git?.sha1, pathInVcs: parsed?.path_in_vcs };
      } catch {
        fail(`invalid VCS metadata: ${key}`);
      }
    }
    // workspace 条目没有 VCS 元数据，必须显式处理 null；不能把 null 与
    // 期望的 null 之外的值做宽松比较，否则会把缺证当成通过。
    if ((entry.cargoVcsSha1 === null) !== (vcs === null))
      fail(`VCS metadata presence mismatch: ${key}`);
    if ((entry.cargoVcsInfoSha256 === null) !== (vcs === null)) {
      fail(`VCS metadata hash presence mismatch: ${key}`);
    }
    if (vcs && vcs.sha1 !== entry.cargoVcsSha1) fail(`VCS commit mismatch: ${key}`);
    if (vcsInfoSha256 !== entry.cargoVcsInfoSha256) fail(`VCS metadata hash mismatch: ${key}`);
    if (vcs && normalizeRepo(metadata.repository) !== normalizeRepo(entry.source.repo)) {
      fail(`package repository mismatch: ${key}`);
    }
    if (vcs && vcs.sha1 !== entry.source.commit) fail(`package vcs commit mismatch: ${key}`);

    const locked = locks.get(key);
    if (entry.lockChecksum !== null) {
      if (lockPackages === undefined)
        fail(`lockPackages is required for registry supplement: ${key}`);
      if (!locked) fail(`supplement package is missing from lock: ${key}`);
      if (locked.checksum !== entry.lockChecksum) fail(`lock checksum mismatch: ${key}`);
    } else if (locked && locked.checksum) {
      fail(`workspace supplement unexpectedly has a lock checksum: ${key}`);
    }

    const source = entry.source;
    const relation = entry.relation;
    // 固定传当前 entry，防止关系校验误读总 manifest。
    await validateRelation({ entry, packageRoot, packageRootText, metadata, vcs, sourceRevision });
    const textPath = await assertNoSymlinkSegments(supplementsRoot, entry.text.path);
    let material;
    try {
      material = await readLicenseMaterial(textPath);
    } catch (error) {
      fail(`supplement license text is incomplete or unreadable: ${key}: ${error.message}`);
    }
    if (!material.isLicense) {
      fail(`supplement license text is incomplete or unrecognized: ${key}`);
    }
    if (material.sha256 !== entry.text.sha256) fail(`supplement text hash mismatch: ${key}`);
    if (material.bytes !== entry.text.bytes) fail(`supplement text bytes mismatch: ${key}`);

    const sourceRecord = {
      package: key,
      repo: source.repo,
      commit: source.commit,
      path: source.path,
      relation: relation.kind,
      evidence: relation.evidence,
      manifestPath,
      manifestSha256: sha256Buffer(manifestBytes),
      text: {
        path: entry.text.path,
        sha256: material.sha256,
        bytes: material.bytes,
        licenseIdentifiers: material.identifiers,
      },
    };
    const archivedName = `${material.sha256.slice(0, 12)}-${basename(entry.text.path)}`;
    const file = {
      path: `${packageRoot.label}/supplements/${archivedName}`,
      sha256: material.sha256,
      bytes: material.bytes,
      licenseIdentifiers: material.identifiers,
      materialKind: "license",
      sourceKind: "supplement",
      sourceRoot: supplementsRoot,
      sourcePath: entry.text.path,
      provenance: sourceRecord,
    };
    byPackage.set(key, { ...sourceRecord, files: [file], material });
  }
  return {
    manifestPath,
    manifestSha256: sha256Buffer(manifestBytes),
    supplementsRoot,
    sourceRevision: manifest.sourceRevision,
    byPackage,
  };
}
