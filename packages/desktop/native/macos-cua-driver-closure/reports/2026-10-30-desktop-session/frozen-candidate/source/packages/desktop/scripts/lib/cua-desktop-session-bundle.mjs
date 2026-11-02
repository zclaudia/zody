// sealed ESM 打包与封闭性审计。native 只接受固定 entry 名与资源 hash；
// 这里记录实际 runtime external 边界，不把 lazy require 当已验收闭包。
import { builtinModules } from "node:module";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import {
  DesktopSessionBuildError,
  ENTRY_NAMES,
  ESM_BANNER,
  MAX_ENTRY_BYTES,
  REPO_ROOT,
  UNSUPPORTED_NATIVE_PINS,
} from "./cua-desktop-session-config.mjs";
import { sha256File } from "./cua-desktop-session-toolchain.mjs";
import {
  createWorkspaceSourcePlugin,
  staleWorkspaceDistInputs,
} from "./cua-desktop-session-workspace-source.mjs";

export {
  staleWorkspaceDistInputs,
  workspaceSourceCounterpart,
} from "./cua-desktop-session-workspace-source.mjs";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const LICENSE_FILE = /^(license|licence|notice|copying|copyright)([._-].*)?$/i;

export async function loadUnsupportedNativeModules(pinsPath = UNSUPPORTED_NATIVE_PINS) {
  const raw = JSON.parse(await readFile(pinsPath, "utf8"));
  const modules = raw.modules ?? {};
  const loaded = {};
  for (const [name, entry] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof entry.file !== "string" || typeof entry.sha256 !== "string") {
      throw new DesktopSessionBuildError("unsupported-pins", `invalid pin for ${name}`);
    }
    const path = resolve(dirname(pinsPath), entry.file);
    const actual = await sha256File(path);
    if (actual !== entry.sha256) {
      throw new DesktopSessionBuildError(
        "unsupported-shim-mismatch",
        `throw-only shim for ${name} differs from its pinned hash`,
        { name, path, expected: entry.sha256, actual },
      );
    }
    loaded[name] = { path, sha256: actual, capability: entry.capability };
  }
  return loaded;
}

export async function bundleEntry({
  entry,
  output,
  metafilePath,
  workdir = REPO_ROOT,
  unsupportedModules,
  defines = {},
  aliases = {},
  moduleUrl = false,
}) {
  if (!unsupportedModules || Object.keys(unsupportedModules).length === 0) {
    throw new DesktopSessionBuildError(
      "unsupported-pins-missing",
      "bundleEntry requires verified throw-only native capability pins",
    );
  }
  const shimPlugin = {
    name: "cua-desktop-session-unsupported-native",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^[^./][^:]*$/ }, (args) => {
        const packageName = args.path.startsWith("@")
          ? args.path.split("/").slice(0, 2).join("/")
          : args.path.split("/")[0];
        const shim = unsupportedModules[packageName];
        if (!shim) return null;
        return { path: shim.path };
      });
    },
  };
  const selectedDefines = moduleUrl
    ? { ...defines, "import.meta.url": "__cuaModuleUrl" }
    : defines;
  const banner = moduleUrl
    ? `import { pathToFileURL as __cuaPathToFileURL } from "node:url";\n${ESM_BANNER}\nconst __cuaModuleUrl = __cuaPathToFileURL(process.execPath).href;`
    : ESM_BANNER;
  try {
    const result = await build({
      absWorkingDir: workdir,
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      define: selectedDefines,
      alias: aliases,
      legalComments: "eof",
      external: ["node:*"],
      banner: { js: banner },
      metafile: true,
      logLevel: "silent",
      plugins: [createWorkspaceSourcePlugin(), shimPlugin],
    });
    await writeFile(metafilePath, `${JSON.stringify(result.metafile)}\n`, { mode: 0o600 });
    return { warnings: result.warnings };
  } catch (error) {
    throw new DesktopSessionBuildError("bundle-failed", "esbuild sealed entry failed", {
      entry,
      stderr: `${error?.message ?? String(error)}\n${error?.errors ? JSON.stringify(error.errors) : ""}`.slice(
        -16_000,
      ),
    });
  }
}

function packageRootFromInput(input) {
  const marker = "node_modules/";
  const index = input.lastIndexOf(marker);
  if (index < 0) return undefined;
  const parts = input.slice(index + marker.length).split("/");
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!name || name.includes("..")) return undefined;
  return {
    name,
    dir: resolve(REPO_ROOT, input.slice(0, index + marker.length), name),
  };
}

