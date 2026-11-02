import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { ClosureBlockedError, ClosureVerificationError } from "./cua-driver-closure-core.mjs";

const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "RUSTUP_HOME",
];

export function baseClosureEnvironment(source = process.env) {
  const environment = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof source[key] === "string" && source[key].length > 0) environment[key] = source[key];
  }
  environment.PATH = environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return environment;
}

export function gitClosureEnvironment(source = process.env) {
  return {
    ...baseClosureEnvironment(source),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LANG: "C",
    LC_ALL: "C",
  };
}

function killGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

export async function runClosureCommand(
  command,
  args,
  { cwd, env, timeoutMs = 30_000, maxOutputBytes = 16 * 1024 * 1024, allowFailure = false } = {},
) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let outputBytes = 0;
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let overflow = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      hardStop = setTimeout(() => {
        finish(
          new ClosureBlockedError("command-timeout", "required command did not exit after timeout"),
        );
      }, 1_000);
    }, timeoutMs);
    let hardStop;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        overflow = true;
        killGroup(child);
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.on("error", () => {
      finish(new ClosureBlockedError("command-unavailable", "required command could not start"));
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(new ClosureBlockedError("command-timeout", "required command timed out"));
        return;
      }
      if (overflow) {
        finish(new ClosureVerificationError("required command output exceeded the audit limit"));
        return;
      }
      const stdoutBuffer = Buffer.concat(chunks);
      const result = { code, stdoutBuffer, stdout: stdoutBuffer.toString("utf8"), stderr };
      if (code !== 0 && !allowFailure) {
        finish(
          new ClosureBlockedError(
            "command-failed",
            `required command failed: ${stderr.trim().slice(-2000) || `exit ${code}`}`,
          ),
        );
        return;
      }
      finish(null, result);
    });
  });
}

export async function copyTreeSafe(sourceRoot, destinationRoot) {
  const sourceStat = await lstat(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new ClosureVerificationError(`source is not a regular directory: ${sourceRoot}`);
  }
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ClosureVerificationError(`symlink is not allowed in audit input: ${entry.name}`);
    }
    if (entry.isDirectory()) await copyTreeSafe(source, destination);
    else if (entry.isFile()) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, (await stat(source)).mode);
    } else throw new ClosureVerificationError(`unsupported audit input type: ${entry.name}`);
  }
}

export async function findAncestorCargoConfigs(startPath) {
  const found = [];
  let directory = startPath;
  while (true) {
    const cargoDirectory = join(directory, ".cargo");
    try {
      const cargoStat = await lstat(cargoDirectory);
      if (cargoStat.isSymbolicLink()) {
        throw new ClosureVerificationError(
          `symlinked Cargo configuration directory: ${cargoDirectory}`,
        );
      }
      if (!cargoStat.isDirectory()) {
        throw new ClosureVerificationError(
          `invalid Cargo configuration directory: ${cargoDirectory}`,
        );
      }
    } catch (error) {
      if (error instanceof ClosureVerificationError) throw error;
      if (error?.code !== "ENOENT") {
        throw new ClosureVerificationError(`cannot inspect Cargo configuration: ${cargoDirectory}`);
      }
    }
    for (const name of ["config.toml", "config"]) {
      const candidate = join(directory, ".cargo", name);
      try {
        const configStat = await lstat(candidate);
        if (configStat.isSymbolicLink()) {
          throw new ClosureVerificationError(`symlinked Cargo configuration: ${candidate}`);
        }
        if (!configStat.isFile()) {
          throw new ClosureVerificationError(`invalid Cargo configuration: ${candidate}`);
        }
        found.push(candidate);
      } catch (error) {
        if (error instanceof ClosureVerificationError) throw error;
        if (error?.code !== "ENOENT") {
          throw new ClosureVerificationError(`cannot inspect Cargo configuration: ${candidate}`);
        }
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return found;
}

export function assertDirectChild(parent, child, label) {
  const rel = relative(parent, child);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
    throw new ClosureVerificationError(`invalid ${label} path`);
  }
}
