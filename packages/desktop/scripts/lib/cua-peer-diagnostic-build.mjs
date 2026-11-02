import { chmod, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILD_MANIFEST_KIND,
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  NATIVE_BINARY_NAME,
  NATIVE_ROOT,
  NATIVE_SOURCE_FILES,
  OUTPUT_ROOT,
  PeerDiagnosticBlockedError,
  PeerDiagnosticFailureError,
  REPO_ROOT,
  ensureOwnedDirectory,
  nowIso,
  sha256File,
  summarizeCommand,
  writeJsonAtomic,
  writeTextAtomic,
} from "./cua-peer-diagnostic-core.mjs";
import { assertCommandOk, runBoundedCommand } from "./cua-peer-diagnostic-command.mjs";
import { probeFixedToolchain } from "./cua-peer-diagnostic-toolchain.mjs";

const LIPO = "/usr/bin/lipo";
const OTOOL = "/usr/bin/otool";

function parseMinos(otoolOutput) {
  const values = [];
  for (const match of otoolOutput.matchAll(/^\s*minos\s+([0-9]+(?:\.[0-9]+){0,2})\s*$/gm)) {
    values.push(match[1]);
  }
  return values;
}

async function sourceHashes() {
  return Promise.all(
    NATIVE_SOURCE_FILES.map(async (relativePath) => ({
      path: relativePath,
      sha256: await sha256File(join(NATIVE_ROOT, relativePath)),
    })),
  );
}

function compilerArguments(toolchain, sourcePaths, outputPath) {
  return [
    "-std=c++17",
    "-x",
    "objective-c++",
    "-fobjc-arc",
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
    NATIVE_ROOT,
    "-I",
    join(NATIVE_ROOT, "src"),
    ...sourcePaths,
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    "-lbsm",
    "-o",
    outputPath,
  ];
}

export async function buildNativePeerDiagnostic({ outputRoot = OUTPUT_ROOT } = {}) {
  const toolchain = await probeFixedToolchain();
  const sources = await sourceHashes();
  const buildRoot = join(outputRoot, "build");
  const binRoot = join(outputRoot, "bin");
  await ensureOwnedDirectory(buildRoot);
  await ensureOwnedDirectory(binRoot);

  const stagingDirectory = await mkdtemp(join(buildRoot, "staging-"));
  await chmod(stagingDirectory, 0o700);
  const stagingBinary = join(stagingDirectory, NATIVE_BINARY_NAME);
  const finalBinary = join(binRoot, NATIVE_BINARY_NAME);
  const sourcePaths = NATIVE_SOURCE_FILES.filter((path) => path.endsWith(".mm")).map((path) =>
    join(NATIVE_ROOT, path),
  );
  const compileArgs = compilerArguments(toolchain, sourcePaths, stagingBinary);

  try {
    const compile = await runBoundedCommand(toolchain.compiler.path, compileArgs, {
      cwd: REPO_ROOT,
      timeoutMs: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (compile.exitCode !== 0 || compile.timedOut || compile.bufferOverflow || compile.error) {
      throw new PeerDiagnosticFailureError("native compile failed", {
        command: summarizeCommand(toolchain.compiler.path, compileArgs),
        exitCode: compile.exitCode,
        timedOut: compile.timedOut,
        bufferOverflow: compile.bufferOverflow,
        stdout: compile.stdout.slice(0, 8_000),
        stderr: compile.stderr.slice(0, 8_000),
      });
    }

    const lipoResult = await runBoundedCommand(LIPO, ["-archs", stagingBinary], {
      timeoutMs: 30_000,
    });
    assertCommandOk(lipoResult, "lipo -archs");
    const architectures = lipoResult.stdout.trim().split(/\s+/).filter(Boolean);
    if (architectures.length !== 1 || architectures[0] !== FIXED_ARCH) {
      throw new PeerDiagnosticFailureError("unexpected architecture set", { architectures });
    }

    const otoolResult = await runBoundedCommand(OTOOL, ["-l", stagingBinary], {
      timeoutMs: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assertCommandOk(otoolResult, "otool -l");
    const minosValues = parseMinos(otoolResult.stdout);
    if (
      minosValues.length === 0 ||
      minosValues.some((value) => value !== FIXED_DEPLOYMENT_TARGET)
    ) {
      throw new PeerDiagnosticFailureError("unexpected minimum macOS version", {
        expected: FIXED_DEPLOYMENT_TARGET,
        minosValues,
      });
    }

    const artifactSha256 = await sha256File(stagingBinary);
    const artifactStats = await stat(stagingBinary);
    await chmod(stagingBinary, 0o755);
    await rename(stagingBinary, finalBinary);
    await chmod(finalBinary, 0o755);

    const commandLine = summarizeCommand(toolchain.compiler.path, compileArgs);
    const manifest = {
      schemaVersion: 1,
      kind: BUILD_MANIFEST_KIND,
      status: "pass",
      generatedAt: nowIso(),
      diagnosticOnly: true,
      grant: false,
      nativeCapabilityProven: false,
      runtimeConsumable: false,
      productHook: false,
      sourceRoot: "packages/desktop/native/macos-cua-peer-diagnostic",
      sources,
      provenance: {
        firstParty: true,
        license: "Apache-2.0",
        thirdPartyCodeIncluded: false,
        appleSdkHeadersAreInterfacesOnly: true,
      },
      build: {
        command: commandLine,
        compiler: toolchain.compiler,
        sdk: toolchain.sdk,
        target: toolchain.target,
        flags: compileArgs,
        cwd: REPO_ROOT,
        verificationCommands: {
          architectures: summarizeCommand(LIPO, ["-archs", finalBinary]),
          minimumMacOS: summarizeCommand(OTOOL, ["-l", finalBinary]),
        },
      },
      artifact: {
        path: "bin/macos-cua-peer-diagnostic",
        absolutePath: finalBinary,
        sha256: artifactSha256,
        sizeBytes: artifactStats.size,
        architecture: FIXED_ARCH,
        minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET,
        architectures,
        minosValues,
        explicitSigningPerformed: false,
        linkerAdhocProbeOnly: true,
        signedForAcceptance: false,
      },
      checkedScope: [
        "fixed xcrun macosx27.0 SDK",
        "arm64 thin executable",
        "LC_BUILD_VERSION minimum macOS 14.2",
        "source and artifact SHA-256",
      ],
      limitations: [
        "The linker may emit an ad-hoc signature; it is probe output only and is never treated as acceptance.",
        "A real certificate-backed Helper identity, TCC, machine lease and native input remain unproven.",
        "This artifact is not wired into the product build, installer, launcher, runtime or model tools.",
      ],
    };
    await writeJsonAtomic(join(outputRoot, "build-manifest.json"), manifest, 0o600);
    await writeTextAtomic(join(outputRoot, "build-command.txt"), `${commandLine}\n`, 0o600);

    return {
      manifest,
      artifactPath: finalBinary,
      sha256: artifactSha256,
      toolchain,
      commands: {
        compile: commandLine,
        architectures: summarizeCommand(LIPO, ["-archs", finalBinary]),
        minimumMacOS: summarizeCommand(OTOOL, ["-l", finalBinary]),
      },
    };
  } catch (error) {
    if (error instanceof PeerDiagnosticBlockedError) {
      throw error;
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
