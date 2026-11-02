export const D06_ROUND5_GATE = "blocked" as const;
export const D06_ROUND5_TOOL = "node-repl-d06-round5";

export const D06_ROUND5_BLOCKED_SCOPE = [
  "real-browser-integration",
  "production-plugin-root-resolution",
  "debugger-attach-under-isolation",
  "descendant-abort-reclamation",
  "native-fenced-helper",
  "sea-runtime",
  "signature-package",
  "trusted-install-immutability",
  "toctou-check-use",
  "tcc-system-input",
] as const;

export type D06Round5Group = "native" | "ffi" | "browser" | "integrity" | "abort" | "debugger";
export type D06Round5Expected = "allowed" | "denied" | "verified";
export type D06Round5Outcome = "allowed" | "denied" | "error" | "crashed" | "blocked";
export type D06Round5Stage =
  | "compiled"
  | "not-loaded"
  | "load-denied"
  | "loaded"
  | "listed"
  | "verified"
  | "attached"
  | "permission-denied"
  | "exit";

export interface D06Round5Observation {
  outcome: D06Round5Outcome;
  stage?: D06Round5Stage;
  code?: string | null;
  errno?: number | null;
  detail?: string;
  checks?: Record<string, boolean>;
  raw?: unknown;
}

export interface D06Round5CaseResult {
  id: string;
  group: D06Round5Group;
  expected: D06Round5Expected;
  status: "passed" | "failed" | "blocked";
  reason: string;
  observed: D06Round5Observation;
  durationMs: number;
  command?: string[];
}

export interface D06Round5Verdict {
  status: "passed" | "failed" | "blocked";
  reason: string;
}

export const NATIVE_REQUIRED_CHECKS = [
  "native include exists",
  "clang executed",
  "addon compiled",
  "control addon loaded",
  "control POSIX read allowed",
  "control POSIX write allowed",
  "control POSIX spawn allowed",
  "isolated addon loaded",
  "isolated POSIX read denied",
  "isolated POSIX write denied",
  "isolated write canary unchanged",
  "isolated POSIX spawn denied",
  "control and isolated share addon hash",
] as const;

export const FFI_REQUIRED_CHECKS = [
  "koffi index fixed hash",
  "koffi native fixed hash",
  "control FFI loaded",
  "control libc read allowed",
  "control libc write allowed",
  "isolated FFI loaded",
  "isolated libc read denied",
  "isolated libc write denied",
  "isolated write canary unchanged",
  "control and isolated share koffi hash",
] as const;

export const BROWSER_REQUIRED_CHECKS = [
  "browser client built through public export",
  "real docs copied with source hashes",
  "client loaded in built cell",
  "setupBrowserRuntime executed",
  "list returned zero synthetic browsers",
  "broker token matched",
  "broker request schema valid",
  "broker list count delta one",
  "client write denied",
  "docs write denied",
  "readme write denied",
  "client hash unchanged",
  "docs hash unchanged",
  "readme hash unchanged",
] as const;

export const INTEGRITY_REQUIRED_CHECKS = [
  "manifest verified before execution",
  "missing rejected",
  "hash mismatch rejected",
  "symlink rejected",
  "path escape rejected",
  "tamper rejected",
  "tamper execute refused",
  "tamper canary unchanged",
] as const;

export const ABORT_REQUIRED_CHECKS = [
  "handshake observed",
  "abort requested after handshake",
  "rejection happened after direct exit",
  "direct pid dead at rejection",
  "no signal sent to unknown pid",
] as const;

export const DEBUGGER_REQUIRED_CHECKS = [
  "target is diagnostic-owned",
  "target env stripped",
  "non-isolated attach succeeded",
  "target exited",
] as const;

export function judgeNativeAddonProbe(observed: D06Round5Observation): D06Round5Verdict {
  return judgeLoadedNativeProbe(observed, "native addon", NATIVE_REQUIRED_CHECKS);
}

export function judgeFfiProbe(observed: D06Round5Observation): D06Round5Verdict {
  return judgeLoadedNativeProbe(observed, "fixed-hash FFI", FFI_REQUIRED_CHECKS);
}

function judgeLoadedNativeProbe(
  observed: D06Round5Observation,
  label: string,
  requiredChecks: readonly string[],
): D06Round5Verdict {
  if (observed.outcome === "blocked") {
    return { status: "blocked", reason: observed.detail ?? "environment blocked native probe" };
  }
  if (observed.stage === "not-loaded") {
    return { status: "failed", reason: `${label} was not loaded` };
  }
  if (observed.stage === "load-denied") {
    return {
      status: "failed",
      reason: `${label} load was rejected before the post-load OS probe`,
    };
  }
  const failedChecks = failedCheckNames(observed, requiredChecks);
  if (failedChecks.length > 0) {
    return { status: "failed", reason: `check failed: ${failedChecks.join(", ")}` };
  }
  if (observed.outcome !== "allowed" || observed.stage !== "loaded") {
    return {
      status: "failed",
      reason: `expected loaded native control and isolated denials, observed ${observed.stage ?? observed.outcome}`,
    };
  }
  return { status: "passed", reason: `${label} loaded and post-load OS boundary observed` };
}

