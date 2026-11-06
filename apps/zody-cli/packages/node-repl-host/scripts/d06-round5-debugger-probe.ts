import type { D06Round5Observation } from "./d06-round5-policy.js";
import { runBoundedCommand } from "./d06-round5-resources.js";

export async function runDebuggerProbe(input: { cwd: string }): Promise<D06Round5Observation> {
  const status = await runBoundedCommand("/usr/sbin/DevToolsSecurity", ["-status"], {
    cwd: input.cwd,
    env: { PATH: "/usr/bin:/bin", HOME: input.cwd, TMPDIR: input.cwd, LANG: "C" },
    timeoutMs: 10_000,
  });
  if (status.timedOut || status.spawnError) {
    return {
      outcome: "blocked",
      detail: `DevToolsSecurity status unavailable: ${status.spawnError ?? "timeout"}`,
    };
  }
  const text = `${status.stdout}\n${status.stderr}`.trim();
  if (!/Developer mode is currently enabled/u.test(text)) {
    return {
      outcome: "blocked",
      stage: "permission-denied",
      detail: `debugger attach blocked: ${text || "developer mode disabled"}`,
    };
  }
  return {
    outcome: "blocked",
    detail:
      "developer mode enabled, but no owned non-sensitive isolated attach target was executed; full debugger attach remains blocked",
  };
}
