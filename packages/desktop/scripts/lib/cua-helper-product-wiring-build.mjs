// 原生组合候选 builder：在 output 独立 source stage 派生 R11 源，打包真实 create-app
// fixture 为 sealed ESM，编译 arm64/macOS14.2 Helper。builder 不签名、不请求 TCC、不采集。
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  APP_BINARY_NAME,
  APP_NAME,
  BOOTSTRAP_ENTRY,
  BUNDLE_ID,
  DEFAULT_IDENTITY_PINS,
  DEFAULT_NODE_PATH,
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_VISUAL_ROOT,
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  KOFFI_PLATFORM_TRIM,
  MAX_BUNDLE_BYTES,
  ProductWiringBuildError,
  R10_NATIVE_ROOT,
  R11_NATIVE_ROOT,
  REPO_ROOT,
  SOURCE_BASELINE,
} from "./cua-helper-product-wiring-config.mjs";
import {
  auditSealedBundle,
  bundleSealedEntry,
  writeBundleAudit,
} from "./cua-helper-product-wiring-bundle.mjs";
import {
  appCompileArgs,
  appInfoPlist,
  loadIdentityPins,
  pinsHeader,
  prepareSourceStage,
} from "./cua-helper-product-wiring-native.mjs";
import {
  compile,
  inspectMachO,
  probeToolchain,
  run,
  sha256File,
} from "./cua-helper-product-wiring-toolchain.mjs";

const ESBUILD_PATH = join(REPO_ROOT, "node_modules/esbuild/bin/esbuild");
const WIRE_FRAME_LIMIT_BYTES = 16 * 1024;

async function exists(path) {
  return access(path, fsConstants.R_OK)
    .then(() => true)
    .catch(() => false);
}

async function licenseForNode(nodePath) {
  const candidate = join(dirname(nodePath), "licenses", "node-LICENSE.txt");
  if (await exists(candidate)) return { path: candidate, present: true };
  return { path: candidate, present: false };
}

/**
 * 构建原生组合候选。产出未签名 app + 完整派生/打包/许可/编译摘要；
 * 签名、TCC 与实机 once-capture 由 controller 负责。
 */
