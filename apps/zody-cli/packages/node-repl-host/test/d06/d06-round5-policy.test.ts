import { describe, expect, it } from "vitest";
import {
  D06_ROUND5_BLOCKED_SCOPE,
  D06_ROUND5_GATE,
  ABORT_REQUIRED_CHECKS,
  BROWSER_REQUIRED_CHECKS,
  DEBUGGER_REQUIRED_CHECKS,
  FFI_REQUIRED_CHECKS,
  INTEGRITY_REQUIRED_CHECKS,
  NATIVE_REQUIRED_CHECKS,
  decideRound5Exit,
  isDenialCode,
  judgeAbortProbe,
  judgeBrowserProbe,
  judgeDebuggerProbe,
  judgeFfiProbe,
  judgeIntegrityProbe,
  judgeNativeAddonProbe,
  type D06Round5CaseResult,
  type D06Round5Observation,
} from "../../scripts/d06-round5-policy.js";

const checks = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, true]));

const nativeChecks = checks(NATIVE_REQUIRED_CHECKS);
const ffiChecks = checks(FFI_REQUIRED_CHECKS);
const browserChecks = checks(BROWSER_REQUIRED_CHECKS);
const integrityChecks = checks(INTEGRITY_REQUIRED_CHECKS);
const abortChecks = checks(ABORT_REQUIRED_CHECKS);
const debuggerChecks = checks(DEBUGGER_REQUIRED_CHECKS);

describe("D06 round 5 native judgement", () => {
  it("requires the same addon to load and exercise POSIX calls before isolated denials", () => {
    expect(
      judgeNativeAddonProbe({
        outcome: "allowed",
        stage: "loaded",
        checks: nativeChecks,
      }),
    ).toEqual({
      status: "passed",
      reason: "native addon loaded and post-load OS boundary observed",
    });
    expect(
      judgeNativeAddonProbe({
        outcome: "allowed",
        stage: "loaded",
        checks: { ...nativeChecks, "isolated POSIX write denied": false },
      }).status,
    ).toBe("failed");
  });

  it("does not treat a missing addon or a load rejection as isolation success", () => {
    expect(
      judgeNativeAddonProbe({ outcome: "error", stage: "not-loaded", checks: nativeChecks }).status,
    ).toBe("failed");
    expect(
      judgeNativeAddonProbe({ outcome: "denied", stage: "load-denied", checks: nativeChecks })
        .status,
    ).toBe("failed");
    expect(
      judgeNativeAddonProbe({
        outcome: "blocked",
        stage: "not-loaded",
        detail: "clang missing",
      }).status,
    ).toBe("blocked");
  });

  it("rejects empty, missing and non-true check maps instead of passing them", () => {
    const falsyChecks: D06Round5Observation[] = [
      { outcome: "allowed" as const, stage: "loaded" as const, checks: {} },
      { outcome: "allowed" as const, stage: "loaded" as const },
      {
        outcome: "allowed" as const,
        stage: "loaded" as const,
        checks: {
          ...nativeChecks,
          "control POSIX spawn allowed": undefined as unknown as boolean,
        },
      },
    ];
    for (const observed of falsyChecks) {
      expect(judgeNativeAddonProbe(observed).status).toBe("failed");
    }
    expect(judgeBrowserProbe({ outcome: "allowed", stage: "listed", checks: {} }).status).toBe(
      "failed",
    );
    expect(judgeIntegrityProbe({ outcome: "allowed", stage: "verified" }).status).toBe("failed");
    expect(judgeAbortProbe({ outcome: "allowed", stage: "exit", checks: {} }).status).toBe(
      "failed",
    );
    expect(judgeDebuggerProbe({ outcome: "allowed", stage: "attached", checks: {} }).status).toBe(
      "failed",
    );
  });

  it("applies the same load-then-OS rule to the fixed-hash FFI probe", () => {
    expect(judgeFfiProbe({ outcome: "allowed", stage: "loaded", checks: ffiChecks }).status).toBe(
      "passed",
    );
    expect(
      judgeFfiProbe({ outcome: "denied", stage: "load-denied", checks: ffiChecks }).status,
    ).toBe("failed");
  });
});

