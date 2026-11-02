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
  DEFAULT_PATCH,
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_SOURCE_MANIFEST,
  ROUND8_BASE_TREE_SHA256,
  assertFreshRound9OutputPath,
  parsePrepareArguments,
  prepareRound9Candidate,
} from "../scripts/prepare-macos-cua-driver-round9.mjs";
import { assertRound9ManifestDelta } from "../scripts/lib/cua-driver-round9-prepare-config.mjs";
import { assertRound9DependencyPolicy } from "../scripts/lib/cua-driver-round9-prepare-policy.mjs";
import { assertRound9LockPolicy } from "../scripts/lib/cua-driver-round9-prepare-lock-policy.mjs";
import {
  PROBE_ROOT,
  VISUAL_ROOT,
  createRound9PrepareFixture,
  readJson,
  refreshRound9Fixture,
  sha,
  snapshotTree,
  writeJson,
} from "./fixtures/cua-driver-round9-prepare-fixtures.mjs";

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../..");
const swiftPath = `${VISUAL_ROOT}/swift/CuaVisualBridge.swift`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-r9-"));
  tempDirs.push(root);
  return root;
}

async function fixture() {
  return createRound9PrepareFixture(await tempDir());
}

function prepareOptions(
  value: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    baseSource: value.base,
    output: value.output,
    baseManifest: value.baseManifestPath,
    patch: value.patchPath,
    reviewConfig: value.reviewConfigPath,
    sourceManifest: value.sourceManifestPath,
    candidateWorkRoot: value.work,
    // 生产默认固定 R8 accepted tree；fixture 用自身树哈希显式覆盖，避免伪造基线。
    expectedBaseTreeSha256: value.baseManifest.treeSha256,
    ...overrides,
  };
}

function writeText(path: string, text: string) {
  return writeFile(path, text);
}

