// sealed ESM 打包与封闭性/许可审计。真正入口是 bootstrap tests fixture（真实 create-app），
// 不是生产公开 API；builder 只把它作为源码入口。
import { builtinModules } from "node:module";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ESM_BANNER,
  KOFFI_PLATFORM_TRIM,
  MAX_BUNDLE_BYTES,
  ProductWiringBuildError,
  REPO_ROOT,
} from "./cua-helper-product-wiring-config.mjs";
import { moduleSpecifiers } from "./cua-module-specifiers.mjs";
import { run, sha256File } from "./cua-helper-product-wiring-toolchain.mjs";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const LICENSE_FILE = /^(license|licence|notice|copying|copyright)([._-].*)?$/i;

export async function bundleSealedEntry({
  esbuildPath,
  entry,
  output,
  metafilePath,
  workdir = REPO_ROOT,
}) {
  const args = [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node24",
    "--legal-comments=eof",
    "--external:node:*",
    `--alias:koffi=${KOFFI_PLATFORM_TRIM}`,
    `--banner:js=${ESM_BANNER}`,
    `--metafile=${metafilePath}`,
    `--outfile=${output}`,
  ];
  const result = await run(esbuildPath, args, { cwd: workdir, timeoutMs: 180_000 });
  if (result.code !== 0) {
    throw new ProductWiringBuildError("bundle-failed", "esbuild sealed entry failed", {
      command: [esbuildPath, ...args].join(" "),
      stdout: result.stdout.slice(-8_000),
      stderr: result.stderr.slice(-16_000),
    });
  }
  return { args, stdout: result.stdout, stderr: result.stderr };
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

/** 收集 metafile 触及的 node_modules 包，保存 package.json 与已有 LICENSE/NOTICE。 */
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
        // 单个许可文件不可读时继续，最终在 summary 里如实记录。
      }
    }
    if (foundLicense) summary.saved.push(entry);
    else {
      entry.missingLicense = true;
      summary.missing.push(entry);
    }
  }
  return summary;
}

export async function auditSealedBundle({
  output,
  metafilePath,
  licenseDestination,
  maxBytes = MAX_BUNDLE_BYTES,
}) {
  const size = (await stat(output)).size;
  if (size > maxBytes) {
    throw new ProductWiringBuildError(
      "bundle-too-large",
      `sealed bundle ${size} bytes exceeds bounded limit ${maxBytes}`,
      { size, maxBytes },
    );
  }
  const text = await readFile(output, "utf8");
  // 修复原因：两个 workspace scope 的真实导入或 require 均不能留在封装结果中。
  const references = moduleSpecifiers(text);
  if (
    [
      ...references.imports,
      ...references.dynamic,
      ...references.requires.map(({ specifier }) => specifier),
    ].some((specifier) => /^@(?:zcode|zody)\//.test(specifier))
  ) {
    throw new ProductWiringBuildError(
      "bundle-external-package",
      "sealed bundle kept a runtime workspace reference",
    );
  }
  const imports = [...new Set(references.imports)];
  const nonBuiltinImports = imports.filter((specifier) => !BUILTINS.has(specifier));
  if (nonBuiltinImports.length > 0) {
    throw new ProductWiringBuildError(
      "bundle-external-import",
      "sealed bundle has non-builtin static imports",
      { nonBuiltinImports },
    );
  }
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  // 输入级 external 可能包含被 tree-shake 的 type-only/optional 引用；以 outputs.imports
  // 作为实际运行时依赖的权威来源。
  const metafileExternal = new Set();
  for (const info of Object.values(metafile.inputs ?? {})) {
    for (const imported of info.imports ?? []) {
      if (imported.external) metafileExternal.add(imported.path);
    }
  }
  const outputExternal = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.external) outputExternal.add(imported.path);
    }
  }
  const nonBuiltinOutputExternals = [...outputExternal].filter(
    (specifier) => !BUILTINS.has(specifier),
  );
  if (nonBuiltinOutputExternals.length > 0) {
    throw new ProductWiringBuildError(
      "bundle-external-output-import",
      "sealed bundle output has non-builtin external imports",
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

  // 明确记录唯一已知的运行时休眠外部：ripgrep 在 fs worker 的源码字符串里懒加载，
  // 当前 held-model fixture 不触发工具/搜索；它不是 bundle 静态 import。
  const dormantRuntimeExternals = [];
  if (/import\(\s*["']ripgrep["']\s*\)/.test(text)) {
    dormantRuntimeExternals.push({
      name: "ripgrep",
      reason:
        "fs adapter 的 worker 源码字符串内 lazy import；held-model fixture 不执行搜索工具，非 bundle 静态依赖",
      evidence: "apps/zody-cli/packages/adapters/src/fs/index.ts",
    });
  }

  return {
    path: output,
    sha256: await sha256File(output),
    bytes: size,
    maxBytes,
    metafilePath,
    metafileSha256: await sha256File(metafilePath),
    inputCount: Object.keys(metafile.inputs ?? {}).length,
    inputHashes,
    staticImports: imports,
    nonBuiltinStaticImports: nonBuiltinImports,
    outputExternalImports: [...outputExternal].sort(),
    nonBuiltinOutputExternals,
    metafileInputExternals: [...metafileExternal].sort(),
    dormantRuntimeExternals,
    licenses,
  };
}

export async function writeBundleAudit(dir, audit) {
  const { inputHashes, ...rest } = audit;
  await writeFile(join(dir, "esbuild-inputs.json"), `${JSON.stringify(inputHashes, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(join(dir, "esbuild-audit.json"), `${JSON.stringify(rest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { inputCount: Object.keys(inputHashes).length };
}
