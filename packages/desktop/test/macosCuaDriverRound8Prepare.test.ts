import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_WORK_ROOT,
  DEFAULT_BASE_SOURCE,
  assertFreshRound8OutputPath,
  parsePrepareArguments,
  prepareRound8Candidate,
} from "../scripts/prepare-macos-cua-driver-round8.mjs";
import { assertRound8ManifestDelta } from "../scripts/lib/cua-driver-round8-prepare-config.mjs";
import { assertRound8DependencyPolicy } from "../scripts/lib/cua-driver-round8-prepare-policy.mjs";
import {
  createRound8PrepareFixture,
  readJson,
  sha,
  snapshotTree,
  writeJson,
} from "./fixtures/cua-driver-round8-prepare-fixtures.mjs";

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../..");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-r8-"));
  tempDirs.push(root);
  return root;
}

async function fixture() {
  return createRound8PrepareFixture(await tempDir());
}

function prepareOptions(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    baseSource: value.base,
    output: value.output,
    baseManifest: value.baseManifestPath,
    patch: value.patchPath,
    reviewConfig: value.reviewConfigPath,
    sourceManifest: value.sourceManifestPath,
    candidateWorkRoot: value.work,
  };
}

describe("round 8 prepare CLI", () => {
  it("defaults to the frozen R7 tree and round 8 evidence paths", () => {
    const output = join(CANDIDATE_WORK_ROOT, "fixture/full-source");
    const parsed = parsePrepareArguments(["--output", output]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({
      baseSource: DEFAULT_BASE_SOURCE,
      output,
      baseManifest: join(
        repoRoot,
        "packages/desktop/native/macos-cua-driver-closure/round7/source-manifest.json",
      ),
      patch: join(
        repoRoot,
        "packages/desktop/native/macos-cua-driver-closure/round8/candidate-source.patch",
      ),
      reviewConfig: join(
        repoRoot,
        "packages/desktop/native/macos-cua-driver-closure/round8/review-config.json",
      ),
      sourceManifest: join(
        repoRoot,
        "packages/desktop/native/macos-cua-driver-closure/round8/source-manifest.json",
      ),
    });
    expect(parsePrepareArguments(["--unknown"]).error).toMatch(/unknown argument/);
    expect(parsePrepareArguments(["--output"]).error).toMatch(/missing value/);
    expect(parsePrepareArguments(["--output", output, "--output", output]).error).toMatch(
      /duplicate/,
    );
  });

  it("refuses existing, misnamed, escaping, and symlinked output paths", async () => {
    const root = await tempDir();
    const work = join(root, "candidate-work");
    await mkdir(work);
    await expect(
      assertFreshRound8OutputPath({ output: join(work, "full-source"), candidateWorkRoot: work }),
    ).resolves.toBe(join(await realpath(work), "full-source"));
    await mkdir(join(work, "full-source"));
    await expect(
      assertFreshRound8OutputPath({ output: join(work, "full-source"), candidateWorkRoot: work }),
    ).rejects.toThrow(/round 8.*already exists/);
    await expect(
      assertFreshRound8OutputPath({ output: join(work, "other"), candidateWorkRoot: work }),
    ).rejects.toThrow(/full-source/);
    await expect(
      assertFreshRound8OutputPath({ output: join(root, "full-source"), candidateWorkRoot: work }),
    ).rejects.toThrow(/round 8 candidate-work root/);
    await mkdir(join(work, "target"));
    await symlink(join(work, "target"), join(work, "linked"), "dir");
    await expect(
      assertFreshRound8OutputPath({
        output: join(work, "linked/full-source"),
        candidateWorkRoot: work,
      }),
    ).rejects.toThrow(/symlink/);
    const symlinkWork = join(root, "symlink-work");
    const linkedOutputTarget = join(root, "output-target");
    await mkdir(symlinkWork);
    await mkdir(linkedOutputTarget);
    await symlink(linkedOutputTarget, join(symlinkWork, "full-source"), "dir");
    await expect(
      assertFreshRound8OutputPath({
        output: join(symlinkWork, "full-source"),
        candidateWorkRoot: symlinkWork,
      }),
    ).rejects.toThrow(/symlink/);
  });
});

describe("round 8 candidate rebuild", () => {
  it("applies the real fixture patch, verifies both trees, and leaves R7 input untouched", async () => {
    const value = await fixture();
    const before = await snapshotTree(value.base);
    const result = await prepareRound8Candidate(prepareOptions(value));
    expect(result).toMatchObject({
      status: "candidate-rebuilt",
      base: {
        fileCount: value.baseManifest.files.length,
        treeSha256: value.baseManifest.treeSha256,
      },
      candidate: {
        fileCount: value.candidateManifest.files.length,
        treeSha256: value.candidateManifest.treeSha256,
      },
      patch: {
        sha256: value.config.candidatePatch.sha256,
        bytes: value.config.candidatePatch.bytes,
      },
    });
    expect(
      await readFile(join(value.output, "crates/cua-macos-visual/src/lib.rs"), "utf8"),
    ).toContain("HostNotApproved");
    expect(await readFile(join(value.output, "notes/old.txt"), "utf8")).toBe(
      "preserve round 7 bytes\n",
    );
    expect(await snapshotTree(value.base)).toEqual(before);
    expect(await readdir(value.work)).toEqual(["full-source"]);
    await expect(prepareRound8Candidate(prepareOptions(value))).rejects.toThrow(/already exists/);
  });

  it("rejects base, patch, and candidate target drift, removing staging on failure", async () => {
    const baseDrift = await fixture();
    await writeFile(join(baseDrift.base, "notes/old.txt"), "drifted base\n");
    await expect(prepareRound8Candidate(prepareOptions(baseDrift))).rejects.toThrow(/round 8 base/);
    expect(await readdir(baseDrift.work)).toEqual([]);

    const manifestDrift = await fixture();
    const baseManifest = await readJson(manifestDrift.baseManifestPath);
    baseManifest.files[0].candidateSha256 = sha("manifest drift");
    await writeJson(manifestDrift.baseManifestPath, baseManifest);
    await expect(prepareRound8Candidate(prepareOptions(manifestDrift))).rejects.toThrow(
      /base source manifest/,
    );
    expect(await readdir(manifestDrift.work)).toEqual([]);

    const patchDrift = await fixture();
    await writeFile(patchDrift.patchPath, "diff --git a/Cargo.toml b/Cargo.toml\n");
    await expect(prepareRound8Candidate(prepareOptions(patchDrift))).rejects.toThrow(/patch/);
    expect(await readdir(patchDrift.work)).toEqual([]);

    const patchBytesDrift = await fixture();
    const byteConfig = await readJson(patchBytesDrift.reviewConfigPath);
    byteConfig.candidatePatch.bytes += 1;
    await writeJson(patchBytesDrift.reviewConfigPath, byteConfig);
    await expect(prepareRound8Candidate(prepareOptions(patchBytesDrift))).rejects.toThrow(
      /patch.*byte/i,
    );
    expect(await readdir(patchBytesDrift.work)).toEqual([]);

    const targetDrift = await fixture();
    const manifest = await readJson(targetDrift.sourceManifestPath);
    manifest.treeSha256 = sha("wrong target tree");
    const manifestWrite = await writeJson(targetDrift.sourceManifestPath, manifest);
    const config = await readJson(targetDrift.reviewConfigPath);
    config.candidateSourceManifestSha256 = manifestWrite.sha256;
    config.candidateTreeSha256 = manifest.treeSha256;
    await writeJson(targetDrift.reviewConfigPath, config);
    await expect(prepareRound8Candidate(prepareOptions(targetDrift))).rejects.toThrow(
      /round 8 candidate/,
    );
    expect(await readdir(targetDrift.work)).toEqual([]);
  });

  it("does not mistake round 7 upstream statuses for a round 8 delta", async () => {
    const value = await fixture();
    expect(
      value.baseManifest.files.find((entry) => entry.path === "crates/platform-macos/Cargo.toml"),
    ).toMatchObject({ status: "modified" });
    expect(
      assertRound8ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: value.candidateManifest,
      }),
    ).toMatchObject({
      modified: ["Cargo.lock", "Cargo.toml"],
      added: ["crates/cua-macos-visual/Cargo.toml", "crates/cua-macos-visual/src/lib.rs"],
      removed: [],
    });
    const changedOld = structuredClone(value.candidateManifest);
    changedOld.files.find(
      (entry) => entry.path === "crates/platform-macos/Cargo.toml",
    ).candidateSha256 = sha("rewritten old platform");
    expect(() =>
      assertRound8ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: changedOld,
      }),
    ).toThrow(/may not modify crates\/platform-macos/);
    const addedOutsideRoot = structuredClone(value.candidateManifest);
    addedOutsideRoot.files.push({
      path: "crates/other/file.rs",
      status: "added",
      candidateSha256: sha("other"),
    });
    expect(() =>
      assertRound8ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: addedOutsideRoot,
      }),
    ).toThrow(/outside crates\/cua-macos-visual/);
    const removed = structuredClone(value.candidateManifest);
    removed.files = removed.files.filter((entry) => entry.path !== "notes/old.txt");
    expect(() =>
      assertRound8ManifestDelta({ baseManifest: value.baseManifest, candidateManifest: removed }),
    ).toThrow(/may not remove notes\/old.txt/);
  });
});

