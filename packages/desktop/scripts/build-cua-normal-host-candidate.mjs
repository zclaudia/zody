#!/usr/bin/env node
// Normal utility Host candidate assembly.
//
// The app shell is an existing electron-builder --dir output. This builder extracts its
// app.asar, rebuilds main/host/scheduler from workspace source, preserves the complete
// runtime node_modules and renderer/preload/plugin-sandbox outputs, then repacks the asar.
// It does not sign, install, request TCC, launch the UI, or run a real capture.
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getBuildMetadata } from "./build-metadata.mjs";
import { DESKTOP_MAIN_ENTRYPOINTS } from "./desktop-main-entrypoints.mjs";
import { resolveDesktopProductFlavor } from "./desktop-product-identity.mjs";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";
import {
  createBuildTimeConfigDefines,
  resolveBuildTimeConfig,
} from "../../../scripts/build-time-config.mjs";
import { sha256Bytes } from "./macos-cua-narrow-resources-base.mjs";
import {
  DESKTOP_HOST_ENTRYPOINTS,
  DESKTOP_ROOT,
  DESKTOP_SCHEDULER_ENTRYPOINTS,
  parseArgs,
  requirePreparedNarrowManifestPath,
  usage,
} from "./lib/normal-host-candidate-config.mjs";
import {
  CUA_NARROW_LAUNCHER_RELATIVE_PATH,
  CUA_NARROW_PROFILE_KIND,
  NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME,
  NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
  assertShellNarrowLauncherMatches,
  createNormalHostNarrowProfile,
  rewriteNormalHostCandidateAppIdentity,
  resolveShellLayout,
} from "./lib/normal-host-candidate-profile.mjs";
import { extractAppAsar, packAppAsar } from "./lib/normal-host-candidate-asar.mjs";
import {
  assertNoSymlinks,
  exists,
  requireFile,
  sha256Tree,
} from "./lib/cua-desktop-candidate-app-files.mjs";
import { writeNormalHostBuildEvidence } from "./lib/normal-host-candidate-evidence.mjs";
import { copyNormalHostAppBundle } from "./lib/normal-host-candidate-app-copy.mjs";
import {
  assertNoBuildErrors,
  buildEntryGroup,
  sourceDefines,
  verifyCompiledCandidateSources,
} from "./lib/normal-host-candidate-build.mjs";
import {
  buildNormalHostCandidateManifest,
  createPublicBuildEvidence,
  verifyRepackedAsar,
  writeCandidateManifest,
  writeHostProfile,
  writePackagedNarrowManifest,
} from "./lib/normal-host-candidate-output.mjs";
import { refreshMacosAsarIntegrity } from "./macos-asar-integrity.mjs";

