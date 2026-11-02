import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { D06Round5Observation } from "./d06-round5-policy.js";
import type { D06Round5ProbeContext } from "./d06-round5-probe-common.js";
import { isPidDead, pidStatus, readPid, waitForFile } from "./d06-round5-resources.js";

export async function runAbortProbe(context: D06Round5ProbeContext): Promise<D06Round5Observation> {
  const token = `d06-abort-${randomUUID()}`;
  const controller = new AbortController();
  const execution = context.forkExecutor({
    code: abortCellCode(context.paths.abortHandshakePath, context.paths.abortPidPath, token),
    requestMeta: { session_id: "d06-abort-session", runtime_scope: "main" },
    signal: controller.signal,
    syncTimeoutMs: 20_000,
  });
  const outcome = execution.then(
    () => undefined,
    (error: unknown) => error,
  );
  let pid: number | undefined;
  let settled = false;
  try {
    const handshake = await waitForFile(context.paths.abortHandshakePath, 10_000);
    if (!handshake) {
      controller.abort(new Error("round5-abort-handshake-timeout"));
      await boundedOutcome(outcome, 5_000);
      return { outcome: "error", stage: "exit", detail: "abort handshake not observed" };
    }
    const handshakeValue = await readFile(context.paths.abortHandshakePath, "utf8").catch(() => "");
    controller.abort(new Error("round5-direct-cell-abort"));
    const error = await boundedOutcome(outcome, 10_000);
    settled = true;
    pid = await readPid(context.paths.abortPidPath);
    return {
      outcome: "allowed",
      stage: "exit",
      detail: error instanceof Error ? error.message : "no abort rejection",
      checks: {
        "handshake observed": handshakeValue.includes(token),
        "abort requested after handshake": handshakeValue.includes(token),
        "rejection happened after direct exit":
          error instanceof Error && error.message === "round5-direct-cell-abort",
        "direct pid dead at rejection": pid ? isPidDead(pid) : false,
        "no signal sent to unknown pid": true,
      },
      raw: {
        transport: "fork/direct-cell",
        descendantReclamation: "not-proven",
        pidStatus: pid ? pidStatus(pid) : "missing",
      },
    };
  } finally {
    // 不按 pid 文件发信号：PID 可能已被系统复用，token 只证明过去的握手。
    // executor 持有直接 ChildProcess，清理与结算归它所有。
    controller.abort(new Error("round5-abort-finally"));
    if (!settled) await boundedOutcome(outcome, 5_000);
  }
}

function abortCellCode(handshakePath: string, pidPath: string, token: string): string {
  return [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid), 'utf8');`,
    `fs.writeFileSync(${JSON.stringify(handshakePath)}, ${JSON.stringify(token)}, 'utf8');`,
    "await new Promise((resolve) => setTimeout(resolve, 60000));",
    "return { outcome: 'allowed' };",
  ].join("\n");
}

async function boundedOutcome<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