export async function buildCuaHelperProductWiring(options = {}) {
  const outputRoot = resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  const visualRoot = resolve(options.visualRoot ?? DEFAULT_VISUAL_ROOT);
  const nodePath = resolve(options.nodePath ?? DEFAULT_NODE_PATH);
  const identityPinsPath = resolve(options.identityPinsPath ?? DEFAULT_IDENTITY_PINS);
  const bootstrapEntry = resolve(options.bootstrapEntry ?? BOOTSTRAP_ENTRY);
  const maxBundleBytes = options.maxBundleBytes ?? MAX_BUNDLE_BYTES;
  const baselinePath = resolve(options.baselinePath ?? SOURCE_BASELINE);
  await access(baselinePath, fsConstants.R_OK);

  await access(bootstrapEntry, fsConstants.R_OK);
  await access(KOFFI_PLATFORM_TRIM, fsConstants.R_OK);
  await access(nodePath, fsConstants.R_OK);
  const staticlib = join(visualRoot, "lib/libcua_macos_visual_round11.a");
  const visualHeader = join(visualRoot, "lib/cua_r11_visual.h");
  await access(staticlib, fsConstants.R_OK);
  await access(visualHeader, fsConstants.R_OK);

  const identityPins = await loadIdentityPins(identityPinsPath);
  const toolchain = await probeToolchain();
  const nodeVersionResult = await run(nodePath, ["--version"], { timeoutMs: 30_000 });
  if (nodeVersionResult.code !== 0) {
    throw new ProductWiringBuildError("node-unavailable", `Node probe failed: ${nodePath}`, {
      stdout: nodeVersionResult.stdout,
      stderr: nodeVersionResult.stderr,
    });
  }
  const nodeVersion = nodeVersionResult.stdout.trim();

  const buildRoot = join(outputRoot, "build");
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(buildRoot, "staging-"));
  try {
    const appContents = join(staging, "app", "Contents");
    const appMacOS = join(appContents, "MacOS");
    const resources = join(appContents, "Resources");
    const licenses = join(resources, "licenses");
    await mkdir(appMacOS, { recursive: true, mode: 0o700 });
    await mkdir(licenses, { recursive: true, mode: 0o700 });

    // 1) 复用固定签名 Node 资源（不改签名/权限）。
    await copyFile(nodePath, join(resources, "node"));
    await chmod(join(resources, "node"), 0o755);
    const nodeLicense = await licenseForNode(nodePath);
    if (nodeLicense.present) {
      await copyFile(nodeLicense.path, join(licenses, "node-LICENSE.txt"));
    }
    const node = {
      sha256: await sha256File(join(resources, "node")),
      bytes: (await stat(join(resources, "node"))).size,
      originalPath: nodePath,
      originalSha256: await sha256File(nodePath),
      version: nodeVersion,
      license: {
        present: nodeLicense.present,
        originalPath: nodeLicense.path,
        sha256: nodeLicense.present
          ? await sha256File(join(licenses, "node-LICENSE.txt"))
          : undefined,
      },
    };

    // 2) sealed ESM：真实 create-app fixture，无 vitest、无生产公开入口。
    const authorityPath = join(resources, "authority-entry.mjs");
    const metafilePath = join(buildRoot, "authority-esbuild-metafile.json");
    const bundle = await bundleSealedEntry({
      esbuildPath: ESBUILD_PATH,
      entry: bootstrapEntry,
      output: authorityPath,
      metafilePath,
      workdir: REPO_ROOT,
    });
    const bundleAudit = await auditSealedBundle({
      output: authorityPath,
      metafilePath,
      licenseDestination: join(licenses, "bundle"),
      maxBytes: maxBundleBytes,
    });
    const bundleAuditFiles = await writeBundleAudit(buildRoot, bundleAudit);
    const authority = {
      path: authorityPath,
      sha256: bundleAudit.sha256,
      bytes: bundleAudit.bytes,
      maxBytes: bundleAudit.maxBytes,
      metafilePath,
      metafileSha256: bundleAudit.metafileSha256,
      entry: bootstrapEntry,
      staticImports: bundleAudit.staticImports,
      nonBuiltinStaticImports: bundleAudit.nonBuiltinStaticImports,
      outputExternalImports: bundleAudit.outputExternalImports,
      nonBuiltinOutputExternals: bundleAudit.nonBuiltinOutputExternals,
      metafileInputExternals: bundleAudit.metafileInputExternals,
      dormantRuntimeExternals: bundleAudit.dormantRuntimeExternals,
      inputCount: bundleAuditFiles.inputCount,
      licenses: bundleAudit.licenses,
      esbuildCommand: bundle.args,
    };

    // 3) 生成资源/身份 pins 头。
    const pinsPath = join(buildRoot, "cua_round11_pins.h");
    await writeFile(
      pinsPath,
      pinsHeader({ nodeSha256: node.sha256, authoritySha256: authority.sha256 }, identityPins),
      { mode: 0o600 },
    );

    // 4) output 独立 source stage + 固定 patch。
    const stageRoot = await mkdtemp(join(buildRoot, "source-stage-"));
    const stage = await prepareSourceStage({
      stageRoot,
      r11Root: R11_NATIVE_ROOT,
      r10Root: R10_NATIVE_ROOT,
      baselinePath,
    });

    // 5) Info.plist。
    const infoPlist = join(appContents, "Info.plist");
    const nativeInfo = join(R11_NATIVE_ROOT, "Info.plist");
    if (await exists(nativeInfo)) await copyFile(nativeInfo, infoPlist);
    else await writeFile(infoPlist, appInfoPlist(), { mode: 0o644 });

    // 6) 实际编译/链接。
    const stagedAppBinary = join(appMacOS, APP_BINARY_NAME);
    const appArgs = appCompileArgs(toolchain, {
      r11Src: stage.r11Src,
      r10Src: stage.r10Src,
      includeRoot: buildRoot,
      visualRoot,
      output: stagedAppBinary,
    });
    const compileResult = await compile(toolchain, appArgs, "helper app", stageRoot);
    const appArtifact = await inspectMachO(stagedAppBinary);
    const codesign = await run("/usr/bin/codesign", ["-dv", "--verbose=4", stagedAppBinary]);

    // 7) 发布到 outputRoot/helper。
    const appFinal = join(outputRoot, "helper", APP_NAME);
    const appBinaryFinal = join(appFinal, "Contents/MacOS", APP_BINARY_NAME);
    await mkdir(join(outputRoot, "helper"), { recursive: true, mode: 0o755 });
    await rm(appFinal, { recursive: true, force: true });
    await rename(join(staging, "app"), appFinal);
    await chmod(appBinaryFinal, 0o755);

    const appCommand = [toolchain.compiler.path, ...appArgs].join(" ");
    const compileArgsPath = join(buildRoot, "app-compile-command.txt");
    await writeFile(compileArgsPath, `${appCommand}\n`, { mode: 0o600 });

    const manifest = {
      schemaVersion: 1,
      kind: "zody-cua-helper-product-wiring-native-candidate",
      status: "pass",
      generatedAt: new Date().toISOString(),
      unsigned: true,
      signing: {
        performed: false,
        acceptance: "blocked",
        reason: "builder does not sign; controller signs and runs the real once-capture",
      },
      captureEntry: false,
      productHook: false,
      nativeCompositionCandidate: true,
      outputRoot,
      visualRoot,
      sourceRoot: R11_NATIVE_ROOT,
      fixture: {
        entry: bootstrapEntry,
        root: "apps/zody-cli/packages/bootstrap/tests/fixtures",
        synthetic: true,
        installedUi: false,
        note:
          "真实 createZCodeApp + CommandInbox/sendText + held model 的测试构建入口；" +
          "Host 身份/模型显式 synthetic，不声称安装版 UI、完整产品启动或截图证据",
        realFactory: "createRegistryBackedTestApp -> createZCodeApp (no vitest)",
        identityFrom: "app.runtime.createCuaSubmissionTurnScope() (真实 ref/trace/run/turn)",
        producerIncarnation: "本次 launcher 唯一 nonce",
      },
      platformTrim: {
        koffi: {
          module: KOFFI_PLATFORM_TRIM,
          behavior: "throw-only darwin 平台裁剪，不是 koffi 可用实现",
          evidence: [
            "apps/zody-cli/packages/adapters/src/mcp/windows-job-object.ts:31",
            "apps/zody-cli/packages/adapters/src/mcp/stdio-transport.ts:96",
          ],
          installUiEquivalence: false,
        },
        entryPlatformGuard: "darwin arm64 only",
      },
      wireFrameLimitBytes: WIRE_FRAME_LIMIT_BYTES,
      bundleBound: {
        previousBytes: 8 * 1024 * 1024,
        currentBytes: maxBundleBytes,
        actualBytes: authority.bytes,
        justification: "真实 create-app/CommandInbox sealed ESM 约 26.5MiB，有界提升到 32MiB",
        frameLimitUnchanged: true,
      },
      identityPins: { path: identityPinsPath, values: identityPins },
      sourceStage: stage.report,
      toolchain,
      node,
      authority,
      resources: {
        staticlib: { path: staticlib, sha256: await sha256File(staticlib) },
        visualHeader: { path: visualHeader, sha256: await sha256File(visualHeader) },
        infoPlist: {
          path: join(appFinal, "Contents/Info.plist"),
          sha256: await sha256File(join(appFinal, "Contents/Info.plist")),
        },
        pins: {
          path: pinsPath,
          sha256: await sha256File(pinsPath),
          note: "buildRoot 中的生成头；编译时作为 -I 输入，不随 app 分发",
        },
      },
      build: {
        command: appCommand,
        compileArgsPath,
        compiler: toolchain.compiler,
        sdk: toolchain.sdk,
        target: { architecture: FIXED_ARCH, minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET },
        linker: {
          swiftSearch: join(toolchain.sdk.path, "usr/lib/swift"),
          rpath: "/usr/lib/swift",
          bsm: true,
        },
        warnings: compileResult.stderr.trim(),
      },
      bundle: {
        path: `helper/${APP_NAME}`,
        bundleIdentifier: BUNDLE_ID,
        minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET,
      },
      artifact: {
        path: `helper/${APP_NAME}/Contents/MacOS/${APP_BINARY_NAME}`,
        absolutePath: appBinaryFinal,
        sha256: await sha256File(appBinaryFinal),
        sizeBytes: (await stat(appBinaryFinal)).size,
        architectures: appArtifact.architectures,
        minosValues: appArtifact.minos,
        rpaths: appArtifact.rpaths,
        linked: appArtifact.linked,
        minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET,
        codesign: {
          inspected: codesign.code === 0,
          adhocOrUnsignedIsNotAcceptance: true,
          output: `${codesign.stdout}${codesign.stderr}`.slice(0, 4_000),
        },
      },
    };
    await writeFile(
      join(buildRoot, "build-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
