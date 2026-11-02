import { createHash } from "node:crypto";
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
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePrepareArguments,
  prepareRound7Candidate,
} from "../scripts/prepare-macos-cua-driver-round7.mjs";
import {
  assertCandidateDependencyPolicy,
  assertUniffiFeatureGates,
} from "../scripts/lib/cua-driver-round7-prepare-config.mjs";
import {
  buildLicenseSupplementSubset,
  writeLicenseSupplementSubset,
} from "../scripts/lib/cua-driver-round7-prepare-licenses.mjs";
import {
  assertPatchPaths,
  applyCandidatePatch,
  verifyPatchIdentity,
} from "../scripts/lib/cua-driver-round7-prepare-patch.mjs";
import {
  assertFreshOutputPath,
  buildCandidateManifest,
  computeTreeSha256,
  scanTree,
  verifyTreeAgainstManifest,
} from "../scripts/lib/cua-driver-round7-prepare-source.mjs";

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../..");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function sha(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-r7-"));
  tempDirs.push(root);
  return root;
}

async function writeTree(root: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
}

async function writeJson(path: string, value: unknown) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return { text, sha256: sha(text) };
}

async function createPrepareFixture() {
  const root = await tempDir();
  const base = join(root, "base");
  const work = join(root, "candidate-work");
  await mkdir(work);
  await writeTree(base, {
    "Cargo.toml":
      '[workspace]\nmembers = ["crates/cua-driver-core", "crates/cua-driver-sdk", "crates/platform-macos", "crates/cua-driver-contract"]\n\n[workspace.package]\nversion = "0.37.0"\n',
    "crates/cua-driver-core/Cargo.toml":
      '[features]\ndefault = ["yaml"]\nyaml = ["dep:regex"]\nrego = ["dep:regorus"]\nscript = ["dep:rquickjs"]\n',
    "crates/cua-driver-contract/Cargo.toml":
      '[dependencies]\nuniffi = { workspace = true, optional = true }\n\n[features]\ndefault = []\nuniffi = ["dep:uniffi"]\n',
    "crates/cua-driver-sdk/Cargo.toml":
      '[dependencies]\ncua-driver-core = { path = "../cua-driver-core", default-features = false, features = ["yaml"] }\ncua-driver-contract = { path = "../cua-driver-contract" }\nuniffi = { workspace = true, optional = true }\n\n[features]\ndefault = []\nuniffi = ["dep:uniffi", "cua-driver-contract/uniffi"]\n',
    "crates/platform-macos/Cargo.toml":
      '[dependencies]\ncua-driver-core = { path = "../cua-driver-core", default-features = false, features = ["yaml"] }\n\n[features]\ndefault = ["zody-dev-no-input", "zody-strict-frame-gate"]\nzody-dev-no-input = []\nzody-strict-frame-gate = []\n',
    "note.txt": "old\n",
  });
  const baseScan = await scanTree(base);
  const baseFiles = baseScan.files.map((file: { path: string; sha256: string }) => ({
    path: file.path,
    status: "added",
    candidateSha256: file.sha256,
  }));
  const baseManifestPath = join(root, "base-manifest.json");
  const baseManifestWrite = await writeJson(baseManifestPath, {
    ...manifest(baseFiles),
    treeSha256: computeTreeSha256(baseFiles),
  });
  const candidateFiles = baseFiles.map(
    (file: { path: string; status: string; candidateSha256: string }) =>
      file.path === "note.txt"
        ? {
            path: file.path,
            status: "modified",
            upstreamSha256: sha("old\n"),
            candidateSha256: sha("new\n"),
          }
        : file,
  );
  const sourceManifest = {
    ...manifest(candidateFiles),
    treeSha256: computeTreeSha256(candidateFiles),
  };
  const sourceManifestPath = join(root, "source-manifest.json");
  const sourceManifestWrite = await writeJson(sourceManifestPath, sourceManifest);
  const patch =
    "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const patchPath = join(root, "candidate-source.patch");
  await writeFile(patchPath, patch);
  const config = {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-review",
    revision: "2d2f99228d4d2508dc6fcc84c176b296e146714a",
    sourceRoot: "libs/cua-driver/rust",
    sourceManifest: "source-manifest.json",
    baseSourceManifest: "../source-manifest.json",
    baseSourceManifestSha256: baseManifestWrite.sha256,
    candidateSourceManifestSha256: sourceManifestWrite.sha256,
    candidatePatch: {
      path: "candidate-source.patch",
      sha256: sha(patch),
      bytes: Buffer.byteLength(patch),
    },
    baseTreeSha256: computeTreeSha256(baseScan.files),
    candidateTreeSha256: sourceManifest.treeSha256,
  };
  const configPath = join(root, "review-config.json");
  await writeJson(configPath, config);
  return {
    root,
    base,
    work,
    patchPath,
    config,
    configPath,
    baseManifestPath,
    sourceManifestPath,
  };
}

