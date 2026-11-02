import type { NodeReplExecutor } from "../src/node-repl-session-executor.js";
import { CELL_RUN_FLAG } from "../src/cell-protocol.js";
import { createSubprocessNodeReplExecutor } from "../src/subprocess-executor.js";
import {
  D06_BROWSER_TOKEN,
  type D06FixtureServers,
  type D06Paths,
  dirnameOf,
  errorText,
} from "./d06-resources.js";
import {
  judgeObservation,
  type D06CaseResult,
  type D06Expectation,
  type D06Observation,
  type D06ObservedOutcome,
} from "./d06-policy.js";

export const D06_REQUEST_META = {
  session_id: "d06-synthetic-session",
  runtime_scope: "main",
} as const;

export interface D06ProbeContext {
  forkExecutor: NodeReplExecutor;
  seatbeltExecutor: NodeReplExecutor;
  paths: D06Paths;
  nodePath: string;
  tcpPort: number;
  stats: D06FixtureServers["stats"];
}

export function createD06ProbeContext(input: {
  nodePath: string;
  sandboxExec: string;
  paths: D06Paths;
  tcpPort: number;
  stats: D06FixtureServers["stats"];
}): D06ProbeContext {
  return {
    paths: input.paths,
    nodePath: input.nodePath,
    tcpPort: input.tcpPort,
    stats: input.stats,
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

export function createD06CellExecutor(input: {
  nodePath: string;
  paths: D06Paths;
  launch: { command: string; args: string[] };
  browserBroker?: { socketPath: string; token: string };
}): NodeReplExecutor {
  return createSubprocessNodeReplExecutor({
    serverPath: input.paths.bundlePath,
    cwd: input.paths.root,
    env: buildD06CellEnvironment(input.nodePath, input.paths.root),
    abortGraceMs: 250,
    requestMaxBytes: 2 * 1024 * 1024,
    responseMaxBytes: 8 * 1024 * 1024,
    documentationRoots: { browser: input.paths.docsDir, cua: input.paths.docsDir },
    launch: input.launch,
    ...(input.browserBroker ? { browserBroker: input.browserBroker } : {}),
  });
}

export async function runProbeCell(
  executor: NodeReplExecutor,
  code: string,
  timeoutMs = 20_000,
): Promise<D06Observation> {
  try {
    const result = await executor({
      code,
      requestMeta: D06_REQUEST_META,
      signal: AbortSignal.timeout(timeoutMs),
      syncTimeoutMs: Math.max(1, timeoutMs - 2_000),
    });
    if (result.error && !result.result) {
      return {
        outcome: "error",
        code: null,
        detail: `${result.error.name}: ${result.error.message}`,
        raw: result.error,
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(result.result ?? "");
    } catch {
      return {
        outcome: "error",
        detail: "cell did not return a JSON probe observation",
        raw: { result: result.result, error: result.error },
      };
    }
    return normalizeProbeValue(value);
  } catch (error) {
    return classifyExecutionError(error);
  }
}

export async function runCase(
  id: string,
  group: "fork" | "seatbelt",
  expected: D06Expectation,
  probe: () => Promise<D06Observation>,
): Promise<D06CaseResult> {
  const started = Date.now();
  let observed: D06Observation;
  try {
    observed = await probe();
  } catch (error) {
    observed = { outcome: "error", detail: errorText(error) };
  }
  const verdict = judgeObservation(expected, observed);
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

function normalizeProbeValue(value: unknown): D06Observation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { outcome: "error", detail: "probe observation is not an object", raw: value };
  }
  const record = value as Record<string, unknown>;
  const rawOutcome = record.outcome;
  const outcome: D06ObservedOutcome =
    rawOutcome === "allowed" || rawOutcome === "denied" || rawOutcome === "error"
      ? rawOutcome
      : "error";
  return {
    outcome,
    code: typeof record.code === "string" ? record.code : null,
    causeCode: typeof record.causeCode === "string" ? record.causeCode : null,
    detail: typeof record.detail === "string" ? record.detail : undefined,
    checks:
      record.checks && typeof record.checks === "object" && !Array.isArray(record.checks)
        ? (record.checks as Record<string, boolean>)
        : undefined,
    raw: value,
  };
}

function classifyExecutionError(error: unknown): D06Observation {
  const detail = errorText(error);
  if (/sandbox_apply:\s*Operation not permitted/u.test(detail)) {
    return { outcome: "blocked", code: "EPERM", detail };
  }
  if (/spawn .*sandbox-exec.*ENOENT|sandbox-exec: No such file/u.test(detail)) {
    return { outcome: "blocked", code: "ENOENT", detail };
  }
  if (/signal=SIGABRT|signal SIGABRT/u.test(detail)) {
    return { outcome: "crashed", code: "SIGABRT", detail };
  }
  if (/exited before returning a result/u.test(detail)) {
    return { outcome: "crashed", detail };
  }
  return { outcome: "error", detail };
}

export function buildD06CellEnvironment(nodePath: string, canaryRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: dirnameOf(nodePath),
    HOME: canaryRoot,
    TMPDIR: canaryRoot,
    TMP: canaryRoot,
    TEMP: canaryRoot,
    LANG: "C",
    ZCODE_D06_SYNTHETIC_SECRET: "d06-not-a-real-secret",
    AWS_SECRET_ACCESS_KEY: "d06-not-a-real-aws-key",
    NODE_OPTIONS: "--inspect=127.0.0.1:65531",
  };
}
