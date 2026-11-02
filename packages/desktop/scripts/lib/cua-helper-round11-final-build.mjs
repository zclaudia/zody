// oxlint-disable max-lines -- one auditable final build module for the R11 Helper bundle
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
export const NATIVE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-helper-round11",
);
export const R10_NATIVE_ROOT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "native",
  "macos-cua-peer-diagnostic",
);
export const CORE_ROOT = join(
  REPO_ROOT,
  "apps",
  "zcode-cli",
  "packages",
  "core",
);
export const DEFAULT_OUTPUT_ROOT = join(
  REPO_ROOT,
  "output/cua-helper-round11/worker-final",
);
export const DEFAULT_VISUAL_ROOT = join(
  REPO_ROOT,
  "output/cua-helper-round11/controller-visual-final",
);
export const FIXED_SDK = "macosx27.0";
export const FIXED_SDK_VERSION = "27.0";
export const FIXED_ARCH = "arm64";
export const FIXED_DEPLOYMENT_TARGET = "14.2";
export const BUNDLE_ID = "io.github.zclaudia.zody.cua-helper";
export const APP_NAME = "Zody CUA Helper Round11.app";
export const APP_BINARY_NAME = "macos-cua-helper-round11";
export const LEASE_TEST_NAME = "cua-helper-round11-lease-test";
export const DEFAULT_NODE_PATH = join(
  homedir(),
  ".local/share/fnm/node-versions/v24.14.0/installation/bin/node",
);
export const DEFAULT_NODE_LICENSE = join(
  homedir(),
  ".local/share/fnm/node-versions/v24.14.0/installation/LICENSE",
);
const TSC_PATH = join(REPO_ROOT, "node_modules/typescript/bin/tsc");

const R11_SOURCES = [
  "authority_client.mm",
  "bundle_paths.mm",
  "capture_owner.mm",
  "machine_lease.mm",
  "main.mm",
  "node_process.mm",
  "orchestrator.mm",
  "peer_auth.mm",
  "r11_pins.mm",
  "r11_self_identity.mm",
];
const R10_SOURCES = [
  "peer_socket.mm",
  "peer_frame.mm",
  "security_identity.mm",
  "profile.mm",
];

export class Round11FinalBuildError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "Round11FinalBuildError";
    this.code = code;
    this.details = details;
  }
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: options.env ?? process.env,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function xcrun(args, label) {
  const result = await run("/usr/bin/xcrun", args, { timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Round11FinalBuildError(
      "toolchain-unavailable",
      `${label} failed: ${(result.stderr || result.stdout).trim()}`,
      { command: ["/usr/bin/xcrun", ...args] },
    );
  }
  return result.stdout.trim();
}

async function probeToolchain() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Round11FinalBuildError(
      "host-unsupported",
      `R11 final build requires darwin arm64, got ${process.platform} ${process.arch}`,
    );
  }
  const sdkPath = await xcrun(
    ["--sdk", FIXED_SDK, "--show-sdk-path"],
    "SDK path probe",
  );
  const sdkVersion = await xcrun(
    ["--sdk", FIXED_SDK, "--show-sdk-version"],
    "SDK version probe",
  );
  if (sdkVersion !== FIXED_SDK_VERSION) {
    throw new Round11FinalBuildError(
      "sdk-version-mismatch",
      `expected SDK ${FIXED_SDK} ${FIXED_SDK_VERSION}, got ${sdkVersion}`,
    );
  }
  const compiler = await xcrun(
    ["--sdk", FIXED_SDK, "--find", "clang++"],
    "clang++ probe",
  );
  const version = await run(compiler, ["--version"], { timeoutMs: 30_000 });
  if (version.code !== 0 || !version.stdout.includes("Apple clang version")) {
    throw new Round11FinalBuildError(
      "toolchain-unavailable",
      "clang++ did not report Apple clang",
      version,
    );
  }
  return {
    sdk: { requested: FIXED_SDK, path: sdkPath, version: sdkVersion },
    compiler: {
      path: compiler,
      versionFirstLine: version.stdout.split("\n")[0]?.trim() ?? "",
    },
  };
}

function cString(value) {
  let escaped = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    switch (character) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      default:
        if (code < 0x20 || code > 0x7e) {
          throw new Round11FinalBuildError(
            "pin-encoding",
            "pin values must stay printable ASCII",
            { value },
          );
        }
        escaped += character;
    }
  }
  return escaped;
}

