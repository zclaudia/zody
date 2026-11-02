#!/usr/bin/env node

import {
  DiagnosticBlockedError,
  DiagnosticVerificationError,
} from "./lib/cua-helper-diagnostic-core.mjs";
import { buildDiagnosticArtifact } from "./lib/cua-helper-diagnostic-build.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/build-macos-cua-helper-diagnostic.mjs [--rust-toolchain <name>]

Builds the diagnostic-only Zody Computer Use Diagnostic.app with locked, offline Cargo and
system-temporary source/CARGO_HOME isolation. It never installs or downloads a toolchain and
never wires the artifact into the default build, installer, launcher, or runtime.

Exit codes:
  0  pass
  1  build or verification failure
  2  invalid arguments, blocked host, or missing toolchain/SDK
`;

function parseArguments(argv) {
  let toolchain = "stable";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--rust-toolchain" || argument.startsWith("--rust-toolchain=")) {
      const value = argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argv[++index];
      if (!value) return { error: "invalid --rust-toolchain" };
      toolchain = value;
      continue;
    }
    return { error: "invalid arguments" };
  }
  return { toolchain };
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (parsed.error) {
  writeResult({ status: "fail", message: parsed.error });
  process.exit(2);
}

try {
  const result = await buildDiagnosticArtifact({ selectedToolchain: parsed.toolchain });
  writeResult({ status: "pass", ...result });
} catch (error) {
  if (error instanceof DiagnosticBlockedError) {
    writeResult({ status: "blocked", code: error.code, message: error.message });
    process.exit(2);
  }
  const message =
    error instanceof DiagnosticVerificationError || error instanceof Error
      ? error.message
      : "unknown build failure";
  writeResult({ status: "fail", message });
  process.exit(1);
}
