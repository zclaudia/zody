import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readClosureReportFile,
  validateComparisonPolicy,
} from "../scripts/lib/cua-driver-closure-comparison-core.mjs";
import { runDriverClosureComparison } from "../scripts/lib/cua-driver-closure-comparison-report.mjs";
import {
  cleanupTempDirs,
  makeReport,
  makeTempRoot,
  pkg,
  sha,
  writeFixture,
} from "./fixtures/cua-driver-closure-comparison-fixtures.mjs";
import {
  LEGACY_PACKAGE,
  LEGACY_PACKAGES,
  REV,
  SRC,
  TARGET,
  VISUAL_PACKAGE,
  VISUAL_PACKAGES,
  buildTransitionSourceFiles,
  writeTransitionFixture,
} from "./fixtures/cua-driver-round8-comparison-fixtures.mjs";

afterEach(cleanupTempDirs);

const REVIEW_CONFIG_SHA = "73171d6112f54c2541f2905f96310e04c3d5b15e49c313d5484b354ecf359ac0";
const SOURCE_MANIFEST_SHA = "53fc08d9835f27c07ae756f93a345b9d0a0cf6d9197aa01db03796fc605f5267";

describe("round 8 closure comparison", () => {
  it("binds the shipped policy to the real R7 archive and declares the visual root", async () => {
    const policy = JSON.parse(
      await readFile(
        new URL(
          "../native/macos-cua-driver-closure/round8/comparison-policy.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(() => validateComparisonPolicy(policy)).not.toThrow();
    const baseline = await readClosureReportFile(
      new URL(
        "../native/macos-cua-driver-closure/reports/2026-10-28-round7/report.json.gz",
        import.meta.url,
      ),
    );
    expect(policy.schemaVersion).toBe(2);
    expect(policy.baseline.sha256).toBe(baseline.sha256);
    expect(policy.baseline.reviewConfigSha256).toBe(REVIEW_CONFIG_SHA);
    expect(policy.baseline.sourceManifestSha256).toBe(SOURCE_MANIFEST_SHA);
    expect(policy.baseline.reviewConfigSha256).toBe(baseline.report.review.configSha256);
    expect(policy.baseline.sourceManifestSha256).toBe(baseline.report.review.manifestSha256);
    expect(policy.baseline.sourceFileCount).toBe(baseline.report.source.files.length);
    expect(policy.baseline.graphPackageCount).toBe(baseline.report.dependencies.graph.packageCount);
    expect(policy.baseline.lockEntryCount).toBe(baseline.report.dependencies.lock.entryCount);
    expect(policy.baseline.lockChecksumEntries).toBe(
      baseline.report.dependencies.lock.checksumEntries,
    );
    expect(policy.baseline.license).toMatchObject({
      packageCount: baseline.report.licenses.packageCount,
      missing: baseline.report.licenses.missingMaterials.length,
      partial: baseline.report.licenses.incompleteCoverage.length,
    });
    expect(policy.baseline.supplements.entryCount).toBe(15);
    const round7Root = new URL("../native/macos-cua-driver-closure/round7/", import.meta.url);
    expect(sha(await readFile(new URL("review-config.json", round7Root)))).toBe(
      policy.baseline.reviewConfigSha256,
    );
    expect(sha(await readFile(new URL("source-manifest.json", round7Root)))).toBe(
      policy.baseline.sourceManifestSha256,
    );
    const supplementManifest = JSON.parse(
      await readFile(new URL("license-supplements/manifest.json", round7Root), "utf8"),
    );
    expect(sha(await readFile(new URL("license-supplements/manifest.json", round7Root)))).toBe(
      policy.baseline.supplements.manifestSha256,
    );
    expect(supplementManifest.entries).toHaveLength(policy.baseline.supplements.entryCount);
    expect(policy.candidate.package).toBe(VISUAL_PACKAGE);
    expect(policy.rootTransition).toMatchObject({
      fromPackage: LEGACY_PACKAGE,
      toPackage: VISUAL_PACKAGE,
      revision: REV,
      sourceRoot: SRC,
      target: TARGET,
      functionalEquivalent: false,
      interfaceEquivalent: "not-established",
      abiEquivalent: "not-established",
      toolEquivalent: "not-established",
      legacyRootUncompiled: true,
    });
  });

  it("compares the shipped R8 policy against the real R7 report without inventing candidate counts", async () => {
    const policy = JSON.parse(
      await readFile(
        new URL(
          "../native/macos-cua-driver-closure/round8/comparison-policy.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const root = await makeTempRoot("zody-cua-round8-shipped-");
    const baseline = await readClosureReportFile(
      new URL(
        "../native/macos-cua-driver-closure/reports/2026-10-28-round7/report.json.gz",
        import.meta.url,
      ),
    );
    const candidate = makeReport({
      packageName: VISUAL_PACKAGE,
      packages: VISUAL_PACKAGES,
      sourceFiles: buildTransitionSourceFiles(baseline.report.source.files),
    });
    const candidatePath = join(root, "candidate.json");
    const policyPath = join(root, "policy.json");
    await writeFile(candidatePath, JSON.stringify(candidate));
    await writeFile(policyPath, JSON.stringify(policy));
    const { report } = await runDriverClosureComparison({
      baselineReportPath: new URL(
        "../native/macos-cua-driver-closure/reports/2026-10-28-round7/report.json.gz",
        import.meta.url,
      ).pathname,
      candidateReportPath: candidatePath,
      policyPath,
      outputDir: join(root, "out"),
    });
    expect(report.schemaVersion).toBe(2);
    expect(report.graph.candidatePackageCount).toBe(VISUAL_PACKAGES.length + 1);
    expect(report.graph.inventoryDelta.removedFromCandidateGraph).toContain(
      `${LEGACY_PACKAGE}@0.37.0`,
    );
    expect(report.licenses.legacyGapsStillExist).toBe(true);
    expect(report.licenses.resolvedByTransition).toBe(false);
    expect(report.sourceRetention).toMatchObject({
      status: "verified",
      baselineFileCount: 753,
      candidateFileCount: 755,
    });
    expect(report.sourceRetention.addedPaths).toEqual([
      "crates/cua-macos-visual/Cargo.toml",
      "crates/cua-macos-visual/src/lib.rs",
    ]);
  });

  it("reports graph and license inventory deltas without claiming equivalence or resolution", async () => {
    const fixture = await writeTransitionFixture();
    const { report, reportPath } = await runDriverClosureComparison(fixture);
    expect(report.rootTransition).toMatchObject({
      declared: true,
      from: { package: LEGACY_PACKAGE, revision: REV, sourceRoot: SRC, target: TARGET },
      to: { package: VISUAL_PACKAGE, revision: REV, sourceRoot: SRC, target: TARGET },
      functionalEquivalent: false,
      interfaceEquivalent: "not-established",
      abiEquivalent: "not-established",
      toolEquivalent: "not-established",
      legacyRootUncompiled: true,
    });
    expect(report.graph.inventoryDelta.removedFromCandidateGraph).toEqual(
      expect.arrayContaining([
        `${LEGACY_PACKAGE}@0.37.0`,
        "cua-driver-core@0.37.0",
        "platform-macos@0.37.0",
        "clipboard-rs@0.37.0",
        "cursor-overlay@0.37.0",
        "pip-preview@0.37.0",
        "cua-cursor-motion@0.37.0",
      ]),
    );
    expect(report.graph.inventoryDelta.addedToCandidateGraph).toEqual(
      expect.arrayContaining([`${VISUAL_PACKAGE}@0.37.0`, "objc2@0.6.3"]),
    );
    expect(report.licenses.inventoryDelta.missing.removedFromCandidateGraph).toEqual(
      expect.arrayContaining([
        "cua-driver-core@0.37.0",
        "platform-macos@0.37.0",
        "rquickjs@0.14.0",
      ]),
    );
    expect(report.licenses.inventoryDelta.partial.removedFromCandidateGraph).toContain(
      "clipboard-rs@0.37.0",
    );
    expect(report.licenses.legacyGapsStillExist).toBe(true);
    expect(report.licenses.resolvedByTransition).toBe(false);
    expect(report.licenses.legalReviewCompleted).toBe(false);
    expect(report.sourceRetention).toMatchObject({
      status: "verified",
      baselineFileCount: 2,
      candidateFileCount: 4,
    });
    expect(JSON.stringify(report)).not.toContain("clearedByGraphRemoval");
    expect(JSON.stringify(report)).not.toContain('"resolvedByGraphRemoval"');

    expect(report.features.baselineOnly).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          package: "cua-driver-core",
          appliesTo: "baseline",
          candidateApplicability: expect.stringMatching(/absent.*uncompiled/i),
        }),
        expect.objectContaining({ package: "platform-macos", appliesTo: "baseline" }),
      ]),
    );
    expect(report.features.candidate.required).toEqual([]);

    const readme = await readFile(join(dirname(reportPath), "COMPARISON.md"), "utf8");
    expect(readme).toMatch(/removedFromCandidateGraph/);
    expect(readme).toMatch(/旧 R7 许可缺口.*仍然存在/);
    expect(readme).toMatch(/legacyRootUncompiled=true/);
    expect(readme).toMatch(/interface\/ABI\/tool.*not-established/);
    expect(readme).toMatch(/不是许可补齐/);
    expect(readme).toMatch(/source retention：verified/);
  });

  it("verifies legacy source retention from both reports and rejects drift", async () => {
    for (const options of [
      { removedSourcePaths: ["crates/cua-driver-core/Cargo.toml"] },
      { mutatedSourcePaths: ["crates/cua-driver-core/Cargo.toml"] },
      {
        addedSourceFiles: [
          {
            path: "crates/other/src/lib.rs",
            status: "added",
            candidateSha256: sha("outside"),
          },
        ],
      },
    ]) {
      const fixture = await writeTransitionFixture(options);
      await expect(runDriverClosureComparison(fixture)).rejects.toThrow(/source retention/);
    }
  });

  it("rejects undeclared or invalid root transition identities", async () => {
    const mutations = [
      (policy) => delete policy.rootTransition,
      (policy) => (policy.rootTransition.fromPackage = "cua-other"),
      (policy) => (policy.baseline.package = "cua-other"),
      (policy) => (policy.rootTransition.toPackage = "cua-other"),
      (policy) => (policy.rootTransition.toPackage = policy.rootTransition.fromPackage),
      (policy) => (policy.candidate.sourceRoot = "other/root"),
      (policy) => (policy.rootTransition.sourceRoot = "other/root"),
      (policy) => (policy.candidate.target = "x86_64-apple-darwin"),
      (policy) => (policy.rootTransition.target = "x86_64-apple-darwin"),
      (policy) => (policy.rootTransition.interfaceEquivalent = true),
      (policy) => (policy.rootTransition.abiEquivalent = true),
      (policy) => (policy.rootTransition.toolEquivalent = true),
      (policy) => (policy.rootTransition.functionalEquivalent = true),
      (policy) => (policy.rootTransition.legacyRootUncompiled = false),
      (policy) =>
        policy.rootTransition.scopeChanges.removedFromCandidateGraph.push(
          policy.rootTransition.scopeChanges.removedFromCandidateGraph[0],
        ),
      (policy) => policy.rootTransition.scopeChanges.baselineOnlyFeaturePackages.pop(),
    ];
    for (const mutatePolicy of mutations) {
      const fixture = await writeTransitionFixture({ mutatePolicy });
      await expect(runDriverClosureComparison(fixture)).rejects.toThrow(
        /root transition|package|sourceRoot|target|equivalent|uncompiled|duplicate|feature/i,
      );
    }
    const legacyMismatch = await writeFixture({
      candidate: { packageName: VISUAL_PACKAGE, packages: VISUAL_PACKAGES },
    });
    await expect(runDriverClosureComparison(legacyMismatch)).rejects.toThrow(/package/i);
  });

  it("rejects wrong actual roots, duplicate identities and forbidden package regression", async () => {
    for (const fixture of [
      await writeTransitionFixture({
        baseline: { packageName: "cua-other", packages: LEGACY_PACKAGES },
      }),
      await writeTransitionFixture({
        candidate: { packageName: "cua-other", packages: VISUAL_PACKAGES },
      }),
      await writeTransitionFixture({
        candidate: { packages: [...VISUAL_PACKAGES, pkg("objc2", "0.6.3")] },
      }),
      await writeTransitionFixture({
        candidate: {
          graphRoot: `${VISUAL_PACKAGE}@9.9.9`,
          packages: VISUAL_PACKAGES,
        },
      }),
      await writeTransitionFixture({
        candidate: {
          packages: [
            ...VISUAL_PACKAGES,
            pkg(VISUAL_PACKAGE, "0.37.0", ["default", "zody-dev-probe"], "crates/visual"),
          ],
        },
      }),
    ]) {
      await expect(runDriverClosureComparison(fixture)).rejects.toThrow(
        /package|root|duplicate|forbidden/i,
      );
    }

    for (const name of [
      LEGACY_PACKAGE,
      "cua-driver-core",
      "platform-macos",
      "clipboard-rs",
      "cursor-overlay",
      "pip-preview",
      "cua-cursor-motion",
      "quickjs",
      "rego",
      "regorus",
      "uniffi",
    ]) {
      const fixture = await writeTransitionFixture({
        candidate: { packages: [...VISUAL_PACKAGES, pkg(name, "0.37.0")] },
      });
      await expect(runDriverClosureComparison(fixture)).rejects.toThrow(/excluded package/i);
    }

    const fakeSafetyFeature = await writeTransitionFixture({
      candidate: {
        packages: [
          ...VISUAL_PACKAGES,
          pkg(VISUAL_PACKAGE, "0.37.0", ["default", "zody-dev-no-input"], "crates/visual"),
        ],
      },
    });
    await expect(runDriverClosureComparison(fakeSafetyFeature)).rejects.toThrow(
      /forbidden graph feature/i,
    );
  });

  it("keeps schema 1 R7 reports and license fields on their original semantics", async () => {
    const CORE = pkg("cua-driver-core", "0.37.0", ["default", "yaml"], "crates/cua-driver-core");
    const PLATFORM = pkg(
      "platform-macos",
      "0.37.0",
      ["default", "zody-dev-no-input", "zody-strict-frame-gate"],
      "crates/platform-macos",
    );
    const { report } = await runDriverClosureComparison(
      await writeFixture({ candidate: { packages: [CORE, PLATFORM] } }),
    );
    expect(report.schemaVersion).toBe(1);
    expect(report.rootTransition).toBeUndefined();
    expect(report.graph).toHaveProperty("removed");
    expect(report.licenses.missing).toHaveProperty("clearedByGraphRemoval");
    expect(report.identity.package).toBe(LEGACY_PACKAGE);
  });
});
