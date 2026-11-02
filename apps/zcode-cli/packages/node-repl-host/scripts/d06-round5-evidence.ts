import { judgeObservation, type D06Observation } from "./d06-policy.js";
import {
  D06_ROUND5_BLOCKED_SCOPE,
  D06_ROUND5_GATE,
  D06_ROUND5_TOOL,
  decideRound5Exit,
  summarizeRound5Cases,
  type D06Round5CaseResult,
  type D06Round5Observation,
} from "./d06-round5-policy.js";
import type { BoundedCommandResult } from "./d06-round5-resources.js";

export interface DiagnosticEvidence {
  schemaVersion: 1;
  tool: typeof D06_ROUND5_TOOL;
  generatedAt: string;
  status: "satisfied" | "failed" | "blocked";
  exitCode: 0 | 1 | 2;
  d06Gate: typeof D06_ROUND5_GATE;
  blockedScope: readonly string[];
  reason: string;
  host: {
    node: {
      runtimeVersion: string;
      runtimeExecPath: string;
      selectedPath?: string;
      selectedVersion?: string;
      expected: string;
    };
    os: { platform: NodeJS.Platform; type: string; release: string; arch: string };
  };
  toolchain?: Record<string, unknown>;
  bundle?: Record<string, unknown>;
  browserAssets?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  native?: Record<string, unknown>;
  integrity?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  cases: D06Round5CaseResult[];
  summary: ReturnType<typeof summarizeRound5Cases>;
  executionSkipped?: string;
  infrastructure?: { phase: string; error: string; code: string | null; blocked: boolean };
  cleanup?: { removed: boolean; error?: string };
  limitations: string[];
}

export function createEvidence(): DiagnosticEvidence {
  return {
    schemaVersion: 1,
    tool: D06_ROUND5_TOOL,
    generatedAt: new Date().toISOString(),
    status: "blocked",
    exitCode: 2,
    d06Gate: D06_ROUND5_GATE,
    blockedScope: D06_ROUND5_BLOCKED_SCOPE,
    reason: "round 5 diagnostic did not complete",
    host: {
      node: {
        runtimeVersion: process.version,
        runtimeExecPath: process.execPath,
        expected: "24.14.0",
      },
      os: { platform: process.platform, type: "", release: "", arch: "" },
    },
    cases: [],
    summary: { total: 0, passed: 0, failed: 0, blocked: 0 },
    limitations: limitations(),
  };
}

export function finalize(
  evidence: DiagnosticEvidence,
  infrastructure: DiagnosticEvidence["infrastructure"],
): DiagnosticEvidence {
  evidence.summary = summarizeRound5Cases(evidence.cases);
  let decision = decideRound5Exit(evidence.cases);
  if (evidence.cleanup && !evidence.cleanup.removed) {
    decision = { status: "failed", exitCode: 1 };
    evidence.reason = `cleanup failed: ${evidence.cleanup.error ?? "unknown cleanup error"}`;
  } else if (infrastructure) {
    evidence.infrastructure = infrastructure;
    decision = infrastructure.blocked
      ? { status: "blocked", exitCode: 2 }
      : { status: "failed", exitCode: 1 };
    evidence.reason = `setup failed: ${infrastructure.error}`;
  } else if (evidence.executionSkipped) {
    evidence.reason = evidence.executionSkipped;
  } else {
    const firstFailure = evidence.cases.find((item) => item.status !== "passed");
    evidence.reason =
      decision.exitCode === 0
        ? "round 5 implemented matrix satisfied; full D06 gate remains blocked"
        : (firstFailure?.reason ?? "round 5 matrix not satisfied");
  }
  evidence.status = decision.status;
  evidence.exitCode = decision.exitCode;
  return evidence;
}

export function profileObservation(observed: D06Observation): D06Round5Observation {
  return {
    outcome: observed.outcome,
    stage: "verified",
    code: observed.code,
    detail: observed.detail,
    checks: observed.checks,
    raw: observed.raw,
  };
}

export function judgeRound5Preflight(observed: D06Round5Observation) {
  if (observed.outcome === "blocked") {
    return { status: "blocked" as const, reason: observed.detail ?? "profile preflight blocked" };
  }
  const verdict = judgeObservation("allowed", observed as D06Observation);
  return verdict.status === "passed"
    ? { status: "passed" as const, reason: "round 5 profile loaded" }
    : { status: verdict.status, reason: verdict.reason };
}

export function boundedCompile(
  compile: BoundedCommandResult | undefined,
): Record<string, unknown> | undefined {
  if (!compile) return undefined;
  return {
    exitCode: compile.exitCode,
    signal: compile.signal,
    timedOut: compile.timedOut,
    stderr: compile.stderr,
    spawnError: compile.spawnError,
  };
}

function limitations(): string[] {
  return [
    "full D06 remains blocked; this entry covers only the explicit round 5 increments",
    "synthetic Browser broker proves client load/protocol compatibility, not real browser E2E",
    "the cell is given an explicit documentation root; production ZCODE_PLUGIN_ROOT stripping remains unresolved",
    "temporary manifest verification is check-time only; same-UID TOCTOU and trusted-install immutability are not proven",
    "direct fork cell exit does not prove descendant reclamation or native Fenced stop",
    "debugger attach is gated by DevToolsSecurity status; no safe isolated attach or lldb run is claimed",
    "no system input, TCC, SEA, signature, notarization, Intel or minimum-macOS claim is made",
  ];
}
