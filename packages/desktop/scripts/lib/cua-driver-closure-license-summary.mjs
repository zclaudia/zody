const KNOWN_TOKENS = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "Unicode-3.0",
  "Unlicense",
  "0BSD",
  "BSL-1.0",
  "MPL-2.0",
  "LLVM-exception",
  "AND",
  "OR",
  "WITH",
]);

export function classifyLicenseExpression(expression) {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return {
      expression: expression ?? null,
      policy: "unknown-review-required",
      requiresReview: true,
      reason: "missing license expression",
      tokens: [],
    };
  }
  const tokens = expression
    .replaceAll("/", " OR ")
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const unknown = tokens.filter((token) => !KNOWN_TOKENS.has(token));
  const hasMpl = tokens.includes("MPL-2.0");
  if (unknown.length > 0) {
    return {
      expression,
      policy: "unknown-review-required",
      requiresReview: true,
      reason: `unrecognized SPDX tokens: ${unknown.join(", ")}`,
      tokens,
    };
  }
  if (hasMpl) {
    return {
      expression,
      policy: "obligations-review-required",
      requiresReview: true,
      reason: "MPL-2.0 text and obligations are recorded for review; no policy decision is made",
      tokens,
    };
  }
  return {
    expression,
    policy: "recorded",
    requiresReview: false,
    reason: "recognized license expression recorded as evidence",
    tokens,
  };
}

function expressionLicenseTokens(tokens) {
  return tokens.filter((token) => !["AND", "OR", "WITH"].includes(token));
}

function coverageFor(entry, identifiers) {
  const tokens = [...new Set(expressionLicenseTokens(entry.classification.tokens))];
  const coveredTokens = tokens.filter((token) => identifiers.includes(token));
  const uncoveredTokens = tokens.filter((token) => !identifiers.includes(token));
  const files = [...(entry.files ?? []), ...(entry.supplementalFiles ?? [])];
  const fileCount = files.length;
  // 只有实际识别出许可正文的文件才计入正文数；COPYING/版权通知等不能因为
  // 文件名或存在性被当作许可正文，否则会出现“有文件即通过”的误判。
  const contentAudited = files.some((file) => Array.isArray(file.licenseIdentifiers));
  const licenseBodyCount = files.filter(
    (file) => file.sourceKind === "supplement" || (file.licenseIdentifiers?.length ?? 0) > 0,
  ).length;
  const legacyUnknown = fileCount > 0 && !contentAudited;
  // AND/OR 表达式必须让每个许可项都有正文。缺一项就是 partial，不能因为
  // 已覆盖其中一项就显示 pass；OR 也按同样保守策略明示覆盖不足。
  const coverage =
    fileCount === 0
      ? "none"
      : legacyUnknown
        ? "legacy-unknown"
        : tokens.length === 0
          ? "unknown"
          : uncoveredTokens.length === 0
            ? "full"
            : coveredTokens.length > 0
              ? "partial"
              : "unknown";
  return {
    textPresent: fileCount > 0,
    actualFileCount: entry.files?.length ?? 0,
    supplementalFileCount: entry.supplementalFiles?.length ?? 0,
    licenseBodyFileCount: licenseBodyCount,
    contentAudited,
    legacyUnknown,
    sourceKinds: [
      ...(entry.files?.length ? ["package"] : []),
      ...(entry.supplementalFiles?.length ? ["supplement"] : []),
    ],
    licenseIdentifiers: identifiers,
    expressionTokens: tokens,
    coveredTokens,
    uncoveredTokens,
    coverage,
  };
}

