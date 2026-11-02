import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCompareArguments } from "../scripts/compare-macos-cua-driver-closure.mjs";
import {
  readClosureReportFile,
  validateClosureReport,
  validateComparisonPolicy,
} from "../scripts/lib/cua-driver-closure-comparison-core.mjs";
import { runDriverClosureComparison } from "../scripts/lib/cua-driver-closure-comparison-report.mjs";
import { validateSupplementSubset } from "../scripts/lib/cua-driver-closure-comparison-supplements.mjs";
import { prepareClosureOutputDirectory } from "../scripts/lib/cua-driver-closure-comparison-output.mjs";
import {
  cleanupTempDirs,
  makeTempRoot,
  makeReport,
  makePolicy,
  pkg,
  sha,
  supplementEntry,
  writeFixture,
  writeSupplementTree,
} from "./fixtures/cua-driver-closure-comparison-fixtures.mjs";

afterEach(cleanupTempDirs);
const CORE = pkg("cua-driver-core", "0.37.0", ["default", "yaml"], "crates/cua-driver-core");
const PLATFORM = pkg(
  "platform-macos",
  "0.37.0",
  ["default", "zody-dev-no-input", "zody-strict-frame-gate"],
  "crates/platform-macos",
);
const STABLE = [CORE, PLATFORM];