function manifest(files: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-source-manifest",
    revision: "2d2f99228d4d2508dc6fcc84c176b296e146714a",
    sourceRoot: "libs/cua-driver/rust",
    files,
  };
}

describe("round 7 prepare CLI", () => {
  it("accepts the fixed rebuild inputs and rejects ambiguous flags", () => {
    const output = join(repoRoot, "output/cua-driver-round7/candidate-work/rebuild/full-source");
    const parsed = parsePrepareArguments([
      "--base-source",
      "/fixed/full-source",
      "--output",
      output,
      "--base-manifest",
      "/fixed/source-manifest.json",
      "--patch",
      "/fixed/candidate-source.patch",
      "--review-config",
      "/fixed/review-config.json",
      "--source-manifest",
      "/fixed/source-manifest-new.json",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({ baseSource: "/fixed/full-source", output });
    expect(parsePrepareArguments(["--base-source"]).error).toMatch(/missing value/);
    expect(
      parsePrepareArguments([
        "--base-source",
        "/fixed/full-source",
        "--output",
        output,
        "--output",
        output,
      ]).error,
    ).toMatch(/duplicate/);
  });

  it("refuses existing, misnamed, symlinked, or escaping output paths", async () => {
    const root = await tempDir();
    const work = join(root, "candidate-work");
    await mkdir(work, { recursive: true });
    const output = join(work, "full-source");
    await expect(assertFreshOutputPath({ output, candidateWorkRoot: work })).resolves.toBe(
      join(await realpath(work), "full-source"),
    );
    await mkdir(output);
    await expect(assertFreshOutputPath({ output, candidateWorkRoot: work })).rejects.toThrow(
      /already exists/,
    );
    await expect(
      assertFreshOutputPath({ output: join(work, "other"), candidateWorkRoot: work }),
    ).rejects.toThrow(/must be named full-source/);
    await expect(
      assertFreshOutputPath({ output: join(root, "full-source"), candidateWorkRoot: work }),
    ).rejects.toThrow(/inside/);
    const symlinkTarget = join(work, "symlink-target");
    await mkdir(symlinkTarget);
    await symlink(symlinkTarget, join(work, "linked"), "dir");
    await expect(
      assertFreshOutputPath({ output: join(work, "linked/full-source"), candidateWorkRoot: work }),
    ).rejects.toThrow(/symlink/);
    const realWork = join(root, "real-work");
    const linkedWork = join(root, "linked-work");
    await mkdir(realWork);
    await symlink(realWork, linkedWork, "dir");
    await expect(
      assertFreshOutputPath({
        output: join(linkedWork, "full-source"),
        candidateWorkRoot: linkedWork,
      }),
    ).rejects.toThrow(/candidate-work root must be a real directory/);
  });
});

describe("round 7 frozen source and patch", () => {
  it("verifies every base file and the canonical tree hash", async () => {
    const root = await tempDir();
    await writeTree(root, { "Cargo.toml": "workspace\n", "a.rs": "fn a() {}\n" });
    const files = [
      { path: "Cargo.toml", status: "added", candidateSha256: sha("workspace\n") },
      {
        path: "a.rs",
        status: "unchanged",
        upstreamSha256: sha("fn a() {}\n"),
        candidateSha256: sha("fn a() {}\n"),
      },
    ];
    const scanned = await scanTree(root);
    const treeSha256 = computeTreeSha256(scanned.files);
    await expect(
      verifyTreeAgainstManifest({ scanned, manifest: manifest(files), treeSha256 }),
    ).resolves.toMatchObject({
      fileCount: 2,
      treeSha256,
    });
    await expect(
      verifyTreeAgainstManifest({ scanned, manifest: manifest(files), treeSha256: sha("drift") }),
    ).rejects.toThrow(/tree hash/);
    await writeFile(join(root, "extra"), "extra");
    await expect(
      verifyTreeAgainstManifest({
        scanned: await scanTree(root),
        manifest: manifest(files),
        treeSha256,
      }),
    ).rejects.toThrow(/unexpected/);
    const duplicate = manifest([...files, { ...files[0], status: "added" }]);
    await expect(
      verifyTreeAgainstManifest({ scanned, manifest: duplicate, treeSha256 }),
    ).rejects.toThrow(/duplicate paths/);
  });

  it("rejects a symlinked source root before resolving it", async () => {
    const root = await tempDir();
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await symlink(real, linked, "dir");
    await expect(scanTree(linked)).rejects.toThrow(/source root must be a real directory/);
  });

  it("rebuilds upstream statuses without inventing removed files", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "Cargo.toml": "workspace\n",
      "crates/core/Cargo.toml": 'default = ["yaml"]\n',
      "crates/core/src/lib.rs": "pub fn changed() {}\n",
      "crates/core/tests/round7.rs": "#[test] fn round7() {}\n",
    });
    const base = manifest([
      { path: "Cargo.toml", status: "added", candidateSha256: sha("old workspace\n") },
      {
        path: "crates/core/Cargo.toml",
        status: "modified",
        upstreamSha256: sha("upstream\n"),
        candidateSha256: sha("old core\n"),
      },
      {
        path: "crates/core/src/lib.rs",
        status: "unchanged",
        upstreamSha256: sha("pub fn upstream() {}\n"),
        candidateSha256: sha("pub fn upstream() {}\n"),
      },
    ]);
    const next = await buildCandidateManifest({ baseManifest: base, candidateRoot: root });
    expect(
      next.files.map((entry: { path: string; status: string }) => [entry.path, entry.status]),
    ).toEqual([
      ["Cargo.toml", "added"],
      ["crates/core/Cargo.toml", "modified"],
      ["crates/core/src/lib.rs", "modified"],
      ["crates/core/tests/round7.rs", "added"],
    ]);
    expect(next.treeSha256).toBe(computeTreeSha256((await scanTree(root)).files));
  });

  it("rejects unsafe patch paths and stale patch hashes", async () => {
    expect(() =>
      assertPatchPaths("diff --git a/../escape b/../escape\n--- a/../escape\n+++ b/../escape\n"),
    ).toThrow(/unsafe path/);
    expect(() =>
      assertPatchPaths(
        "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n",
      ),
    ).toThrow(/symlink/);
    expect(() => assertPatchPaths("diff --git a/a b/a\ndeleted file mode 100644\n")).toThrow(
      /deletion/,
    );
    const root = await tempDir();
    const patch = join(root, "candidate.patch");
    await writeFile(patch, "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n");
    await expect(verifyPatchIdentity({ patchPath: patch, sha256: sha("other") })).rejects.toThrow(
      /hash mismatch/,
    );
  });

  it("applies a patch to a fresh tree and verifies all hashes", async () => {
    const root = await tempDir();
    const base = join(root, "base");
    const output = join(root, "candidate");
    await writeTree(base, { "a.txt": "old\n" });
    const patch = join(root, "candidate.patch");
    await writeFile(
      patch,
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    );
    const result = await applyCandidatePatch({
      baseRoot: base,
      patchPath: patch,
      stagingRoot: output,
      expected: [
        {
          path: "a.txt",
          status: "modified",
          upstreamSha256: sha("old\n"),
          candidateSha256: sha("new\n"),
        },
      ],
    });
    expect(result.treeSha256).toBe(computeTreeSha256(result.files));
    expect(await readFile(join(output, "a.txt"), "utf8")).toBe("new\n");
    await expect(
      applyCandidatePatch({ baseRoot: base, patchPath: patch, stagingRoot: output }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("round 7 dependency gates", () => {
  it("skips rego/script by default while retaining their feature definitions", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "Cargo.toml":
        '[workspace]\nmembers = ["crates/cua-driver-core", "crates/cua-driver-sdk", "crates/platform-macos"]\n\n[workspace.package]\nversion = "0.37.0"\n',
      "crates/cua-driver-core/Cargo.toml":
        '[features]\ndefault = ["yaml"]\nyaml = ["dep:regex"]\nrego = ["dep:regorus"]\nscript = ["dep:rquickjs"]\n',
      "crates/cua-driver-sdk/Cargo.toml":
        '[dependencies]\ncua-driver-core = { path = "../cua-driver-core", default-features = false, features = ["yaml"] }\ncua-driver-contract = { path = "../cua-driver-contract" }\nuniffi = { workspace = true, optional = true }\n\n[features]\ndefault = []\nuniffi = ["dep:uniffi", "cua-driver-contract/uniffi"]\n',
      "crates/platform-macos/Cargo.toml":
        '[dependencies]\ncua-driver-core = { path = "../cua-driver-core", default-features = false, features = ["yaml"] }\n\n[features]\ndefault = ["zody-dev-no-input", "zody-strict-frame-gate"]\nzody-dev-no-input = []\nzody-strict-frame-gate = []\n',
      "crates/cua-driver-contract/Cargo.toml":
        '[dependencies]\nuniffi = { workspace = true, optional = true }\n\n[features]\ndefault = []\nuniffi = ["dep:uniffi"]\n',
      "crates/cua-driver-sdk/src/lib.rs":
        '#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]\nstruct A;\n#[cfg(feature = "uniffi")]\nuniffi::setup_scaffolding!("x");\n',
    });
    await expect(assertCandidateDependencyPolicy(root)).resolves.toMatchObject({
      coreDefaultFeatures: ["yaml"],
      uniffiDefault: false,
    });
    await expect(assertUniffiFeatureGates(root)).resolves.toBe(true);
    await writeFile(
      join(root, "crates/cua-driver-core/Cargo.toml"),
      '[features]\ndefault = ["yaml", "rego", "script"]\nrego = []\nscript = []\n',
    );
    await expect(assertCandidateDependencyPolicy(root)).rejects.toThrow(/core default features/);
  });

  it("rejects ungated uniffi derives, exports, constructors, fields, and scaffolding", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "crates/cua-driver-sdk/src/lib.rs":
        '#[derive(uniffi::Record)]\nstruct A;\n#[uniffi::export]\nfn a() {}\n#[uniffi::constructor]\nfn new() {}\n#[uniffi(default = None)]\nfield: u8,\nuniffi::setup_scaffolding!("x");\n',
    });
    await expect(assertUniffiFeatureGates(root)).rejects.toThrow(/ungated uniffi/);
  });
});

