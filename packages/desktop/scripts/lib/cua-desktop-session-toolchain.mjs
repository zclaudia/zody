// 工具链探测/执行/哈希与 Mach-O 校验，固定 SDK/arch/minOS/rpath。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  DesktopSessionBuildError,
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  FIXED_SDK,
  FIXED_SDK_VERSION,
  REPO_ROOT,
} from "./cua-desktop-session-config.mjs";

const execFileAsync = promisify(execFile);

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 180_000,
      maxBuffer: 64 * 1024 * 1024,
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

export async function xcrun(args, label) {
  const result = await run("/usr/bin/xcrun", args, { timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new DesktopSessionBuildError(
      "toolchain-unavailable",
      `${label} failed: ${(result.stderr || result.stdout).trim()}`,
      { command: ["/usr/bin/xcrun", ...args] },
    );
  }
  return result.stdout.trim();
}

export async function probeToolchain() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new DesktopSessionBuildError(
      "host-unsupported",
      `desktop-session build requires darwin arm64, got ${process.platform} ${process.arch}`,
    );
  }
  const sdkPath = await xcrun(["--sdk", FIXED_SDK, "--show-sdk-path"], "SDK path probe");
  const sdkVersion = await xcrun(["--sdk", FIXED_SDK, "--show-sdk-version"], "SDK version probe");
  if (sdkVersion !== FIXED_SDK_VERSION) {
    throw new DesktopSessionBuildError(
      "sdk-version-mismatch",
      `expected SDK ${FIXED_SDK} ${FIXED_SDK_VERSION}, got ${sdkVersion}`,
    );
  }
  const compiler = await xcrun(["--sdk", FIXED_SDK, "--find", "clang++"], "clang++ probe");
  const version = await run(compiler, ["--version"], { timeoutMs: 30_000 });
  if (version.code !== 0 || !version.stdout.includes("Apple clang version")) {
    throw new DesktopSessionBuildError(
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

export async function compile(toolchain, args, label, cwd) {
  const result = await run(toolchain.compiler.path, args, { cwd, timeoutMs: 300_000 });
  if (result.code !== 0) {
    throw new DesktopSessionBuildError(`${label}-compile`, `${label} compile failed`, {
      command: [toolchain.compiler.path, ...args].join(" "),
      stdout: result.stdout.slice(-8_000),
      stderr: result.stderr.slice(-16_000),
    });
  }
  return result;
}

export async function inspectMachO(path, { requireSwiftRpath = true } = {}) {
  const lipo = await run("/usr/bin/lipo", ["-archs", path]);
  if (lipo.code !== 0 || lipo.stdout.trim() !== FIXED_ARCH) {
    throw new DesktopSessionBuildError("architecture", `${path} is not arm64`, lipo);
  }
  const otoolL = await run("/usr/bin/otool", ["-l", path]);
  const minos = [...otoolL.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm)].map((m) => m[1]);
  const rpaths = [...otoolL.stdout.matchAll(/^\s*path\s+(.+?)\s+\(offset \d+\)\s*$/gm)].map(
    (m) => m[1],
  );
  if (minos.length === 0 || minos.some((value) => value !== FIXED_DEPLOYMENT_TARGET)) {
    throw new DesktopSessionBuildError(
      "deployment-target",
      `${path} minimum macOS is not ${FIXED_DEPLOYMENT_TARGET}`,
      { minos },
    );
  }
  if (requireSwiftRpath && !rpaths.includes("/usr/lib/swift")) {
    throw new DesktopSessionBuildError("rpath", `${path} is missing /usr/lib/swift`, { rpaths });
  }
  const linked = await run("/usr/bin/otool", ["-L", path]);
  return { architectures: [FIXED_ARCH], minos, rpaths, linked: linked.stdout };
}
