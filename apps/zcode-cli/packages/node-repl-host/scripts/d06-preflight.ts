import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { D06Observation } from "./d06-policy.js";

const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export interface PolicyLoadProbeResult {
  observation: D06Observation;
  command: string[];
}

export interface InspectorProbeResult {
  observation: D06Observation;
  command: string[];
}

export async function runPolicyLoadProbe(input: {
  sandboxExec: string;
  nodePath: string;
  profilePath: string;
  cwd: string;
  expectedNodeVersion: string;
  timeoutMs?: number;
}): Promise<PolicyLoadProbeResult> {
  const args = ["-f", input.profilePath, input.nodePath, "--version"];
  const result = await runBounded(input.sandboxExec, args, {
    cwd: input.cwd,
    env: { PATH: dirname(input.nodePath), LANG: "C" },
    timeoutMs: input.timeoutMs ?? 10_000,
  });
  const raw = {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.spawnError,
  };
  if (result.spawnError?.includes("ENOENT")) {
    return {
      command: [input.sandboxExec, ...args],
      observation: { outcome: "blocked", code: "ENOENT", detail: result.spawnError, raw },
    };
  }
  if (/sandbox_apply:\s*Operation not permitted/u.test(result.stderr)) {
    return {
      command: [input.sandboxExec, ...args],
      observation: { outcome: "blocked", code: "EPERM", detail: result.stderr, raw },
    };
  }
  if (result.signal === "SIGABRT") {
    return {
      command: [input.sandboxExec, ...args],
      observation: { outcome: "crashed", code: "SIGABRT", detail: result.stderr, raw },
    };
  }
  if (result.spawnError) {
    return {
      command: [input.sandboxExec, ...args],
      observation: { outcome: "error", detail: result.spawnError, raw },
    };
  }
  if (result.exitCode !== 0) {
    return {
      command: [input.sandboxExec, ...args],
      observation: {
        outcome: "error",
        code: result.exitCode === null ? null : `EXIT_${result.exitCode}`,
        detail: result.stderr || `sandbox policy probe exited ${result.exitCode}`,
        raw,
      },
    };
  }
  return {
    command: [input.sandboxExec, ...args],
    observation: {
      outcome: "allowed",
      checks: {
        "sandbox policy loaded": true,
        "node version matches": result.stdout.trim() === `v${input.expectedNodeVersion}`,
      },
      raw,
    },
  };
}

export async function runInspectorListenProbe(input: {
  sandboxExec: string;
  nodePath: string;
  profilePath: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<InspectorProbeResult> {
  const source = [
    "(async () => {",
    '  const inspector = require("node:inspector");',
    "  const result = { url: null, threw: null };",
    "  try {",
    '    inspector.open(0, "127.0.0.1");',
    "    result.url = inspector.url() ?? null;",
    "  } catch (error) {",
    "    result.threw = { code: error.code ?? null, message: String(error.message) };",
    "  }",
    "  process.stdout.write(JSON.stringify(result));",
    "  await new Promise((resolve) => setTimeout(resolve, 100));",
    "  if (result.url) inspector.close();",
    "})();",
  ].join("\n");
  const args = ["-f", input.profilePath, input.nodePath, "-e", source];
  const result = await runBounded(input.sandboxExec, args, {
    cwd: input.cwd,
    env: {
      PATH: dirname(input.nodePath),
      HOME: input.cwd,
      TMPDIR: input.cwd,
      TMP: input.cwd,
      TEMP: input.cwd,
      LANG: "C",
    },
    timeoutMs: input.timeoutMs ?? 10_000,
  });
  const raw = {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.spawnError,
  };
  const command = [input.sandboxExec, ...args];
  if (result.spawnError?.includes("ENOENT")) {
    return {
      command,
      observation: { outcome: "blocked", code: "ENOENT", detail: result.spawnError, raw },
    };
  }
  if (/sandbox_apply:\s*Operation not permitted/u.test(result.stderr)) {
    return {
      command,
      observation: { outcome: "blocked", code: "EPERM", detail: result.stderr, raw },
    };
  }
  if (result.signal === "SIGABRT") {
    return {
      command,
      observation: { outcome: "crashed", code: "SIGABRT", detail: result.stderr, raw },
    };
  }
  if (result.exitCode !== 0) {
    return {
      command,
      observation: {
        outcome: "error",
        detail: result.stderr || `inspector probe exit ${result.exitCode}`,
        raw,
      },
    };
  }
  let value: { url?: unknown; threw?: { code?: unknown } | null } | undefined;
  try {
    value = JSON.parse(result.stdout) as typeof value;
  } catch {
    return {
      command,
      observation: { outcome: "error", detail: "inspector probe returned invalid JSON", raw },
    };
  }
  if (typeof value?.url === "string" && value.url.length > 0) {
    return {
      command,
      observation: { outcome: "allowed", checks: { "inspector URL is absent": false }, raw },
    };
  }
  const deniedByThrow = value?.threw?.code === "EPERM" || value?.threw?.code === "EACCES";
  const deniedByStderr =
    /Starting inspector.*(?:Operation not permitted|operation not permitted)/u.test(result.stderr);
  if (value?.url === null && (deniedByThrow || deniedByStderr)) {
    return {
      command,
      observation: {
        outcome: "denied",
        code: deniedByThrow ? String(value.threw?.code) : "EPERM",
        detail: deniedByThrow ? "inspector.open threw" : "inspector listener denied; URL absent",
        checks: { "inspector URL is absent": true },
        raw,
      },
    };
  }
  return {
    command,
    observation: {
      outcome: "error",
      detail: "inspector produced no URL and no EPERM/EACCES denial signal",
      raw,
    },
  };
}

interface BoundedResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function runBounded(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr = `${stderr}\nD06 policy probe timed out after ${options.timeoutMs}ms`.slice(
        0,
        MAX_DIAGNOSTIC_BYTES,
      );
    }, options.timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, MAX_DIAGNOSTIC_BYTES);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, MAX_DIAGNOSTIC_BYTES);
    });
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, spawnError });
    });
  });
}