describe("round 7 license supplement subset", () => {
  it("keeps only actual graph packages and preserves registry evidence bytes", async () => {
    const root = await tempDir();
    const supplements = join(root, "old");
    await writeTree(supplements, {
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        kind: "zody-cua-driver-closure-license-supplements",
        sourceRevision: "rev",
        entries: [],
      }),
      "texts/workspace.txt": "workspace license\n",
      "texts/mit.txt": "MIT license body\n",
    });
    const workspaceCargo = "workspace changed\n";
    const entries = [
      {
        name: "cua-driver-core",
        version: "0.37.0",
        lockChecksum: null,
        cargoTomlSha256: sha("old core cargo\n"),
        cargoVcsSha1: null,
        cargoVcsInfoSha256: null,
        source: {
          repo: "https://github.com/trycua/cua",
          commit: "2d2f99228d4d2508dc6fcc84c176b296e146714a",
          path: "LICENSE.md",
        },
        text: { path: "texts/workspace.txt", sha256: sha("workspace license\n"), bytes: 18 },
        relation: {
          kind: "workspace-root-license",
          licenseExpression: "MIT",
          workspaceCargoTomlSha256: sha("old workspace\n"),
          evidence: "workspace",
        },
      },
      {
        name: "block2",
        version: "0.5.1",
        lockChecksum: "a".repeat(64),
        cargoTomlSha256: sha("block2 cargo\n"),
        cargoVcsSha1: "b".repeat(40),
        cargoVcsInfoSha256: "c".repeat(64),
        source: {
          repo: "https://github.com/madsmtm/objc2",
          commit: "d".repeat(40),
          path: "LICENSE.txt",
        },
        text: { path: "texts/mit.txt", sha256: sha("MIT license body\n"), bytes: 17 },
        relation: { kind: "package-root-license", licenseExpression: "MIT", evidence: "root" },
      },
      {
        name: "rquickjs-core",
        version: "0.14.0",
        lockChecksum: "e".repeat(64),
        cargoTomlSha256: sha("quickjs cargo\n"),
        cargoVcsSha1: "f".repeat(40),
        cargoVcsInfoSha256: "1".repeat(64),
        source: {
          repo: "https://github.com/DelSkayn/rquickjs",
          commit: "2".repeat(40),
          path: "LICENSE",
        },
        text: { path: "texts/mit.txt", sha256: sha("MIT license body\n"), bytes: 17 },
        relation: { kind: "package-root-license", licenseExpression: "MIT", evidence: "root" },
      },
    ];
    await writeFile(
      join(supplements, "manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, kind: "zody-cua-driver-closure-license-supplements", sourceRevision: "rev", entries }, null, 2)}\n`,
    );
    const graph = {
      packages: [
        { name: "cua-driver-core", version: "0.37.0" },
        { name: "block2", version: "0.5.1" },
      ],
    };
    const subset = await buildLicenseSupplementSubset({
      supplementsRoot: supplements,
      graph,
      workspaceCargoTomlSha256: sha(workspaceCargo),
      workspacePackageCargoHashes: { "cua-driver-core": sha("new core cargo\n") },
    });
    expect(subset.manifest.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "block2",
      "cua-driver-core",
    ]);
    expect(subset.manifest.entries[1].relation.workspaceCargoTomlSha256).toBe(sha(workspaceCargo));
    expect(subset.manifest.entries[1].cargoTomlSha256).toBe(sha("new core cargo\n"));
    expect(subset.manifest.entries[0].lockChecksum).toBe("a".repeat(64));
    expect(subset.texts.get("texts/mit.txt")?.equals(Buffer.from("MIT license body\n"))).toBe(true);
    await expect(
      buildLicenseSupplementSubset({
        supplementsRoot: supplements,
        graph,
        workspaceCargoTomlSha256: sha(workspaceCargo),
      }),
    ).rejects.toThrow(/invalid workspace package Cargo.toml hash/);
  });

  it("rejects a symlinked license text instead of copying through it", async () => {
    const root = await tempDir();
    const supplements = join(root, "old");
    const body = "MIT license body\n";
    await writeTree(supplements, {
      "real.txt": body,
      "manifest.json": JSON.stringify({
        schemaVersion: 1,
        kind: "zody-cua-driver-closure-license-supplements",
        sourceRevision: "rev",
        entries: [
          {
            name: "block2",
            version: "0.5.1",
            text: { path: "texts/mit.txt", sha256: sha(body), bytes: Buffer.byteLength(body) },
            relation: { kind: "package-root-license" },
          },
        ],
      }),
    });
    await mkdir(join(supplements, "texts"));
    await symlink(join(supplements, "real.txt"), join(supplements, "texts/mit.txt"));
    await expect(
      buildLicenseSupplementSubset({
        supplementsRoot: supplements,
        graph: { packages: [{ name: "block2", version: "0.5.1" }] },
        workspaceCargoTomlSha256: sha("workspace\n"),
      }),
    ).rejects.toThrow(/regular non-symlink file/);
  });

  it("writes copied text bytes without following symlinks", async () => {
    const root = await tempDir();
    const output = join(root, "new");
    const texts = new Map([["texts/mit.txt", Buffer.from("MIT license body\n")]]);
    await writeLicenseSupplementSubset({
      outputRoot: output,
      manifest: {
        schemaVersion: 1,
        kind: "zody-cua-driver-closure-license-supplements",
        sourceRevision: "rev",
        entries: [],
      },
      texts,
    });
    expect(await readFile(join(output, "texts/mit.txt"), "utf8")).toBe("MIT license body\n");
  });
});

