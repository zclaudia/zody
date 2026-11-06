#!/usr/bin/env node
// 独立 Electron UI 候选构建。只使用未签名的原厂 Electron 作为 UI 壳；不签名、不申请 TCC、
// 不启动应用或截图。可信 Host/CLI 仍由输入的原生 launcher 在运行时验证。
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getBuildMetadata } from "./build-metadata.mjs";
import { DESKTOP_MAIN_ENTRYPOINTS } from "./desktop-main-entrypoints.mjs";
import { resolveDesktopProductFlavor } from "./desktop-product-identity.mjs";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";
import {
  createBuildTimeConfigDefines,
  resolveBuildTimeConfig,
} from "../../../scripts/build-time-config.mjs";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "../..");
const DEFAULT_OUTPUT = join(REPO_ROOT, "output/cua-desktop-session/ui-candidate");
const DEFAULT_RENDERER = join(DESKTOP_ROOT, "out/renderer");
const DEFAULT_PRELOAD = join(DESKTOP_ROOT, "out/preload");
const DEFAULT_PLUGIN_SANDBOX = join(DESKTOP_ROOT, "out/plugin-sandbox");
const DEFAULT_PROVIDER_CONFIG = join(REPO_ROOT, "config/provider/zody-builtin.json");
const RUNTIME_EXTERNALS = ["electron", "node-pty", "ssh2", "undici", "yaml", "node-forge", "yauzl"];
const DESKTOP_SCHEDULER_ENTRYPOINTS = Object.freeze({
  "scheduler/index": "src/scheduler/index.ts",
});
// esbuild 把 CJS 依赖内联进 ESM 时会生成 `typeof require` 的 helper。独立候选构建
// 必须像 Node ESM 入口一样显式提供 createRequire，否则 Electron 启动即报
// `Dynamic require of "util" is not supported`。这是构建互操作 shim，不是信任边界。
const ESM_CJS_INTEROP_BANNER =
  'import { createRequire as __zcodeCreateRequire } from "node:module"; ' +
  'import { fileURLToPath as __zcodeFileURLToPath } from "node:url"; ' +
  'import { dirname as __zcodeDirname } from "node:path"; ' +
  "const require = __zcodeCreateRequire(import.meta.url); " +
  "const __filename = __zcodeFileURLToPath(import.meta.url); " +
  "const __dirname = __zcodeDirname(__filename);";
const requireFromDesktop = createRequire(import.meta.url);

function usage() {
  return `Usage: node packages/desktop/scripts/build-cua-desktop-ui.mjs \\
  --launcher <absolute native launcher> [--launcher-cwd <absolute cwd>] \\
  [--output <absolute output dir>] [--renderer <absolute renderer dir>] \\
  [--preload <absolute preload dir>] [--plugin-sandbox <absolute dir>] \\
  [--bridge-fd <fd>] [--no-minify] [--replace]`;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--replace" || name === "--no-minify" || name === "--help" || name === "-h") {
      flags.add(name);
      continue;
    }
    if (!name?.startsWith("--")) throw new Error(`Unknown argument: ${name ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("--help") || flags.has("-h")) return { help: true };
  const required = (name) => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`${name} is required`);
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return resolve(value);
  };
  const launcherPath = required("--launcher");
  const launcherCwd = values.has("--launcher-cwd")
    ? required("--launcher-cwd")
    : dirname(launcherPath);
  const output = values.has("--output") ? required("--output") : DEFAULT_OUTPUT;
  const renderer = values.has("--renderer") ? required("--renderer") : DEFAULT_RENDERER;
  const preload = values.has("--preload") ? required("--preload") : DEFAULT_PRELOAD;
  const pluginSandbox = values.has("--plugin-sandbox")
    ? required("--plugin-sandbox")
    : DEFAULT_PLUGIN_SANDBOX;
  const bridgeFd = values.has("--bridge-fd") ? Number(values.get("--bridge-fd")) : 5;
  if (!Number.isInteger(bridgeFd) || bridgeFd < 3 || bridgeFd > 1024) {
    throw new Error("--bridge-fd must be an integer between 3 and 1024");
  }
  return {
    help: false,
    launcherPath,
    launcherCwd,
    output,
    renderer,
    preload,
    pluginSandbox,
    bridgeFd,
    replace: flags.has("--replace"),
    minify: !flags.has("--no-minify"),
  };
}

async function exists(path) {
  return access(path, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function requireFile(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} is not a file: ${path}`);
  return { path, bytes: info.size, sha256: await sha256File(path) };
}

async function requireDirectory(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return path;
}

