#!/usr/bin/env node

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCandidateDependencyPolicy,
  assertUniffiFeatureGates,
} from "./lib/cua-driver-round7-prepare-config.mjs";
import {
  assertFreshOutputPath,
  readJsonFile,
  scanTree,
  sha256File,
  verifyTreeAgainstManifest,
} from "./lib/cua-driver-round7-prepare-source.mjs";
import {
  applyCandidatePatch,
  verifyPatchIdentity,
} from "./lib/cua-driver-round7-prepare-patch.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLOSURE_ROOT = join(REPO_ROOT, "packages/desktop/native/macos-cua-driver-closure");
const ROUND7_ROOT = join(CLOSURE_ROOT, "round7");
export const CANDIDATE_WORK_ROOT = join(REPO_ROOT, "output/cua-driver-round7/candidate-work");

const USAGE = `Usage:
  node packages/desktop/scripts/prepare-macos-cua-driver-round7.mjs \\
    --base-source <frozen-752-file-full-source> \\
    --output <output/cua-driver-round7/candidate-work/.../full-source> \\
    [--base-manifest <frozen-source-manifest.json>] \\
    [--patch <round7/candidate-source.patch>] \\
    [--review-config <round7/review-config.json>] \\
    [--source-manifest <round7/source-manifest.json>]

The output is staged, patched, validated against the round 7 manifest and only
then renamed to the required full-source name. No upstream program, native API,
test suite, TCC prompt, network request, or package installation is performed.
`;

const VALUE_FLAGS = new Map([
  ["--base-source", "baseSource"],
  ["--output", "output"],
  ["--base-manifest", "baseManifest"],
  ["--patch", "patch"],
  ["--review-config", "reviewConfig"],
  ["--source-manifest", "sourceManifest"],
]);

export function parsePrepareArguments(argv) {
  const options = {
    baseManifest: join(CLOSURE_ROOT, "source-manifest.json"),
    patch: join(ROUND7_ROOT, "candidate-source.patch"),
    reviewConfig: join(ROUND7_ROOT, "review-config.json"),
    sourceManifest: join(ROUND7_ROOT, "source-manifest.json"),
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const [name, inline] = argument.split("=", 2);
    const key = VALUE_FLAGS.get(name);
    if (!key) return { error: `unknown argument: ${name}` };
    if (seen.has(name)) return { error: `duplicate argument: ${name}` };
    seen.add(name);
    const value = inline ?? argv[++index];
    if (!value) return { error: `missing value for ${name}` };
    options[key] = resolve(value);
  }
  if (!options.baseSource) return { error: "missing --base-source" };
  if (!options.output) return { error: "missing --output" };
  return { options };
}

function validateConfigShape({
  config,
  baseManifest,
  sourceManifest,
  baseManifestSha256,
  sourceManifestSha256,
}) {
  if (
    config?.revision !== baseManifest.revision ||
    sourceManifest?.revision !== baseManifest.revision ||
    config?.sourceRoot !== baseManifest.sourceRoot ||
    sourceManifest?.sourceRoot !== baseManifest.sourceRoot
  ) {
    throw new Error("round 7 revision or source root differs from the frozen baseline");
  }
  if (!/^[a-f0-9]{64}$/.test(config?.candidatePatch?.sha256 ?? "")) {
    throw new Error("round 7 review config does not pin the patch SHA-256");
  }
  if (
    !/^[a-f0-9]{64}$/.test(config?.baseTreeSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(config?.candidateTreeSha256 ?? "")
  ) {
    throw new Error("round 7 review config must pin both source tree SHA-256 values");
  }
  if (config.baseSourceManifestSha256 !== baseManifestSha256) {
    throw new Error("review config does not match the frozen base source manifest");
  }
  if (
    config.candidateSourceManifestSha256 !== sourceManifestSha256 ||
    sourceManifest?.treeSha256 !== config.candidateTreeSha256
  ) {
    throw new Error("review config does not match the round 7 source manifest");
  }
}

export async function prepareRound7Candidate(options) {
  const candidateWorkRoot = options.candidateWorkRoot ?? CANDIDATE_WORK_ROOT;
  await mkdir(candidateWorkRoot, { recursive: true });
  const output = await assertFreshOutputPath({ output: options.output, candidateWorkRoot });
  const baseManifest = await readJsonFile(options.baseManifest);
  const sourceManifest = await readJsonFile(options.sourceManifest);
  const config = await readJsonFile(options.reviewConfig);
  const baseManifestSha256 = await sha256File(options.baseManifest);
  const sourceManifestSha256 = await sha256File(options.sourceManifest);
  validateConfigShape({
    config,
    baseManifest,
    sourceManifest,
    baseManifestSha256,
    sourceManifestSha256,
  });

  const baseScanned = await scanTree(options.baseSource);
  const baseTree = await verifyTreeAgainstManifest({
    scanned: baseScanned,
    manifest: baseManifest,
    treeSha256: config.baseTreeSha256,
  });
  const patch = await verifyPatchIdentity({
    patchPath: options.patch,
    sha256: config.candidatePatch.sha256,
    bytes: config.candidatePatch.bytes,
  });
  const staged = await mkdtemp(join(candidateWorkRoot, ".round7-prepare-"));
  const stagedRoot = join(staged, "full-source");
  try {
    const applied = await applyCandidatePatch({
      baseRoot: options.baseSource,
      patchPath: options.patch,
      stagingRoot: stagedRoot,
      expected: sourceManifest.files,
    });
    const scanned = await scanTree(stagedRoot);
    const candidateTree = await verifyTreeAgainstManifest({
      scanned,
      manifest: sourceManifest,
      treeSha256: config.candidateTreeSha256,
    });
    if (applied.treeSha256 !== candidateTree.treeSha256) {
      throw new Error("patched tree hash changed between validation passes");
    }
    await assertCandidateDependencyPolicy(stagedRoot);
    await assertUniffiFeatureGates(stagedRoot);
    await mkdir(dirname(output), { recursive: true });
    await assertFreshOutputPath({ output, candidateWorkRoot });
    await rename(stagedRoot, output);
    return {
      status: "candidate-rebuilt",
      output,
      base: baseTree,
      candidate: candidateTree,
      patch,
      sourceManifestSha256,
      reviewConfigSha256: await sha256File(options.reviewConfig),
    };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

async function main() {
  const parsed = parsePrepareArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await prepareRound7Candidate(parsed.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "round 7 prepare failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