describe("round 9 prepare CLI", () => {
  it("defaults to the accepted R8 tree and round 9 frozen inputs", () => {
    const output = join(CANDIDATE_WORK_ROOT, "fixture/full-source");
    const parsed = parsePrepareArguments(["--output", output]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({
      baseSource: DEFAULT_BASE_SOURCE,
      output,
      baseManifest: join(
        repoRoot,
        "packages/desktop/native/macos-cua-driver-closure/round8/source-manifest.json",
      ),
      patch: DEFAULT_PATCH,
      reviewConfig: DEFAULT_REVIEW_CONFIG,
      sourceManifest: DEFAULT_SOURCE_MANIFEST,
    });
    expect(DEFAULT_BASE_SOURCE).toContain(
      "output/cua-driver-round8/candidate-work/controller-accepted/full-source",
    );
    expect(ROUND8_BASE_TREE_SHA256).toBe(
      "4cbad8776947504f9883bf5370d6802177090d7a01075c5640b64a730950d9de",
    );
    expect(parsePrepareArguments(["--unknown"]).error).toMatch(/unknown argument/);
    expect(parsePrepareArguments(["--output"]).error).toMatch(/missing value/);
    expect(parsePrepareArguments(["--output", output, "--output", output]).error).toMatch(
      /duplicate/,
    );
    expect(
      parsePrepareArguments(["--output", output, "--expected-base-tree-sha256", sha("x")]).error,
    ).toMatch(/unknown argument/);
  });

  it("refuses existing, misnamed, escaping, and symlinked output paths", async () => {
    const root = await tempDir();
    const work = join(root, "candidate-work");
    await mkdir(work);
    await expect(
      assertFreshRound9OutputPath({ output: join(work, "full-source"), candidateWorkRoot: work }),
    ).resolves.toBe(join(await realpath(work), "full-source"));
    await mkdir(join(work, "full-source"));
    await expect(
      assertFreshRound9OutputPath({ output: join(work, "full-source"), candidateWorkRoot: work }),
    ).rejects.toThrow(/round 9.*already exists/);
    await expect(
      assertFreshRound9OutputPath({ output: join(work, "other"), candidateWorkRoot: work }),
    ).rejects.toThrow(/full-source/);
    await expect(
      assertFreshRound9OutputPath({ output: join(root, "full-source"), candidateWorkRoot: work }),
    ).rejects.toThrow(/round 9 candidate-work root/);
    await mkdir(join(work, "target"));
    await symlink(join(work, "target"), join(work, "linked"), "dir");
    await expect(
      assertFreshRound9OutputPath({
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
      assertFreshRound9OutputPath({
        output: join(symlinkWork, "full-source"),
        candidateWorkRoot: symlinkWork,
      }),
    ).rejects.toThrow(/symlink/);
  });
});

describe("round 9 manifest delta", () => {
  it("allows only root Cargo changes, visual edits, and visual/probe additions", async () => {
    const value = await fixture();
    expect(
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: value.candidateManifest,
      }),
    ).toMatchObject({
      modified: [
        "Cargo.lock",
        "Cargo.toml",
        "crates/cua-macos-visual/build.rs",
        "crates/cua-macos-visual/Cargo.toml",
        "crates/cua-macos-visual/src/capture.rs",
        "crates/cua-macos-visual/src/lib.rs",
      ],
      added: [
        "crates/cua-macos-visual-link-probe/Cargo.toml",
        "crates/cua-macos-visual-link-probe/src/main.rs",
        "crates/cua-macos-visual/swift/CuaVisualBridge.swift",
      ],
      removed: [],
    });

    const changedOld = structuredClone(value.candidateManifest);
    const changedOldEntry = changedOld.files.find(
      (entry) => entry.path === "crates/cua-driver-core/src/lib.rs",
    );
    changedOldEntry.candidateSha256 = sha("rewritten old core");
    changedOldEntry.status = "modified";
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: changedOld,
      }),
    ).toThrow(/may not modify crates\/cua-driver-core/);

    const addedOutsideRoot = structuredClone(value.candidateManifest);
    addedOutsideRoot.files.push({
      path: "crates/other/file.rs",
      status: "added",
      candidateSha256: sha("other"),
    });
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: addedOutsideRoot,
      }),
    ).toThrow(/outside crates\/cua-macos-visual/);

    const removed = structuredClone(value.candidateManifest);
    removed.files = removed.files.filter((entry) => entry.path !== "notes/old.txt");
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: removed,
      }),
    ).toThrow(/may not remove notes\/old.txt/);

    const statusDrift = structuredClone(value.candidateManifest);
    statusDrift.files.find((entry) => entry.path === "notes/old.txt").status = "modified";
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: statusDrift,
      }),
    ).toThrow(/notes\/old.txt status must be unchanged/);

    const upstreamDrift = structuredClone(value.candidateManifest);
    upstreamDrift.files.find((entry) => entry.path === "notes/old.txt").upstreamSha256 =
      sha("rewritten provenance");
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: upstreamDrift,
      }),
    ).toThrow(/notes\/old.txt changes upstream provenance/);

    const addedStatusDrift = structuredClone(value.candidateManifest);
    const addedStatusEntry = addedStatusDrift.files.find((entry) => entry.path === "Cargo.lock");
    addedStatusEntry.status = "modified";
    addedStatusEntry.upstreamSha256 = sha("phantom upstream");
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: addedStatusDrift,
      }),
    ).toThrow(/Cargo.lock must remain status added/);

    const addedUpstreamDrift = structuredClone(value.candidateManifest);
    addedUpstreamDrift.files.find((entry) => entry.path === "Cargo.lock").upstreamSha256 =
      sha("phantom upstream");
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: addedUpstreamDrift,
      }),
    ).toThrow(/Cargo.lock must not carry an upstream hash/);

    const newEntryDrift = structuredClone(value.candidateManifest);
    const newEntry = newEntryDrift.files.find((entry) => entry.path === swiftPath);
    newEntry.status = "unchanged";
    newEntry.upstreamSha256 = sha("phantom upstream");
    expect(() =>
      assertRound9ManifestDelta({
        baseManifest: value.baseManifest,
        candidateManifest: newEntryDrift,
      }),
    ).toThrow(/new crates\/cua-macos-visual\/swift\/CuaVisualBridge.swift must be status added/);
  });
});