describe("D06 round 5 browser judgement", () => {
  it("requires the built client, synthetic broker contract and unchanged hashes", () => {
    expect(
      judgeBrowserProbe({ outcome: "allowed", stage: "listed", checks: browserChecks }),
    ).toEqual({
      status: "passed",
      reason: "built Browser client loaded and synthetic broker contract observed",
    });
    expect(
      judgeBrowserProbe({
        outcome: "allowed",
        stage: "listed",
        checks: { ...browserChecks, "broker request schema valid": false },
      }).status,
    ).toBe("failed");
    expect(
      judgeBrowserProbe({
        outcome: "allowed",
        stage: "listed",
        checks: { ...browserChecks, "client hash unchanged": false },
      }).status,
    ).toBe("failed");
  });

  it("does not call missing resources a browser E2E pass", () => {
    expect(
      judgeBrowserProbe({ outcome: "error", stage: "not-loaded", checks: browserChecks }).status,
    ).toBe("failed");
    expect(
      judgeBrowserProbe({ outcome: "blocked", stage: "not-loaded", detail: "esbuild missing" })
        .status,
    ).toBe("blocked");
  });
});

describe("D06 round 5 integrity, abort and debugger judgement", () => {
  it("requires all negative integrity counterexamples to be rejected before execution", () => {
    expect(
      judgeIntegrityProbe({ outcome: "allowed", stage: "verified", checks: integrityChecks }),
    ).toEqual({
      status: "passed",
      reason: "temporary resource manifest accepted before execution",
    });
    expect(
      judgeIntegrityProbe({
        outcome: "allowed",
        stage: "verified",
        checks: { ...integrityChecks, "symlink rejected": false },
      }).status,
    ).toBe("failed");
  });

  it("requires an observed handshake and a dead direct PID at abort settlement", () => {
    expect(judgeAbortProbe({ outcome: "allowed", stage: "exit", checks: abortChecks })).toEqual({
      status: "passed",
      reason: "direct cell exited before abort settlement",
    });
    expect(
      judgeAbortProbe({
        outcome: "allowed",
        stage: "exit",
        checks: { ...abortChecks, "handshake observed": false },
      }).status,
    ).toBe("failed");
    expect(
      judgeAbortProbe({
        outcome: "allowed",
        stage: "exit",
        checks: { ...abortChecks, "direct pid dead at rejection": false },
      }).status,
    ).toBe("failed");
  });

  it("reports debugger permission failures as blocked, not passed", () => {
    expect(
      judgeDebuggerProbe({
        outcome: "allowed",
        stage: "attached",
        checks: debuggerChecks,
      }).status,
    ).toBe("passed");
    expect(
      judgeDebuggerProbe({ outcome: "blocked", stage: "permission-denied", detail: "EPERM" })
        .status,
    ).toBe("blocked");
    expect(
      judgeDebuggerProbe({
        outcome: "allowed",
        stage: "attached",
        checks: { ...debuggerChecks, "target env stripped": false },
      }).status,
    ).toBe("failed");
  });
});

describe("D06 round 5 exit policy", () => {
  const item = (status: D06Round5CaseResult["status"]): D06Round5CaseResult => ({
    id: `case-${status}`,
    group: "native",
    expected: "allowed",
    status,
    reason: status,
    observed: { outcome: status === "blocked" ? "blocked" : "allowed" },
    durationMs: 1,
  });

  it("keeps the full D06 gate blocked while allowing an implemented-matrix exit 0", () => {
    expect(decideRound5Exit([item("passed"), item("passed")])).toEqual({
      status: "satisfied",
      exitCode: 0,
    });
    expect(D06_ROUND5_GATE).toBe("blocked");
    expect(D06_ROUND5_BLOCKED_SCOPE).toContain("real-browser-integration");
    expect(D06_ROUND5_BLOCKED_SCOPE).toContain("toctou-check-use");
  });

  it("uses exit 1 for failed and exit 2 for blocked evidence", () => {
    expect(decideRound5Exit([item("passed"), item("failed")])).toEqual({
      status: "failed",
      exitCode: 1,
    });
    expect(decideRound5Exit([item("passed"), item("blocked")])).toEqual({
      status: "blocked",
      exitCode: 2,
    });
    expect(decideRound5Exit([])).toEqual({ status: "blocked", exitCode: 2 });
  });

  it("accepts only EPERM/EACCES or their POSIX errno values as denial", () => {
    expect(isDenialCode("EPERM")).toBe(true);
    expect(isDenialCode("EACCES")).toBe(true);
    expect(isDenialCode(null, 1)).toBe(true);
    expect(isDenialCode(null, 13)).toBe(true);
    expect(isDenialCode("ENOENT", 2)).toBe(false);
    expect(isDenialCode(null, null)).toBe(false);
  });
});
