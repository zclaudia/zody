#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_SOURCE_MANIFEST,
} from "./lib/cua-driver-closure-core.mjs";
import {
  DEFAULT_TOOLCHAIN_CONFIG,
  runDriverClosureAudit,
} from "./lib/cua-driver-closure-report.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/audit-macos-cua-driver-closure.mjs \\
    --source-repo <fixed-upstream-git-repo> \\
    --candidate-root <experiment/full-source> \\
    --cargo-home <experiment/build/cargo-home> \\
    --output-dir <audit-output-directory> \\
    [--review-config <review-config.json>] \\
    [--source-manifest <source-manifest.json>] \\
    [--rebuild-cache] \\
    [--toolchain-root <absolute-1.97.1-toolchain>] \\
    [--toolchain-config <round6/toolchain.json>] \\
    [--license-supplements <supplements-manifest.json>] \\
    [--check-build | --build-library]

Reads a fixed upstream revision through git objects, verifies the frozen source
manifest, writes a self-contained candidate patch, reconstructs it byte-for-byte,
and audits the locked macOS Cargo graph, registry cache, licenses and toolchain.

--rebuild-cache verifies every locked archive in an owned empty staging directory,
records all original cache drift (including Cargo.lock), and rebuilds exact sources.
--toolchain-root uses only absolute rustc/cargo paths from the pinned 1.97.1 root;
there is no stable fallback. --check-build/--build-library run locked/offline
non-input compilation in isolated staging and never start the upstream application.

The command never downloads dependencies, changes the source tree, executes the
upstream application, or enables product CUA. A source-audit-only pass exits 0 even
when dependency, license, toolchain, build or product-adoption gates remain blocked.

Exit codes:
  0  source audit complete and no verification failure
  1  source/dependency/license verification failure
  2  invalid arguments or blocked source input/toolchain
`;

const BOOLEAN_FLAGS = new Set(["--help", "--rebuild-cache", "--check-build", "--build-library"]);

export function parseAuditArguments(argv) {
  const options = {
    reviewConfig: DEFAULT_REVIEW_CONFIG,
    sourceManifest: DEFAULT_SOURCE_MANIFEST,
    toolchainConfig: DEFAULT_TOOLCHAIN_CONFIG,
    rebuildCache: false,
    buildMode: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const [name, inline] = argument.split("=", 2);
    if (BOOLEAN_FLAGS.has(name) && inline === undefined && !["--help"].includes(name)) {
      if (name === "--rebuild-cache") options.rebuildCache = true;
      if (name === "--check-build" || name === "--build-library") {
        if (options.buildMode)
          return { error: "--check-build and --build-library are mutually exclusive" };
        options.buildMode = name.slice(2);
      }
      continue;
    }
    const value = inline ?? argv[++index];
    if (!value) return { error: `missing value for ${name}` };
    if (name === "--source-repo") options.sourceRepo = resolve(value);
    else if (name === "--candidate-root") options.candidateRoot = resolve(value);
    else if (name === "--cargo-home") options.cargoHome = resolve(value);
    else if (name === "--output-dir") options.outputDir = resolve(value);
    else if (name === "--review-config") options.reviewConfig = resolve(value);
    else if (name === "--source-manifest") options.sourceManifest = resolve(value);
    else if (name === "--toolchain-root") options.toolchainRoot = resolve(value);
    else if (name === "--toolchain-config") options.toolchainConfig = resolve(value);
    else if (name === "--license-supplements") options.licenseSupplements = resolve(value);
    else return { error: `unknown argument: ${name}` };
  }
  for (const key of ["sourceRepo", "candidateRoot", "cargoHome", "outputDir"]) {
    if (!options[key])
      return { error: `missing --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}` };
  }
  if (options.buildMode && !options.toolchainRoot) {
    return { error: "--check-build and --build-library require an explicit --toolchain-root" };
  }
  if (options.buildMode && !options.rebuildCache) {
    return { error: "--check-build and --build-library require --rebuild-cache" };
  }
  return { options };
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const parsed = parseAuditArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
  } else if (parsed.error) {
    writeResult({ status: "invalid", message: parsed.error, usage: USAGE });
    process.exitCode = 2;
  } else {
    try {
      const result = await runDriverClosureAudit({
        ...parsed.options,
        reviewConfigPath: parsed.options.reviewConfig,
        sourceManifestPath: parsed.options.sourceManifest,
        toolchainConfigPath: parsed.options.toolchainConfig,
      });
      writeResult({
        status: result.exitCode === 0 ? "source-audit-pass" : "verification-failed",
        sourceAudit: result.report.source.status,
        productAdoption: result.report.gates.productAdoption,
        gates: result.report.gates,
        originalCache: result.report.originalCache?.status ?? null,
        reconstructedCache: result.report.reconstructedCache?.status ?? null,
        targetGraph: result.report.targetGraph?.status ?? null,
        build: result.report.build?.status ?? null,
        reportPath: result.reportPath,
        patch: result.report.patch,
        blockedItems: result.report.blockedItems,
      });
      process.exitCode = result.exitCode;
    } catch (error) {
      if (error instanceof ClosureVerificationError) {
        writeResult({ status: "fail", message: error.message });
        process.exitCode = 1;
      } else if (error instanceof ClosureBlockedError) {
        writeResult({ status: "blocked", code: error.code, message: error.message });
        process.exitCode = 2;
      } else {
        writeResult({
          status: "fail",
          message: error instanceof Error ? error.message : "unknown failure",
        });
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
