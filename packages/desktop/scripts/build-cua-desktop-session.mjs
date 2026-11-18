#!/usr/bin/env node
// 可信桌面会话候选构建入口。不签名、不请求 TCC、不执行截图。
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_BINARY_NAME,
  APP_ICON_FILE,
  APP_ICON_SOURCE,
  APP_NAME,
  AUXILIARY_RESOURCES,
  DEFAULT_IDENTITY_PINS,
  DEFAULT_NODE_PATH,
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_VISUAL_ROOT,
  EMBEDDED_RESOURCES,
  ENTRY_NAMES,
  MAX_ENTRY_BYTES,
  NATIVE_ROOT,
  R10_NATIVE_ROOT,
  R11_NATIVE_ROOT,
  REPO_ROOT,
  UNSUPPORTED_NATIVE_PINS,
} from "./lib/cua-desktop-session-config.mjs";
import { buildSdkResources } from "./lib/cua-desktop-session-sdk.mjs";
import {
  auditEntry,
  bundleEntry,
  loadUnsupportedNativeModules,
  validateEntryPins,
  writeEntryAudit,
} from "./lib/cua-desktop-session-bundle.mjs";
import {
  createBuildManifest,
  summarizeBuildManifest,
  writeBuildManifest,
} from "./lib/cua-desktop-session-manifest.mjs";
import { pathIsReadable, runNativeTests } from "./lib/cua-desktop-session-native-tests.mjs";
import { describeCandidateFetchMaterial } from "./lib/cua-desktop-session-dependencies.mjs";
import {
  appInfoPlist,
  pinsHeader,
  prepareSessionSourceStage,
  sessionCompileArgs,
} from "./lib/cua-desktop-session-source.mjs";
import {
  compile,
  inspectMachO,
  probeToolchain,
  run,
  sha256File,
} from "./lib/cua-desktop-session-toolchain.mjs";
import { loadIdentityPins } from "./macos-cua-narrow-resources-pins.mjs";
import { resolveIdentityProfileName } from "./macos-cua-narrow-identity-profile.mjs";

const ENTRY_SOURCES = {
  "host-entry.mjs": "host-entry.ts",
  "cli-entry.mjs": "cli-entry.ts",
  "session-entry.mjs": "session-entry.ts",
};

// 入口只写公开子路径；builder 按该包自己的 exports 表解析成实际文件，避免在
// entry 源码里跨包深导入 src 实现。
async function resolvePublicExport(moduleDir, specifier) {
  const meta = JSON.parse(await readFile(join(moduleDir, "package.json"), "utf8"));
  const target = meta.exports?.[specifier];
  if (typeof target !== "string") {
    throw new Error(`${moduleDir} does not export ${specifier}`);
  }
  return join(moduleDir, target);
}

export async function resolveDesktopSessionIdentityPins(options = {}) {
  const identityProfile = resolveIdentityProfileName(options.identityProfile);
  if (identityProfile === "developer-id" && !options.identityPinsPath) {
    throw new Error("developer-id requires explicit --identity-pins");
  }
  const identityPinsPath = resolve(options.identityPinsPath ?? DEFAULT_IDENTITY_PINS);
  const identityPins = await loadIdentityPins({ path: identityPinsPath, identityProfile });
  return { identityPinsPath, identityPins };
}