const IDENTITY_PIN_FIELDS = [
  "leafSha256",
  "designatedRequirement",
  "nodeIdentifier",
  "nodeLeafSha256",
  "nodeDesignatedRequirement",
  "nodeCdhash",
];

function normalizeIdentityPins(identityPins = {}) {
  if (
    identityPins === null ||
    typeof identityPins !== "object" ||
    Array.isArray(identityPins)
  ) {
    throw new Round11FinalBuildError(
      "identity-pins",
      "identityPins must be an object",
    );
  }
  const normalized = {};
  for (const field of IDENTITY_PIN_FIELDS) {
    const value = identityPins[field] ?? "";
    if (typeof value !== "string") {
      throw new Round11FinalBuildError(
        "identity-pins",
        `identityPins.${field} must be a string`,
        { field },
      );
    }
    normalized[field] = value;
  }
  return normalized;
}

function pinsHeader(resources, identityPins) {
  return `#pragma once
// 由 final-build 生成。身份 pin 为空表示未获批构建在任何 capture/lease 前拒绝；
// 资源 pin 来自本次实际复制/打包后的 bytes。
#define CUA_ROUND11_PIN_BUNDLE_ID "${cString(BUNDLE_ID)}"
#define CUA_ROUND11_PIN_LEAF_SHA256 "${cString(identityPins.leafSha256)}"
#define CUA_ROUND11_PIN_DESIGNATED_REQUIREMENT "${cString(identityPins.designatedRequirement)}"
#define CUA_ROUND11_PIN_NODE_SHA256 "${cString(resources.nodeSha256)}"
#define CUA_ROUND11_PIN_AUTHORITY_SHA256 "${cString(resources.authoritySha256)}"
#define CUA_ROUND11_PIN_NODE_IDENTIFIER "${cString(identityPins.nodeIdentifier)}"
#define CUA_ROUND11_PIN_NODE_LEAF_SHA256 "${cString(identityPins.nodeLeafSha256)}"
#define CUA_ROUND11_PIN_NODE_DESIGNATED_REQUIREMENT "${cString(identityPins.nodeDesignatedRequirement)}"
#define CUA_ROUND11_PIN_NODE_CDHASH "${cString(identityPins.nodeCdhash)}"
`;
}

function appInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${APP_BINARY_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Zody CUA Helper Round11</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>${FIXED_DEPLOYMENT_TARGET}</string>
</dict>
</plist>
`;
}

function appCompileArgs(toolchain, buildRoot, visualRoot, output) {
  const sdk = toolchain.sdk.path;
  const sources = [
    ...R11_SOURCES.map((name) => join(NATIVE_ROOT, "src", name)),
    ...R10_SOURCES.map((name) => join(R10_NATIVE_ROOT, "src", name)),
  ];
  return [
    "-std=c++17",
    "-x",
    "objective-c++",
    "-fobjc-arc",
    "-arch",
    FIXED_ARCH,
    "-isysroot",
    sdk,
    `-mmacosx-version-min=${FIXED_DEPLOYMENT_TARGET}`,
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DCUA_R11_HAVE_VISUAL",
    "-I",
    join(NATIVE_ROOT, "src"),
    "-I",
    join(R10_NATIVE_ROOT, "src"),
    "-I",
    buildRoot,
    "-I",
    join(visualRoot, "lib"),
    ...sources,
    "-x",
    "none",
    join(visualRoot, "lib/libcua_macos_visual_round11.a"),
    "-L",
    join(sdk, "usr/lib/swift"),
    "-Wl,-rpath,/usr/lib/swift",
    "-liconv",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "AppKit",
    "-lbsm",
    "-o",
    output,
  ];
}

function leaseTestCompileArgs(toolchain, output) {
  return [
    "-std=c++17",
    "-x",
    "objective-c++",
    "-arch",
    FIXED_ARCH,
    "-isysroot",
    toolchain.sdk.path,
    `-mmacosx-version-min=${FIXED_DEPLOYMENT_TARGET}`,
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I",
    join(NATIVE_ROOT, "src"),
    join(NATIVE_ROOT, "src/lease_test.mm"),
    join(NATIVE_ROOT, "src/machine_lease.mm"),
    "-o",
    output,
  ];
}

async function compile(toolchain, args, label, cwd) {
  const result = await run(toolchain.compiler.path, args, {
    cwd,
    timeoutMs: 300_000,
  });
  if (result.code !== 0) {
    throw new Round11FinalBuildError(
      `${label}-compile`,
      `${label} compile failed`,
      {
        command: [toolchain.compiler.path, ...args].join(" "),
        stdout: result.stdout.slice(-8_000),
        stderr: result.stderr.slice(-16_000),
      },
    );
  }
  return result;
}

async function inspectMachO(path, { requireSwiftRpath = true } = {}) {
  const lipo = await run("/usr/bin/lipo", ["-archs", path]);
  if (lipo.code !== 0 || lipo.stdout.trim() !== FIXED_ARCH) {
    throw new Round11FinalBuildError(
      "architecture",
      `${path} is not arm64`,
      lipo,
    );
  }
  const otoolL = await run("/usr/bin/otool", ["-l", path]);
  const minos = [...otoolL.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm)].map(
    (match) => match[1],
  );
  const rpaths = [
    ...otoolL.stdout.matchAll(/^\s*path\s+(.+?)\s+\(offset \d+\)\s*$/gm),
  ].map((match) => match[1]);
  if (
    minos.length === 0 ||
    minos.some((value) => value !== FIXED_DEPLOYMENT_TARGET)
  ) {
    throw new Round11FinalBuildError(
      "deployment-target",
      `${path} minimum macOS is not ${FIXED_DEPLOYMENT_TARGET}`,
      { minos },
    );
  }
  if (requireSwiftRpath && !rpaths.includes("/usr/lib/swift")) {
    throw new Round11FinalBuildError(
      "rpath",
      `${path} is missing /usr/lib/swift`,
      { rpaths },
    );
  }
  const linked = await run("/usr/bin/otool", ["-L", path]);
  return { architectures: [FIXED_ARCH], minos, rpaths, linked: linked.stdout };
}

async function resolveCoreSubmissionExport() {
  const packagePath = join(CORE_ROOT, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const entry = packageJson.exports?.["./cua-submission"];
  const target =
    typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
  if (typeof target !== "string") {
    throw new Round11FinalBuildError(
      "authority-export",
      "@zcode/core package.json has no ./cua-submission import export",
      { packagePath },
    );
  }
  return { packagePath, distEntry: resolve(CORE_ROOT, target) };
}

async function refreshCoreDist() {
  const submission = await resolveCoreSubmissionExport();
  const result = await run(DEFAULT_NODE_PATH, [TSC_PATH, "-p", CORE_ROOT], {
    timeoutMs: 300_000,
  });
  if (result.code !== 0) {
    throw new Round11FinalBuildError(
      "authority-tsc",
      "@zcode/core tsc refresh failed",
      {
        command: [DEFAULT_NODE_PATH, TSC_PATH, "-p", CORE_ROOT].join(" "),
        stdout: result.stdout.slice(-8_000),
        stderr: result.stderr.slice(-16_000),
      },
    );
  }
  await access(submission.distEntry, fsConstants.R_OK);
  return submission;
}

async function bundleAuthority(
  esbuildPath,
  resourceRoot,
  buildRoot,
  distEntry,
) {
  const entry = join(NATIVE_ROOT, "authority-entry.mjs");
  await access(distEntry, fsConstants.R_OK);
  const output = join(resourceRoot, "authority-entry.mjs");
  const metafilePath = join(buildRoot, "authority-esbuild-metafile.json");
  const args = [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node24",
    "--legal-comments=eof",
    "--external:node:*",
    `--alias:@zcode/core/cua-submission=${distEntry}`,
    `--metafile=${metafilePath}`,
    `--outfile=${output}`,
  ];
  const result = await run(esbuildPath, args, { timeoutMs: 180_000 });
  if (result.code !== 0) {
    throw new Round11FinalBuildError(
      "authority-bundle",
      "esbuild authority bundle failed",
      {
        command: [esbuildPath, ...args].join(" "),
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  }
  const text = await readFile(output, "utf8");
  if (/(?:from|import)\s*\(?\s*["']@zcode\//.test(text)) {
    throw new Round11FinalBuildError(
      "authority-external-package",
      "authority bundle kept an external @zcode package",
    );
  }
  if (/\brequire\s*\(\s*["']@zcode\//.test(text)) {
    throw new Round11FinalBuildError(
      "authority-external-package",
      "authority bundle kept a require(@zcode) call",
    );
  }
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const inputs = {};
  for (const input of Object.keys(metafile.inputs ?? {}).sort()) {
    inputs[input] = await sha256File(resolve(REPO_ROOT, input));
  }
  return {
    path: output,
    sha256: await sha256File(output),
    bytes: (await stat(output)).size,
    metafilePath,
    metafileSha256: await sha256File(metafilePath),
    inputs,
  };
}

export async function buildRound11Helper(options = {}) {
  const outputRoot = resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  const visualRoot = resolve(options.visualRoot ?? DEFAULT_VISUAL_ROOT);
  const nodePath = resolve(options.nodePath ?? DEFAULT_NODE_PATH);
  const identityPins = normalizeIdentityPins(options.identityPins);
  const toolchain = await probeToolchain();
  const nodeVersionResult = await run(nodePath, ["--version"], {
    timeoutMs: 30_000,
  });
  if (nodeVersionResult.code !== 0) {
    throw new Round11FinalBuildError(
      "node-unavailable",
      `Node probe failed: ${nodePath}`,
      nodeVersionResult,
    );
  }
  const nodeVersion = nodeVersionResult.stdout.trim();
  const coreSubmission = await refreshCoreDist();
  const buildRoot = join(outputRoot, "build");
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });

  const staticlib = join(visualRoot, "lib/libcua_macos_visual_round11.a");
  const visualHeader = join(visualRoot, "lib/cua_r11_visual.h");
  await access(staticlib, fsConstants.R_OK);
  await access(visualHeader, fsConstants.R_OK);

  const staging = await mkdtemp(join(buildRoot, "staging-"));
  try {
    const appContents = join(staging, "app", "Contents");
    const appMacOS = join(appContents, "MacOS");
    const resources = join(appContents, "Resources");
    const licenses = join(resources, "licenses");
    await mkdir(appMacOS, { recursive: true, mode: 0o700 });
    await mkdir(licenses, { recursive: true, mode: 0o700 });

    await copyFile(nodePath, join(resources, "node"));
    await chmod(join(resources, "node"), 0o755);
    await copyFile(DEFAULT_NODE_LICENSE, join(licenses, "node-LICENSE.txt"));
    const esbuildPath = join(REPO_ROOT, "node_modules/esbuild/bin/esbuild");
    const authority = await bundleAuthority(
      esbuildPath,
      resources,
      buildRoot,
      coreSubmission.distEntry,
    );
    const node = {
      sha256: await sha256File(join(resources, "node")),
      bytes: (await stat(join(resources, "node"))).size,
      license: {
        sha256: await sha256File(join(licenses, "node-LICENSE.txt")),
      },
    };

    const infoPlist = join(appContents, "Info.plist");
    const nativeInfo = join(NATIVE_ROOT, "Info.plist");
    if (
      await access(nativeInfo, fsConstants.R_OK)
        .then(() => true)
        .catch(() => false)
    ) {
      await copyFile(nativeInfo, infoPlist);
    } else {
      await writeFile(infoPlist, appInfoPlist(), { mode: 0o644 });
    }

    const pinsPath = join(buildRoot, "cua_round11_pins.h");
    await writeFile(
      pinsPath,
      pinsHeader(
        {
          nodeSha256: node.sha256,
          authoritySha256: authority.sha256,
        },
        identityPins,
      ),
      { mode: 0o600 },
    );

    const stagedAppBinary = join(appMacOS, APP_BINARY_NAME);
    const appArgs = appCompileArgs(
      toolchain,
      buildRoot,
      visualRoot,
      stagedAppBinary,
    );
    const appCompile = await compile(
      toolchain,
      appArgs,
      "helper app",
      NATIVE_ROOT,
    );
    const appArtifact = await inspectMachO(stagedAppBinary);
    const codesign = await run("/usr/bin/codesign", [
      "-dv",
      "--verbose=4",
      stagedAppBinary,
    ]);

    const stagedLeaseTest = join(staging, LEASE_TEST_NAME);
    const leaseArgs = leaseTestCompileArgs(toolchain, stagedLeaseTest);
    const leaseCompile = await compile(
      toolchain,
      leaseArgs,
      "lease test",
      NATIVE_ROOT,
    );
    const leaseArtifact = await inspectMachO(stagedLeaseTest, {
      requireSwiftRpath: false,
    });

    const appFinal = join(outputRoot, "helper", APP_NAME);
    const appBinaryFinal = join(appFinal, "Contents/MacOS", APP_BINARY_NAME);
    const leaseTestFinal = join(outputRoot, "bin", LEASE_TEST_NAME);
    await rm(appFinal, { recursive: true, force: true });
    await rm(leaseTestFinal, { force: true });
    await mkdir(join(outputRoot, "helper"), { recursive: true, mode: 0o755 });
    await mkdir(dirname(leaseTestFinal), { recursive: true, mode: 0o755 });
    await rename(join(staging, "app"), appFinal);
    await copyFile(stagedLeaseTest, leaseTestFinal);
    await chmod(appBinaryFinal, 0o755);
    await chmod(leaseTestFinal, 0o755);

    const sourceHashes = {};
    for (const name of [...R11_SOURCES, ...R10_SOURCES]) {
      const root = R11_SOURCES.includes(name) ? NATIVE_ROOT : R10_NATIVE_ROOT;
      sourceHashes[name] = await sha256File(join(root, "src", name));
    }
    for (const [root, prefix] of [
      [NATIVE_ROOT, "round11"],
      [R10_NATIVE_ROOT, "r10"],
    ]) {
      for (const name of await readdir(join(root, "src"))) {
        if (!name.endsWith(".h")) continue;
        sourceHashes[`${prefix}/src/${name}`] = await sha256File(
          join(root, "src", name),
        );
      }
    }
    const appCommand = [toolchain.compiler.path, ...appArgs].join(" ");
    const leaseCommand = [toolchain.compiler.path, ...leaseArgs].join(" ");
    const manifest = {
      schemaVersion: 1,
      kind: "zody-cua-helper-round11-final-build",
      status: "pass",
      generatedAt: new Date().toISOString(),
      unsigned: true,
      signing: {
        performed: false,
        acceptance: "blocked",
        reason: "unsigned; no certificate or signing approval is used",
      },
      captureEntry: false,
      productHook: false,
      outputRoot,
      visualRoot,
      sourceRoot: NATIVE_ROOT,
      sources: sourceHashes,
      identityPins: {
        configured: Object.values(identityPins).some(Boolean),
        values: identityPins,
      },
      resources: {
        node: {
          ...node,
          path: join(appFinal, "Contents/Resources/node"),
          originalPath: nodePath,
          originalSha256: node.sha256,
          version: nodeVersion,
          license: {
            ...node.license,
            path: join(
              appFinal,
              "Contents/Resources/licenses/node-LICENSE.txt",
            ),
            originalPath: DEFAULT_NODE_LICENSE,
            originalSha256: node.license.sha256,
          },
        },
        authority: {
          path: join(appFinal, "Contents/Resources/authority-entry.mjs"),
          sha256: authority.sha256,
          bytes: authority.bytes,
          metafilePath: authority.metafilePath,
          metafileSha256: authority.metafileSha256,
          inputs: authority.inputs,
          distEntry: coreSubmission.distEntry,
          distSha256: await sha256File(coreSubmission.distEntry),
        },
        infoPlist: {
          path: join(appFinal, "Contents/Info.plist"),
          sha256: await sha256File(join(appFinal, "Contents/Info.plist")),
        },
        pins: { path: pinsPath, sha256: await sha256File(pinsPath) },
        staticlib: { path: staticlib, sha256: await sha256File(staticlib) },
        visualHeader: {
          path: visualHeader,
          sha256: await sha256File(visualHeader),
        },
      },
      build: {
        command: appCommand,
        leaseTestCommand: leaseCommand,
        compiler: toolchain.compiler,
        sdk: toolchain.sdk,
        target: {
          architecture: FIXED_ARCH,
          minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET,
        },
        linker: {
          swiftSearch: join(toolchain.sdk.path, "usr/lib/swift"),
          rpath: "/usr/lib/swift",
          bsm: true,
        },
        warnings: [appCompile.stderr, leaseCompile.stderr]
          .map((warning) => warning.trim())
          .filter(Boolean)
          .join("\n"),
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
        minos: FIXED_DEPLOYMENT_TARGET,
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
      leaseTest: {
        path: `bin/${LEASE_TEST_NAME}`,
        absolutePath: leaseTestFinal,
        sha256: await sha256File(leaseTestFinal),
        sizeBytes: (await stat(leaseTestFinal)).size,
        architectures: leaseArtifact.architectures,
        minos: FIXED_DEPLOYMENT_TARGET,
        minosValues: leaseArtifact.minos,
        productionMain: false,
      },
    };
    await writeFile(
      join(buildRoot, "build-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    await writeFile(
      join(buildRoot, "app-compile-command.txt"),
      `${appCommand}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(buildRoot, "lease-test-compile-command.txt"),
      `${leaseCommand}\n`,
      {
        mode: 0o600,
      },
    );
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