describe("round 9 dependency policy", () => {
  it("accepts the narrow visual crate and requires the consumer probe", async () => {
    const value = await fixture();
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).resolves.toMatchObject({
      visualRoot: VISUAL_ROOT,
      probeRoot: PROBE_ROOT,
      preservedFeatures: ["zody-dev-no-input", "zody-strict-frame-gate"],
      swiftBridgeFiles: [swiftPath],
    });
  });

  it("rejects direct, renamed, table, and target dependencies on old roots or wide capture", async () => {
    const value = await fixture();
    const visualCargoPath = join(value.expected, VISUAL_ROOT, "Cargo.toml");
    const original = await readFile(visualCargoPath, "utf8");
    const cases = [
      [
        '[dependencies.renamed-core]\npackage = "cua-driver-core"\npath = "../../cua-driver-core"\n',
        /independent from cua-driver-core/,
      ],
      [
        '[target.\'cfg(target_os = "macos")\'.dependencies.sck]\npackage = "screencapturekit"\nversion = "8.0.1"\n',
        /independent from screencapturekit/,
      ],
      [
        '[dependencies.metal]\npackage = "apple-metal"\npath = "../../apple-metal"\n',
        /independent from apple-metal/,
      ],
      [
        '[dependencies.cf]\npackage = "apple-cf"\npath = "../../apple-cf"\n',
        /independent from apple-cf/,
      ],
      [
        '[dependencies.clipboard]\npackage = "clipboard-rs"\nversion = "0.3"\n',
        /independent from clipboard-rs/,
      ],
      [
        '[dependencies.ax]\npackage = "accessibility-sys"\nversion = "0.1"\n',
        /independent from accessibility-sys/,
      ],
      [
        '[dependencies.overlay]\npackage = "cursor-overlay"\npath = "../cursor-overlay"\n',
        /independent from cursor-overlay/,
      ],
      [
        '[dependencies.pip]\npackage = "pip-preview"\npath = "../pip-preview"\n',
        /independent from pip-preview/,
      ],
      ['[dependencies.input]\npackage = "enigo"\nversion = "0.2"\n', /independent from enigo/],
      ['[dependencies.rdev]\npackage = "rdev"\nversion = "0.5"\n', /independent from rdev/],
    ];
    for (const [suffix, expected] of cases) {
      await writeText(visualCargoPath, `${original}\n${suffix}`);
      await expect(
        assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
      ).rejects.toThrow(expected);
    }
    await writeText(visualCargoPath, original);
  });

  it("resolves workspace inheritance and rejects dependency backflow", async () => {
    const value = await fixture();
    const visualCargoPath = join(value.expected, VISUAL_ROOT, "Cargo.toml");
    const rootCargoPath = join(value.expected, "Cargo.toml");
    const visual = await readFile(visualCargoPath, "utf8");
    const root = await readFile(rootCargoPath, "utf8");
    const inheritedRoot = root.replace(
      "[workspace.dependencies]\n",
      '[workspace.dependencies]\nwide = { package = "cua-driver-core", path = "crates/cua-driver-core" }\n',
    );
    await writeText(rootCargoPath, inheritedRoot);
    await writeText(visualCargoPath, `${visual}\n[dependencies.wide]\nworkspace = true\n`);
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/independent from cua-driver-core/);

    const sdkRoot = root.replace(
      "[workspace.dependencies]\n",
      '[workspace.dependencies]\nsdk-alias = { package = "cua-driver-sdk", path = "crates/cua-driver-sdk" }\n',
    );
    await writeText(rootCargoPath, sdkRoot);
    await writeText(
      visualCargoPath,
      `${visual}\n[target.'cfg(target_os = "macos")'.dependencies.sdk-alias]\nworkspace = true\n`,
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/independent from cua-driver-sdk/);
    await writeText(rootCargoPath, root);
    await writeText(visualCargoPath, visual);
  });

  it("rejects probe backflow and reverse visual-to-probe dependencies", async () => {
    const value = await fixture();
    const probeCargoPath = join(value.expected, PROBE_ROOT, "Cargo.toml");
    const visualCargoPath = join(value.expected, VISUAL_ROOT, "Cargo.toml");
    const probe = await readFile(probeCargoPath, "utf8");
    const visual = await readFile(visualCargoPath, "utf8");
    await writeText(
      probeCargoPath,
      `${probe}\n[dependencies.platform]\npackage = "platform-macos"\npath = "../platform-macos"\n`,
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/probe root must stay independent from platform-macos/);
    await writeText(probeCargoPath, probe);
    await writeText(
      visualCargoPath,
      `${visual}\n[dependencies.probe]\npackage = "cua-macos-visual-link-probe"\npath = "../cua-macos-visual-link-probe"\n`,
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/may not depend on the link probe/);
    await writeText(visualCargoPath, visual);
  });

  it("binds the probe to the real visual path and rejects external or fake sources", async () => {
    const value = await fixture();
    const probeCargoPath = join(value.expected, PROBE_ROOT, "Cargo.toml");
    const probe = await readFile(probeCargoPath, "utf8");
    const dependency = 'cua-macos-visual = { path = "../cua-macos-visual" }';
    const replaceDependency = (text: string) =>
      probe.replace(dependency, `cua-macos-visual = { ${text} }`);
    const cases = [
      [replaceDependency('git = "https://example.invalid/cua-macos-visual"'), /external source/],
      [replaceDependency('registry = "custom"'), /external source/],
      [replaceDependency("workspace = true"), /explicit path/],
      [
        replaceDependency('path = "../cua-macos-visual-link-probe/../cua-macos-visual"'),
        /direct sibling path/,
      ],
    ];
    await mkdir(join(value.expected, "cua-macos-visual"));
    cases.push([
      replaceDependency('path = "../../cua-macos-visual"'),
      /must resolve to crates\/cua-macos-visual/,
    ]);
    for (const [text, expected] of cases) {
      await writeText(probeCargoPath, text);
      await expect(
        assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
      ).rejects.toThrow(expected);
    }
    await writeText(probeCargoPath, probe);
  });

  it("rejects probe feature requests that the visual crate does not declare", async () => {
    const value = await fixture();
    const probeCargoPath = join(value.expected, PROBE_ROOT, "Cargo.toml");
    const visualCargoPath = join(value.expected, VISUAL_ROOT, "Cargo.toml");
    const probe = await readFile(probeCargoPath, "utf8");
    const visual = await readFile(visualCargoPath, "utf8");
    const dependency = 'cua-macos-visual = { path = "../cua-macos-visual" }';
    await writeText(
      probeCargoPath,
      probe.replace(
        dependency,
        'cua-macos-visual = { path = "../cua-macos-visual", features = ["probe-ok"] }',
      ),
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/undeclared visual feature probe-ok/);
    await writeText(visualCargoPath, `${visual}\n[features]\nprobe-ok = []\n`);
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).resolves.toMatchObject({ probeDependencies: ["cua-macos-visual"] });
    await writeText(probeCargoPath, probe);
    await writeText(visualCargoPath, visual);
  });

  it("keeps the visual dependency set fixed and rejects root workspace drift", async () => {
    const value = await fixture();
    const visualCargoPath = join(value.expected, VISUAL_ROOT, "Cargo.toml");
    const rootCargoPath = join(value.expected, "Cargo.toml");
    const visual = await readFile(visualCargoPath, "utf8");
    const root = await readFile(rootCargoPath, "utf8");
    await writeText(
      visualCargoPath,
      visual.replace("image = { workspace = true }", 'image = { workspace = true }\nlibc = "0.2"'),
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/only image and core-foundation/);
    await writeText(
      visualCargoPath,
      visual.replace("image = { workspace = true }", 'image = { version = "0.25" }'),
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/preserved visual dependency image/);
    await writeText(visualCargoPath, visual);

    await writeText(
      rootCargoPath,
      root.replace("[workspace.dependencies]\n", '[workspace.dependencies]\nunused = "1"\n'),
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/root workspace only adds the link probe member/);
    await writeText(
      rootCargoPath,
      root.replace(
        '  "crates/cua-macos-visual-link-probe",\n',
        '  "crates/cua-macos-visual-link-probe",\n  "crates/other",\n',
      ),
    );
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/root workspace only adds the link probe member/);
    await writeText(rootCargoPath, root);
  });

  it("preserves old safety features and requires non-empty Swift source under visual", async () => {
    const value = await fixture();
    const platformCargoPath = join(value.expected, "crates/platform-macos/Cargo.toml");
    const platform = await readFile(platformCargoPath, "utf8");
    await writeText(platformCargoPath, platform.replace("zody-dev-no-input = []\n", ""));
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/removes zody-dev-no-input/);
    await writeText(platformCargoPath, platform);

    const swiftFile = join(value.expected, swiftPath);
    const swift = await readFile(swiftFile, "utf8");
    await writeText(swiftFile, "");
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/Swift source must not be empty/);
    await writeText(swiftFile, swift);
    await rm(swiftFile);
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/at least one Swift/);
    await writeText(swiftFile, swift);

    const outsideSwift = join(value.expected, PROBE_ROOT, "src/bridge.swift");
    await writeText(outsideSwift, "public func outside() {}\n");
    await expect(
      assertRound9DependencyPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/Swift source must live under crates\/cua-macos-visual/);
    await rm(outsideSwift);
  });
});

