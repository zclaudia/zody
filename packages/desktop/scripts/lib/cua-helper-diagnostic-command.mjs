import { spawn } from "node:child_process";

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
  "RUSTUP_TOOLCHAIN",
];

export class DiagnosticCommandError extends Error {
  constructor(message, { code = null, timedOut = false, stdout = "", stderr = "" } = {}) {
    super(message);
    this.name = "DiagnosticCommandError";
    this.code = code;
    this.timedOut = timedOut;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function baseEnvironment(source = process.env) {
  const environment = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  environment.PATH = environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return environment;
}

function appendLimited(current, chunk, limit) {
  const next = current + chunk.toString("utf8");
  return next.length > limit ? next.slice(-limit) : next;
}

function killChild(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

export async function runCommand(
  command,
  args,
  { cwd, env, timeoutMs = 10_000, maxOutputBytes = 512 * 1024, allowFailure = false } = {},
) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let hardStopTimer;
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
      clearTimeout(hardStopTimer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
      hardStopTimer = setTimeout(() => {
        finish(
          new DiagnosticCommandError("required command did not exit after timeout", {
            timedOut: true,
            stdout,
            stderr,
          }),
        );
      }, 1_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, maxOutputBytes);
    });
    child.on("error", () => {
      finish(
        new DiagnosticCommandError("required command could not start", {
          stdout,
          stderr,
        }),
      );
    });
    child.on("close", (code) => {
      const result = { code, stdout, stderr, timedOut };
      if (timedOut) {
        finish(
          new DiagnosticCommandError("required command timed out", {
            code,
            timedOut: true,
            stdout,
            stderr,
          }),
        );
        return;
      }
      if (code !== 0 && !allowFailure) {
        finish(
          new DiagnosticCommandError("required command failed", {
            code,
            stdout,
            stderr,
          }),
        );
        return;
      }
      finish(null, result);
    });
  });
}

export function boundedCommandFailure(error) {
  if (!(error instanceof DiagnosticCommandError)) return "command failed";
  const detail = (error.stderr || error.stdout).trim().slice(-2000);
  return detail.length > 0 ? detail : "command failed";
}