async function assemble(options) {
  const buildMetadata = {
    ...getBuildMetadata(),
  };
  const { environment } = await loadBuiltinProviderConfig({ root: resolve(DESKTOP_ROOT, "../..") });
  const productFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: environment });
  const buildTimeDefines = createBuildTimeConfigDefines(await resolveBuildTimeConfig(process.env));
  const manifestPath = requirePreparedNarrowManifestPath(options.narrowManifest);
  const outputParent = dirname(options.output);
  await mkdir(outputParent, { recursive: true });
  if (await exists(options.output)) {
    if (!options.replace) {
      throw new Error(`Output already exists: ${options.output} (use --replace)`);
    }
  }

  const staging = await mkdtemp(join(outputParent, ".normal-host-candidate-"));
  const finalPath = (path) => {
    const relativePath = relative(staging, path);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`candidate manifest path is outside staging: ${path}`);
    }
    return join(options.output, relativePath);
  };

  const sourceLayout = resolveShellLayout(options.appShell);
  const prepared = await createNormalHostNarrowProfile({
    narrowManifest: manifestPath,
    workspaceAllowlist: options.workspaceAllowlist,
    startupSnapshot: options.startupSnapshot,
    providerProfile: options.providerProfile,
    networkProfile: options.networkProfile,
    testedMacOSVersion: options.testedMacOSVersion,
  });
  await assertShellNarrowLauncherMatches(sourceLayout, prepared.launcherSha256);
  const manifestBytes = await readFile(manifestPath);
  if (sha256Bytes(manifestBytes) !== prepared.profile.resourceManifest.sha256) {
    throw new Error("prepared cua-narrow manifest digest changed before assembly");
  }

  const appBundle = join(staging, NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME);
  const appDir = join(staging, "app-runtime");
  try {
    await copyNormalHostAppBundle(options.appShell, appBundle);
    await rm(join(appBundle, "Contents", "_CodeSignature"), { recursive: true, force: true });
    const copiedLayout = resolveShellLayout(appBundle);
    await extractAppAsar({
      appAsarPath: copiedLayout.appAsarPath,
      destinationDir: appDir,
    });

    const appPackageJson = await requireFile(join(appDir, "package.json"), "app package.json");
    const parsedPackageJson = JSON.parse(await readFile(appPackageJson.path, "utf8"));
    if (parsedPackageJson.main !== "out/main/index.js") {
      throw new Error(`unexpected normal app package.json main: ${parsedPackageJson.main}`);
    }
    const candidateUiIdentity = await rewriteNormalHostCandidateAppIdentity({
      infoPlistPath: join(appBundle, "Contents", "Info.plist"),
      packageJsonPath: appPackageJson.path,
      frameworksDir: join(appBundle, "Contents", "Frameworks"),
      sourceApplicationName: basename(options.appShell, ".app"),
    });
    await assertNoSymlinks(join(appDir, "node_modules"), "normal Host runtime node_modules");
    const packageNames = await readdir(join(appDir, "node_modules"));
    if (packageNames.length === 0) {
      throw new Error("normal Host runtime node_modules is empty");
    }

    const reused = {};
    for (const asset of ["renderer", "preload", "plugin-sandbox"]) {
      const path = join(appDir, "out", asset);
      await requireFile(
        join(
          path,
          asset === "renderer" ? "index.html" : asset === "preload" ? "index.cjs" : "gen-ui.js",
        ),
        `reused ${asset}`,
      );
      reused[asset] = {
        source: `app.asar:out/${asset}`,
        origin: "existing-normal-app-build",
        ...(await sha256Tree(path)),
      };
    }

    await Promise.all(
      ["main", "host", "scheduler"].map((name) =>
        rm(join(appDir, "out", name), { recursive: true, force: true }),
      ),
    );
    const sharedDefines = sourceDefines({
      buildMetadata,
      environment,
      productFlavor,
      buildTimeDefines,
    });
    const mainBuild = await buildEntryGroup({
      name: "main",
      entryPoints: DESKTOP_MAIN_ENTRYPOINTS,
      outDir: appDir,
      defines: {
        ...sharedDefines,
        __ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__: "undefined",
        __ZCODE_NORMAL_CUA_CANDIDATE_UI_NAME__: JSON.stringify(NORMAL_HOST_CANDIDATE_DISPLAY_NAME),
      },
      minify: options.minify,
    });
    const hostBuild = await buildEntryGroup({
      name: "host",
      entryPoints: DESKTOP_HOST_ENTRYPOINTS,
      outDir: appDir,
      defines: {
        ...sharedDefines,
        __ZCODE_CUA_NARROW_AGENT__: JSON.stringify(prepared.profile),
      },
      minify: options.minify,
    });
    const schedulerBuild = await buildEntryGroup({
      name: "scheduler",
      entryPoints: DESKTOP_SCHEDULER_ENTRYPOINTS,
      outDir: appDir,
      defines: sharedDefines,
      minify: options.minify,
    });

    const entries = {
      main: await requireFile(join(appDir, "out/main/index.js"), "rebuilt main entry"),
      host: await requireFile(join(appDir, "out/host/index.js"), "rebuilt Host entry"),
      scheduler: await requireFile(
        join(appDir, "out/scheduler/index.js"),
        "rebuilt scheduler entry",
      ),
    };
    verifyCompiledCandidateSources({
      mainSource: await readFile(entries.main.path, "utf8"),
      hostSource: await readFile(entries.host.path, "utf8"),
      schedulerSource: await readFile(entries.scheduler.path, "utf8"),
      forbiddenPaths: [
        sourceLayout.appShell,
        sourceLayout.launcherPath,
        options.output,
        staging,
        appBundle,
        appDir,
      ],
      displayName: NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
      profileKind: CUA_NARROW_PROFILE_KIND,
      launcherRelativePath: CUA_NARROW_LAUNCHER_RELATIVE_PATH,
    });
    assertNoBuildErrors([mainBuild, hostBuild, schedulerBuild]);

    const buildEvidence = await writeNormalHostBuildEvidence({
      evidenceDir: join(staging, "build-evidence"),
      builds: [
        { name: "main", metafile: mainBuild.metafile, defines: mainBuild.defines },
        { name: "host", metafile: hostBuild.metafile, defines: hostBuild.defines },
        { name: "scheduler", metafile: schedulerBuild.metafile, defines: schedulerBuild.defines },
      ],
    });
    const publicBuildEvidence = createPublicBuildEvidence(buildEvidence, finalPath);

    const manifestDestination = join(copiedLayout.resourcesDir, "cua-narrow", "manifest.json");
    await writePackagedNarrowManifest({
      destination: manifestDestination,
      bytes: manifestBytes,
      expectedSha256: prepared.profile.resourceManifest.sha256,
    });

    const packed = await packAppAsar({
      sourceDir: appDir,
      appAsarPath: copiedLayout.appAsarPath,
      targetPlatformKey: "darwin-arm64",
    });
    const { asarFiles, nodePtyHelperInfo } = await verifyRepackedAsar({
      appAsarPath: copiedLayout.appAsarPath,
      sourceAppAsarUnpackedPath: sourceLayout.appAsarUnpackedPath,
      copiedAppAsarUnpackedPath: copiedLayout.appAsarUnpackedPath,
    });

    const asarIntegrity = await refreshMacosAsarIntegrity({
      appAsarPath: copiedLayout.appAsarPath,
      infoPlistPath: join(appBundle, "Contents", "Info.plist"),
    });
    if (
      asarIntegrity.archiveBytes !== packed.bytes ||
      asarIntegrity.archiveSha256 !== packed.sha256
    ) {
      throw new Error("app.asar changed after packing before integrity refresh");
    }
    await writeHostProfile({ staging, prepared, narrowManifestPath: options.narrowManifest });

    const candidateManifest = await buildNormalHostCandidateManifest({
      options,
      appBundle,
      copiedLayout,
      parsedPackageJson,
      candidateUiIdentity,
      prepared,
      manifestDestination,
      reused,
      packageNames,
      appDir,
      entries,
      asarIntegrity,
      asarFiles,
      nodePtyHelperInfo,
      publicBuildEvidence,
      finalPath,
    });
    await writeCandidateManifest({ staging, candidateManifest });
    await rm(appDir, { recursive: true, force: true });

    if (await exists(options.output)) {
      await rm(options.output, { recursive: true, force: true });
    }
    await rename(staging, options.output);
    return {
      output: options.output,
      app: join(options.output, NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME),
      profile: prepared.profile,
      candidateManifest,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
} else {
  const result = await assemble(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "built",
        output: result.output,
        app: result.app,
        workspaceAllowlist: result.profile.workspaceAllowlist,
        providerDigest: result.profile.provider.revisionSha256,
        networkDigest: result.profile.network.digestSha256,
        manifestSha256: result.profile.resourceManifest.sha256,
        buildEvidenceInputsSha256: result.candidateManifest.buildEvidence.inputsSha256,
        appAsarArchiveSha256: result.candidateManifest.appAsar.archiveSha256,
        appAsarHeaderSha256: result.candidateManifest.appAsar.headerSha256,
        builderSigned: false,
        launchedUi: false,
        requestedTcc: false,
      },
      null,
      2,
    )}\n`,
  );
}
