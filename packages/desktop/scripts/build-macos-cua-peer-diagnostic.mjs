#!/usr/bin/env node

import {
  PeerDiagnosticBlockedError,
  PeerDiagnosticFailureError,
} from "./lib/cua-peer-diagnostic-core.mjs";
import { buildNativePeerDiagnostic } from "./lib/cua-peer-diagnostic-build.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/build-macos-cua-peer-diagnostic.mjs

Builds the diagnostic-only macOS CUA peer identity executable with the fixed
xcrun macosx27.0 SDK, arm64 and minimum macOS 14.2. It performs no explicit
codesign, certificate, keychain, TCC or product integration action.

Exit codes:
  0  build and verification pass
  1  build or verification failure
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
  const result = await buildNativePeerDiagnostic();
  process.stdout.write(
    `${JSON.stringify({ status: "pass", artifact: result.manifest.artifact, sdk: result.manifest.build.sdk }, null, 2)}\n`,
  );
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
