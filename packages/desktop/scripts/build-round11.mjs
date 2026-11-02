#!/usr/bin/env node

import { resolve } from "node:path";
import {
  OUTPUT_ROOT,
  VISUAL_OUTPUT_ROOT,
  buildRound11Helper,
} from "./lib/cua-helper-round11-build.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/build-round11.mjs [--output-root <dir>] [--visual-root <dir>]

Delegates to the final R11 build: fixed macosx27.0 SDK, arm64, minimum macOS
14.2, verified Node/authority resources and the native visual static library.
This command does not sign, install certificates, request TCC or run capture.

Defaults:
  output root: ${OUTPUT_ROOT}
  visual root: ${VISUAL_OUTPUT_ROOT}
`;

function parseArgs(argv) {
  let outputRoot = OUTPUT_ROOT;
  let visualRoot = VISUAL_OUTPUT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true, outputRoot, visualRoot };
    if (value === "--output-root") {
      const next = argv[index + 1];
      if (!next) throw new Error("--output-root requires a path");
      outputRoot = resolve(next);
      index += 1;
      continue;
    }
    if (value === "--visual-root") {
      const next = argv[index + 1];
      if (!next) throw new Error("--visual-root requires a path");
      visualRoot = resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return { help: false, outputRoot, visualRoot };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "fail", message: error.message })}\n`);
  process.exit(1);
}
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

try {
  const manifest = await buildRound11Helper({
    outputRoot: args.outputRoot,
    visualRoot: args.visualRoot,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "pass",
        outputRoot: args.outputRoot,
        visualRoot: args.visualRoot,
        artifact: manifest.artifact.absolutePath,
        artifactSha256: manifest.artifact.sha256,
        architectures: manifest.artifact.architectures,
        minimumMacOSVersion: manifest.artifact.minimumMacOSVersion,
        leaseTest: manifest.leaseTest.absolutePath,
        leaseTestSha256: manifest.leaseTest.sha256,
        signingPerformed: manifest.signing.performed,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ status: "fail", message: error?.message ?? String(error) })}\n`,
  );
  process.exit(1);
}
