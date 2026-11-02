#!/usr/bin/env node

import {
  DiagnosticBlockedError,
  DiagnosticVerificationError,
} from "./lib/cua-helper-diagnostic-core.mjs";
import { buildDiagnosticArtifact } from "./lib/cua-helper-diagnostic-build.mjs";
import { verifyDiagnosticArtifact } from "./lib/cua-helper-diagnostic-verify.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/test-macos-cua-helper-diagnostic.mjs

Runs the real R4-H diagnostic build smoke: fixed offline build, app/manifest/hash/schema
validation, then direct --health, --help, --version and invalid-argument process checks.

Exit codes:
  0  pass
  1  build or verification failure
  2  blocked host or missing build prerequisite
`;

if (process.argv.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (process.argv.length !== 2) {
  process.stdout.write(`${JSON.stringify({ status: "fail", message: "invalid arguments" })}\n`);
  process.exit(2);
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  const build = await buildDiagnosticArtifact();
  const verification = await verifyDiagnosticArtifact();
  writeResult({ status: "pass", build, verification });
} catch (error) {
  if (error instanceof DiagnosticBlockedError) {
    writeResult({ status: "blocked", code: error.code, message: error.message });
    process.exit(2);
  }
  const message =
    error instanceof DiagnosticVerificationError || error instanceof Error
      ? error.message
      : "unknown diagnostic smoke failure";
  writeResult({ status: "fail", message });
  process.exit(1);
}