export function summarizeLicenseMaterials(packages, upstreamLicense = null) {
  const entries = packages.map((entry) => {
    const classification = classifyLicenseExpression(entry.expression);
    const files = entry.files ?? [];
    const supplementalFiles = entry.supplementalFiles ?? [];
    const allFiles = [...files, ...supplementalFiles];
    const identifiers = [
      ...new Set(allFiles.flatMap((file) => file.licenseIdentifiers ?? [])),
    ].sort();
    const coverage = coverageFor({ ...entry, classification }, identifiers);
    // 没有识别到任何完整许可正文时一律记为 missingMaterials；legacy 输入
    // 会同时带 legacyUnknown 标记，由 blocked 状态兜底，不能当作真实通过。
    const missing = coverage.licenseBodyFileCount === 0;
    const reviewRequired = classification.requiresReview;
    const missingReason = missing
      ? allFiles.length > 0
        ? coverage.legacyUnknown
          ? "license files are present but their content was not audited; legacy coverage is not accepted as complete"
          : "notice or copyright material is present, but no complete license body was recognized"
        : entry.workspaceRootLicenseApplicable
          ? "package-level license text absent; upstream root LICENSE.md relationship pending verification"
          : "no license text found in package source"
      : null;
    const coverageComplete = coverage.coverage === "full";
    const result = {
      package: entry.package,
      expression: entry.expression ?? null,
      classification,
      files,
      missingMaterials: missing,
      missingReason,
      workspaceRootLicenseApplicable: entry.workspaceRootLicenseApplicable === true,
      materialCoverage: coverage,
      reviewRequired,
      incompleteCoverage: !missing && !coverageComplete,
      status: missing || reviewRequired || !coverageComplete ? "blocked" : "recorded",
    };
    if (supplementalFiles.length > 0) result.supplementalFiles = supplementalFiles;
    return result;
  });
  const missingMaterials = entries
    .filter((entry) => entry.missingMaterials)
    .map((entry) => entry.package);
  const missingMaterialDetails = entries
    .filter((entry) => entry.missingMaterials)
    .map((entry) => ({ package: entry.package, reason: entry.missingReason }));
  const reviewRequired = entries
    .filter((entry) => entry.classification.requiresReview)
    .map((entry) => entry.package);
  const mplPackages = entries
    .filter((entry) => entry.classification.tokens.includes("MPL-2.0"))
    .map((entry) => entry.package);
  const incompleteCoverage = entries
    .filter((entry) => entry.incompleteCoverage)
    .map((entry) => ({
      package: entry.package,
      expression: entry.expression,
      coverage: entry.materialCoverage.coverage,
      coveredTokens: entry.materialCoverage.coveredTokens,
      uncoveredTokens: entry.materialCoverage.uncoveredTokens,
      legacyUnknown: entry.materialCoverage.legacyUnknown,
    }));
  const blocked = entries.length === 0 || entries.some((entry) => entry.status === "blocked");
  const packageCoverage = {
    packageCount: entries.length,
    packagesWithText: entries.filter((entry) => entry.materialCoverage.textPresent).length,
    packagesWithLicenseBody: entries.filter((entry) => !entry.missingMaterials).length,
    packagesMissingText: entries.filter((entry) => entry.missingMaterials).length,
    actualFileCount: entries.reduce(
      (sum, entry) => sum + entry.materialCoverage.actualFileCount,
      0,
    ),
    supplementalFileCount: entries.reduce(
      (sum, entry) => sum + entry.materialCoverage.supplementalFileCount,
      0,
    ),
    packages: entries.map((entry) => ({
      package: entry.package,
      expression: entry.expression,
      ...entry.materialCoverage,
    })),
  };
  const summary = {
    status: blocked ? "blocked" : "pass",
    gateMeaning: "license-expression-and-material-inventory-only",
    legalConclusion: "not-made",
    productAdoption: "blocked",
    productAdoptionReason:
      "this summary records expressions, files, hashes and open materials; it is not a legal or product adoption decision",
    packageCount: entries.length,
    entries,
    missingMaterials,
    missingMaterialDetails,
    reviewRequired,
    mplPackages,
    incompleteCoverage,
    materialCoverage: packageCoverage,
    upstreamLicense,
    policyDecisionMade: false,
  };
  const supplementalTextSources = entries.flatMap((entry) =>
    (entry.supplementalFiles ?? []).map((file) => file.provenance),
  );
  if (supplementalTextSources.length > 0) summary.supplementalTextSources = supplementalTextSources;
  return summary;
}
