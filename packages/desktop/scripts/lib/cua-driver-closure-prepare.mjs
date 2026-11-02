import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { ClosureVerificationError, isPathInside, sha256File } from "./cua-driver-closure-core.mjs";
import { baseClosureEnvironment, runClosureCommand } from "./cua-driver-closure-command.mjs";

function isArtifactPath(path) {
  return [".rlib", ".dylib", ".a"].includes(extname(path));
}

// 现代 Cargo 的 package_id 可能形如 path+file:///...#0.37.0（片段没有 name@），
// 仅解析 `#name@version` 会漏掉真实 SDK 产物，因此缺包名时从路径末段补出。
export function parsePackageId(packageId) {
  if (typeof packageId !== "string") return { name: null, version: null };
  const hashIndex = packageId.lastIndexOf("#");
  if (hashIndex !== -1) {
    const fragment = packageId.slice(hashIndex + 1);
    if (fragment.includes("@")) {
      const [name, version] = fragment.split("@", 2);
      return { name, version };
    }
    const pathPart = packageId.slice(0, hashIndex).replace(/\/$/, "");
    return { name: basename(pathPart), version: fragment };
  }
  const legacy = /^([^ ]+) ([^ ]+) \(/.exec(packageId);
  if (legacy) return { name: legacy[1], version: legacy[2] };
  return { name: null, version: null };
}

export async function parseCargoMessages(stdout, targetRoot) {
  const buildScripts = new Set();
  const compiledProcMacros = new Set();
  const artifacts = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason === "build-script-executed" && typeof message.package_id === "string") {
      buildScripts.add(message.package_id);
      continue;
    }
    if (message.reason !== "compiler-artifact" || typeof message.package_id !== "string") continue;
    const kinds = [...(message.target?.kind ?? []), ...(message.target?.crate_types ?? [])];
    if (kinds.includes("proc-macro")) compiledProcMacros.add(message.package_id);
    for (const filename of message.filenames ?? []) {
      if (typeof filename !== "string" || !isArtifactPath(filename)) continue;
      if (!isPathInside(targetRoot, filename)) {
        throw new ClosureVerificationError(
          `build artifact escaped the isolated target: ${filename}`,
        );
      }
      const metadata = await lstat(filename);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new ClosureVerificationError(`build artifact is not a regular file: ${filename}`);
      }
      artifacts.push({
        packageId: message.package_id,
        identity: parsePackageId(message.package_id),
        targetName: message.target?.name ?? null,
        crateTypes: message.target?.crate_types ?? [],
        path: relative(targetRoot, filename),
        bytes: metadata.size,
        sha256: await sha256File(filename),
      });
    }
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return {
    buildScripts: [...buildScripts].sort(),
    compiledProcMacros: [...compiledProcMacros].sort(),
    artifacts,
  };
}

export function selectSdkArtifacts({ artifacts, packageName, packageVersion }) {
  return artifacts.filter(
    (artifact) =>
      artifact.identity?.name === packageName &&
      artifact.identity?.version === packageVersion &&
      artifact.crateTypes?.some((kind) => kind === "rlib" || kind === "cdylib") &&
      [".rlib", ".dylib"].includes(extname(artifact.path)),
  );
}

async function probePlatform() {
  const env = baseClosureEnvironment(process.env);
  const run = async (command, args) => {
    try {
      const result = await runClosureCommand(command, args, {
        env,
        timeoutMs: 15_000,
        maxOutputBytes: 256 * 1024,
        allowFailure: true,
      });
      return {
        status: result.code === 0 ? "pass" : "blocked",
        value: result.stdout.trim(),
        error: result.code === 0 ? null : result.stderr.trim().slice(-500),
      };
    } catch (error) {
      return { status: "blocked", value: null, error: error.message };
    }
  };
  const sdkPath = await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const sdkVersion = await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
  const clang = await run("/usr/bin/clang", ["--version"]);
  return {
    sdkPath: sdkPath.value,
    sdkVersion: sdkVersion.value,
    sdkStatus: sdkPath.status === "pass" && sdkVersion.status === "pass" ? "pass" : "blocked",
    clangPath: "/usr/bin/clang",
    clangVersion: clang.value?.split(/\r?\n/, 1)[0] ?? null,
    clangStatus: clang.status,
    errors: [sdkPath.error, sdkVersion.error, clang.error].filter(Boolean),
  };
}

