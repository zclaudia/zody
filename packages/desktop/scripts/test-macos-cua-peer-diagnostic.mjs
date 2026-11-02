#!/usr/bin/env node

import {
  PeerDiagnosticBlockedError,
  PeerDiagnosticFailureError,
} from "./lib/cua-peer-diagnostic-core.mjs";
import { runNativePeerDiagnosticSuite } from "./lib/cua-peer-diagnostic-run.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/test-macos-cua-peer-diagnostic.mjs

Builds and runs the real R10 native peer diagnostic: own AF_UNIX listener,
own test client, LOCAL_PEERTOKEN audit token, Security.framework dynamic code
checks, and clearly separated synthetic policy scenarios. It never creates or
installs certificates, changes keychain/TCC, signs an artifact or wires the
diagnostic into the product.

Exit codes:
  0  pass
  1  scenario or verification failure
  2  blocked host or missing fixed toolchain/SDK
`;

if (process.argv.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (process.argv.length !== 2) {
  process.stdout.write(`${JSON.stringify({ status: "fail", message: "invalid arguments" })}\n`);
  process.exit(2);
}

try {
  const report = await runNativePeerDiagnosticSuite({ writeReports: true });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: report.status,
        evidence: report.evidence,
        scenarios: report.scenarios.map((scenario) => ({
          id: scenario.id,
          kind: scenario.kind,
          status: scenario.status,
          decision: scenario.response?.decision ?? null,
        })),
        reportPath: report.reportPath ?? null,
      },
      null,
      2,
    )}\n`,
  );
  if (report.status === "blocked") {
    process.exit(2);
  }
} catch (error) {
  if (error instanceof PeerDiagnosticBlockedError) {
    process.stdout.write(
      `${JSON.stringify({ status: "blocked", code: error.code, message: error.message, details: error.details ?? null }, null, 2)}\n`,
    );
    process.exit(2);
  }
  const details = error instanceof PeerDiagnosticFailureError ? error.details : null;
  process.stdout.write(
    `${JSON.stringify({ status: "fail", message: error.message, details }, null, 2)}\n`,
  );
  process.exit(1);
}