describe("round 8 static dependency guard", () => {
  it("keeps the old safety features and rejects old-root or wide dependencies", async () => {
    const value = await fixture();
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).resolves.toMatchObject({
      visualRoot: "crates/cua-macos-visual",
      preservedFeatures: ["zody-dev-no-input", "zody-strict-frame-gate"],
    });
    const visualCargo = join(value.expected, "crates/cua-macos-visual/Cargo.toml");
    const isolated = await readFile(visualCargo, "utf8");
    await writeFile(
      visualCargo,
      isolated.replace(
        'objc2 = "0.6"',
        'core = { package = "cua-driver-core", path = "../../cua-driver-core" }',
      ),
    );
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/independent/);
    await writeFile(visualCargo, isolated.replace('objc2 = "0.6"', 'clipboard-rs = "0.3"'));
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/clipboard-rs/);
    await writeFile(
      visualCargo,
      isolated.replace(
        "[dependencies]\n",
        "[features]\nzody-dev-no-input = []\nzody-strict-frame-gate = []\n\n[dependencies]\n",
      ),
    );
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/zody-dev-no-input/);
    await writeFile(
      visualCargo,
      `${isolated}\n[dependencies.renamed-core]\npackage = "cua-driver-core"\npath = "../../cua-driver-core"\n`,
    );
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/independent/);
    await writeFile(
      visualCargo,
      `${isolated}\n[target.'cfg(target_os = "macos")'.dependencies.renamed-sdk]\npackage = "cua-driver-sdk"\npath = "../../cua-driver-sdk"\n`,
    );
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/independent/);
    await writeFile(visualCargo, `${isolated}\n[workspace]\n`);
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/full-source workspace/);
    await writeFile(visualCargo, isolated);
    const rootCargoPath = join(value.expected, "Cargo.toml");
    const rootCargo = await readFile(rootCargoPath, "utf8");
    await writeFile(rootCargoPath, rootCargo.replace(', "crates/cua-macos-visual"', ""));
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/workspace members/);
    await writeFile(rootCargoPath, rootCargo);
    const inheritedRoot = rootCargo.replace(
      "[workspace.package]",
      '[workspace.dependencies]\nwide = { package = "cua-driver-core", path = "crates/cua-driver-core" }\nmacos-alias = { package = "cua-driver-sdk", path = "crates/cua-driver-sdk" }\n\n[workspace.package]',
    );
    await writeFile(rootCargoPath, inheritedRoot);
    await writeFile(
      visualCargo,
      isolated.replace('objc2 = "0.6"', 'objc2 = "0.6"\nwide = { workspace = true }'),
    );
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/independent from cua-driver-core/);
    await writeFile(
      visualCargo,
      `${isolated}\n[target.'cfg(target_os = "macos")'.dependencies.macos-alias]\nworkspace = true\n`,
    );
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/independent from cua-driver-sdk/);
    await writeFile(rootCargoPath, rootCargo);
    await writeFile(visualCargo, isolated);
    const platformCargo = join(value.expected, "crates/platform-macos/Cargo.toml");
    await writeFile(platformCargo, "[features]\ndefault = []\nzody-strict-frame-gate = []\n");
    await expect(
      assertRound8DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/zody-dev-no-input/);
  });
});