export function judgeBrowserProbe(observed: D06Round5Observation): D06Round5Verdict {
  if (observed.outcome === "blocked") {
    return { status: "blocked", reason: observed.detail ?? "browser probe blocked" };
  }
  if (observed.stage === "not-loaded" || observed.stage === "load-denied") {
    return { status: "failed", reason: "built Browser client was not loaded in the cell" };
  }
  const failedChecks = failedCheckNames(observed, BROWSER_REQUIRED_CHECKS);
  if (failedChecks.length > 0) {
    return { status: "failed", reason: `check failed: ${failedChecks.join(", ")}` };
  }
  if (observed.outcome !== "allowed" || observed.stage !== "listed") {
    return {
      status: "failed",
      reason: `expected built Browser client list, observed ${observed.stage ?? observed.outcome}`,
    };
  }
  return {
    status: "passed",
    reason: "built Browser client loaded and synthetic broker contract observed",
  };
}

export function judgeIntegrityProbe(observed: D06Round5Observation): D06Round5Verdict {
  if (observed.outcome === "blocked") {
    return { status: "blocked", reason: observed.detail ?? "integrity precheck blocked" };
  }
  const failedChecks = failedCheckNames(observed, INTEGRITY_REQUIRED_CHECKS);
  if (failedChecks.length > 0) {
    return { status: "failed", reason: `check failed: ${failedChecks.join(", ")}` };
  }
  if (observed.outcome !== "allowed" || observed.stage !== "verified") {
    return {
      status: "failed",
      reason: `expected verified temporary resources, observed ${observed.stage ?? observed.outcome}`,
    };
  }
  return { status: "passed", reason: "temporary resource manifest accepted before execution" };
}

export function judgeAbortProbe(observed: D06Round5Observation): D06Round5Verdict {
  if (observed.outcome === "blocked") {
    return { status: "blocked", reason: observed.detail ?? "abort probe blocked" };
  }
  const failedChecks = failedCheckNames(observed, ABORT_REQUIRED_CHECKS);
  if (failedChecks.length > 0) {
    return { status: "failed", reason: `check failed: ${failedChecks.join(", ")}` };
  }
  if (observed.outcome !== "allowed" || observed.stage !== "exit") {
    return {
      status: "failed",
      reason: `expected observed handshake and real direct-cell exit, observed ${observed.stage ?? observed.outcome}`,
    };
  }
  return { status: "passed", reason: "direct cell exited before abort settlement" };
}

export function judgeDebuggerProbe(observed: D06Round5Observation): D06Round5Verdict {
  if (observed.outcome === "blocked" || observed.stage === "permission-denied") {
    return {
      status: "blocked",
      reason: observed.detail ?? "debugger attach permission or tooling is unavailable",
    };
  }
  const failedChecks = failedCheckNames(observed, DEBUGGER_REQUIRED_CHECKS);
  if (failedChecks.length > 0) {
    return { status: "failed", reason: `check failed: ${failedChecks.join(", ")}` };
  }
  if (observed.outcome !== "allowed" || observed.stage !== "attached") {
    return {
      status: "failed",
      reason: `expected owned non-sensitive target attach, observed ${observed.stage ?? observed.outcome}`,
    };
  }
  return {
    status: "passed",
    reason: "non-isolated attach to diagnostic-owned process succeeded",
  };
}

export function decideRound5Exit(cases: readonly D06Round5CaseResult[]): {
  status: "satisfied" | "failed" | "blocked";
  exitCode: 0 | 1 | 2;
} {
  if (cases.length === 0) return { status: "blocked", exitCode: 2 };
  if (cases.some((item) => item.status === "failed")) return { status: "failed", exitCode: 1 };
  if (cases.some((item) => item.status === "blocked")) return { status: "blocked", exitCode: 2 };
  return { status: "satisfied", exitCode: 0 };
}

export function summarizeRound5Cases(cases: readonly D06Round5CaseResult[]): {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
} {
  return {
    total: cases.length,
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    blocked: cases.filter((item) => item.status === "blocked").length,
  };
}

export function isDenialCode(code: string | null | undefined, errno?: number | null): boolean {
  if (code === "EPERM" || code === "EACCES") return true;
  return errno === 1 || errno === 13;
}

function failedCheckNames(
  observed: D06Round5Observation,
  requiredChecks: readonly string[],
): string[] {
  return requiredChecks.filter((name) => observed.checks?.[name] !== true);
}
