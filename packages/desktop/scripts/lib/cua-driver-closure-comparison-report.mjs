import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLOSURE_ROOT,
  ClosureVerificationError,
  isRecord,
  readJsonFile,
  writeJsonFile,
} from "./cua-driver-closure-core.mjs";
import {
  readClosureReportFile,
  validateClosureReport,
  validateComparisonPolicy,
} from "./cua-driver-closure-comparison-core.mjs";
import {
  compareGraphs,
  compareLicenseEvidence,
  evaluateDependencyPolicy,
} from "./cua-driver-closure-comparison-graph.mjs";
import { validateSupplementSubset } from "./cua-driver-closure-comparison-supplements.mjs";
import { prepareClosureOutputDirectory } from "./cua-driver-closure-comparison-output.mjs";
import { buildRootTransitionComparison } from "./cua-driver-closure-comparison-transition.mjs";

export const COMPARISON_REPORT_KIND = "zody-cua-driver-closure-comparison";

function policySupplementPath(policy) {
  return policy.baseline.supplements
    ? join(CLOSURE_ROOT, policy.baseline.supplements.manifestPath)
    : null;
}

async function compareSupplements({ policy, baseline, candidate, candidateSupplementsPath }) {
  const reported = candidate.report.licenses.supplements;
  const candidatePath =
    candidateSupplementsPath ?? (isRecord(reported) ? reported.manifestPath : null);
  if (!candidatePath) return { status: "not-requested" };
  if (!isRecord(reported)) {
    throw new ClosureVerificationError(
      "candidate supplement manifest is not recorded by the original audit",
    );
  }
  const baselinePath = policySupplementPath(policy);
  if (!baselinePath)
    throw new ClosureVerificationError("comparison policy has no baseline supplement manifest");
  const result = await validateSupplementSubset({
    baselineManifestPath: baselinePath,
    candidateManifestPath: candidatePath,
    baselineManifestSha256: policy.baseline.supplements.manifestSha256,
    baselineEntryCount: policy.baseline.supplements.entryCount,
    baselineGraph: baseline.graph,
    candidateGraph: candidate.graph,
    baselineSourceFiles: baseline.source.files,
    candidateSourceFiles: candidate.source.files,
    candidateRevision: policy.candidate.revision,
  });
  if (reported.manifestSha256 !== result.candidate.manifestSha256) {
    throw new ClosureVerificationError(
      "candidate report supplement manifest hash does not match the file",
    );
  }
  if (reported.sourceRevision !== result.candidate.sourceRevision) {
    throw new ClosureVerificationError(
      "candidate report supplement revision does not match the manifest",
    );
  }
  if (reported.entryCount !== result.candidate.entryCount) {
    throw new ClosureVerificationError(
      "candidate report supplement entry count does not match the manifest",
    );
  }
  return result;
}

function lockDelta(baseline, candidate) {
  return {
    baseline: {
      entryCount: baseline.lock.entryCount,
      checksumEntries: baseline.lock.checksumEntries,
    },
    candidate: {
      entryCount: candidate.lock.entryCount,
      checksumEntries: candidate.lock.checksumEntries,
    },
    delta: {
      entryCount: candidate.lock.entryCount - baseline.lock.entryCount,
      checksumEntries: candidate.lock.checksumEntries - baseline.lock.checksumEntries,
    },
    note: "lock entries are counts only in the reports; verify both Cargo.lock files directly for identity and checksum stability",
  };
}

function licenseBlockedItems(licenses) {
  const items = [];
  for (const key of ["missing", "partial", "reviewRequired", "mpl"]) {
    if (licenses.residualGaps[key].length > 0) {
      items.push({
        gate: `licenses.${key}`,
        status: "blocked",
        reason: `${licenses.residualGaps[key].length} residual ${key} gaps in the candidate graph`,
      });
    }
  }
  return items;
}

function renderComparisonReadme(report) {
  const graph = report.graph;
  const licenses = report.licenses;
  return [
    "# Driver 闭包比较结果",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    `- 固定来源：\`${report.identity.revision}\` (\`${report.identity.sourceRoot}\`)，target \`${report.identity.target}\`，package \`${report.identity.package}\`。`,
    `- 实际 graph：${graph.baselinePackageCount} -> ${graph.candidatePackageCount}（差额 ${graph.delta}）；移除 ${graph.removed.length}，新增 ${graph.added.length}，版本替换 ${graph.versionChanged.length}，版本集合变更 ${graph.versionSetChanged.length}，feature 变更 ${graph.featureChanged.length}，来源变更 ${graph.sourceChanged.length}。`,
    `- lock 计数：${report.lock.baseline.entryCount} -> ${report.lock.candidate.entryCount}（checksum ${report.lock.baseline.checksumEntries} -> ${report.lock.candidate.checksumEntries}）；逐项身份/checksum 需直接比较两个 Cargo.lock。`,
    `- 排除包：actual graph 中未出现 rquickjs/rquickjs-core/rquickjs-sys/regorus/uniffi/uniffi_*。`,
    `- core feature：${JSON.stringify(report.features.core.actual)}；platform feature：${JSON.stringify(report.features.platform.actual)}。`,
    `- 许可残留：missing ${licenses.residualGaps.missing.length}，partial ${licenses.residualGaps.partial.length}，reviewRequired ${licenses.residualGaps.reviewRequired.length}，MPL ${licenses.residualGaps.mpl.length}。版本替换 ${licenses.missing.versionReplacement.length} 项不按已解决处理；材料变化不构成法律审查完成。`,
    `- 补充许可：${report.supplements.status}${report.supplements.retained ? `（保留 ${report.supplements.retained.length}，图外剔除 ${report.supplements.droppedOutsideGraph.length}）` : ""}。`,
    "",
    `产品采用：${report.productAdoption}。${report.productAdoptionReason}`,
    "",
    "本工具只比较显式报告与 policy，不执行编译、系统输入、证书或 TCC 操作，也不修改候选或旧报告。",
  ].join("\n");
}