export async function runDriverBuild({
  toolchain,
  sourceRoot,
  cargoHome,
  tempRoot,
  mode,
  target,
  packageName,
  packageVersion,
  logPath,
}) {
  if (mode !== "check" && mode !== "build") {
    throw new ClosureVerificationError("invalid build mode");
  }
  if (!packageVersion) throw new ClosureVerificationError("driver package version is required");
  const platform = await probePlatform();
  const buildRoot = join(tempRoot, "driver-build");
  const home = join(buildRoot, "home");
  const temporary = join(buildRoot, "tmp");
  const targetRoot = join(buildRoot, "target");
  await mkdir(home, { recursive: true });
  await mkdir(temporary, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  const env = baseClosureEnvironment(process.env);
  env.PATH = `${join(toolchain.sysroot, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`;
  env.HOME = home;
  env.TMPDIR = temporary;
  env.CARGO_HOME = cargoHome;
  env.CARGO_TARGET_DIR = targetRoot;
  env.CARGO_NET_OFFLINE = "true";
  env.CARGO_TERM_COLOR = "never";
  env.CARGO_INCREMENTAL = "0";
  env.RUSTUP_AUTO_INSTALL = "0";
  env.RUSTC = toolchain.rustcPath;
  env.SOURCE_DATE_EPOCH = "0";
  delete env.MACOSX_DEPLOYMENT_TARGET;
  platform.deploymentTarget = null;
  platform.deploymentTargetSource =
    "forced unset in the isolated build environment; rustc/build default applies";
  const command = mode === "build" ? "build" : "check";
  let result;
  try {
    result = await runClosureCommand(
      toolchain.cargoPath,
      [
        command,
        "--locked",
        "--offline",
        "--package",
        packageName,
        "--lib",
        "--target",
        target,
        "--message-format=json-render-diagnostics",
      ],
      {
        cwd: sourceRoot,
        env,
        timeoutMs: 30 * 60 * 1000,
        maxOutputBytes: 256 * 1024 * 1024,
        allowFailure: true,
      },
    );
  } catch (error) {
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, `build did not produce a log: ${error.message}\n`, "utf8");
    return {
      status: "blocked",
      mode: mode === "build" ? "build-library" : "check-build",
      command,
      error: { code: error.code ?? "build-failed", message: error.message },
      platform,
      isolation: { home, cargoHome, targetRoot, osSandbox: false },
      executedUpstreamApplication: false,
      executedTests: false,
    };
  }
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `${result.stdout}\n${result.stderr}`, "utf8");
  let parsed;
  try {
    parsed = await parseCargoMessages(result.stdout, targetRoot);
  } catch (error) {
    return {
      status: "fail",
      mode: mode === "build" ? "build-library" : "check-build",
      command,
      exitCode: result.code,
      logPath,
      error: { code: error.code ?? "build-message-invalid", message: error.message },
      platform,
      isolation: { home, cargoHome, targetRoot, osSandbox: false },
      executedUpstreamApplication: false,
      executedTests: false,
    };
  }
  const sdkArtifacts = selectSdkArtifacts({
    artifacts: parsed.artifacts,
    packageName,
    packageVersion,
  });
  const base = {
    mode: mode === "build" ? "build-library" : "check-build",
    command,
    target,
    package: packageName,
    packageVersion,
    logPath,
    targetRoot,
    exitCode: result.code,
    buildScriptCount: parsed.buildScripts.length,
    buildScripts: parsed.buildScripts,
    compiledProcMacroCount: parsed.compiledProcMacros.length,
    compiledProcMacros: parsed.compiledProcMacros,
    artifactCount: parsed.artifacts.length,
    artifacts: parsed.artifacts,
    sdkArtifacts,
    platform,
    isolation: {
      home,
      cargoHome,
      targetRoot,
      osSandbox: false,
      note: "HOME/CARGO_HOME/target are private staging paths; this is not an OS sandbox",
    },
    executedUpstreamApplication: false,
    executedTests: false,
    offlineLocked: true,
  };
  if (result.code !== 0) {
    return {
      status: "fail",
      ...base,
      error: {
        code: "cargo-failed",
        message: result.stderr.trim().slice(-2000) || `exit ${result.code}`,
      },
    };
  }
  if (mode === "build" && sdkArtifacts.length === 0) {
    return {
      status: "fail",
      ...base,
      error: {
        code: "sdk-artifact-missing",
        message: "driver build did not produce the SDK rlib/cdylib",
      },
    };
  }
  return { status: "pass", ...base };
}

export async function preserveBuildArtifacts({ build, outputDir }) {
  if (!build || build.status !== "pass") return { files: [] };
  const targetRoot = build.targetRoot;
  const root = join(outputDir, "build-artifacts");
  const files = [];
  for (const artifact of build.sdkArtifacts) {
    if (!isAbsolute(targetRoot)) throw new ClosureVerificationError("invalid build artifact root");
    const source = join(targetRoot, artifact.path);
    const destination = join(root, basename(artifact.path));
    await mkdir(root, { recursive: true });
    await copyFile(source, destination);
    if ((await sha256File(destination)) !== artifact.sha256) {
      throw new ClosureVerificationError(
        `preserved build artifact hash mismatch: ${artifact.path}`,
      );
    }
    files.push({
      path: relative(outputDir, destination),
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    });
  }
  return { files };
}
