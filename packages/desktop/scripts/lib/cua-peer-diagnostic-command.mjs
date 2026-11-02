import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function appendBounded(chunks, chunk, state, maxBuffer) {
  if (state.overflow) {
    return;
  }
  state.bytes += chunk.length;
  if (state.bytes > maxBuffer) {
    state.overflow = true;
    return;
  }
  chunks.push(chunk);
}

export function spawnCollected(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const startedAt = nowMs();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  const state = { bytes: 0, overflow: false, timedOut: false, settled: false };
  let timer = null;

  const result = new Promise((resolve) => {
    const finish = (outcome) => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        command,
        args,
        exitCode: outcome.exitCode ?? null,
        signal: outcome.signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut: state.timedOut,
        bufferOverflow: state.overflow,
        error: outcome.error ? outcome.error.message : null,
        durationMs: nowMs() - startedAt,
      });
    };

    const collect = (chunks) => (chunk) => {
      appendBounded(chunks, chunk, state, maxBuffer);
      if (state.overflow && !state.killed) {
        state.killed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.on("error", (error) => finish({ error }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));

    timer = setTimeout(() => {
      state.timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
  });

  return { child, pid: child.pid ?? null, result };
}

export async function runBoundedCommand(command, args, options = {}) {
  return spawnCollected(command, args, options).result;
}

export function assertCommandOk(result, label) {
  const status = result.timedOut
    ? "timeout"
    : result.bufferOverflow
      ? "buffer-overflow"
      : result.error
        ? "failed"
        : result.exitCode === 0
          ? "ok"
          : "failed";
  if (status === "ok") {
    return result;
  }
  const details = [result.stderr, result.stdout, result.error]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join("\n")
    .slice(0, 2_000);
  throw new Error(`${label} failed (${status}): ${details}`);
}