describe("round 7 orchestration", () => {
  it("exports a rebuild entry that refuses an existing output before reading inputs", async () => {
    const root = await tempDir();
    const output = join(root, "full-source");
    await mkdir(output);
    await expect(
      prepareRound7Candidate({ baseSource: join(root, "missing"), output }),
    ).rejects.toThrow(/already exists/);
    expect(basename(output)).toBe("full-source");
  });

  it("verifies, publishes, and removes the staged parent after success", async () => {
    const fixture = await createPrepareFixture();
    const output = join(fixture.work, "published/full-source");
    const published = join(await realpath(fixture.work), "published/full-source");
    await expect(
      prepareRound7Candidate({
        baseSource: fixture.base,
        output,
        candidateWorkRoot: fixture.work,
        baseManifest: fixture.baseManifestPath,
        sourceManifest: fixture.sourceManifestPath,
        reviewConfig: fixture.configPath,
        patch: fixture.patchPath,
      }),
    ).resolves.toMatchObject({ status: "candidate-rebuilt", output: published });
    expect(await readFile(join(published, "note.txt"), "utf8")).toBe("new\n");
    expect(
      (await readdir(fixture.work)).filter((entry) => entry.startsWith(".round7-prepare-")),
    ).toEqual([]);
  });

  it("rejects a config that does not pin the reviewed candidate manifest", async () => {
    const fixture = await createPrepareFixture();
    const configPath = join(fixture.root, "bad-config.json");
    await writeJson(configPath, {
      ...fixture.config,
      candidateSourceManifestSha256: sha("unreviewed manifest\n"),
    });
    await expect(
      prepareRound7Candidate({
        baseSource: fixture.base,
        output: join(fixture.work, "rejected/full-source"),
        candidateWorkRoot: fixture.work,
        baseManifest: fixture.baseManifestPath,
        sourceManifest: fixture.sourceManifestPath,
        reviewConfig: configPath,
        patch: fixture.patchPath,
      }),
    ).rejects.toThrow(/does not match the round 7 source manifest/);
    expect(await readdir(fixture.work)).toEqual([]);
  });
});