async function resolveElectron() {
  const packageJsonPath = requireFromDesktop.resolve("electron/package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const executable = join(
    dirname(packageJsonPath),
    "dist",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  await requireFile(executable, "Electron executable");
  return { packageJsonPath, version: packageJson.version, executable };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function copyDirectory(source, destination, label) {
  await requireDirectory(source, label);
  await cp(source, destination, { recursive: true, errorOnExist: true });
  return { source, destination };
}

async function buildCandidate(options) {
  const { environment } = await loadBuiltinProviderConfig({ root: REPO_ROOT });
  const productFlavor = resolveDesktopProductFlavor({ ...process.env, ZODY_ENV: environment });
  const buildMetadata = getBuildMetadata();
  const buildTimeDefines = createBuildTimeConfigDefines(
    await resolveBuildTimeConfig(process.env),
  );
  const nativeHostLaunch = {
    launcherPath: options.launcherPath,
    cwd: options.launcherCwd,
    entryName: "host-entry.mjs",
    bridgeFd: options.bridgeFd,
  };
  const define = {
    __ZODY_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZODY_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZODY_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZODY_ENV__: JSON.stringify(environment),
    __ZODY_PRODUCT_FLAVOR__: JSON.stringify(productFlavor),
    ...buildTimeDefines,
    __ZODY_CUA_HELPER_BUILD_ID__: JSON.stringify(""),
    __ZODY_REMOTE_CDN_RELEASE_ROOTS__: JSON.stringify([]),
    __ZODY_PACKAGED_AGENT_TELEMETRY_ENV__: JSON.stringify({}),
    __ZODY_CANDIDATE_NATIVE_HOST_LAUNCH__: JSON.stringify(nativeHostLaunch),
  };

  const outputParent = dirname(options.output);
  await mkdir(outputParent, { recursive: true });
  const staging = await mkdtemp(join(outputParent, ".ui-candidate-"));
  try {
    const appDir = join(staging, "app");
    await mkdir(appDir, { recursive: true, mode: 0o700 });
    const launcher = await requireFile(options.launcherPath, "native launcher");
    const electron = await resolveElectron();
    const rendererSource = await copyDirectory(options.renderer, join(appDir, "renderer"), "renderer output");
    const preloadSource = await copyDirectory(options.preload, join(appDir, "preload"), "preload output");
    const pluginSandboxSource = (await exists(options.pluginSandbox))
      ? await copyDirectory(options.pluginSandbox, join(appDir, "plugin-sandbox"), "plugin-sandbox output")
      : undefined;
    const providerConfig = await requireFile(DEFAULT_PROVIDER_CONFIG, "builtin provider config");
    const providerConfigDestination = join(staging, "config/provider/zody-builtin.json");
    await mkdir(dirname(providerConfigDestination), { recursive: true, mode: 0o700 });
    await copyFile(providerConfig.path, providerConfigDestination);
    for (const directory of ["profile/user-data", "profile/session-data"]) {
      await mkdir(join(staging, directory), { recursive: true, mode: 0o700 });
    }

    const metafilePath = join(staging, "main.metafile.json");
    const result = await build({
      absWorkingDir: DESKTOP_ROOT,
      entryPoints: { ...DESKTOP_MAIN_ENTRYPOINTS },
      outdir: appDir,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: RUNTIME_EXTERNALS,
      define,
      banner: { js: ESM_CJS_INTEROP_BANNER },
      keepNames: options.minify,
      minify: options.minify,
      sourcemap: false,
      legalComments: "none",
      chunkNames: "main/chunk-[hash]",
      metafile: true,
      logLevel: "info",
    });
    await writeFile(metafilePath, `${JSON.stringify(result.metafile)}\n`, { mode: 0o600 });

    // Main 会在 ready 阶段 eager fork scheduler；候选 app 布局必须与 tsup 一样提供
    // app/scheduler/index.js。scheduler 使用独立的 chunk 目录和同一套 Node ESM defines。
    const schedulerMetafilePath = join(staging, "scheduler.metafile.json");
    const schedulerResult = await build({
      absWorkingDir: DESKTOP_ROOT,
      entryPoints: { ...DESKTOP_SCHEDULER_ENTRYPOINTS },
      outdir: appDir,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: RUNTIME_EXTERNALS,
      define,
      banner: { js: ESM_CJS_INTEROP_BANNER },
      keepNames: options.minify,
      minify: options.minify,
      sourcemap: false,
      legalComments: "none",
      chunkNames: "scheduler/chunk-[hash]",
      metafile: true,
      logLevel: "info",
    });
    await writeFile(schedulerMetafilePath, `${JSON.stringify(schedulerResult.metafile)}\n`, {
      mode: 0o600,
    });

    const builtMainEntries = [];
    for (const name of Object.keys(DESKTOP_MAIN_ENTRYPOINTS)) {
      const entry = await requireFile(join(appDir, `${name}.js`), `built ${name} entry`);
      const source = await readFile(entry.path, "utf8");
      if (!source.includes("__zcodeCreateRequire(import.meta.url)")) {
        throw new Error(`built ${name} entry is missing the ESM createRequire shim`);
      }
      builtMainEntries.push({ name, bytes: entry.bytes, sha256: entry.sha256 });
    }
    const main = builtMainEntries.find((entry) => entry.name === "main/index");
    if (!main) throw new Error("built main entry is missing");
    const mainEntry = join(appDir, "main/index.js");
    const mainSource = await readFile(mainEntry, "utf8");
    if (mainSource.includes("__ZODY_CANDIDATE_NATIVE_HOST_LAUNCH__")) {
      throw new Error("candidate nativeHostLaunch define was not compiled into main");
    }
    if (!mainSource.includes(options.launcherPath)) {
      throw new Error("compiled main does not contain the fixed native launcher path");
    }
    const scheduler = await requireFile(join(appDir, "scheduler/index.js"), "built scheduler entry");
    const schedulerSource = await readFile(scheduler.path, "utf8");
    if (!schedulerSource.includes("__zcodeCreateRequire(import.meta.url)")) {
      throw new Error("built scheduler entry is missing the ESM createRequire shim");
    }

    await writeFile(
      join(appDir, "package.json"),
      `${JSON.stringify(
        {
          name: "zody-cua-ui-candidate",
          productName: "Zody CUA UI Candidate",
          version: buildMetadata.appVersion,
          private: true,
          type: "module",
          main: "main/index.js",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const nodeModulesTarget = relative(appDir, join(REPO_ROOT, "node_modules"));
    await symlink(nodeModulesTarget, join(appDir, "node_modules"), "dir");

    const runScript = join(staging, "run-ui-candidate.sh");
    await writeFile(
      runScript,
      `#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nunset ELECTRON_RUN_AS_NODE ELECTRON_RENDERER_URL\nmkdir -p "$HERE/profile/user-data" "$HERE/profile/session-data"\nexport ZODY_BUILTIN_PROVIDER_CONFIG_FILE="$HERE/config/provider/zody-builtin.json"\nexport ZODY_DESKTOP_USER_DATA_DIR="$HERE/profile/user-data"\nexport ZODY_DESKTOP_SESSION_DATA_DIR="$HERE/profile/session-data"\nexport ZODY_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1\n\nexec ${shellQuote(electron.executable)} "$HERE/app" "$@"\n`,
      { mode: 0o755 },
    );

    const rendererIndex = await requireFile(join(options.renderer, "index.html"), "renderer index");
    const preloadIndex = await requireFile(join(options.preload, "index.cjs"), "preload index");
    const manifest = {
      schemaVersion: 1,
      kind: "zody-cua-ui-candidate",
      generatedAt: new Date().toISOString(),
      trusted: false,
      signed: false,
      defaultDisabled: true,
      note: "Build-only candidate. Does not launch UI, request TCC, capture, or modify /Applications.",
      buildMetadata,
      nativeHostLaunch: {
        ...nativeHostLaunch,
        launcher: { path: launcher.path, bytes: launcher.bytes, sha256: launcher.sha256 },
        compileTimeDefine: "__ZODY_CANDIDATE_NATIVE_HOST_LAUNCH__",
      },
      electron: {
        version: electron.version,
        executable: electron.executable,
        reusedWithoutModification: true,
      },
      main: {
        source: join(DESKTOP_ROOT, "src/main/index.ts"),
        path: join(options.output, "app/main/index.js"),
        bytes: main.bytes,
        sha256: main.sha256,
        entries: builtMainEntries.map((entry) => ({
          name: entry.name,
          path: join(options.output, "app", `${entry.name}.js`),
          bytes: entry.bytes,
          sha256: entry.sha256,
        })),
      },
      scheduler: {
        source: join(DESKTOP_ROOT, "src/scheduler/index.ts"),
        path: join(options.output, "app/scheduler/index.js"),
        bytes: scheduler.bytes,
        sha256: scheduler.sha256,
      },
      copied: {
        renderer: {
          source: rendererSource.source,
          destination: join(options.output, "app/renderer"),
          index: rendererIndex,
        },
        preload: {
          source: preloadSource.source,
          destination: join(options.output, "app/preload"),
          index: preloadIndex,
        },
        ...(pluginSandboxSource
          ? {
              pluginSandbox: {
                source: pluginSandboxSource.source,
                destination: join(options.output, "app/plugin-sandbox"),
              },
            }
          : {}),
      },
      runtimeNodeModules: join(REPO_ROOT, "node_modules"),
      builtinProviderConfig: {
        source: providerConfig.path,
        destination: join(options.output, "config/provider/zody-builtin.json"),
        bytes: providerConfig.bytes,
        sha256: providerConfig.sha256,
      },
      profile: {
        userDataDir: join(options.output, "profile/user-data"),
        sessionDataDir: join(options.output, "profile/session-data"),
      },
      runtimeEnv: {
        ZODY_BUILTIN_PROVIDER_CONFIG_FILE: join(
          options.output,
          "config/provider/zody-builtin.json",
        ),
        ZODY_DESKTOP_USER_DATA_DIR: join(options.output, "profile/user-data"),
        ZODY_DESKTOP_SESSION_DATA_DIR: join(options.output, "profile/session-data"),
        ZODY_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
      },
      run: {
        script: "run-ui-candidate.sh",
        command: [join(options.output, "run-ui-candidate.sh")],
      },
    };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    if (await exists(options.output)) {
      if (!options.replace) throw new Error(`Output already exists: ${options.output} (use --replace)`);
      await rm(options.output, { recursive: true, force: true });
    }
    await rename(staging, options.output);
    return { output: options.output, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
} else {
  const result = await buildCandidate(options);
  process.stdout.write(
    `${JSON.stringify({ status: "built", output: result.output, trusted: false }, null, 2)}\n`,
  );
}
