import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  isRecord,
  isSha256,
  sha256File,
} from "./cua-driver-closure-core.mjs";
import { baseClosureEnvironment, runClosureCommand } from "./cua-driver-closure-command.mjs";

const SAFE_HOST = "aarch64-apple-darwin";
const EXPECTED = Object.freeze({
  version: "1.97.1",
  host: SAFE_HOST,
  rustcCommit: "8bab26f4f68e0e26f0bb7960be334d5b520ea452",
  cargoCommit: "c980f4866141969fab6254a680546a277789d6f0",
});
export const DRIVER_TOOLCHAIN_EXPECTED = EXPECTED;

function parseRustc(output) {
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  return {
    version: /^rustc\s+([^\s]+)/.exec(firstLine)?.[1] ?? null,
    release: /^release:\s*([^\s]+)$/m.exec(output)?.[1] ?? null,
    commit: /^commit-hash:\s*([0-9a-f]{40})$/m.exec(output)?.[1] ?? null,
    host: /^host:\s*([^\s]+)$/m.exec(output)?.[1] ?? null,
  };
}

function parseCargo(output) {
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  return {
    version: /^cargo\s+([^\s]+)/.exec(firstLine)?.[1] ?? null,
    release: /^release:\s*([^\s]+)$/m.exec(output)?.[1] ?? null,
    commit: /^commit-hash:\s*([0-9a-f]{40})$/m.exec(output)?.[1] ?? null,
    host: /^host:\s*([^\s]+)$/m.exec(output)?.[1] ?? null,
  };
}

export async function readToolchainConfig(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ClosureVerificationError("invalid driver toolchain configuration");
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "zody-cua-driver-round6-toolchain" ||
    parsed.version !== EXPECTED.version ||
    parsed.host !== EXPECTED.host ||
    !isRecord(parsed.rustc) ||
    !isRecord(parsed.cargo) ||
    !isSha256(parsed.rustc.sha256) ||
    !isSha256(parsed.cargo.sha256) ||
    parsed.rustc.version !== EXPECTED.version ||
    parsed.cargo.version !== EXPECTED.version ||
    parsed.rustc.commit !== EXPECTED.rustcCommit ||
    parsed.cargo.commit !== EXPECTED.cargoCommit
  ) {
    throw new ClosureVerificationError("invalid driver toolchain configuration");
  }
  return parsed;
}

async function runProbe(command, args, env) {
  try {
    return await runClosureCommand(command, args, {
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    });
  } catch (error) {
    throw new ClosureBlockedError(
      "toolchain-unavailable",
      `required driver toolchain command failed: ${error.message}`,
    );
  }
}

