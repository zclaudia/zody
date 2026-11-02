#!/usr/bin/env node

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  validateRound8ReviewConfig,
  assertRound8ManifestDelta,
  Round8PrepareError,
  failure,
} from "./lib/cua-driver-round8-prepare-config.mjs";
import { assertRound8DependencyPolicy } from "./lib/cua-driver-round8-prepare-policy.mjs";
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
const ROUND8_ROOT = join(CLOSURE_ROOT, "round8");
export const CANDIDATE_WORK_ROOT = join(REPO_ROOT, "output/cua-driver-round8/candidate-work");
export const DEFAULT_BASE_SOURCE = join(
  REPO_ROOT,
  "output/cua-driver-round7/candidate-work/controller-first/full-source",
);

const USAGE = `Usage:
  node packages/desktop/scripts/prepare-macos-cua-driver-round8.mjs --output <.../full-source> \\
    [--base-source <frozen-R7-full-source>] [--base-manifest <round7/source-manifest.json>] \\
    [--patch <round8/candidate-source.patch>] [--review-config <round8/review-config.json>] \\
    [--source-manifest <round8/source-manifest.json>]

Verifies the exact R7 input before and after patching, then publishes the exact
R8 manifest/tree/patch result. It runs no native API, network, install, TCC, test.
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
    baseManifest: join(ROUND7_ROOT, "source-manifest.json"),
    patch: join(ROUND8_ROOT, "candidate-source.patch"),
    reviewConfig: join(ROUND8_ROOT, "review-config.json"),
    sourceManifest: join(ROUND8_ROOT, "source-manifest.json"),
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

export async function assertFreshRound8OutputPath({ output, candidateWorkRoot }) {
  try {
    return await assertFreshOutputPath({ output, candidateWorkRoot });
  } catch (error) {
    if (error?.name !== "Round7PrepareError") throw error;
    failure(`round 8 output: ${error.message.replace(/\bround 7\b/g, "round 8")}`);
  }
}

async function withRound8(label, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Round8PrepareError) throw error;
    failure(`round 8 ${label}: ${error instanceof Error ? error.message : "verification failed"}`);
  }
}

const readInput = (path, label) => withRound8(label, () => readJsonFile(path));
const verifyTree = (label, options) => withRound8(label, () => verifyTreeAgainstManifest(options));
const verifyPatch = (patchPath, config) =>
  withRound8("candidate patch", () =>
    verifyPatchIdentity({
      patchPath,
      sha256: config.candidatePatch.sha256,
      bytes: config.candidatePatch.bytes,
    }),
  );

async function assertInputHashes(paths, expected) {
  const actual = await Promise.all(paths.map((path) => sha256File(path)));
  if (actual.some((hash, index) => hash !== expected[index])) {
    failure("round 8 input changed during candidate rebuild");
  }
}

export async function prepareRound8Candidate(options) {
  if (!options?.output) failure("round 8 output is required");
  const candidateWorkRoot = resolve(options.candidateWorkRoot ?? CANDIDATE_WORK_ROOT);
  await mkdir(candidateWorkRoot, { recursive: true });
  const output = await assertFreshRound8OutputPath({ output: options.output, candidateWorkRoot });
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
  validateRound8ReviewConfig({
    config,
    baseManifest,
    candidateManifest,
    baseManifestSha256,
    candidateManifestSha256,
  });
  const baseTree = await verifyTree("base source", {
    scanned: await scanTree(options.baseSource),
    manifest: baseManifest,
    treeSha256: config.baseTreeSha256,
  });
  const patch = await verifyPatch(options.patch, config);
  const staged = await mkdtemp(join(candidateWorkRoot, ".round8-prepare-"));
  const stagedRoot = join(staged, "full-source");
  try {
    const applied = await withRound8("candidate patch", () =>
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
      failure("round 8 candidate tree hash changed between validation passes");
    }
    const delta = assertRound8ManifestDelta({ baseManifest, candidateManifest });
    const dependencyPolicy = await assertRound8DependencyPolicy({
      baseRoot: options.baseSource,
      candidateRoot: stagedRoot,
    });
    await verifyTree("base source", {
      scanned: await scanTree(options.baseSource),
      manifest: baseManifest,
      treeSha256: config.baseTreeSha256,
    });
    await verifyPatch(options.patch, config);
    await assertInputHashes(inputPaths, inputHashes);
    await assertFreshRound8OutputPath({ output, candidateWorkRoot });
    await mkdir(dirname(output), { recursive: true });
    await assertFreshRound8OutputPath({ output, candidateWorkRoot });
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
    const result = await prepareRound8Candidate(parsed.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "round 8 prepare failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
