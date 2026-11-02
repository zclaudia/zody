import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  CLOSURE_ROOT,
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_SOURCE_MANIFEST,
  REPORT_KIND,
  readJsonFile,
  sha256File,
  validateReviewConfig,
  validateSourceManifest,
  writeBufferFile,
  writeJsonFile,
} from "./cua-driver-closure-core.mjs";
import {
  auditSourceFiles,
  createGitBlobReader,
  loadBaselineBlobs,
} from "./cua-driver-closure-source.mjs";
import {
  assertReconstructedTree,
  createSourcePatch,
  reconstructCandidateFromPatch,
} from "./cua-driver-closure-patch.mjs";
import {
  auditLockedCargoGraph,
  deriveClosureGates,
  readTomlJson,
  toolchainDeltaFromProbe,
} from "./cua-driver-closure-dependencies.mjs";
import { archiveLicenseMaterials, auditLicenseClosure } from "./cua-driver-closure-licenses.mjs";
import {
  copyTreeSafe,
  gitClosureEnvironment,
  runClosureCommand,
} from "./cua-driver-closure-command.mjs";
import { prepareReconstructedCache, snapshotTree } from "./cua-driver-closure-cache-rebuild.mjs";
import {
  probeDriverToolchain,
  readToolchainConfig,
  toolchainAssessment,
} from "./cua-driver-closure-toolchain.mjs";
import { preserveBuildArtifacts } from "./cua-driver-closure-prepare.mjs";
import {
  blockedItems,
  buildRerun,
  failedDependencies,
  gateError,
  licensePackageRoots,
  normalizeGraph,
  readUpstreamLicense,
  renderAuditReadme,
} from "./cua-driver-closure-report-support.mjs";
import { prepareClosureOutputDirectory } from "./cua-driver-closure-comparison-output.mjs";

export const DEFAULT_TOOLCHAIN_CONFIG = join(CLOSURE_ROOT, "round6", "toolchain.json");

