import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FIXED_COMMANDS = Object.freeze({
  codesign: "/usr/bin/codesign",
  lipo: "/usr/bin/lipo",
  otool: "/usr/bin/otool",
  plutil: "/usr/bin/plutil",
});

function toText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") {
    return {
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: "",
      message: "command adapter returned no result",
    };
  }
  return {
    status: result.status ?? (result.exitCode === 0 ? "ok" : "failed"),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    stdout: toText(result.stdout),
    stderr: toText(result.stderr),
    message: result.message,
  };
}

export function createExecFileCommandAdapter({
  timeoutMs = 30_000,
  maxBuffer = 8 * 1024 * 1024,
} = {}) {
  return {
    async run(command, args) {
      try {
        const result = await execFileAsync(command, args, {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true,
        });
        return {
          status: "ok",
          exitCode: 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      } catch (error) {
        const stdout = toText(error.stdout);
        const stderr = toText(error.stderr);
        if (error.code === "ENOENT") {
          return {
            status: "missing",
            exitCode: null,
            stdout,
            stderr,
            message: `missing required command: ${command}`,
          };
        }
        if (error.killed || error.code === "ETIMEDOUT") {
          return {
            status: "timeout",
            exitCode: null,
            stdout,
            stderr,
            message: `command timed out after ${timeoutMs}ms: ${command}`,
          };
        }
        return {
          status: "failed",
          exitCode: typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        };
      }
    },
  };
}

export async function runFixedCommand(adapter, command, args) {
  try {
    return normalizeResult(await adapter.run(command, args));
  } catch (error) {
    return {
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: "",
      message: `command adapter failure: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function isCommandMissing(result) {
  return result?.status === "missing";
}

export function isCommandOk(result) {
  return result?.status === "ok";
}

export function commandFailureSummary(result, command) {
  const details = [result?.message, result?.stderr, result?.stdout]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 1_500);
  const exit = typeof result?.exitCode === "number" ? ` (exit ${result.exitCode})` : "";
  return details.length > 0 ? `${command} failed${exit}: ${details}` : `${command} failed${exit}`;
}
