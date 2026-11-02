import { rm } from "node:fs/promises";
import { DOCTOR_KIND, DOCTOR_SCHEMA_VERSION, executeChecks } from "./cua-helper-local-doctor.mjs";
import { addCheck, errorMessage } from "./cua-helper-local-utils.mjs";

function summarize(checks) {
  const summary = { pass: 0, fail: 0, blocked: 0 };
  for (const check of checks) {
    if (Object.prototype.hasOwnProperty.call(summary, check.status)) {
      summary[check.status] += 1;
    }
  }
  const status = summary.fail > 0 ? "fail" : summary.blocked > 0 ? "blocked" : "pass";
  return { status, summary };
}

export async function runDoctor(options = {}) {
  const state = { checks: [], tempDir: null };
  try {
    await executeChecks(state, options);
  } catch (error) {
    addCheck(
      state.checks,
      "doctor.internal",
      "fail",
      `unexpected doctor failure: ${errorMessage(error)}`,
    );
  } finally {
    if (state.tempDir) {
      try {
        await rm(state.tempDir, { recursive: true, force: true });
        addCheck(state.checks, "doctor.cleanup", "pass", "temporary artifacts removed");
      } catch (error) {
        addCheck(
          state.checks,
          "doctor.cleanup",
          "fail",
          `temporary artifacts were not removed: ${errorMessage(error)}`,
          { tempDir: state.tempDir },
        );
      }
    }
  }
  const { status, summary } = summarize(state.checks);
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    kind: DOCTOR_KIND,
    status,
    appPath: state.appPath ?? options.appPath ?? null,
    profilePath: state.profilePath ?? options.profilePath ?? null,
    profile: "local-self-signed",
    checks: state.checks,
    summary,
  };
}

export function formatHumanResult(result) {
  const lines = [
    `macos-cua-helper-local-doctor [${result.status}] app=${result.appPath ?? "<missing>"} profile=${result.profilePath ?? "<missing>"}`,
  ];
  for (const check of result.checks) {
    lines.push(`  [${check.status}] ${check.id}: ${check.message}`);
  }
  lines.push(
    `summary: pass=${result.summary.pass} fail=${result.summary.fail} blocked=${result.summary.blocked}`,
  );
  return lines.join("\n");
}
