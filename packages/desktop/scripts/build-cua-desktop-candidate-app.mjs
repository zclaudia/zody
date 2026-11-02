#!/usr/bin/env node
// Independent packaged candidate for the macOS Computer Use launch-services slice.
// The Electron UI is copied from the stock runtime and remains untrusted. The supplied
// Helper app is copied unchanged; this script never signs, installs, launches UI, or
// requests TCC. The controller performs final signing and system verification.
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { build } from "esbuild";
import { getBuildMetadata } from "./build-metadata.mjs";
import { DESKTOP_MAIN_ENTRYPOINTS } from "./desktop-main-entrypoints.mjs";
import { resolveDesktopProductFlavor } from "./desktop-product-identity.mjs";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";
import {
  createBuildTimeConfigDefines,
  resolveBuildTimeConfig,
} from "../../../scripts/build-time-config.mjs";
import {
  APP_BUNDLE_ID,
  APP_DISPLAY_NAME,
  APP_EXECUTABLE_NAME,
  APP_EXECUTABLE_RELATIVE,
  APP_NAME,
  DESKTOP_ROOT,
  DESKTOP_SCHEDULER_ENTRYPOINTS,
  ESM_CJS_INTEROP_BANNER,
  HELPER_RELATIVE_APP,
  HELPER_RELATIVE_LAUNCHER,
  REPO_ROOT,
  RUNTIME_EXTERNALS,
  RUNTIME_MODULE_LOOKUP_ROOTS,
  candidateNativeHostLaunch,
  parseArgs,
  usage,
} from "./lib/cua-desktop-candidate-app-config.mjs";
import {
  assertMachO,
  assertBundleSymlinks,
  assertNoSymlinks,
  collectExternalPackages,
  copyExternalRuntimeModules,
  exists,
  getPlistString,
  renameElectronHelperBundles,
  requireDirectory,
  requireFile,
  setBundleMetadata,
  sha256Tree,
} from "./lib/cua-desktop-candidate-app-files.mjs";

function assertMainBundleDoesNotLeakBuildPaths(source, options) {
  const forbidden = [REPO_ROOT, options.output, options.helperApp, dirname(options.helperApp)];
  for (const value of forbidden) {
    if (value && source.includes(value)) {
      throw new Error(`compiled main contains a build/checkout absolute path: ${value}`);
    }
  }
}

