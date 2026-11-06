import { describe, expect, it } from "vitest";
import {
  D06_BLOCKED_SCOPE,
  D06_GATE,
  buildSeatbeltProfile,
  collectAncestorDirectories,
  decideFailureTests,
  decideExit,
  describeSeatbeltAllowlist,
  isKnownMaskedModuleFailure,
  judgeObservation,
  type D06CaseResult,
  type D06FailureTestResult,
  type SeatbeltProfileInput,
} from "../../scripts/d06-policy.js";

const input: SeatbeltProfileInput = {
  nodePath: "/Users/example/.local/node/bin/node",
  bundlePath: "/private/tmp/d06-root/server.mjs",
  canaryRoot: "/private/tmp/d06-root",
  docsDir: "/private/tmp/d06-root/docs",
  docsFile: "/private/tmp/d06-root/docs/guide.md",
  clientDir: "/private/tmp/d06-root/client",
  clientFile: "/private/tmp/d06-root/client/browser-client.mjs",
  browserSocketPath: "/private/tmp/d06-root/browser.sock",
};

describe("D06 seatbelt profile", () => {
  it("uses deny-default, exact process exec and no broad filesystem or network grants", () => {
    const profile = buildSeatbeltProfile(input);
    expect(profile).toContain("(deny default)");
    expect(profile).not.toContain("(allow default)");
    expect(profile).toContain(`(allow process-exec (literal ${JSON.stringify(input.nodePath)}))`);
    expect(profile).toContain('(literal "/")');
    expect(profile).toContain('(subpath "/System/Library")');
    expect(profile).toContain('(subpath "/usr/lib")');
    expect(profile).not.toMatch(/\(subpath "\/(?:Users|private|tmp|var)?"\)/u);
    expect(profile.match(/network-outbound/gu)).toHaveLength(1);
    expect(profile).toContain(
      `(remote unix-socket (path ${JSON.stringify(input.browserSocketPath)}))`,
    );
    expect(profile).not.toContain("network-inbound");
    expect(profile).not.toContain("process-fork");
    expect(profile).not.toContain("mach-lookup");
  });

  it("allows only literal ancestors for realpath/lstat metadata", () => {
    const profile = buildSeatbeltProfile(input);
    expect(profile).toContain("(allow file-read-metadata");
    expect(profile).toContain('(literal "/private")');
    expect(profile).toContain('(literal "/private/tmp")');
    expect(profile).toContain('(literal "/Users")');
    expect(profile).not.toContain('(subpath "/private/tmp")');
    expect(collectAncestorDirectories(["/a/b/c"])).toEqual(["/a", "/a/b"]);
  });

  it("records the same explicit allowlist that the profile renders", () => {
    const entries = describeSeatbeltAllowlist(input);
    expect(entries.filter((entry) => entry.operation === "process-exec")).toHaveLength(1);
    expect(entries.some((entry) => entry.path === "/" && entry.match === "literal")).toBe(true);
    expect(
      entries.some(
        (entry) => entry.match === "unix-socket" && entry.path === input.browserSocketPath,
      ),
    ).toBe(true);
    expect(entries.filter((entry) => entry.operation === "network-outbound")).toHaveLength(1);
    expect(entries.every((entry) => entry.reason.length > 0)).toBe(true);
  });
});