export async function probeDriverToolchain({ toolchainRoot, config, sourceEnv = process.env }) {
  if (typeof toolchainRoot !== "string" || !isAbsolute(toolchainRoot)) {
    throw new ClosureBlockedError(
      "toolchain-unavailable",
      "driver toolchain root must be absolute",
    );
  }
  let root;
  try {
    const metadata = await lstat(toolchainRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("not a directory");
    root = await realpath(toolchainRoot);
  } catch {
    throw new ClosureBlockedError(
      "toolchain-unavailable",
      "explicit driver toolchain root is missing or unsafe",
    );
  }
  const rustcPath = join(root, "bin", "rustc");
  const cargoPath = join(root, "bin", "cargo");
  try {
    await access(rustcPath, fsConstants.X_OK);
    await access(cargoPath, fsConstants.X_OK);
    for (const [label, path] of [
      ["rustc", rustcPath],
      ["cargo", cargoPath],
    ]) {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new ClosureBlockedError(
          "toolchain-unavailable",
          `driver ${label} is not a regular file`,
        );
      }
    }
  } catch (error) {
    if (error instanceof ClosureBlockedError) throw error;
    throw new ClosureBlockedError(
      "toolchain-unavailable",
      "explicit driver toolchain lacks executable rustc/cargo",
    );
  }
  const rustcSha256 = await sha256File(rustcPath);
  const cargoSha256 = await sha256File(cargoPath);
  if (rustcSha256 !== config.rustc.sha256 || cargoSha256 !== config.cargo.sha256) {
    throw new ClosureBlockedError(
      "toolchain-digest",
      "driver toolchain binary digest does not match the pinned preparation record; refusing to execute",
    );
  }
  const env = baseClosureEnvironment(sourceEnv);
  env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  env.RUSTUP_AUTO_INSTALL = "0";
  delete env.RUSTUP_HOME;
  const rustcResult = await runProbe(rustcPath, ["--version", "--verbose"], env);
  const sysrootResult = await runProbe(rustcPath, ["--print", "sysroot"], env);
  const cargoResult = await runProbe(cargoPath, ["--version", "--verbose"], env);
  const rustc = parseRustc(rustcResult.stdout);
  const cargo = parseCargo(cargoResult.stdout);
  const sysrootOutput = sysrootResult.stdout.trim();
  let sysroot;
  try {
    sysroot = await realpath(sysrootOutput);
  } catch {
    throw new ClosureBlockedError("toolchain-sysroot", "driver toolchain sysroot is unavailable");
  }
  if (!isAbsolute(sysrootOutput) || sysroot !== root) {
    throw new ClosureBlockedError(
      "toolchain-sysroot",
      "driver toolchain sysroot does not resolve to the explicit toolchain root",
    );
  }
  if (rustc.version !== EXPECTED.version || rustc.release !== EXPECTED.version) {
    throw new ClosureBlockedError("toolchain-mismatch", "driver rustc version does not match");
  }
  if (cargo.version !== EXPECTED.version || cargo.release !== EXPECTED.version) {
    throw new ClosureBlockedError("toolchain-mismatch", "driver cargo version does not match");
  }
  if (rustc.commit !== EXPECTED.rustcCommit) {
    throw new ClosureBlockedError("toolchain-mismatch", "driver rustc commit does not match");
  }
  if (cargo.commit !== EXPECTED.cargoCommit) {
    throw new ClosureBlockedError("toolchain-mismatch", "driver cargo commit does not match");
  }
  if (rustc.host !== EXPECTED.host || cargo.host !== EXPECTED.host) {
    throw new ClosureBlockedError("toolchain-host", "driver toolchain host does not match");
  }
  const rustcAfter = await sha256File(rustcPath);
  const cargoAfter = await sha256File(cargoPath);
  if (rustcAfter !== rustcSha256 || cargoAfter !== cargoSha256) {
    throw new ClosureBlockedError(
      "toolchain-drift",
      "driver toolchain binary changed during probing",
    );
  }
  return {
    status: "pass",
    root,
    sysroot,
    rustcPath,
    cargoPath,
    rustc: { ...rustc, sha256: rustcSha256 },
    cargo: { ...cargo, sha256: cargoSha256 },
    noStableFallback: true,
  };
}

export function toolchainAssessment({ upstreamDeclared, probe, config }) {
  const exactMatch =
    probe?.rustc?.version === upstreamDeclared &&
    probe?.rustc?.version === config.version &&
    probe?.rustc?.host === EXPECTED.host &&
    probe?.cargo?.host === EXPECTED.host;
  return {
    upstreamDeclared,
    auditedVersion: probe?.rustc?.version ?? "unavailable",
    auditedCommit: probe?.rustc?.commit ?? null,
    expectedVersion: config.version,
    expectedHost: config.host,
    rustcSha256: probe?.rustc?.sha256 ?? null,
    cargoSha256: probe?.cargo?.sha256 ?? null,
    noStableFallback: true,
    exactMatch,
    status: exactMatch ? "pass" : "blocked",
    reason: exactMatch
      ? "explicit driver toolchain matches the fixed upstream declaration, commit, host and binary digests"
      : "explicit driver toolchain is missing or drifted; stable fallback is forbidden",
  };
}
