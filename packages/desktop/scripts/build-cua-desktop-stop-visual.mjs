#!/usr/bin/env node
// Build the derived stop-worker visual staticlib/header for one explicit
// profile. This does not touch frozen R11 outputs or the old visual builder.
import {
  buildAndRunStopCaptureOwnerHarness,
  buildStopVisual,
} from "./lib/cua-desktop-stop-visual-build.mjs";
import { STOP_VISUAL_PROFILES } from "./lib/cua-desktop-stop-visual-config.mjs";

function usage() {
  return [
    "Usage: node packages/desktop/scripts/build-cua-desktop-stop-visual.mjs --profile <production|diagnostic> [options]",
    "",
    "Options:",
    "  --profile <name>          required: production or diagnostic",
    "  --output-root <dir>       must stay strictly inside output/cua-arm64-screenshot",
    "  --rust-tests              run derived Rust unit tests before the build",
    "  --native-harness          compile/run the real capture_owner fake-visual harness",
    "  --skip-native-harness     do not compile the native harness",
    "  --help                    show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    profile: null,
    outputRoot: null,
    runRustTests: false,
    nativeHarness: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${value}`);
      return argv[index];
    };
    if (value === "--profile") options.profile = next();
    else if (value === "--output-root") options.outputRoot = next();
    else if (value === "--rust-tests") options.runRustTests = true;
    else if (value === "--native-harness") options.nativeHarness = true;
    else if (value === "--skip-native-harness") options.nativeHarness = false;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!STOP_VISUAL_PROFILES[options.profile]) {
    throw new Error("--profile must be production or diagnostic");
  }
  const manifest = await buildStopVisual({
    profile: options.profile,
    outputRoot: options.outputRoot,
    runRustTests: options.runRustTests,
  });
  const harness = options.nativeHarness
    ? await buildAndRunStopCaptureOwnerHarness({
        outputRoot: manifest.paths.root,
      })
    : { status: "not-run" };
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "pass",
        profile: manifest.profile,
        outputRoot: manifest.paths.root,
        staticlib: {
          path: manifest.artifact.path,
          sha256: manifest.artifact.sha256,
          gateSymbolPresent: manifest.artifact.gateSymbolPresent,
        },
        header: manifest.header,
        buildManifest: `${manifest.paths.buildRoot}/build-manifest-${options.profile}.json`,
        rustTests: manifest.rustTests.status,
        nativeHarness: harness.status,
        nativeHarnessPath: harness.path,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  if (error.details)
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  process.exitCode = 1;
});