describe("D06 result classification", () => {
  it("accepts only EPERM/EACCES as expected denial", () => {
    expect(judgeObservation("denied", { outcome: "denied", code: "EPERM" }).status).toBe("passed");
    expect(judgeObservation("denied", { outcome: "denied", code: "EACCES" }).status).toBe("passed");
    expect(judgeObservation("denied", { outcome: "denied", causeCode: "EPERM" }).status).toBe(
      "passed",
    );
    expect(judgeObservation("denied", { outcome: "denied", code: "EINVAL" }).status).toBe("failed");
    expect(
      judgeObservation("denied", { outcome: "error", code: "ERR_MODULE_NOT_FOUND" }).status,
    ).toBe("failed");
  });

  it("does not turn initialization crashes or unknown errors into denial", () => {
    expect(judgeObservation("denied", { outcome: "crashed", code: "SIGABRT" }).status).toBe(
      "failed",
    );
    expect(judgeObservation("allowed", { outcome: "crashed", code: "SIGABRT" }).status).toBe(
      "failed",
    );
    expect(judgeObservation("allowed", { outcome: "error", detail: "unknown" }).status).toBe(
      "failed",
    );
    expect(judgeObservation("allowed", { outcome: "blocked", code: "EPERM" }).status).toBe(
      "blocked",
    );
  });

  it("accepts only known masked import failures for targeted attribution", () => {
    expect(isKnownMaskedModuleFailure({ outcome: "denied", code: "EPERM" })).toBe(true);
    expect(isKnownMaskedModuleFailure({ outcome: "denied", causeCode: "EACCES" })).toBe(true);
    expect(isKnownMaskedModuleFailure({ outcome: "error", code: "ERR_MODULE_NOT_FOUND" })).toBe(
      true,
    );
    expect(isKnownMaskedModuleFailure({ outcome: "error", code: "SyntaxError" })).toBe(false);
    expect(isKnownMaskedModuleFailure({ outcome: "error", code: "ERR_INVALID_URL" })).toBe(false);
    expect(isKnownMaskedModuleFailure({ outcome: "error", code: null })).toBe(false);
    expect(isKnownMaskedModuleFailure({ outcome: "allowed" })).toBe(false);
  });

  it("requires every case check to pass", () => {
    expect(
      judgeObservation("allowed", {
        outcome: "allowed",
        checks: { "child exited": true, "cleanup done": false },
      }).status,
    ).toBe("failed");
    expect(judgeObservation("allowed", { outcome: "allowed", checks: {} }).status).toBe("passed");
  });
});

describe("D06 exit policy", () => {
  const item = (status: D06CaseResult["status"]): D06CaseResult => ({
    id: `case-${status}`,
    group: "seatbelt",
    expected: "allowed",
    status,
    reason: status,
    observed: { outcome: status === "blocked" ? "blocked" : "allowed" },
    durationMs: 1,
  });

  it("returns 0 only when every implemented case passes while D06 stays blocked", () => {
    expect(decideExit([item("passed"), item("passed")])).toEqual({
      status: "satisfied",
      exitCode: 0,
    });
    expect(D06_GATE).toBe("blocked");
    expect(D06_BLOCKED_SCOPE).toContain("real-browser-integration");
  });

  it("uses exit 1 for failed cases and exit 2 for blocked/precondition cases", () => {
    expect(decideExit([item("passed"), item("failed")])).toEqual({ status: "failed", exitCode: 1 });
    expect(decideExit([item("passed"), item("blocked")])).toEqual({
      status: "blocked",
      exitCode: 2,
    });
    expect(decideExit([])).toEqual({ status: "blocked", exitCode: 2 });
  });
});

describe("R4-07 failure-test policy", () => {
  const item = (status: D06FailureTestResult["status"]): D06FailureTestResult => ({
    id: `failure-${status}`,
    expected: "startup-rejected-no-execution",
    status,
    reason: status,
    command: ["/usr/bin/sandbox-exec"],
    canary: { beforeSha256: "same", afterSha256: "same", unchanged: true },
    durationMs: 1,
  });

  it("treats expected startup rejection as success, not D06 blocked", () => {
    expect(decideFailureTests([item("passed"), item("passed")])).toEqual({
      status: "satisfied",
      exitCode: 0,
    });
    expect(item("passed").status).not.toBe("blocked");
  });

  it("fails or blocks independently from the main matrix", () => {
    expect(decideFailureTests([item("failed")])).toEqual({ status: "failed", exitCode: 1 });
    expect(decideFailureTests([item("blocked")])).toEqual({ status: "blocked", exitCode: 2 });
    expect(decideFailureTests([])).toEqual({ status: "failed", exitCode: 1 });
  });
});
