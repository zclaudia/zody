import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  hasRequiredSshE2EEnvironment,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "../scripts/e2e-formal-spec-selection.mjs";

describe("desktop E2E environment-gated formal spec admission", () => {
  it("excludes real SSH specs from default runs without complete credentials", () => {
    expect(hasRequiredSshE2EEnvironment({})).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts",
    );
  });

  it("keeps explicit SSH runs fail-closed and admits configured default runs", () => {
    const env = {
      ZODY_E2E_SSH_HOST: "ssh.example.test",
      ZODY_E2E_SSH_USERNAME: "root",
      ZODY_E2E_SSH_PASSWORD: "secret-from-test-env",
    };
    expect(hasRequiredSshE2EEnvironment(env)).toBe(true);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).not.toContain(
      "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts",
    );
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: true })).toEqual([]);
  });

  it("keeps human macOS R1 acceptance out of default replay even with ambient fixture configuration", () => {
    const r1 = "./test/e2e/conversation-session/conversation-session-cua-r1-*.test.ts";
    for (const env of [
      {},
      {
        ZODY_E2E_PACKAGED_APP_PATH: "/controlled/Candidate.app/Contents/MacOS/Zody",
        ZODY_CUA_R1_FIXTURE_MANIFEST: "/controlled/manifest.json",
        ZODY_CUA_R1_EVIDENCE_DIR: "/controlled/evidence",
        ZODY_E2E_MANUAL_REVIEW: "1",
      },
    ]) {
      expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toContain(r1);
      expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: true })).not.toContain(r1);
    }
  });

  it("uses the shared admission helper in the WDIO exclude list", () => {
    const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveEnvironmentGatedFormalSpecExcludes({");
    expect(source).toContain("hasRequiredSshE2EEnvironment(process.env)");
  });

  it("keeps promoted R2 hardware acceptance explicit even with ambient fixture configuration", () => {
    const r2 = "./test/e2e/conversation-session/conversation-session-cua-r2-*.test.ts";
    for (const env of [
      {},
      {
        ZODY_E2E_PACKAGED_APP_PATH: "/controlled/Candidate.app/Contents/MacOS/Zody",
        ZODY_CUA_R2_FIXTURE_MANIFEST: "/controlled/manifest.json",
        ZODY_CUA_R2_MONITOR_RUN: "/controlled/monitor",
        ZODY_E2E_MANUAL_REVIEW: "1",
      },
    ]) {
      expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toContain(r2);
      expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: true })).not.toContain(r2);
    }
  });
});