describe("round 9 lock policy", () => {
  it("preserves every old record and the exact visual dependency transition", async () => {
    const value = await fixture();
    const result = await assertRound9LockPolicy({
      baseRoot: value.base,
      candidateRoot: value.expected,
    });
    expect(result).toMatchObject({
      visualDependencies: ["core-foundation", "image"],
      addedPathPackages: ["cua-macos-visual-link-probe"],
      existingPackagesRetained: expect.any(Number),
      unchangedPackages: expect.any(Number),
      modifiedPackages: ["cua-macos-visual"],
    });
    expect(result.existingPackagesRetained).toBe(result.unchangedPackages + 1);
  });

  it("rejects checksum drift, old-record removal, and visual dependency drift", async () => {
    const value = await fixture();
    const lockPath = join(value.expected, "Cargo.lock");
    const original = await readFile(lockPath, "utf8");
    const checksumDrift = original.replace(
      'checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
      'checksum = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"',
    );
    await writeText(lockPath, checksumDrift);
    await expect(
      assertRound9LockPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/lock changes existing image/);

    const removed = original.replace(
      /\n\[\[package\]\]\nname = "screencapturekit"\nversion = "8\.0\.1"\nsource = "[^"]+"\nchecksum = "[^"]+"\n/,
      "\n",
    );
    await writeText(lockPath, removed);
    await expect(
      assertRound9LockPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/lock removes screencapturekit/);

    const visualStillWide = original.replace(
      'name = "cua-macos-visual"\nversion = "0.37.0"\ndependencies = [\n "core-foundation",\n "image",\n]',
      'name = "cua-macos-visual"\nversion = "0.37.0"\ndependencies = [\n "core-foundation",\n "image",\n "screencapturekit",\n]',
    );
    await writeText(lockPath, visualStillWide);
    await expect(
      assertRound9LockPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/visual lock dependencies must change/);
    await writeText(lockPath, original);
  });

  it("rejects new registry packages, missing probe entries, and probe dependency drift", async () => {
    const value = await fixture();
    const lockPath = join(value.expected, "Cargo.lock");
    const original = await readFile(lockPath, "utf8");
    await writeText(
      lockPath,
      `${original}\n[[package]]\nname = "unexpected"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${"e".repeat(64)}"\n`,
    );
    await expect(
      assertRound9LockPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/non-path package unexpected/);

    const missingProbe = original.replace(
      /\n\[\[package\]\]\nname = "cua-macos-visual-link-probe"\nversion = "0\.37\.0"\ndependencies = \[\n "cua-macos-visual",\n\]\n/,
      "\n",
    );
    await writeText(lockPath, missingProbe);
    await expect(
      assertRound9LockPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/probe.*lock entry/);

    const wrongProbeDeps = original.replace(
      'name = "cua-macos-visual-link-probe"\nversion = "0.37.0"\ndependencies = [\n "cua-macos-visual",\n]',
      'name = "cua-macos-visual-link-probe"\nversion = "0.37.0"\ndependencies = [\n "platform-macos",\n]',
    );
    await writeText(lockPath, wrongProbeDeps);
    await expect(
      assertRound9LockPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/probe lock dependencies/);

    const probeChecksum = original.replace(
      'name = "cua-macos-visual-link-probe"\nversion = "0.37.0"\ndependencies = [\n "cua-macos-visual",\n]',
      `name = "cua-macos-visual-link-probe"\nversion = "0.37.0"\nchecksum = "${"f".repeat(64)}"\ndependencies = [\n "cua-macos-visual",\n]`,
    );
    await writeText(lockPath, probeChecksum);
    await expect(
      assertRound9LockPolicy({ baseRoot: value.base, candidateRoot: value.expected }),
    ).rejects.toThrow(/must not carry source or checksum/);
    await writeText(lockPath, original);
  });
});