function renderTransitionReadme(report) {
  const graph = report.graph;
  const licenses = report.licenses;
  const transition = report.rootTransition;
  const removed = graph.inventoryDelta.removedFromCandidateGraph;
  const legacyGaps = [
    ...licenses.inventoryDelta.missing.removedFromCandidateGraph,
    ...licenses.inventoryDelta.partial.removedFromCandidateGraph,
    ...licenses.inventoryDelta.reviewRequired.removedFromCandidateGraph,
    ...licenses.inventoryDelta.mpl.removedFromCandidateGraph,
  ];
  return [
    "# Driver 显式根迁移比较结果",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    `- 根迁移：\`${transition.from.package}\` -> \`${transition.to.package}\`；revision \`${transition.to.revision}\`，sourceRoot \`${transition.to.sourceRoot}\`，target \`${transition.to.target}\`。functionalEquivalent=false；interface/ABI/tool equivalence not-established；legacyRootUncompiled=true。`,
    `- source retention：${report.sourceRetention.status}；baseline ${report.sourceRetention.baselineFileCount} -> candidate ${report.sourceRetention.candidateFileCount}，所有 baseline 路径仍存在，除 ${report.sourceRetention.exemptPaths.join("/")} 外字节不变，新增仅限 \`${report.sourceRetention.allowedAdditionRoot}\`。旧 SDK/core/platform 源码仍留存，但不在新构建图。`,
    `- 实际 graph：${graph.baselinePackageCount} -> ${graph.candidatePackageCount}（差额 ${graph.delta}）；removedFromCandidateGraph=${removed.length}，addedToCandidateGraph=${graph.inventoryDelta.addedToCandidateGraph.length}。差额来自 root 功能收窄，不是功能等价替换。`,
    `- 许可：旧 R7 许可缺口仍然存在（baseline entries ${licenses.legacyGapEntries}）。inventoryDelta 中 removedFromCandidateGraph=${legacyGaps.length} 仅表示这些精确身份不在新图，不是许可补齐或已解决；candidate residual missing ${licenses.residualGaps.missing.length}、partial ${licenses.residualGaps.partial.length}、reviewRequired ${licenses.residualGaps.reviewRequired.length}、MPL ${licenses.residualGaps.mpl.length}。`,
    `- feature 约束：${report.features.baselineOnly.map((entry) => entry.package).join("/")} 仅在 R7 baseline 图适用；新图 required=${JSON.stringify(report.features.candidate.required)}，旧安全 feature 只留在旧源码，未伪造同名 feature 通过检查。`,
    `- 排除包：candidate graph 未出现 ${report.excluded.packages.join("/")} 或 ${report.excluded.prefixes.join("/")}*。`,
    `- lock 计数：${report.lock.baseline.entryCount} -> ${report.lock.candidate.entryCount}（checksum ${report.lock.baseline.checksumEntries} -> ${report.lock.candidate.checksumEntries}）；逐项身份/checksum 需直接比较两个 Cargo.lock。`,
    `- 补充许可：${report.supplements.status}。新视觉根自带 LICENSE-MIT，不新增 supplement mapping。`,
    "",
    `产品采用：${report.productAdoption}。${report.productAdoptionReason}`,
    "",
    "本工具只比较显式报告与 policy，不执行编译、系统输入、证书或 TCC 操作，也不修改候选或旧报告。",
  ].join("\n");
}