describe("round 7 closure comparison", () => {
  it("binds the shipped policy to the fixed baseline report and reads candidate hashes", async () => {
    const policy = JSON.parse(
      await readFile(
        new URL(
          "../native/macos-cua-driver-closure/round7/comparison-policy.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(() => validateComparisonPolicy(policy)).not.toThrow();
    const baseline = await readClosureReportFile(
      new URL(
        "../native/macos-cua-driver-closure/reports/2026-10-28/report.json.gz",
        import.meta.url,
      ),
    );
    expect(baseline.sha256).toBe(policy.baseline.sha256);
    expect(baseline.report.revision).toBe(policy.baseline.revision);
    expect(
      baseline.report.source.files.every((entry: { candidateSha256: string }) =>
        /^[a-f0-9]{64}$/.test(entry.candidateSha256),
      ),
    ).toBe(true);
  });

  it("rejects a baseline whose bytes do not match the bound SHA", async () => {
    const fixture = await writeFixture({
      mutatePolicy: (policy) => {
        policy.baseline.sha256 = "0".repeat(64);
      },
    });
    await expect(runDriverClosureComparison(fixture)).rejects.toThrow(/baseline.*sha256/i);
  });

  it("fails closed when source, dependencies or target graph did not pass", async () => {
    for (const option of [
      { sourceStatus: "fail" },
      { dependenciesStatus: "fail" },
      { targetGraphStatus: "blocked" },
      { registryStatus: "blocked" },
    ]) {
      await expect(
        runDriverClosureComparison(
          await writeFixture({ candidate: { packages: STABLE, ...option } }),
        ),
      ).rejects.toThrow(/not verified|not pass|blocked/i);
    }
  });

  it("rejects a missing graph and mismatched source, target, package or policy", async () => {
    const graphless = await writeFixture({ candidate: { packages: STABLE, graph: false } });
    await expect(runDriverClosureComparison(graphless)).rejects.toThrow(/graph/i);
    for (const candidate of [
      { packages: STABLE, revision: "a".repeat(40) },
      { packages: STABLE, target: "x86_64-apple-darwin" },
      { packages: STABLE, packageName: "other" },
    ]) {
      await expect(runDriverClosureComparison(await writeFixture({ candidate }))).rejects.toThrow(
        /revision|target|package/i,
      );
    }
    const policyMismatch = await writeFixture({
      candidate: { packages: STABLE },
      mutatePolicy: (policy) => {
        policy.candidate.sourceRoot = "other/root";
      },
    });
    await expect(runDriverClosureComparison(policyMismatch)).rejects.toThrow(/sourceRoot/i);
  });

  it("requires verificationFailed to be explicitly false", () => {
    const report = makeReport();
    const policy = validateComparisonPolicy(makePolicy(report, sha(JSON.stringify(report))));
    delete (report.gates as Record<string, unknown>).verificationFailed;
    expect(() => validateClosureReport(report, { policy, role: "candidate" })).toThrow(
      /verification/i,
    );
  });

  it("compares actual graph identities, versions, features and relative paths", async () => {
    const baseline = [
      pkg(
        "cua-driver-core",
        "0.37.0",
        ["default", "yaml"],
        "/tmp/one/full-source/crates/cua-driver-core",
      ),
      PLATFORM,
      pkg("foo", "1.0.0", ["default"], null),
      pkg("bar", "1.0.0", ["default"], "crates/bar"),
      pkg("rquickjs", "0.14.0", ["default"], null),
      pkg("uniffi", "0.31.0", ["default"], null),
    ];
    const candidate = [
      pkg(
        "cua-driver-core",
        "0.37.0",
        ["default", "yaml"],
        "/tmp/two/full-source/crates/cua-driver-core",
      ),
      PLATFORM,
      pkg("foo", "2.0.0", ["default"], null),
      pkg("bar", "1.0.0", ["default", "serde"], "crates/bar"),
    ];
    const fixture = await writeFixture({
      baseline: {
        packages: baseline,
        gaps: {
          missing: ["foo@1.0.0", "rquickjs@0.14.0"],
          partial: ["bar@1.0.0"],
          reviewRequired: ["uniffi@0.31.0"],
          mpl: ["uniffi@0.31.0"],
        },
      },
      candidate: { packages: candidate, gaps: { missing: ["foo@2.0.0"], partial: ["bar@1.0.0"] } },
    });
    const { report } = await runDriverClosureComparison(fixture);
    expect(report.graph.removed.map((entry: { name: string }) => entry.name)).toContain("rquickjs");
    expect(report.graph.added.map((entry: { name: string }) => entry.name)).toContain("foo");
    expect(report.graph.versionChanged).toEqual([{ name: "foo", from: ["1.0.0"], to: ["2.0.0"] }]);
    expect(report.graph.featureChanged).toEqual([
      expect.objectContaining({ name: "bar", version: "1.0.0" }),
    ]);
    expect(report.graph.sourceChanged).toEqual([]);
    expect(report.licenses.missing.versionReplacement).toEqual(["foo@1.0.0"]);
    expect(report.licenses.missing.clearedByGraphRemoval).toContain("rquickjs@0.14.0");
    expect(report.licenses.reviewRequired.clearedByGraphRemoval).toContain("uniffi@0.31.0");
    expect(report.licenses.legalReviewCompleted).toBe(false);
    expect(report.lock).toMatchObject({
      baseline: { entryCount: 2 },
      candidate: { entryCount: 2 },
    });
    expect(report.productAdoption).toBe("blocked");
  });

  it("separates same-identity material changes from version replacement", async () => {
    const packages = [...STABLE, pkg("foo", "1.0.0", ["default"], null)];
    const fixture = await writeFixture({
      baseline: { packages, gaps: { missing: ["foo@1.0.0"] } },
      candidate: { packages, gaps: {} },
    });
    const { report } = await runDriverClosureComparison(fixture);
    expect(report.licenses.missing.versionReplacement).toEqual([]);
    expect(report.licenses.missing.materialEvidenceChanged).toEqual([
      { package: "foo@1.0.0", direction: "gap-removed" },
    ]);
    expect(report.licenses.legalReviewCompleted).toBe(false);
  });

  it("reports partial multi-version changes without hiding a shared version", async () => {
    const fixture = await writeFixture({
      baseline: { packages: [...STABLE, pkg("foo", "1.0.0"), pkg("foo", "2.0.0")] },
      candidate: { packages: [...STABLE, pkg("foo", "1.0.0"), pkg("foo", "3.0.0")] },
    });
    const { report } = await runDriverClosureComparison(fixture);
    expect(report.graph.versionChanged).toEqual([]);
    expect(report.graph.versionSetChanged).toEqual([
      {
        name: "foo",
        from: ["1.0.0", "2.0.0"],
        to: ["1.0.0", "3.0.0"],
        removed: ["2.0.0"],
        added: ["3.0.0"],
      },
    ]);
  });

  it("rejects excluded packages and feature recurrence anywhere in the graph", async () => {
    for (const packages of [
      [...STABLE, pkg("regorus", "0.14.0")],
      [
        pkg("cua-driver-core", "0.37.0", ["default", "yaml", "script"], "crates/cua-driver-core"),
        PLATFORM,
      ],
      [
        pkg(
          "cua-driver-core",
          "0.37.0",
          ["default", "yaml", "zody-dev-probe"],
          "crates/cua-driver-core",
        ),
        PLATFORM,
      ],
      [
        CORE,
        pkg(
          "platform-macos",
          "0.37.0",
          [...PLATFORM.features, "zody-dev-probe"],
          "crates/platform-macos",
        ),
      ],
    ]) {
      await expect(
        runDriverClosureComparison(await writeFixture({ candidate: { packages } })),
      ).rejects.toThrow(/excluded package|forbidden feature|forbidden graph feature/i);
    }
  });

  it("rejects missing roots, empty graphs, duplicate gaps and product adoption", async () => {
    for (const candidate of [
      { packages: STABLE, graphRoot: "cua-driver-sdk@9.9.9" },
      { packages: [], skipRoot: true },
    ]) {
      await expect(runDriverClosureComparison(await writeFixture({ candidate }))).rejects.toThrow(
        /root|graph packages/i,
      );
    }
    const duplicate = await writeFixture({
      baseline: {
        packages: [...STABLE, pkg("foo", "1.0.0")],
        gaps: { missing: ["foo@1.0.0", "foo@1.0.0"] },
      },
      candidate: { packages: [...STABLE, pkg("foo", "1.0.0")] },
    });
    await expect(runDriverClosureComparison(duplicate)).rejects.toThrow(/duplicate/i);
    await expect(
      runDriverClosureComparison(
        await writeFixture({ candidate: { packages: STABLE, productAdoption: "pass" } }),
      ),
    ).rejects.toThrow(/product adoption/i);
  });

  it("requires a fresh comparison output and accepts macOS temp parents and empty audit dirs", async () => {
    const existing = await makeTempRoot("zody-cua-round7-existing-");
    await writeFile(join(existing, "keep.txt"), "x");
    await expect(prepareClosureOutputDirectory(existing)).rejects.toThrow(
      /already contains files/i,
    );
    const empty = await makeTempRoot("zody-cua-round7-empty-");
    await expect(
      prepareClosureOutputDirectory(empty, { allowEmptyExisting: true }),
    ).resolves.toBeUndefined();
    await expect(prepareClosureOutputDirectory(empty)).rejects.toThrow(/already exists/i);
    const linkRoot = await makeTempRoot("zody-cua-round7-link-");
    const link = join(linkRoot, "out");
    await symlink(join(linkRoot, "target"), link);
    await expect(prepareClosureOutputDirectory(link)).rejects.toThrow(/symlink/i);
    const tmpRoot = await makeTempRoot("zody-cua-round7-tmp-", "/tmp");
    await expect(
      prepareClosureOutputDirectory(join(tmpRoot, "nested", "out")),
    ).resolves.toBeUndefined();
    expect(
      parseCompareArguments([
        "--baseline-report",
        "a",
        "--candidate-report",
        "b",
        "--policy",
        "c",
        "--output-dir",
        "d",
      ]).options.outputDir,
    ).toBeTruthy();
  });

  it("validates supplement subset reuse, graph-outside removal and workspace hash updates", async () => {
    const root = await makeTempRoot("zody-cua-round7-supplements-");
    const baselineDir = join(root, "baseline");
    const candidateDir = join(root, "candidate");
    const text = "MIT License\n";
    const registry = supplementEntry("rquickjs-core", "0.14.0", { lockChecksum: "1".repeat(64) });
    const gone = supplementEntry("uniffi", "0.31.0", { lockChecksum: "2".repeat(64) });
    const oldWorkspace = supplementEntry("cua-driver-core", "0.37.0", {
      workspace: true,
      rootHash: sha("root-old"),
      cargoHash: sha("core-old"),
    });
    const newWorkspace = supplementEntry("cua-driver-core", "0.37.0", {
      workspace: true,
      rootHash: sha("root-new"),
      cargoHash: sha("core-new"),
    });
    const baseManifest = {
      schemaVersion: 1,
      kind: "zody-cua-driver-closure-license-supplements",
      sourceRevision: "2d2f99228d4d2508dc6fcc84c176b296e146714a",
      entries: [registry, gone, oldWorkspace],
    };
    const candManifest = { ...baseManifest, entries: [newWorkspace] };
    await writeSupplementTree(baselineDir, baseManifest, text);
    await writeSupplementTree(candidateDir, candManifest, text);
    const baselineManifestPath = join(baselineDir, "manifest.json");
    const candidateManifestPath = join(candidateDir, "manifest.json");
    const args = {
      baselineManifestPath,
      candidateManifestPath,
      baselineManifestSha256: sha(await readFile(baselineManifestPath)),
      baselineEntryCount: 3,
      baselineGraph: {
        packages: [registry, gone, oldWorkspace].map((entry) =>
          pkg(entry.name, entry.version, [], entry.lockChecksum ? null : `crates/${entry.name}`),
        ),
      },
      candidateGraph: {
        packages: [pkg("cua-driver-core", "0.37.0", [], "crates/cua-driver-core")],
      },
      baselineSourceFiles: [],
      candidateSourceFiles: [
        { path: "Cargo.toml", candidateSha256: sha("root-new") },
        { path: "crates/cua-driver-core/Cargo.toml", candidateSha256: sha("core-new") },
      ],
    };
    const result = await validateSupplementSubset(args);
    expect(result.status).toBe("pass");
    expect(result.droppedOutsideGraph).toEqual(["rquickjs-core@0.14.0", "uniffi@0.31.0"]);
    expect(result.workspaceCargoHashesUpdated).toContain("cua-driver-core@0.37.0");
    await writeSupplementTree(
      candidateDir,
      { ...candManifest, entries: [{ ...newWorkspace, lockChecksum: "9".repeat(64) }] },
      text,
    );
    await expect(validateSupplementSubset(args)).rejects.toThrow(/workspace|registry|checksum/i);
    await writeSupplementTree(
      candidateDir,
      {
        ...candManifest,
        entries: [{ ...newWorkspace, text: { ...newWorkspace.text, sha256: sha("drift") } }],
      },
      text,
    );
    await expect(validateSupplementSubset(args)).rejects.toThrow(/text|drift|sha/i);
    await writeSupplementTree(candidateDir, candManifest, `${text}drift`);
    await expect(validateSupplementSubset(args)).rejects.toThrow(/text/i);
  });

  it("rejects missing old mappings for graph packages and unknown identities", async () => {
    const root = await makeTempRoot("zody-cua-round7-supplement-map-");
    const base = supplementEntry("rquickjs-core", "0.14.0", { lockChecksum: "1".repeat(64) });
    const baseManifest = {
      schemaVersion: 1,
      kind: "zody-cua-driver-closure-license-supplements",
      sourceRevision: "2d2f99228d4d2508dc6fcc84c176b296e146714a",
      entries: [base],
    };
    await writeSupplementTree(join(root, "b"), baseManifest, "MIT License\n");
    await writeSupplementTree(join(root, "c"), { ...baseManifest, entries: [] }, "MIT License\n");
    const args = {
      baselineManifestPath: join(root, "b", "manifest.json"),
      candidateManifestPath: join(root, "c", "manifest.json"),
      baselineManifestSha256: sha(await readFile(join(root, "b", "manifest.json"))),
      baselineEntryCount: 1,
      baselineGraph: { packages: [pkg("rquickjs-core", "0.14.0", [], null)] },
      candidateGraph: { packages: [pkg("rquickjs-core", "0.14.0", [], null)] },
      baselineSourceFiles: [],
      candidateSourceFiles: [],
    };
    await expect(validateSupplementSubset(args)).rejects.toThrow(/missing.*mapping/i);
    await writeSupplementTree(join(root, "c"), baseManifest, "MIT License\n");
    await expect(validateSupplementSubset(args)).resolves.toMatchObject({ status: "pass" });
    const drifted = { ...base, source: { ...base.source, commit: "b".repeat(40) } };
    await writeSupplementTree(
      join(root, "c"),
      { ...baseManifest, entries: [drifted] },
      "MIT License\n",
    );
    await expect(validateSupplementSubset(args)).rejects.toThrow(/source drift/i);
    await writeSupplementTree(
      join(root, "c"),
      {
        ...baseManifest,
        entries: [supplementEntry("new", "1.0.0", { lockChecksum: "3".repeat(64) })],
      },
      "MIT License\n",
    );
    await expect(
      validateSupplementSubset({
        ...args,
        candidateGraph: { packages: [pkg("new", "1.0.0", [], null)] },
      }),
    ).rejects.toThrow(/unknown/i);
  });
});