export async function buildCuaDesktopSession(options = {}) {
  // 中文原因：身份配置必须在运行 Node 或探测工具链之前验证，避免发布构建回退到本地 pin。
  const { identityPinsPath, identityPins } = await resolveDesktopSessionIdentityPins(options);
  const outputRoot = resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  const visualRoot = resolve(options.visualRoot ?? DEFAULT_VISUAL_ROOT);
  const nodePath = resolve(options.nodePath ?? DEFAULT_NODE_PATH);
  const runTests = options.runTests !== false;
  const staticlib = join(visualRoot, "lib/libcua_macos_visual_round11.a");
  const visualHeader = join(visualRoot, "lib/cua_r11_visual.h");
  for (const [label, path] of [
    ["node", nodePath],
    ["identity pins", identityPinsPath],
    ["unsupported native pins", UNSUPPORTED_NATIVE_PINS],
    ["visual static library", staticlib],
    ["visual header", visualHeader],
    ["app icon", APP_ICON_SOURCE],
  ]) {
    if (!(await pathIsReadable(path))) throw new Error(`${label} unavailable: ${path}`);
  }

  const unsupportedModules = await loadUnsupportedNativeModules(UNSUPPORTED_NATIVE_PINS);
  const toolchain = await probeToolchain();
  const nodeVersionResult = await run(nodePath, ["--version"], {
    timeoutMs: 30_000,
  });
  const nodeVersion = nodeVersionResult.stdout.trim();
  if (nodeVersionResult.code !== 0 || nodeVersion !== "v24.14.0") {
    throw new Error(`expected signed Node v24.14.0, got ${nodeVersion || "unavailable"}`);
  }

  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const buildRoot = join(outputRoot, "build");
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  const auditRoot = join(buildRoot, "audit");
  await rm(auditRoot, { recursive: true, force: true });
  await mkdir(auditRoot, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(buildRoot, "staging-"));
  try {
    const appContents = join(staging, "app", "Contents");
    const appMacOS = join(appContents, "MacOS");
    const resources = join(appContents, "Resources");
    await mkdir(appMacOS, { recursive: true, mode: 0o700 });
    await mkdir(resources, { recursive: true, mode: 0o700 });

    const stage = await prepareSessionSourceStage({
      stageRoot: join(staging, "source"),
      r11Root: R11_NATIVE_ROOT,
      r10Root: R10_NATIVE_ROOT,
    });

    const embeddedDir = join(staging, "embedded");
    await mkdir(embeddedDir, { recursive: true, mode: 0o700 });
    const embeddedResources = {};
    for (const resource of EMBEDDED_RESOURCES) {
      const output = join(embeddedDir, resource.name);
      const metafilePath = join(auditRoot, `${resource.name}.metafile.json`);
      await bundleEntry({
        entry: resource.source,
        output,
        metafilePath,
        unsupportedModules,
        moduleUrl: true,
      });
      const audit = await auditEntry({
        name: resource.name,
        output,
        metafilePath,
        licenseDestination: join(auditRoot, "licenses", resource.name),
        maxBytes: MAX_ENTRY_BYTES,
      });
      await writeEntryAudit(auditRoot, audit);
      embeddedResources[resource.key] = {
        ...audit,
        definePrefix: resource.definePrefix,
        source: await readFile(output, "utf8"),
      };
    }
    const hostDefines = {};
    for (const resource of Object.values(embeddedResources)) {
      hostDefines[`__CUA_${resource.definePrefix}_SHA256__`] = JSON.stringify(resource.sha256);
      hostDefines[`__CUA_${resource.definePrefix}_SOURCE__`] = JSON.stringify(resource.source);
    }

    // 中文原因：cli-entry 必须在封装时钉住实际 node-repl-server 字节，因此资源先于入口产出。
    const auxiliaryResources = [];
    for (const resource of AUXILIARY_RESOURCES) {
      const output = join(resources, resource.name);
      const metafilePath = join(auditRoot, `${resource.name}.metafile.json`);
      await bundleEntry({
        entry: resource.source,
        output,
        metafilePath,
        unsupportedModules,
      });
      const audit = await auditEntry({
        name: resource.name,
        output,
        metafilePath,
        licenseDestination: join(auditRoot, "licenses", resource.name),
        maxBytes: MAX_ENTRY_BYTES,
      });
      await writeEntryAudit(auditRoot, audit);
      auxiliaryResources.push({ ...audit, capability: resource.capability });
    }
    auxiliaryResources.push(...(await buildSdkResources(resources)));
    const nodeReplServer = auxiliaryResources.find(
      (resource) => resource.name === "node-repl-server.mjs",
    );
    if (!nodeReplServer) {
      throw new Error("node-repl-server resource was not produced");
    }
    const cliDefines = {
      __CUA_NODE_REPL_SERVER_SHA256__: JSON.stringify(nodeReplServer.sha256),
      __CUA_NODE_REPL_SERVER_MAX_BYTES__: JSON.stringify(nodeReplServer.maxBytes),
    };
    for (const resource of auxiliaryResources.filter((item) => item.definePrefix)) {
      cliDefines[`__CUA_${resource.definePrefix}_SHA256__`] = JSON.stringify(resource.sha256);
      cliDefines[`__CUA_${resource.definePrefix}_MAX_BYTES__`] = JSON.stringify(resource.maxBytes);
    }
    const cliAliases = {
      "@zody/node-repl-host/cua-node-repl-mcp-port": await resolvePublicExport(
        join(REPO_ROOT, "apps", "zody-cli", "packages", "node-repl-host"),
        "./cua-node-repl-mcp-port",
      ),
    };

    const entries = [];
    for (const entryName of ENTRY_NAMES) {
      const sourceName = ENTRY_SOURCES[entryName];
      const output = join(resources, entryName);
      const metafilePath = join(auditRoot, `${entryName}.metafile.json`);
      const defines =
        entryName === "host-entry.mjs"
          ? hostDefines
          : entryName === "cli-entry.mjs"
            ? cliDefines
            : {};
      const aliases = entryName === "cli-entry.mjs" ? cliAliases : {};
      await bundleEntry({
        entry: join(NATIVE_ROOT, "entries", sourceName),
        output,
        metafilePath,
        unsupportedModules,
        defines,
        aliases,
      });
      const audit = await auditEntry({
        name: entryName,
        output,
        metafilePath,
        licenseDestination: join(auditRoot, "licenses", entryName),
        maxBytes: MAX_ENTRY_BYTES,
      });
      await writeEntryAudit(auditRoot, audit);
      entries.push(audit);
    }
    const entryPins = validateEntryPins(entries);
    const candidateFetch = await describeCandidateFetchMaterial(entries);

    const nodeSha256 = await sha256File(nodePath);
    const pinsPath = join(stage.srcDir, "cua_desktop_session_pins.h");
    await writeFile(
      pinsPath,
      pinsHeader({
        nodeSha256,
        entries,
        resources: auxiliaryResources,
        identityPins,
      }),
      {
        mode: 0o600,
      },
    );
    const persistedPinsPath = join(buildRoot, "cua_desktop_session_pins.h");
    await copyFile(pinsPath, persistedPinsPath);
    await chmod(persistedPinsPath, 0o600);

    const binaryPath = join(appMacOS, APP_BINARY_NAME);
    const compileArgs = sessionCompileArgs(toolchain, {
      srcDir: stage.srcDir,
      r10SrcDir: stage.r10SrcDir,
      includeRoot: stage.srcDir,
      visualRoot,
      output: binaryPath,
    });
    const compileResult = await compile(toolchain, compileArgs, "desktop-session", stage.srcDir);
    await chmod(binaryPath, 0o755);

    await copyFile(nodePath, join(resources, "node"));
    await chmod(join(resources, "node"), 0o755);
    const nodeLicenseSource = join(dirname(nodePath), "licenses", "node-LICENSE.txt");
    const nodeLicensePresent = await pathIsReadable(nodeLicenseSource);
    if (nodeLicensePresent) {
      await mkdir(join(resources, "licenses"), {
        recursive: true,
        mode: 0o700,
      });
      await copyFile(nodeLicenseSource, join(resources, "licenses", "node-LICENSE.txt"));
    }
    const infoPlistPath = join(appContents, "Info.plist");
    await writeFile(infoPlistPath, appInfoPlist(), { mode: 0o644 });
    await copyFile(APP_ICON_SOURCE, join(resources, APP_ICON_FILE));

    const testResults = runTests
      ? await runNativeTests(toolchain, {
          srcDir: stage.srcDir,
          includeRoot: stage.srcDir,
          visualRoot,
          testRoot: join(staging, "tests"),
        })
      : [];

    const finalApp = join(outputRoot, "helper", APP_NAME);
    await rm(finalApp, { recursive: true, force: true });
    await mkdir(dirname(finalApp), { recursive: true, mode: 0o700 });
    await rename(join(staging, "app"), finalApp);

    const finalBinary = join(finalApp, "Contents/MacOS", APP_BINARY_NAME);
    const finalArtifact = await inspectMachO(finalBinary);
    const manifest = await createBuildManifest({
      outputRoot,
      nodePath,
      nodeSha256,
      nodeVersion,
      nodeLicensePresent,
      identityPinsPath,
      identityPins,
      stageReport: stage.report,
      entries,
      entryPins,
      auxiliaryResources,
      embeddedResources,
      candidateFetch,
      toolchain,
      compileArgs,
      compileResult,
      finalBinary,
      finalArtifact,
      staticlib,
      visualHeader,
      infoPlistPath: join(finalApp, "Contents/Info.plist"),
      appIconPath: join(finalApp, "Contents", "Resources", APP_ICON_FILE),
      appIconSource: APP_ICON_SOURCE,
      persistedPinsPath,
      auditRoot,
      testResults,
      runTests,
      unsupportedModules,
    });
    await writeBuildManifest(buildRoot, manifest);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const USAGE = `Usage:
  node packages/desktop/scripts/build-cua-desktop-session.mjs [options]

Builds an unsigned darwin arm64 / macOS 14.2 / SDK 27 candidate. Pure JS is bundled;
unsupported native capabilities are fixed throw-only shims. Tests run by default.

Options:
  --output-root <dir>       default ${DEFAULT_OUTPUT_ROOT}
  --visual-root <dir>       default ${DEFAULT_VISUAL_ROOT}
  --node <path>             default ${DEFAULT_NODE_PATH}
  --identity-profile <kind> local-self-signed (default) or developer-id
  --identity-pins <path>    local default ${DEFAULT_IDENTITY_PINS}; required for developer-id
  --skip-tests              compile/package only
`;

export function parseArgs(argv) {
  const options = { identityProfile: "local-self-signed" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    const next = () => {
      const arg = argv[index + 1];
      if (!arg) throw new Error(`${value} requires a value`);
      index += 1;
      return arg;
    };
    if (value === "--output-root") options.outputRoot = resolve(next());
    else if (value === "--visual-root") options.visualRoot = resolve(next());
    else if (value === "--node") options.nodePath = resolve(next());
    else if (value === "--identity-pins") options.identityPinsPath = resolve(next());
    else if (value === "--identity-profile") {
      options.identityProfile = resolveIdentityProfileName(next());
    } else if (value === "--skip-tests") options.runTests = false;
    else throw new Error(`unknown argument: ${value}`);
  }
  return { help: false, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "fail", message: error.message })}\n`);
    process.exit(1);
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  try {
    const manifest = await buildCuaDesktopSession(parsed.options);
    process.stdout.write(`${JSON.stringify(summarizeBuildManifest(manifest), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: "fail", message: error?.message ?? String(error), details: error?.details })}\n`,
    );
    process.exit(1);
  }
}
