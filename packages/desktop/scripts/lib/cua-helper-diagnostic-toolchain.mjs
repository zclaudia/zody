import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  DEPLOYMENT_TARGET,
  DiagnosticBlockedError,
  EXPECTED_TOOLCHAIN,
} from "./cua-helper-diagnostic-core.mjs";
import {
  baseEnvironment,
  boundedCommandFailure,
  runCommand,
} from "./cua-helper-diagnostic-command.mjs";

const RUST_STDLIB_COPYRIGHT = join("share", "doc", "rust", "COPYRIGHT-library.html");
const SAFE_TOOLCHAIN_NAME = /^(stable|[0-9]+\.[0-9]+\.[0-9]+)$/;

export function assertSupportedHost(platform = process.platform, architecture = process.arch) {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new DiagnosticBlockedError(
      "unsupported-host",
      "diagnostic build requires macOS arm64; current host is unsupported",
    );
  }
}

function parseRustcVersion(output) {
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  const version = /^rustc\s+([^\s]+)/.exec(firstLine)?.[1] ?? null;
  const commit = /^commit-hash:\s*([0-9a-f]+)$/m.exec(output)?.[1] ?? null;
  const host = /^host:\s*([^\s]+)$/m.exec(output)?.[1] ?? null;
  const release = /^release:\s*([^\s]+)$/m.exec(output)?.[1] ?? version;
  return { version: release, displayVersion: version, commit, host };
}

function parseCargoVersion(output) {
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  const version = /^cargo\s+([^\s]+)/.exec(firstLine)?.[1] ?? null;
  const commit = /^commit-hash:\s*([0-9a-f]+)$/m.exec(output)?.[1] ?? null;
  const host = /^host:\s*([^\s]+)$/m.exec(output)?.[1] ?? null;
  const release = /^release:\s*([^\s]+)$/m.exec(output)?.[1] ?? version;
  return { version: release, displayVersion: version, commit, host };
}

function assertExactToolchain(rustc, cargo) {
  if (
    rustc.version !== EXPECTED_TOOLCHAIN.rustVersion ||
    rustc.commit !== EXPECTED_TOOLCHAIN.rustCommit ||
    cargo.version !== EXPECTED_TOOLCHAIN.cargoVersion ||
    cargo.commit !== EXPECTED_TOOLCHAIN.cargoCommit
  ) {
    throw new DiagnosticBlockedError(
      "toolchain-mismatch",
      `required rustc/cargo ${EXPECTED_TOOLCHAIN.rustVersion} with pinned commits, found a different toolchain`,
    );
  }
}

async function runProbe(command, args, env) {
  try {
    return await runCommand(command, args, { env, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
  } catch (error) {
    throw new DiagnosticBlockedError(
      "toolchain-unavailable",
      `toolchain probe failed: ${boundedCommandFailure(error)}`,
    );
  }
}

export async function probeToolchain({ selected = "stable", sourceEnv = process.env } = {}) {
  if (!SAFE_TOOLCHAIN_NAME.test(selected)) {
    throw new DiagnosticBlockedError("invalid-toolchain", "invalid Rust toolchain selection");
  }
  const env = baseEnvironment(sourceEnv);
  env.RUSTUP_TOOLCHAIN = selected;
  env.RUSTUP_AUTO_INSTALL = "0";

  const rustcProbe = await runProbe("rustc", ["--version", "--verbose"], env);
  const sysrootProbe = await runProbe("rustc", ["--print", "sysroot"], env);
  const sysroot = sysrootProbe.stdout.trim();
  if (!isAbsolute(sysroot) || sysroot.includes("\0")) {
    throw new DiagnosticBlockedError("invalid-sysroot", "rustc returned an invalid sysroot");
  }
  let sysrootReal;
  try {
    sysrootReal = await realpath(sysroot);
    await access(join(sysrootReal, "bin", "rustc"), fsConstants.X_OK);
    await access(join(sysrootReal, "bin", "cargo"), fsConstants.X_OK);
    await access(join(sysrootReal, RUST_STDLIB_COPYRIGHT), fsConstants.R_OK);
  } catch {
    throw new DiagnosticBlockedError(
      "incomplete-toolchain",
      "toolchain sysroot lacks runnable rustc/cargo or standard-library license material",
    );
  }

  const directEnv = { ...env, PATH: `${join(sysrootReal, "bin")}:${env.PATH}` };
  const directRustc = await runProbe(
    join(sysrootReal, "bin", "rustc"),
    ["--version", "--verbose"],
    directEnv,
  );
  const directCargo = await runProbe(
    join(sysrootReal, "bin", "cargo"),
    ["--version", "--verbose"],
    directEnv,
  );
  const rustc = parseRustcVersion(directRustc.stdout);
  const cargo = parseCargoVersion(directCargo.stdout);
  const probeRustc = parseRustcVersion(rustcProbe.stdout);
  if (rustc.host !== "aarch64-apple-darwin" || cargo.host !== "aarch64-apple-darwin") {
    throw new DiagnosticBlockedError("toolchain-host", "toolchain host is not arm64 Apple Darwin");
  }
  if (probeRustc.commit !== rustc.commit || probeRustc.version !== rustc.version) {
    throw new DiagnosticBlockedError(
      "toolchain-drift",
      "toolchain probe changed during resolution",
    );
  }
  assertExactToolchain(rustc, cargo);
  return {
    selected,
    rustc,
    cargo,
    sysroot: sysrootReal,
    rustcPath: join(sysrootReal, "bin", "rustc"),
    cargoPath: join(sysrootReal, "bin", "cargo"),
    rustStandardLibraryLicensePath: join(sysrootReal, RUST_STDLIB_COPYRIGHT),
  };
}

export async function probeSdk({ sourceEnv = process.env } = {}) {
  const env = baseEnvironment(sourceEnv);
  const sdkPathResult = await runProbe("xcrun", ["--sdk", "macosx", "--show-sdk-path"], env);
  const versionResult = await runProbe("xcrun", ["--sdk", "macosx", "--show-sdk-version"], env);
  const sdkPath = sdkPathResult.stdout.trim();
  const version = versionResult.stdout.trim();
  if (!isAbsolute(sdkPath) || sdkPath.includes("\0") || version.length === 0) {
    throw new DiagnosticBlockedError("invalid-sdk", "xcrun returned an invalid macOS SDK");
  }
  try {
    if (!(await stat(sdkPath)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new DiagnosticBlockedError("missing-sdk", "macOS SDK path is unavailable");
  }
  return { path: sdkPath, version };
}

export function createBuildEnvironment({ toolchain, cargoHome, sdkPath }, sourceEnv = process.env) {
  const env = baseEnvironment(sourceEnv);
  env.PATH = `${join(toolchain.sysroot, "bin")}:${env.PATH}`;
  env.RUSTC = toolchain.rustcPath;
  env.RUSTUP_TOOLCHAIN = toolchain.selected;
  env.RUSTUP_AUTO_INSTALL = "0";
  env.CARGO_HOME = cargoHome;
  env.CARGO_NET_OFFLINE = "true";
  env.CARGO_TERM_COLOR = "never";
  env.CARGO_INCREMENTAL = "0";
  env.MACOSX_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
  env.SDKROOT = sdkPath;
  env.SOURCE_DATE_EPOCH = "0";
  env.ZERO_AR_DATE = "1";
  return env;
}

export const BUILD_FORBIDDEN_ENVIRONMENT = Object.freeze([
  "RUSTFLAGS",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_BUILD_RUSTFLAGS",
  "CARGO_BUILD_TARGET",
  "CARGO_TARGET_DIR",
  "RUSTC",
]);
