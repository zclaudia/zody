import { CELL_RUN_FLAG } from "../src/cell-protocol.js";
import { D06_BROWSER_TOKEN, type D06FixtureServers } from "./d06-resources.js";
import {
  type D06Round5CaseResult,
  type D06Round5Expected,
  type D06Round5Group,
  type D06Round5Observation,
  type D06Round5Verdict,
} from "./d06-round5-policy.js";
import { createD06CellExecutor, type D06ProbeContext } from "./d06-probe-runtime.js";
import type { D06Round5Paths } from "./d06-round5-resources.js";

export interface D06Round5ProbeContext extends D06ProbeContext {
  paths: D06Round5Paths;
  sandboxExec: string;
}

export function createRound5ProbeContext(input: {
  nodePath: string;
  sandboxExec: string;
  paths: D06Round5Paths;
  tcpPort: number;
  stats: D06FixtureServers["stats"];
}): D06Round5ProbeContext {
  return {
    paths: input.paths,
    nodePath: input.nodePath,
    tcpPort: input.tcpPort,
    stats: input.stats,
    sandboxExec: input.sandboxExec,
    forkExecutor: createD06CellExecutor({
      nodePath: input.nodePath,
      paths: input.paths,
      launch: { command: input.nodePath, args: [input.paths.bundlePath, CELL_RUN_FLAG] },
    }),
    seatbeltExecutor: createD06CellExecutor({
      nodePath: input.nodePath,
      paths: input.paths,
      launch: {
        command: input.sandboxExec,
        args: [
          "-f",
          input.paths.profilePath,
          input.nodePath,
          input.paths.bundlePath,
          CELL_RUN_FLAG,
        ],
      },
      browserBroker: {
        socketPath: input.paths.browserSocketPath,
        token: D06_BROWSER_TOKEN,
      },
    }),
  };
}

export async function runRound5Case(
  id: string,
  group: D06Round5Group,
  expected: D06Round5Expected,
  judge: (observed: D06Round5Observation) => D06Round5Verdict,
  probe: () => Promise<D06Round5Observation>,
): Promise<D06Round5CaseResult> {
  const started = Date.now();
  let observed: D06Round5Observation;
  try {
    observed = await probe();
  } catch (error) {
    observed = { outcome: "error", detail: errorText(error) };
  }
  const verdict = judge(observed);
  return {
    id,
    group,
    expected,
    status: verdict.status,
    reason: verdict.reason,
    observed,
    durationMs: Date.now() - started,
  };
}

export const CELL_CLASSIFY = [
  "const d06Parse = (value) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return { ok: false }; } };",
  "const d06LoadError = (error) => {",
  "  const code = error && typeof error === 'object' ? error.code ?? null : null;",
  "  const causeCode = error && typeof error === 'object' && error.cause ? error.cause.code ?? null : null;",
  "  const denial = code === 'EPERM' || code === 'EACCES' || causeCode === 'EPERM' || causeCode === 'EACCES';",
  "  return { outcome: denial ? 'denied' : 'error', stage: denial ? 'load-denied' : 'not-loaded', code, causeCode, detail: error instanceof Error ? error.message : String(error) };",
  "};",
].join("\n");

export function extractData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const data = (raw as Record<string, unknown>).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function stageOf(result: D06Round5Observation): D06Round5Observation["stage"] {
  const raw = result.raw;
  if (!raw || typeof raw !== "object") return undefined;
  const stage = (raw as Record<string, unknown>).stage;
  return typeof stage === "string" ? (stage as D06Round5Observation["stage"]) : undefined;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function deltaStats(
  before: D06FixtureServers["stats"],
  after: D06FixtureServers["stats"],
): Record<string, number> {
  return {
    browserRequests: after.browserRequests - before.browserRequests,
    browserValidRequests: after.browserValidRequests - before.browserValidRequests,
    browserInvalidRequests: after.browserInvalidRequests - before.browserInvalidRequests,
    browserTokenMatches: after.browserTokenMatches - before.browserTokenMatches,
    browserSchemaValid: after.browserSchemaValid - before.browserSchemaValid,
    browserListMethods: after.browserListMethods - before.browserListMethods,
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
