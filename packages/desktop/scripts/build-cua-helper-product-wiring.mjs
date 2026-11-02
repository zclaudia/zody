#!/usr/bin/env node
// 原生组合候选构建入口。builder 不签名、不请求 TCC、不采集；签名与实机验证由 controller 负责。
import { resolve } from "node:path";
import {
  DEFAULT_IDENTITY_PINS,
  DEFAULT_NODE_PATH,
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_VISUAL_ROOT,
  BOOTSTRAP_ENTRY,
  MAX_BUNDLE_BYTES,
} from "./lib/cua-helper-product-wiring-config.mjs";
import { buildCuaHelperProductWiring } from "./lib/cua-helper-product-wiring-build.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/build-cua-helper-product-wiring.mjs [options]

Builds the darwin arm64 native composition candidate: real create-app fixture sealed
into ESM, R11-derived native supervisor with empty bootstrap, compile/link against the
R11 visual static library. Does not sign, request TCC, install, or capture.

Options:
  --output-root <dir>       default ${DEFAULT_OUTPUT_ROOT}
  --visual-root <dir>       default ${DEFAULT_VISUAL_ROOT}
  --node <path>             default ${DEFAULT_NODE_PATH}
  --identity-pins <path>    default ${DEFAULT_IDENTITY_PINS}
  --entry <path>            default ${BOOTSTRAP_ENTRY}
  --max-bundle-bytes <n>    default ${MAX_BUNDLE_BYTES}
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    const next = () => {
      const arg = argv[index + 1];
      if (!arg) throw new Error(`${value} requires a value`);
      index += 1;
      return arg;
    };
    if (value === "--output-root") options.outputRoot = resolve(next());
    else if (value === "--visual-root") options.visualRoot = resolve(next());
    else if (value === "--node") options.nodePath = resolve(next());
    else if (value === "--identity-pins") options.identityPinsPath = resolve(next());
    else if (value === "--entry") options.bootstrapEntry = resolve(next());
    else if (value === "--max-bundle-bytes") options.maxBundleBytes = Number(next());
    else throw new Error(`unknown argument: ${value}`);
  }
  return { help: false, options };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "fail", message: error.message })}\n`);
  process.exit(1);
}
if (parsed.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

try {
  const manifest = await buildCuaHelperProductWiring(parsed.options);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "pass",
        outputRoot: manifest.outputRoot,
        artifact: manifest.artifact.absolutePath,
        artifactSha256: manifest.artifact.sha256,
        architectures: manifest.artifact.architectures,
        minimumMacOSVersion: manifest.artifact.minimumMacOSVersion,
        authorityBytes: manifest.authority.bytes,
        authoritySha256: manifest.authority.sha256,
        bundleInputCount: manifest.authority.inputCount,
        nonBuiltinStaticImports: manifest.authority.nonBuiltinStaticImports,
        signingPerformed: manifest.signing.performed,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ status: "fail", message: error?.message ?? String(error), details: error?.details })}\n`,
  );
  process.exit(1);
}