export async function runDriverClosureComparison({
  baselineReportPath,
  candidateReportPath,
  policyPath,
  outputDir,
  candidateSupplementsPath = null,
}) {
  const policy = validateComparisonPolicy(await readJsonFile(policyPath));
  const baselineFile = await readClosureReportFile(baselineReportPath);
  if (baselineFile.sha256 !== policy.baseline.sha256) {
    throw new ClosureVerificationError(
      `baseline report sha256 mismatch: ${baselineFile.sha256} != ${policy.baseline.sha256}`,
    );
  }
  const candidateFile = await readClosureReportFile(candidateReportPath);
  const baseline = validateClosureReport(baselineFile.report, { policy, role: "baseline" });
  const candidate = validateClosureReport(candidateFile.report, { policy, role: "candidate" });
  const transition =
    policy.schemaVersion === 2
      ? buildRootTransitionComparison({ policy, baseline, candidate })
      : null;
  const graph = transition?.graph ?? compareGraphs(baseline.packages, candidate.packages);
  const features = transition?.features ?? evaluateDependencyPolicy(candidate.packages, policy);
  const licenses = transition?.licenses ?? compareLicenseEvidence(baseline, candidate);
  const supplements = await compareSupplements({
    policy,
    baseline,
    candidate,
    candidateSupplementsPath,
  });
  const productAdoptionReason = transition
    ? "root transition candidate only; interface, ABI and tool equivalence remain not-established, legacy root remains uncompiled, and native, signing, TCC, runtime and legal review remain separate gates"
    : "dependency trimming candidate only; native, signing, TCC, runtime and legal review remain separate gates";
  const report = {
    schemaVersion: policy.schemaVersion,
    kind: COMPARISON_REPORT_KIND,
    generatedAt: new Date().toISOString(),
    policy: {
      path: policyPath,
      baselineReportPath: policy.baseline.reportPath,
      baselineSha256: policy.baseline.sha256,
      ...(transition ? { schemaVersion: policy.schemaVersion } : {}),
    },
    inputs: {
      baseline: {
        path: baselineReportPath,
        sha256: baselineFile.sha256,
        sourceFingerprint: baseline.source.fingerprint,
        sourceFileCount: baseline.source.files.length,
      },
      candidate: {
        path: candidateReportPath,
        sha256: candidateFile.sha256,
        sourceFingerprint: candidate.source.fingerprint,
        sourceFileCount: candidate.source.files.length,
      },
    },
    identity: {
      revision: policy.candidate.revision,
      sourceRoot: policy.candidate.sourceRoot,
      target: policy.candidate.target,
      package: policy.candidate.package,
    },
    gates: {
      baseline: "pass",
      candidate: "pass",
      dependencyPolicy: "pass",
      ...(transition ? { rootTransition: "declared-non-equivalent" } : {}),
      supplements: supplements.status,
      verificationFailed: false,
      exitCode: 0,
    },
    graph,
    lock: lockDelta(baseline, candidate),
    excluded: {
      packages: policy.excludedPackages,
      prefixes: policy.excludedPackagePrefixes,
      baselinePresent: baseline.packages
        .map((entry) => entry.name)
        .filter(
          (name) =>
            policy.excludedPackages.includes(name) ||
            policy.excludedPackagePrefixes.some((prefix) => name.startsWith(prefix)),
        )
        .sort(),
      candidatePresent: features.excludedPresent,
    },
    features: transition ? features : features.features,
    licenses,
    ...(transition ? { rootTransition: transition.rootTransition } : {}),
    ...(transition ? { sourceRetention: transition.sourceRetention } : {}),
    supplements,
    productAdoption: "blocked",
    productAdoptionReason,
    blockedItems: [
      { gate: "productAdoption", status: "blocked", reason: productAdoptionReason },
      ...(transition
        ? [
            {
              gate: "rootTransition",
              status: "blocked",
              reason:
                "functional, interface, ABI and tool equivalence are not established; legacy root remains uncompiled",
            },
          ]
        : []),
      ...licenseBlockedItems(licenses),
      {
        gate: "lockIdentity",
        status: "not-evaluated",
        reason: "compare both Cargo.lock files directly",
      },
    ],
    limitations: transition
      ? [
          "comparison reads only the supplied reports and policy",
          "the smaller visual graph is a declared root transition, not functional, interface, ABI or tool equivalence",
          "legacy SDK source remains in the shared source root but is not a candidate build root and remains uncompiled",
          "removedFromCandidateGraph means absent from the new graph; it does not resolve old license gaps",
          "license evidence is not a legal conclusion and does not complete review",
          "no build, system input, signing, TCC or product adoption evidence is produced",
        ]
      : [
          "comparison reads only the supplied reports and policy",
          "license evidence is not a legal conclusion and does not complete review",
          "version replacement and graph removal do not by themselves resolve license obligations",
          "lock package identities and checksums are not available in the reports and are not inferred",
          "no build, system input, signing, TCC or product adoption evidence is produced",
        ],
  };
  await prepareClosureOutputDirectory(outputDir);
  const reportPath = join(outputDir, "comparison.json");
  await writeJsonFile(reportPath, report);
  const readme = transition ? renderTransitionReadme(report) : renderComparisonReadme(report);
  await writeFile(join(outputDir, "COMPARISON.md"), `${readme}\n`, "utf8");
  return { report, reportPath, exitCode: report.gates.exitCode };
}
