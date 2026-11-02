#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDriverClosureComparison } from "./lib/cua-driver-closure-comparison-report.mjs";

const USAGE = `Usage:
  node packages/desktop/scripts/compare-macos-cua-driver-closure.mjs \\
    --baseline-report <reports/2026-10-28/report.json.gz> \\
    --candidate-report <candidate-report.json|report.json.gz> \\
    --policy <round7/comparison-policy.json> \\
    --output-dir <new-comparison-directory> \\
    [--candidate-supplements <candidate-supplements-manifest.json>]

Compares two existing closure reports against an explicit, SHA-bound policy.
The baseline must match the policy bytes; source, dependencies and target graph
must have passed in both reports. Missing or unknown evidence fails closed, and
the tool never reports a zero diff as a pass.

The comparison never downloads dependencies, compiles code, changes inputs,
runs system input, touches signing/TCC, or authorizes product adoption.

Exit codes:
  0  comparison completed (product adoption and license gaps may remain blocked)
  1  invalid or unverified comparison input
  2  invalid arguments
`;

const VALUE_FLAGS = new Map([
  ["--baseline-report", "baselineReportPath"],
  ["--candidate-report", "candidateReportPath"],
  ["--policy", "policyPath"],
  ["--output-dir", "outputDir"],
  ["--candidate-supplements", "candidateSupplementsPath"],
]);

export function parseCompareArguments(argv) {
  const options = { candidateSupplementsPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const [name, inline] = argument.split("=", 2);
    const key = VALUE_FLAGS.get(name);
    if (!key) return { error: `unknown argument: ${name}` };
    const value = inline ?? argv[++index];
    if (!value) return { error: `missing value for ${name}` };
    options[key] = resolve(value);
  }
  for (const [flag, key] of VALUE_FLAGS) {
    if (key !== "candidateSupplementsPath" && !options[key]) {
      return { error: `missing ${flag}` };
    }
  }
  return { options };
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const parsed = parseCompareArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.error) {
    writeResult({ status: "invalid", message: parsed.error, usage: USAGE });
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runDriverClosureComparison(parsed.options);
    writeResult({
      status: "pass",
      reportPath: result.reportPath,
      graph: {
        baselinePackageCount: result.report.graph.baselinePackageCount,
        candidatePackageCount: result.report.graph.candidatePackageCount,
      },
      productAdoption: result.report.productAdoption,
      licenseResidual: result.report.licenses.residualGaps,
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    writeResult({
      status: "blocked",
      error: error?.message ?? "comparison failed",
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    writeResult({ status: "blocked", error: error?.message ?? "comparison failed" });
    process.exitCode = 1;
  });
}