describe("round 9 candidate rebuild", () => {
  it("applies the real fixture patch and publishes only full-source", async () => {
    const value = await fixture();
    const before = await snapshotTree(value.base);
    expect(value.patchText).toContain("new file mode 100644");
    expect(value.patchText).toContain(`diff --git a/${swiftPath} b/${swiftPath}`);
    const result = await prepareRound9Candidate(prepareOptions(value));
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
      sourceManifestSha256: value.config.candidateSourceManifestSha256,
      dependencyPolicy: {
        visualRoot: VISUAL_ROOT,
        probeRoot: PROBE_ROOT,
        preservedFeatures: ["zody-dev-no-input", "zody-strict-frame-gate"],
        swiftBridgeFiles: [swiftPath],
      },
      lockPolicy: {
        visualDependencies: ["core-foundation", "image"],
        addedPathPackages: ["cua-macos-visual-link-probe"],
      },
    });
    expect(result.reviewConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(value.output, swiftPath), "utf8")).toContain("@_cdecl");
    expect(await readFile(join(value.output, "notes/old.txt"), "utf8")).toBe(
      "preserve round 8 bytes\n",
    );
    expect(await readFile(join(value.output, "crates/cua-driver-core/src/lib.rs"), "utf8")).toBe(
      "pub fn old_core() {}\n",
    );
    expect(await snapshotTree(value.base)).toEqual(before);
    expect(await readdir(value.work)).toEqual(["full-source"]);
    await expect(prepareRound9Candidate(prepareOptions(value))).rejects.toThrow(/already exists/);
  });

  it("requires the accepted R8 base tree by default", async () => {
    const value = await fixture();
    const options = prepareOptions(value);
    delete options.expectedBaseTreeSha256;
    await expect(prepareRound9Candidate(options)).rejects.toThrow(/accepted R8 tree/);
    expect(await readdir(value.work)).toEqual([]);
  });

  it("rejects base, patch, input-pin, and candidate target drift without leaving staging", async () => {
    const baseDrift = await fixture();
    await writeText(join(baseDrift.base, "notes/old.txt"), "drifted base\n");
    await expect(prepareRound9Candidate(prepareOptions(baseDrift))).rejects.toThrow(
      /round 9 base source/,
    );
    expect(await readdir(baseDrift.work)).toEqual([]);

    const manifestDrift = await fixture();
    const baseManifest = await readJson(manifestDrift.baseManifestPath);
    baseManifest.files[0].candidateSha256 = sha("manifest drift");
    await writeJson(manifestDrift.baseManifestPath, baseManifest);
    await expect(prepareRound9Candidate(prepareOptions(manifestDrift))).rejects.toThrow(
      /base source manifest/,
    );
    expect(await readdir(manifestDrift.work)).toEqual([]);

    const patchDrift = await fixture();
    await writeText(patchDrift.patchPath, "diff --git a/Cargo.toml b/Cargo.toml\n");
    await expect(prepareRound9Candidate(prepareOptions(patchDrift))).rejects.toThrow(/patch/);
    expect(await readdir(patchDrift.work)).toEqual([]);

    const patchBytesDrift = await fixture();
    const byteConfig = await readJson(patchBytesDrift.reviewConfigPath);
    byteConfig.candidatePatch.bytes += 1;
    await writeJson(patchBytesDrift.reviewConfigPath, byteConfig);
    await expect(prepareRound9Candidate(prepareOptions(patchBytesDrift))).rejects.toThrow(
      /patch.*byte/i,
    );
    expect(await readdir(patchBytesDrift.work)).toEqual([]);

    const pathPinDrift = await fixture();
    const pathConfig = await readJson(pathPinDrift.reviewConfigPath);
    pathConfig.baseSourceManifest = "other-base-manifest.json";
    await writeJson(pathPinDrift.reviewConfigPath, pathConfig);
    await expect(prepareRound9Candidate(prepareOptions(pathPinDrift))).rejects.toThrow(
      /different base source manifest/,
    );
    expect(await readdir(pathPinDrift.work)).toEqual([]);

    const targetPinDrift = await fixture();
    const targetConfig = await readJson(targetPinDrift.reviewConfigPath);
    targetConfig.target = "x86_64-apple-darwin";
    await writeJson(targetPinDrift.reviewConfigPath, targetConfig);
    await expect(prepareRound9Candidate(prepareOptions(targetPinDrift))).rejects.toThrow(
      /aarch64-apple-darwin/,
    );
    expect(await readdir(targetPinDrift.work)).toEqual([]);

    const toolchainPinDrift = await fixture();
    const toolchainConfig = await readJson(toolchainPinDrift.reviewConfigPath);
    toolchainConfig.toolchain.auditedVersion = "1.96.0";
    await writeJson(toolchainPinDrift.reviewConfigPath, toolchainConfig);
    await expect(prepareRound9Candidate(prepareOptions(toolchainPinDrift))).rejects.toThrow(
      /1\.97\.1/,
    );
    expect(await readdir(toolchainPinDrift.work)).toEqual([]);

    const targetDrift = await fixture();
    const manifest = await readJson(targetDrift.sourceManifestPath);
    manifest.treeSha256 = sha("wrong target tree");
    const manifestWrite = await writeJson(targetDrift.sourceManifestPath, manifest);
    const config = await readJson(targetDrift.reviewConfigPath);
    config.candidateSourceManifestSha256 = manifestWrite.sha256;
    config.candidateTreeSha256 = manifest.treeSha256;
    await writeJson(targetDrift.reviewConfigPath, config);
    await expect(prepareRound9Candidate(prepareOptions(targetDrift))).rejects.toThrow(
      /round 9 candidate source/,
    );
    expect(await readdir(targetDrift.work)).toEqual([]);
  });

  it("rejects a real patch that modifies an unknown old root", async () => {
    const value = await fixture();
    const oldCore = join(value.expected, "crates/cua-driver-core/src/lib.rs");
    await writeText(oldCore, `${await readFile(oldCore, "utf8")}pub fn rewritten() {}\n`);
    await refreshRound9Fixture(value);
    await expect(prepareRound9Candidate(prepareOptions(value))).rejects.toThrow(
      /may not modify crates\/cua-driver-core/,
    );
    expect(await readdir(value.work)).toEqual([]);
  });

  it("rejects real-patch dependency backflow, lock record drift, and root workspace drift", async () => {
    const backflow = await fixture();
    const backflowVisual = join(backflow.expected, VISUAL_ROOT, "Cargo.toml");
    await writeText(
      backflowVisual,
      `${await readFile(backflowVisual, "utf8")}\n[dependencies.old-core]\npackage = "cua-driver-core"\npath = "../../cua-driver-core"\n`,
    );
    await refreshRound9Fixture(backflow);
    await expect(prepareRound9Candidate(prepareOptions(backflow))).rejects.toThrow(
      /independent from cua-driver-core/,
    );
    expect(await readdir(backflow.work)).toEqual([]);

    const lockDrift = await fixture();
    const lockPath = join(lockDrift.expected, "Cargo.lock");
    await writeText(
      lockPath,
      (await readFile(lockPath, "utf8")).replace(
        'checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
        'checksum = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"',
      ),
    );
    await refreshRound9Fixture(lockDrift);
    await expect(prepareRound9Candidate(prepareOptions(lockDrift))).rejects.toThrow(
      /lock changes existing image/,
    );
    expect(await readdir(lockDrift.work)).toEqual([]);

    const workspaceDrift = await fixture();
    const rootCargoPath = join(workspaceDrift.expected, "Cargo.toml");
    await writeText(
      rootCargoPath,
      (await readFile(rootCargoPath, "utf8")).replace(
        "[workspace.dependencies]\n",
        '[workspace.dependencies]\nunused = "1"\n',
      ),
    );
    await refreshRound9Fixture(workspaceDrift);
    await expect(prepareRound9Candidate(prepareOptions(workspaceDrift))).rejects.toThrow(
      /root workspace only adds the link probe member/,
    );
    expect(await readdir(workspaceDrift.work)).toEqual([]);
  });
});