async function readPackageMeta(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    return {
      name: typeof raw.name === "string" ? raw.name : undefined,
      version: typeof raw.version === "string" ? raw.version : undefined,
      license: typeof raw.license === "string" ? raw.license : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function inventoryLicenses({ metafile, destination }) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const parsed = packageRootFromInput(input);
    if (!parsed) continue;
    if (!packages.has(parsed.dir)) packages.set(parsed.dir, parsed);
  }
  const summary = { packageCount: packages.size, saved: [], missing: [] };
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let index = 0;
  for (const [dir, info] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = `${String(index).padStart(3, "0")}-${info.name.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    index += 1;
    const target = join(destination, key);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const meta = await readPackageMeta(dir);
    const entry = {
      name: meta?.name ?? info.name,
      version: meta?.version,
      license: meta?.license,
      packageJsonPresent: meta !== undefined,
      files: [],
    };
    if (meta !== undefined) {
      await copyFile(join(dir, "package.json"), join(target, "package.json"));
      entry.files.push("package.json");
    }
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      names = [];
    }
    let foundLicense = false;
    for (const name of names.sort()) {
      if (!LICENSE_FILE.test(name)) continue;
      try {
        if (!(await stat(join(dir, name))).isFile()) continue;
        await copyFile(join(dir, name), join(target, name));
        entry.files.push(name);
        foundLicense = true;
      } catch {
        // 单个许可读取失败不能伪造“已收集”；记入 missing。
      }
    }
    if (!foundLicense) summary.missing.push(entry.name);
    summary.saved.push(entry);
  }
  return summary;
}

function staticImportSpecifiers(text) {
  const specifiers = [];
  for (const match of text.matchAll(/^import\s+(?:[^"'();]*?\s+from\s+)?["']([^"']+)["'];?/gm)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function runtimeRequireSpecifiers(text) {
  // 只检查 esbuild 实际留下的 __require("literal") 调用；ajv 等 codegen 中的
  // 字符串字面量不是运行时解析，不能用宽泛 require 正则误报。
  return [
    ...new Set(
      [...text.matchAll(/\b__require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]),
    ),
  ];
}

export function findWebAssemblyReferences(text) {
  const matches = [];
  let count = 0;
  for (const match of text.matchAll(/\bWebAssembly\b/g)) {
    if (match.index === undefined) continue;
    count += 1;
    if (matches.length >= 32) continue;
    const before = text.slice(0, match.index);
    const line = before.split("\n").length;
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEnd = text.indexOf("\n", match.index);
    const snippet = text
      .slice(lineStart, lineEnd < 0 ? Math.min(text.length, match.index + 120) : lineEnd)
      .trim()
      .slice(0, 240);
    matches.push({ line, snippet });
  }
  return { count, matches };
}

export function validateEntryPins(entries) {
  if (!Array.isArray(entries) || entries.length !== ENTRY_NAMES.length) {
    throw new DesktopSessionBuildError(
      "entry-pin-set-incomplete",
      "sealed entry pins must cover exactly the fixed entry allowlist",
      { expected: ENTRY_NAMES, received: entries?.map?.((entry) => entry?.name) ?? [] },
    );
  }
  const byName = new Map();
  const byHash = new Map();
  for (const entry of entries) {
    if (!ENTRY_NAMES.includes(entry?.name)) {
      throw new DesktopSessionBuildError(
        "entry-pin-name-mismatch",
        `entry pin ${String(entry?.name)} is not in the fixed allowlist`,
        { entryName: entry?.name, expected: ENTRY_NAMES },
      );
    }
    if (byName.has(entry.name)) {
      throw new DesktopSessionBuildError(
        "entry-pin-duplicate-name",
        `entry pin ${entry.name} appears more than once`,
        { entryName: entry.name },
      );
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new DesktopSessionBuildError(
        "entry-pin-hash-invalid",
        `entry pin ${entry.name} has an invalid sha256`,
        { entryName: entry.name, sha256: entry.sha256 },
      );
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > entry.maxBytes) {
      throw new DesktopSessionBuildError(
        "entry-pin-size-invalid",
        `entry pin ${entry.name} has an invalid byte bound`,
        { entryName: entry.name, bytes: entry.bytes, maxBytes: entry.maxBytes },
      );
    }
    const sameHash = byHash.get(entry.sha256);
    if (sameHash !== undefined) {
      throw new DesktopSessionBuildError(
        "entry-pin-hash-collision",
        `entry pins ${sameHash} and ${entry.name} share one sealed bundle hash`,
        { first: sameHash, second: entry.name, sha256: entry.sha256 },
      );
    }
    byName.set(entry.name, entry);
    byHash.set(entry.sha256, entry.name);
  }
  return Object.fromEntries(ENTRY_NAMES.map((name) => [name, byName.get(name).sha256]));
}

export async function auditEntry({
  name,
  output,
  metafilePath,
  licenseDestination,
  maxBytes = MAX_ENTRY_BYTES,
}) {
  const size = (await stat(output)).size;
  if (size > maxBytes) {
    throw new DesktopSessionBuildError(
      "entry-too-large",
      `sealed entry ${name} is ${size} bytes, above bounded limit ${maxBytes}`,
      { size, maxBytes },
    );
  }
  const text = await readFile(output, "utf8");
  if (/\bfrom\s*["']@zcode\//.test(text) || /\bimport\s*\(\s*["']@zcode\//.test(text)) {
    throw new DesktopSessionBuildError(
      "entry-external-package",
      `sealed entry ${name} kept a runtime @zcode import`,
    );
  }
  // 中文原因：入口可以是真正的 Host/CLI bundle，但它不能靠未封装的外部
  // require 假装闭包；只允许 manifest 明确声明的懒加载 runtime external。
  const imports = [...new Set(staticImportSpecifiers(text))];
  const nonBuiltinStaticImports = imports.filter(
    (specifier) => !BUILTINS.has(specifier),
  );
  if (nonBuiltinStaticImports.length > 0) {
    throw new DesktopSessionBuildError(
      "entry-external-import",
      `sealed entry ${name} has undeclared non-builtin static imports`,
      { nonBuiltinStaticImports },
    );
  }
  const runtimeRequires = runtimeRequireSpecifiers(text);
  const nonBuiltinRuntimeRequires = runtimeRequires.filter(
    (specifier) => !BUILTINS.has(specifier),
  );
  if (nonBuiltinRuntimeRequires.length > 0) {
    throw new DesktopSessionBuildError(
      "entry-runtime-require",
      `sealed entry ${name} still resolves non-builtin modules at runtime`,
      { nonBuiltinRuntimeRequires },
    );
  }
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const staleWorkspaceInputs = staleWorkspaceDistInputs(metafile);
  if (staleWorkspaceInputs.length > 0) {
    throw new DesktopSessionBuildError(
      "entry-stale-workspace-dist",
      `sealed entry ${name} still resolves workspace dist inputs`,
      { entryName: name, inputs: staleWorkspaceInputs.slice(0, 32) },
    );
  }
  const outputExternal = new Set();
  for (const outputInfo of Object.values(metafile.outputs ?? {})) {
    for (const imported of outputInfo.imports ?? []) {
      if (imported.external) outputExternal.add(imported.path);
    }
  }
  const nonBuiltinOutputExternals = [...outputExternal].filter(
    (specifier) => !BUILTINS.has(specifier),
  );
  if (nonBuiltinOutputExternals.length > 0) {
    throw new DesktopSessionBuildError(
      "entry-external-output-import",
      `sealed entry ${name} has undeclared runtime externals`,
      { nonBuiltinOutputExternals },
    );
  }
  const inputHashes = {};
  for (const input of Object.keys(metafile.inputs ?? {}).sort()) {
    inputHashes[input] = await sha256File(resolve(REPO_ROOT, input));
  }
  const licenses = licenseDestination
    ? await inventoryLicenses({ metafile, destination: licenseDestination })
    : undefined;
  const webAssembly = findWebAssemblyReferences(text);
  return {
    name,
    path: output,
    sha256: await sha256File(output),
    bytes: size,
    maxBytes,
    metafilePath,
    metafileSha256: await sha256File(metafilePath),
    inputCount: Object.keys(metafile.inputs ?? {}).length,
    staticImports: imports,
    nonBuiltinStaticImports,
    runtimeRequires: runtimeRequires.filter((specifier) => BUILTINS.has(specifier)),
    runtimeExternals: [...outputExternal]
      .filter((specifier) => !BUILTINS.has(specifier))
      .sort(),
    webAssemblyReferences: webAssembly,
    inputHashes,
    licenses,
  };
}

export async function writeEntryAudit(dir, audit) {
  const { inputHashes, ...rest } = audit;
  await writeFile(
    join(dir, `${audit.name}.inputs.json`),
    `${JSON.stringify(inputHashes, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, `${audit.name}.audit.json`),
    `${JSON.stringify(rest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { inputCount: Object.keys(inputHashes).length };
}
