import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { collectRuntimeModuleClosureEntries } from "../runtime-dependency-closure.mjs";

const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export async function exists(path) {
  return access(path, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export async function requireFile(path, label) {
  if (!(await exists(path))) throw new Error(`${label} is missing: ${path}`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  return {
    path,
    bytes: info.size,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}

export async function requireDirectory(path, label) {
  if (!(await exists(path))) throw new Error(`${label} is missing: ${path}`);
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return path;
}

export async function sha256Tree(root) {
  const hash = createHash("sha256");
  let bytes = 0;
  let entries = 0;
  async function walk(relativePath) {
    const absolutePath = relativePath ? join(root, relativePath) : root;
    const info = await lstat(absolutePath);
    const key = relativePath || ".";
    hash.update(`${info.isSymbolicLink() ? "l" : info.isDirectory() ? "d" : "f"}\0${key}\0`);
    if (info.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      hash.update(target);
      entries += 1;
      return;
    }
    if (info.isDirectory()) {
      for (const child of (await readdir(absolutePath)).sort()) {
        await walk(relativePath ? join(relativePath, child) : child);
      }
      return;
    }
    bytes += info.size;
    entries += 1;
    hash.update(await readFile(absolutePath));
  }
  await walk("");
  return { bytes, entries, sha256: hash.digest("hex") };
}

export async function assertNoSymlinks(root, label) {
  const symlinks = [];
  async function walk(path) {
    for (const child of await readdir(path, { withFileTypes: true })) {
      const childPath = join(path, child.name);
      if (child.isSymbolicLink()) {
        symlinks.push(childPath);
      } else if (child.isDirectory()) {
        await walk(childPath);
      }
    }
  }
  await walk(root);
  if (symlinks.length > 0) {
    throw new Error(`${label} contains symlinks:\n- ${symlinks.join("\n- ")}`);
  }
}

export async function assertBundleSymlinks(root, label) {
  const bundleRoot = resolve(root);
  const symlinks = [];
  async function walk(path) {
    for (const child of await readdir(path, { withFileTypes: true })) {
      const childPath = join(path, child.name);
      if (child.isSymbolicLink()) {
        const target = await readlink(childPath);
        if (!target.trim()) {
          throw new Error(`${label} has an empty symlink target: ${childPath}`);
        }
        if (isAbsolute(target)) {
          throw new Error(`${label} has an absolute symlink: ${childPath} -> ${target}`);
        }
        const resolvedTarget = resolve(dirname(childPath), target);
        const relativeTarget = relative(bundleRoot, resolvedTarget);
        if (
          isAbsolute(relativeTarget) ||
          relativeTarget === ".." ||
          relativeTarget.startsWith(`..${sep}`)
        ) {
          throw new Error(`${label} symlink escapes the app bundle: ${childPath} -> ${target}`);
        }
        symlinks.push({ path: childPath, target, resolvedTarget });
      } else if (child.isDirectory()) {
        await walk(childPath);
      }
    }
  }
  await walk(bundleRoot);
  return symlinks;
}

export async function assertMachO(path, label) {
  const info = await requireFile(path, label);
  const header = await readFile(path);
  if (header.length < 4) throw new Error(`${label} is too small to be Mach-O`);
  const magic = header.readUInt32BE(0);
  if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) {
    throw new Error(`${label} is not a Mach-O executable: ${path}`);
  }
  return info;
}

export function setPlistString(plistPath, key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
      stdio: "pipe",
    });
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], {
      stdio: "pipe",
    });
  }
}

export function getPlistString(plistPath, key) {
  return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], {
    encoding: "utf8",
  }).trim();
}

const CHROMIUM_HELPER_SUFFIXES = Object.freeze([
  "Helper",
  "Helper (GPU)",
  "Helper (Renderer)",
  "Helper (Plugin)",
]);

export async function renameElectronHelperBundles(
  frameworksDir,
  applicationName,
  { sourceApplicationName = "Electron" } = {},
) {
  const renamed = [];
  for (const suffix of CHROMIUM_HELPER_SUFFIXES) {
    const sourceName = `${sourceApplicationName} ${suffix}`;
    const targetName = `${applicationName} ${suffix}`;
    const sourceBundle = join(frameworksDir, `${sourceName}.app`);
    const targetBundle = join(frameworksDir, `${targetName}.app`);
    await rename(sourceBundle, targetBundle);
    const targetExecutable = join(targetBundle, "Contents/MacOS", targetName);
    await rename(join(targetBundle, "Contents/MacOS", sourceName), targetExecutable);
    const executable = await assertMachO(targetExecutable, `renamed ${targetName}`);
    const plistPath = join(targetBundle, "Contents/Info.plist");
    setPlistString(plistPath, "CFBundleExecutable", targetName);
    setPlistString(plistPath, "CFBundleName", targetName);
    setPlistString(plistPath, "CFBundleDisplayName", targetName);
    renamed.push({
      from: `${sourceName}.app`,
      to: `${targetName}.app`,
      executable: { path: targetExecutable, bytes: executable.bytes, sha256: executable.sha256 },
    });
  }
  return renamed;
}

function packageNameFromImport(specifier) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

export function collectExternalPackages(metafiles) {
  const packages = new Set();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs ?? {})) {
      for (const imported of output.imports ?? []) {
        if (!imported.external || !imported.path) continue;
        const specifier = imported.path;
        if (nodeBuiltins.has(specifier) || specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
        const packageName = packageNameFromImport(specifier);
        if (packageName !== "electron") packages.add(packageName);
      }
    }
  }
  return [...packages].sort();
}

export async function copyExternalRuntimeModules(nodeModulesDir, externalPackages, lookupRoots) {
  const closure = collectRuntimeModuleClosureEntries(externalPackages, lookupRoots);
  const copied = [];
  for (const entry of closure) {
    if (!entry.sourceModulePath || !entry.packageJsonPath) {
      throw new Error(`Runtime package is not resolvable: ${entry.moduleName}`);
    }
    const packageJson = JSON.parse(await readFile(entry.packageJsonPath, "utf8"));
    const destination = join(nodeModulesDir, ...entry.moduleName.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(entry.sourceModulePath, destination, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await assertNoSymlinks(destination, `runtime package ${entry.moduleName}`);
    const copiedPackageJson = await requireFile(
      join(destination, "package.json"),
      `copied runtime package ${entry.moduleName}`,
    );
    copied.push({
      name: entry.moduleName,
      version: packageJson.version ?? null,
      source: entry.sourceModulePath,
      destination,
      packageJsonSha256: copiedPackageJson.sha256,
    });
  }
  return copied;
}

export function setBundleMetadata(plistPath, displayName, bundleId, executableName) {
  setPlistString(plistPath, "CFBundleName", displayName);
  setPlistString(plistPath, "CFBundleDisplayName", displayName);
  setPlistString(plistPath, "CFBundleIdentifier", bundleId);
  if (executableName) setPlistString(plistPath, "CFBundleExecutable", executableName);
}