export async function runDriverClosureAudit({
  sourceRepo,
  candidateRoot,
  cargoHome,
  outputDir,
  reviewConfigPath = DEFAULT_REVIEW_CONFIG,
  sourceManifestPath = DEFAULT_SOURCE_MANIFEST,
  rebuildCache = false,
  toolchainRoot = null,
  toolchainConfigPath = DEFAULT_TOOLCHAIN_CONFIG,
  licenseSupplements = null,
  buildMode = null,
}) {
  if (buildMode && !toolchainRoot) {
    throw new ClosureVerificationError("build evidence requires an explicit --toolchain-root");
  }
  if (buildMode && !rebuildCache) {
    throw new ClosureVerificationError("build evidence requires --rebuild-cache");
  }
  const configRaw = await readJsonFile(reviewConfigPath);
  const config = validateReviewConfig(configRaw);
  const manifestRaw = await readJsonFile(sourceManifestPath);
  const manifest = validateSourceManifest(manifestRaw, config);
  const configSha256 = await sha256File(reviewConfigPath);
  const manifestSha256 = await sha256File(sourceManifestPath);
  await prepareClosureOutputDirectory(outputDir, { allowEmptyExisting: true });
  const tempRoot = await mkdtemp(join(tmpdir(), "zody-cua-driver-closure-audit-"));
  const options = {
    sourceRepo,
    candidateRoot,
    cargoHome,
    outputDir,
    rebuildCache,
    toolchainRoot,
    licenseSupplements,
    buildMode,
  };
  try {
    const revisionResult = await runClosureCommand(
      "git",
      ["-C", sourceRepo, "rev-parse", "--verify", `${config.revision}^{commit}`],
      { env: gitClosureEnvironment(), timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 },
    );
    if (revisionResult.stdout.trim() !== config.revision) {
      throw new ClosureVerificationError("fixed upstream revision does not resolve to itself");
    }
    const blobCache = new Map();
    const baseReader = createGitBlobReader({
      sourceRepo,
      revision: config.revision,
      sourceRoot: config.sourceRoot,
      runCommand: runClosureCommand,
    });
    const readBlob = async (path) => {
      if (!blobCache.has(path)) blobCache.set(path, await baseReader(path));
      return blobCache.get(path);
    };
    const source = await auditSourceFiles({ config, manifest, candidateRoot, readBlob });
    const baselineBlobs = await loadBaselineBlobs({ manifest, readBlob });
    const baselineRoot = join(tempRoot, "baseline");
    for (const [path, blob] of baselineBlobs) {
      await writeBufferFile(join(baselineRoot, path), blob);
    }
    const candidateCopy = join(tempRoot, "candidate");
    await copyTreeSafe(candidateRoot, candidateCopy);
    const patchPath = join(outputDir, "candidate-source.patch");
    const patchInfo = await createSourcePatch({
      baselineRoot,
      candidateRoot: candidateCopy,
      patchPath,
      workRoot: tempRoot,
    });
    const reconstructed = await reconstructCandidateFromPatch({
      baselineRoot,
      patchPath,
      outputRoot: join(tempRoot, "reconstructed"),
      workRoot: tempRoot,
    });
    await assertReconstructedTree({
      reconstructed,
      expectedEntries: new Map(manifest.files.map((entry) => [entry.path, entry])),
    });

    const candidateLock = await readTomlJson(join(candidateRoot, "Cargo.lock"));
    let cache = null;
    let cacheHome = cargoHome;
    if (rebuildCache) {
      cache = await prepareReconstructedCache({
        cargoHome,
        lockPackages: candidateLock.package,
        stagingRoot: join(tempRoot, "cache-rebuild"),
        candidateRoot,
      });
      cacheHome = cache.cargoHome;
    }

    let toolchainProbe = null;
    let toolchainConfig = null;
    let toolchainFailure = null;
    if (toolchainRoot) {
      try {
        toolchainConfig = await readToolchainConfig(toolchainConfigPath);
        toolchainProbe = await probeDriverToolchain({ toolchainRoot, config: toolchainConfig });
      } catch (error) {
        toolchainFailure = error;
      }
    }

    let dependencies;
    try {
      if (cache && cache.status !== "pass") {
        throw new ClosureBlockedError(
          "cache-rebuild-blocked",
          "reconstructed cache did not pass verification",
        );
      }
      if (toolchainRoot && !toolchainProbe) throw toolchainFailure;
      dependencies = await auditLockedCargoGraph({
        candidateRoot,
        cargoHome: cacheHome,
        externalMembers: config.workspaceExternalMembers,
        packageName: config.package,
        target: config.target,
        tempRoot,
        toolchain: toolchainProbe,
        lockPackages: cache ? candidateLock.package : null,
        reconstructedKeys: cache?.reconstructedKeys ?? null,
        build: buildMode
          ? {
              mode: buildMode === "build-library" ? "build" : "check",
              logPath: join(outputDir, "build.log"),
            }
          : null,
      });
    } catch (error) {
      dependencies = failedDependencies(error);
    }

    let toolchain;
    if (toolchainRoot) {
      toolchain = toolchainFailure
        ? {
            upstreamDeclared: config.toolchain.upstreamDeclared,
            auditedVersion: "unavailable",
            auditedCommit: null,
            exactMatch: false,
            status: "blocked",
            reason: toolchainFailure.message,
            noStableFallback: true,
          }
        : toolchainAssessment({
            upstreamDeclared: config.toolchain.upstreamDeclared,
            probe: toolchainProbe,
            config: toolchainConfig,
          });
    } else {
      toolchain = dependencies.toolchain
        ? toolchainDeltaFromProbe({
            upstreamDeclared: config.toolchain.upstreamDeclared,
            toolchain: dependencies.toolchain,
          })
        : {
            upstreamDeclared: config.toolchain.upstreamDeclared,
            auditedVersion: "unavailable",
            auditedCommit: null,
            exactMatch: false,
            status: "blocked",
            reason: dependencies.error?.message ?? "toolchain evidence unavailable",
          };
    }

    let build = dependencies.build ?? null;
    if (build?.status === "pass") {
      const preserved = await preserveBuildArtifacts({ build, outputDir });
      build = { ...build, targetRoot: undefined, preservedArtifacts: preserved.files };
    } else if (build?.targetRoot) {
      build = { ...build, targetRoot: undefined };
    }

    let cacheInput = null;
    if (cache) {
      const finalInput = await snapshotTree(cargoHome);
      cacheInput = {
        beforeSha256: cache.originalCache.inputBefore.treeSha256,
        afterSha256: finalInput.treeSha256,
        stable: finalInput.treeSha256 === cache.originalCache.inputBefore.treeSha256,
        fileCount: finalInput.fileCount,
      };
      if (!cacheInput.stable) {
        dependencies = failedDependencies(
          new ClosureVerificationError("original cache changed during the audit"),
        );
      }
    }

    let licenses;
    if (dependencies.graph && dependencies.workspace) {
      try {
        const upstreamRecord = await readUpstreamLicense({
          sourceRepo,
          revision: config.revision,
          path: config.upstreamLicensePath,
        });
        const upstreamArchivePath = join(
          outputDir,
          "licenses",
          "upstream",
          config.upstreamLicensePath,
        );
        await writeBufferFile(upstreamArchivePath, upstreamRecord.buffer);
        const { buffer: _buffer, ...upstreamLicense } = upstreamRecord;
        upstreamLicense.archivePath = relative(outputDir, upstreamArchivePath);
        const packageRoots = await licensePackageRoots(dependencies);
        licenses = await auditLicenseClosure({
          packageRoots,
          upstreamLicense,
          workRoot: tempRoot,
          supplementsManifestPath: licenseSupplements,
          lockPackages: dependencies.lock.packages ?? candidateLock.package,
          sourceRevision: config.revision,
        });
        licenses = {
          ...licenses,
          archive: await archiveLicenseMaterials({ summary: licenses, packageRoots, outputDir }),
          supplementsManifestPath: licenseSupplements,
        };
      } catch (error) {
        licenses = {
          ...gateError(error),
          packageCount: 0,
          entries: [],
          missingMaterials: [],
          reviewRequired: [],
          mplPackages: [],
          gateMeaning: "license-expression-and-material-inventory-only",
          legalConclusion: "not-made",
          productAdoption: "blocked",
        };
      }
    } else {
      licenses = {
        status: "blocked",
        packageCount: 0,
        entries: [],
        missingMaterials: [],
        reviewRequired: [],
        mplPackages: [],
        gateMeaning: "license-expression-and-material-inventory-only",
        legalConclusion: "not-made",
        productAdoption: "blocked",
        error: { message: "license audit unavailable without a resolved graph" },
      };
    }

    const gates = deriveClosureGates({ source, dependencies, licenses, toolchain, build });
    const { packages: _lockPackages, ...lockSummary } = dependencies.lock;
    const report = {
      schemaVersion: 1,
      kind: REPORT_KIND,
      generatedAt: new Date().toISOString(),
      sourceAuditOnlyExit: true,
      review: { configSha256, manifestSha256, config: configRaw },
      revision: config.revision,
      sourceRoot: config.sourceRoot,
      source: { ...source, candidateRoot: undefined },
      patch: {
        path: relative(outputDir, patchPath),
        sha256: patchInfo.sha256,
        bytes: patchInfo.bytes,
        reconstruction: "pass",
      },
      cacheInput,
      originalCache: cache?.originalCache ?? null,
      reconstructedCache: cache?.reconstructedCache ?? null,
      unlockedArchives: cache?.unlockedArchives ?? [],
      targetGraph: dependencies.targetGraph ?? null,
      build,
      dependencies: {
        status: dependencies.status,
        error: dependencies.error ?? null,
        toolchain: dependencies.toolchain ?? null,
        lock: lockSummary,
        graph: dependencies.graph
          ? await normalizeGraph(dependencies.graph, dependencies.workspace.sourceCopy)
          : null,
        registry: dependencies.registry,
        workspace: dependencies.workspace
          ? { cargoConfigIsolation: true, externalMembers: dependencies.workspace.externalMembers }
          : null,
        metadata: dependencies.metadata
          ? { workspaceMemberCount: dependencies.metadata.workspaceMembers.length }
          : null,
      },
      licenses,
      licenseSupplementsPath: licenseSupplements,
      toolchain,
      gates,
      blockedItems: blockedItems({ cache, dependencies, licenses, toolchain, build, gates }),
      limitations: [
        "source audit does not execute the upstream application or its tests",
        "optional build evidence compiles locked offline in private staging but is not an OS sandbox",
        "original cache drift is recorded, never rewritten as a pass",
        "reconstructed cache and the actual macOS target graph are the only dependency pass inputs",
        "license summary is evidence only; no legal or policy decision is made",
        "MPL-2.0 obligations require separate review and are not treated as an MIT failure",
        "optional build evidence does not authorize product adoption",
        "product adoption remains blocked regardless of this report",
      ],
    };
    await writeJsonFile(join(outputDir, "report.json"), report);
    const rerun = [
      "## 复跑",
      "",
      "```sh",
      buildRerun(options),
      "```",
      "",
      "`exit 0` 只确认来源审计完成且无验证失败；依赖、许可、工具链、编译和产品采用门禁可能仍为 blocked。原始 cache 漂移、目标图归档缺失和工具链漂移均 fail-closed。",
    ].join("\n");
    await writeFile(
      join(outputDir, "AUDIT.md"),
      `${renderAuditReadme(report)}\n\n${rerun}\n`,
      "utf8",
    );
    return { report, reportPath: join(outputDir, "report.json"), exitCode: gates.exitCode };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