async function buildCandidate(options) {
  const helperApp = await requireDirectory(options.helperApp, "Helper app");
  const helperInfo = await requireFile(join(helperApp, "Contents/Info.plist"), "Helper Info.plist");
  const helperLauncherPath = join(helperApp, HELPER_RELATIVE_LAUNCHER.slice(HELPER_RELATIVE_APP.length + 1));
  await assertMachO(helperLauncherPath, "Helper launcher");
  const electronApp = await requireDirectory(options.electronApp, "Electron app");
  const electronExecutable = join(electronApp, "Contents/MacOS/Electron");
  const electronExecutableInfo = await assertMachO(electronExecutable, "Electron executable");
  const electronPackageJson = await requireFile(
    join(REPO_ROOT, "node_modules/electron/package.json"),
    "Electron package.json",
  );
  const electronVersion = JSON.parse(await readFile(electronPackageJson.path, "utf8")).version;
  const { environment } = await loadBuiltinProviderConfig({ root: REPO_ROOT });
  const productFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: environment });
  const buildMetadata = getBuildMetadata();
  const buildTimeDefines = createBuildTimeConfigDefines(
    await resolveBuildTimeConfig(process.env),
  );
  const define = {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(environment),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(productFlavor),
    ...buildTimeDefines,
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(""),
    __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: JSON.stringify([]),
    __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: JSON.stringify({}),
    __ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__: JSON.stringify(candidateNativeHostLaunch),
  };

  const outputParent = dirname(options.output);
  await mkdir(outputParent, { recursive: true });
  const staging = await mkdtemp(join(outputParent, ".cua-candidate-app-"));
  const finalPath = (path) => {
    const relativePath = relative(staging, path);
    if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
      throw new Error(`candidate manifest path is outside staging: ${path}`);
    }
    return join(options.output, relativePath);
  };
  try {
    const appBundle = join(staging, APP_NAME);
    // Electron 以主 MachO basename 判断 isPackaged；普通 Node cp 默认还会解析框架
    // symlink。这里保留相对链接并重命名主 MachO，保证完整 bundle 自包含且 packaged。
    await cp(electronApp, appBundle, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const resourcesDir = join(appBundle, "Contents", "Resources");
    await rm(join(resourcesDir, "default_app.asar"), { force: true });
    await rm(join(appBundle, "Contents", "_CodeSignature"), { recursive: true, force: true });
    const copiedExecutable = join(appBundle, APP_EXECUTABLE_RELATIVE);
    await rename(join(appBundle, "Contents", "MacOS", "Electron"), copiedExecutable);
    const copiedExecutableInfo = await assertMachO(copiedExecutable, "renamed candidate executable");
    if (copiedExecutableInfo.sha256 !== electronExecutableInfo.sha256) {
      throw new Error("renamed candidate executable bytes differ from the Electron source");
    }
    await setBundleMetadata(
      join(appBundle, "Contents", "Info.plist"),
      APP_DISPLAY_NAME,
      APP_BUNDLE_ID,
      APP_EXECUTABLE_NAME,
    );
    if (
      getPlistString(join(appBundle, "Contents", "Info.plist"), "CFBundleExecutable") !==
      APP_EXECUTABLE_NAME
    ) {
      throw new Error("candidate CFBundleExecutable does not match the renamed executable");
    }
    const renamedElectronHelpers = await renameElectronHelperBundles(
      join(appBundle, "Contents", "Frameworks"),
      APP_DISPLAY_NAME,
    );

    const appDir = join(resourcesDir, "app");
    await mkdir(appDir, { recursive: true, mode: 0o700 });
    await mkdir(join(resourcesDir, "config/provider"), { recursive: true, mode: 0o700 });
    await mkdir(join(resourcesDir, "cua-helper"), { recursive: true, mode: 0o700 });

    const mainBuild = await build({
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
    const schedulerBuild = await build({
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

    const mainEntryPath = join(appDir, "main/index.js");
    const mainEntry = await requireFile(mainEntryPath, "candidate main entry");
    const mainSource = await readFile(mainEntryPath, "utf8");
    if (mainSource.includes("typeof __ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__")) {
      throw new Error("candidate native Host define was not compiled into main");
    }
    if (!mainSource.includes(HELPER_RELATIVE_LAUNCHER)) {
      throw new Error("compiled main is missing the fixed resources-relative Helper launcher");
    }
    if (!mainSource.includes("workspace-relay")) {
      throw new Error("compiled main is missing workspace-relay launch mode");
    }
    assertMainBundleDoesNotLeakBuildPaths(mainSource, options);

    const copiedAssets = {};
    for (const [name, source] of [
      ["renderer", options.renderer],
      ["preload", options.preload],
      ["pluginSandbox", options.pluginSandbox],
    ]) {
      await requireDirectory(source, `${name} output`);
      const destination = join(appDir, name === "pluginSandbox" ? "plugin-sandbox" : name);
      await cp(source, destination, {
        recursive: true,
        errorOnExist: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      copiedAssets[name] = {
        source,
        destination,
        sha256: (await sha256Tree(destination)).sha256,
      };
    }
    const rendererIndex = await requireFile(join(appDir, "renderer/index.html"), "renderer index");
    const preloadIndex = await requireFile(join(appDir, "preload/index.cjs"), "preload index");
    const schedulerEntry = await requireFile(
      join(appDir, "scheduler/index.js"),
      "scheduler entry",
    );

    const providerConfig = await requireFile(
      join(REPO_ROOT, "config/provider/zcode-builtin.json"),
      "builtin provider config",
    );
    const providerDestination = join(resourcesDir, "config/provider/zcode-builtin.json");
    await copyFile(providerConfig.path, providerDestination);
    const defaultConfig = await requireFile(join(REPO_ROOT, "config/default.json"), "default config");
    await copyFile(defaultConfig.path, join(resourcesDir, "config/default.json"));
    const icon = await requireFile(join(DESKTOP_ROOT, "build/icon.png"), "app icon");
    await copyFile(icon.path, join(resourcesDir, "icon.png"));

    const helperDestination = join(resourcesDir, HELPER_RELATIVE_APP);
    await cp(helperApp, helperDestination, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const copiedHelperLauncher = await assertMachO(
      join(resourcesDir, HELPER_RELATIVE_LAUNCHER),
      "copied Helper launcher",
    );
    await requireFile(join(resourcesDir, HELPER_RELATIVE_APP, "Contents/Info.plist"), "copied Helper Info.plist");

    const observedExternalImports = collectExternalPackages([
      mainBuild.metafile,
      schedulerBuild.metafile,
    ]);
    const externalPackages = RUNTIME_EXTERNALS.filter((name) => name !== "electron");
    const nodeModulesDir = join(appDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true, mode: 0o700 });
    const runtimeModules = await copyExternalRuntimeModules(
      nodeModulesDir,
      externalPackages,
      RUNTIME_MODULE_LOOKUP_ROOTS,
    );
    await assertNoSymlinks(nodeModulesDir, "candidate runtime node_modules");
    const bundleSymlinks = await assertBundleSymlinks(appBundle, "candidate app bundle");
    const appPackageJson = {
      name: "zody-cua-launchservices-candidate",
      productName: APP_DISPLAY_NAME,
      version: buildMetadata.appVersion,
      private: true,
      type: "module",
      main: "main/index.js",
      dependencies: Object.fromEntries(
        runtimeModules.map((entry) => [entry.name, entry.version ?? "*"]),
      ),
    };
    await writeFile(join(appDir, "package.json"), `${JSON.stringify(appPackageJson, null, 2)}\n`, {
      mode: 0o600,
    });

    const helperTreeHash = await sha256Tree(helperApp);
    const copiedHelperTreeHash = await sha256Tree(helperDestination);
    if (helperTreeHash.sha256 !== copiedHelperTreeHash.sha256) {
      throw new Error("copied Helper tree differs from its source");
    }
    const manifest = {
      schemaVersion: 1,
      kind: "zody-cua-launchservices-candidate-app",
      generatedAt: new Date().toISOString(),
      trusted: false,
      builderSigned: false,
      defaultDisabled: true,
      note: "Independent packaged candidate. No UI launch, TCC request, signing, installation, or permission change was performed.",
      uiTrust: {
        level: "untrusted",
        originalElectronSignature: "adhoc linker-signed",
        originalInfoPlistBound: false,
        originalSealedResources: "none",
        machoChanged: false,
        candidateInfoPlistMetadataPatched: true,
        productSigned: false,
      },
      buildMetadata,
      app: {
        bundle: join(options.output, APP_NAME),
        applicationName: APP_DISPLAY_NAME,
        displayName: APP_DISPLAY_NAME,
        bundleIdentifier: APP_BUNDLE_ID,
        executable: APP_EXECUTABLE_RELATIVE,
        executableRenamedFrom: "Contents/MacOS/Electron",
        executableBytesUnchanged: true,
        executableSha256: copiedExecutableInfo.sha256,
        packagedLayout: true,
      },
      bundleSymlinks: {
        checked: bundleSymlinks.length,
        allRelative: true,
        allInsideBundle: true,
      },
      renamedElectronHelpers: renamedElectronHelpers.map((entry) => ({
        from: entry.from,
        to: entry.to,
        executable: { ...entry.executable, path: finalPath(entry.executable.path) },
      })),
      electron: {
        version: electronVersion,
        sourceApp: electronApp,
        sourceExecutable: electronExecutable,
        sourceExecutableSha256: electronExecutableInfo.sha256,
        cacheModified: false,
      },
      helper: {
        sourceApp: helperApp,
        sourceInfoPlist: helperInfo,
        destination: finalPath(join(resourcesDir, HELPER_RELATIVE_APP)),
        launcher: {
          ...copiedHelperLauncher,
          path: finalPath(copiedHelperLauncher.path),
        },
        sourceTree: helperTreeHash,
        destinationTree: copiedHelperTreeHash,
        copiedUnchanged: true,
        existingSignaturePreservedByCopy: true,
        signedByBuilder: false,
        resigned: false,
      },
      nativeHostLaunch: {
        descriptor: candidateNativeHostLaunch,
        resolvedLauncherRelativeToResources: HELPER_RELATIVE_LAUNCHER,
        compileTimeDefine: "__ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__",
      },
      candidateUiProfile: {
        isolation: "electron-userData-and-sessionData-only",
        root: "<dataBaseDir>/.zody/desktop/Zody CUA Launchservices Candidate",
        configurableByShellEnv: false,
        sharedCliSessionStoreUnchanged: true,
      },
      main: {
        source: join(DESKTOP_ROOT, "src/main/index.ts"),
        destination: finalPath(mainEntryPath),
        bytes: mainEntry.bytes,
        sha256: mainEntry.sha256,
      },
      scheduler: {
        source: join(DESKTOP_ROOT, "src/scheduler/index.ts"),
        destination: finalPath(join(appDir, "scheduler/index.js")),
        bytes: schedulerEntry.bytes,
        sha256: schedulerEntry.sha256,
      },
      copiedAssets: {
        ...Object.fromEntries(
          Object.entries(copiedAssets).map(([name, asset]) => [
            name,
            { ...asset, destination: finalPath(asset.destination) },
          ]),
        ),
        rendererIndex: { ...rendererIndex, path: finalPath(rendererIndex.path) },
        preloadIndex: { ...preloadIndex, path: finalPath(preloadIndex.path) },
      },
      providerConfig: {
        source: providerConfig,
        destination: finalPath(providerDestination),
      },
      defaultConfig: {
        source: defaultConfig,
        destination: finalPath(join(resourcesDir, "config/default.json")),
      },
      runtimeNodeModules: {
        copiedExternalPackages: externalPackages,
        observedExternalImports,
        packages: runtimeModules.map((entry) => ({
          ...entry,
          destination: finalPath(entry.destination),
        })),
        symlinks: [],
      },
    };
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    if (manifestSource.includes(staging)) {
      throw new Error("candidate manifest still contains a staging path");
    }
    await writeFile(join(staging, "manifest.json"), manifestSource, { mode: 0o600 });

    if (await exists(options.output)) {
      if (!options.replace) throw new Error(`Output already exists: ${options.output} (use --replace)`);
      await rm(options.output, { recursive: true, force: true });
    }
    await rename(staging, options.output);
    return { output: options.output, appBundle: join(options.output, APP_NAME), manifest };
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
    `${JSON.stringify({ status: "built", output: result.output, app: result.appBundle, builderSigned: false, uiTrust: "untrusted" }, null, 2)}\n`,
  );
}
