#!/usr/bin/env node

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PROBE_ROOT,
  ROUND8_BASE_TREE_SHA256,
  Round9PrepareError,
  VISUAL_ROOT,
  assertRound9InputPins,
  assertRound9ManifestDelta,
  failure,
  validateRound9ReviewConfig,
} from "./lib/cua-driver-round9-prepare-config.mjs";
import { assertRound9DependencyPolicy } from "./lib/cua-driver-round9-prepare-policy.mjs";
import { assertRound9LockPolicy } from "./lib/cua-driver-round9-prepare-lock-policy.mjs";
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
export const ROUND9_ROOT = join(CLOSURE_ROOT, "round9");
export const DEFAULT_BASE_SOURCE = join(
  REPO_ROOT,
  "output/cua-driver-round8/candidate-work/controller-accepted/full-source",
);
export const DEFAULT_BASE_MANIFEST = join(CLOSURE_ROOT, "round8/source-manifest.json");
export const DEFAULT_PATCH = join(ROUND9_ROOT, "candidate-source.patch");
export const DEFAULT_REVIEW_CONFIG = join(ROUND9_ROOT, "review-config.json");
export const DEFAULT_SOURCE_MANIFEST = join(ROUND9_ROOT, "source-manifest.json");
export const CANDIDATE_WORK_ROOT = join(REPO_ROOT, "output/cua-driver-round9/candidate-work");
export { PROBE_ROOT, ROUND8_BASE_TREE_SHA256, VISUAL_ROOT };

const USAGE = `Usage:
  node packages/desktop/scripts/prepare-macos-cua-driver-round9.mjs --output <.../full-source> \\
    [--base-source <frozen-R8-full-source>] [--base-manifest <round8/source-manifest.json>] \\
    [--patch <round9/candidate-source.patch>] [--review-config <round9/review-config.json>] \\
    [--source-manifest <round9/source-manifest.json>]

Verifies the accepted R8 tree and round 9 frozen inputs before and after patching,
then publishes exactly output/cua-driver-round9/candidate-work/<...>/full-source.
It runs no native API, network, install, TCC, or test suite.
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
    baseSource: DEFAULT_BASE_SOURCE,
    baseManifest: DEFAULT_BASE_MANIFEST,
    patch: DEFAULT_PATCH,
    reviewConfig: DEFAULT_REVIEW_CONFIG,
    sourceManifest: DEFAULT_SOURCE_MANIFEST,
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
  if (!options.output) return { error: "missing --output" };
  return { options };
}

export async function assertFreshRound9OutputPath({ output, candidateWorkRoot }) {
  try {
    return await assertFreshOutputPath({ output, candidateWorkRoot });
  } catch (error) {
    if (error?.name !== "Round7PrepareError") throw error;
    failure(`round 9 output: ${error.message.replace(/\bround 7\b/g, "round 9")}`);
  }
}

async function withRound9(label, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Round9PrepareError) throw error;
    failure(`round 9 ${label}: ${error instanceof Error ? error.message : "verification failed"}`);
  }
}

const readInput = (path, label) => withRound9(label, () => readJsonFile(path));
const verifyTree = (label, options) => withRound9(label, () => verifyTreeAgainstManifest(options));
const verifyPatch = (patchPath, config) =>
  withRound9("candidate patch", () =>
    verifyPatchIdentity({
      patchPath,
      sha256: config.candidatePatch.sha256,
      bytes: config.candidatePatch.bytes,
    }),
  );

async function assertInputHashes(paths, expected) {
  const actual = await Promise.all(paths.map((path) => sha256File(path)));
  if (actual.some((hash, index) => hash !== expected[index])) {
    failure("round 9 input changed during candidate rebuild");
  }
}

export async function prepareRound9Candidate(options) {
  if (!options?.output) failure("round 9 output is required");
  const candidateWorkRoot = resolve(options.candidateWorkRoot ?? CANDIDATE_WORK_ROOT);
  await mkdir(candidateWorkRoot, { recursive: true });
  const output = await assertFreshRound9OutputPath({
    output: options.output,
    candidateWorkRoot,
  });
  const [baseManifest, candidateManifest, config] = await Promise.all([
    readInput(options.baseManifest, "base source manifest"),
    readInput(options.sourceManifest, "candidate source manifest"),
    readInput(options.reviewConfig, "review config"),
  ]);
  const inputPaths = [
    options.baseManifest,
    options.sourceManifest,
    options.reviewConfig,
    options.patch,
  ];
  const inputHashes = await Promise.all(inputPaths.map((path) => sha256File(path)));
  const [baseManifestSha256, candidateManifestSha256, reviewConfigSha256] = inputHashes;
  validateRound9ReviewConfig({
    config,
    baseManifest,
    candidateManifest,
    baseManifestSha256,
    candidateManifestSha256,
    expectedBaseTreeSha256: options.expectedBaseTreeSha256,
  });
  assertRound9InputPins({
    config,
    configPath: options.reviewConfig,
    baseManifestPath: options.baseManifest,
    sourceManifestPath: options.sourceManifest,
    patchPath: options.patch,
  });
  const baseTree = await verifyTree("base source", {
    scanned: await scanTree(options.baseSource),
    manifest: baseManifest,
    treeSha256: config.baseTreeSha256,
  });
  const patch = await verifyPatch(options.patch, config);
  const staged = await mkdtemp(join(candidateWorkRoot, ".round9-prepare-"));
  const stagedRoot = join(staged, "full-source");
  try {
    const applied = await withRound9("candidate patch", () =>
      applyCandidatePatch({
        baseRoot: options.baseSource,
        patchPath: options.patch,
        stagingRoot: stagedRoot,
        expected: candidateManifest.files,
      }),
    );
    const candidateTree = await verifyTree("candidate source", {
      scanned: await scanTree(stagedRoot),
      manifest: candidateManifest,
      treeSha256: config.candidateTreeSha256,
    });
    if (applied.treeSha256 !== candidateTree.treeSha256) {
      failure("round 9 candidate tree hash changed between validation passes");
    }
    const delta = assertRound9ManifestDelta({ baseManifest, candidateManifest });
    const dependencyPolicy = await withRound9("dependency policy", () =>
      assertRound9DependencyPolicy({
        baseRoot: options.baseSource,
        candidateRoot: stagedRoot,
      }),
    );
    const lockPolicy = await withRound9("lock policy", () =>
      assertRound9LockPolicy({
        baseRoot: options.baseSource,
        candidateRoot: stagedRoot,
      }),
    );
    await verifyTree("base source", {
      scanned: await scanTree(options.baseSource),
      manifest: baseManifest,
      treeSha256: config.baseTreeSha256,
    });
    await verifyPatch(options.patch, config);
    await assertInputHashes(inputPaths, inputHashes);
    await assertFreshRound9OutputPath({ output, candidateWorkRoot });
    await mkdir(dirname(output), { recursive: true });
    await assertFreshRound9OutputPath({ output, candidateWorkRoot });
    await rename(stagedRoot, output);
    return {
      status: "candidate-rebuilt",
      output,
      base: baseTree,
      candidate: candidateTree,
      patch,
      sourceManifestSha256: candidateManifestSha256,
      reviewConfigSha256,
      delta,
      dependencyPolicy,
      lockPolicy,
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
    const result = await prepareRound9Candidate(parsed.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "round 9 prepare failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
