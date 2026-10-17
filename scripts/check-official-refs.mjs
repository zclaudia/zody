#!/usr/bin/env node

// F0.1 官方引用残留检查（specs/fork-official-deps-removal-tasks.md「F0.1」小节，
// 规则见 specs/fork-official-deps-removal-plan.md 阶段 0.1）。
// 结构参照 scripts/audit-zcode-agent-remnants.mjs：文本扩展名过滤、根目录列表、相对路径输出。
//
// 规则：
// - 域名类（拦截）：扫描 packages/ apps/ scripts/ config/ public/，与基线
//   scripts/official-refs-baseline.json 比较，新增文件或命中数增加即失败；
// - 标识类（只统计）：zhipu、@zai-ai、zai-sdk、zai-org、z-ai 等，不参与拦截；
// - 允许的 BYOK 端点（api.z.ai / open.bigmodel.cn 的公开 API 地址）不计入；
// - docs/ 与 apps/dev-docs 单列统计，不参与拦截（文档在阶段 7 处理）；
// - 排除二进制（按扩展名过滤）与 dist/ 等构建产物目录。
//
// 用法：
//   node scripts/check-official-refs.mjs                    # 检查模式（对照基线）
//   node scripts/check-official-refs.mjs --update-baseline  # 重新生成基线
//   node scripts/check-official-refs.mjs --json             # 机器可读输出

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  allowedByokEndpointPattern,
  officialDomainPatterns,
  officialIdentifierPatterns,
} from "./lib/official-domains.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const baselinePath = resolve(repoRoot, "scripts/official-refs-baseline.json");

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

// 构建产物与夹具目录，整体跳过。注意不含 `locales`：
// packages/ui/src/i18n/locales 与 apps/zcode-cli/packages/i18n/src/locales 是
// i18n 源码（含官方下载链接等文案，属阶段 3/7 的收紧范围），必须纳入统计。
const alwaysIgnoredSegments = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vite",
  ".e2e-cache",
  ".e2e-home",
  "bundled-agents",
  "bundled-resources",
  "mock-cdn",
  "assets",
  "material-icons",
]);

/** 拦截范围：与基线比较，新增文件或命中数增加即失败。 */
const enforcedRoots = ["packages", "apps", "scripts", "config", "public"];
/** 单列统计：不参与拦截（文档在阶段 7 处理）。 */
const reportOnlyRoots = ["docs", "apps/dev-docs"];

// 检查器自身、其测试与词表模块必然包含官方引用字面量，纳入统计会让基线
// 自指（无法收敛也无法判定新增）；基线文件只含路径与数字，一并排除。
const selfExcludedPaths = new Set([
  "scripts/check-official-refs.mjs",
  "scripts/check-official-refs.test.mjs",
  "scripts/lib/official-domains.mjs",
  "scripts/official-refs-baseline.json",
]);

function parseArgs(argv) {
  const options = {
    updateBaseline: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--update-baseline") {
      options.updateBaseline = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-official-refs.mjs [options]

Options:
  --update-baseline    Rewrite scripts/official-refs-baseline.json from the current scan
  --json               Print machine-readable JSON
  --help, -h           Show this help
`);
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function classifyPath(relativePath) {
  if (relativePath === "apps/dev-docs" || relativePath.startsWith("apps/dev-docs/")) {
    return "apps/dev-docs";
  }
  if (relativePath === "docs" || relativePath.startsWith("docs/")) {
    return "docs";
  }
  return "enforced";
}

function isTextFile(relativePath) {
  const extensionMatch = /\.[^.]+$/u.exec(relativePath);
  return extensionMatch ? textExtensions.has(extensionMatch[0]) : false;
}

function* walk(root) {
  if (!existsSync(root)) {
    return;
  }
  const stat = statSync(root);
  const relativePath = toPosixPath(relative(repoRoot, root));
  if (
    relativePath &&
    (selfExcludedPaths.has(relativePath) ||
      alwaysIgnoredSegments.has(relativePath.split("/").at(-1)))
  ) {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      yield* walk(resolve(root, entry.name));
    }
    return;
  }
  if (stat.isFile() && isTextFile(relativePath)) {
    yield { absolutePath: root, relativePath };
  }
}

/** 扫描单行：先剔除允许的 BYOK 端点 URL 再统计域名，保证放行只作用于 URL 本身。 */
export function scanLine(line) {
  const remaining = line.replace(allowedByokEndpointPattern, "");
  const domainKeywords = [];
  for (const { keyword, regex } of officialDomainPatterns) {
    for (const match of remaining.match(regex) ?? []) {
      domainKeywords.push({ keyword, match });
    }
  }
  const identifierKeywords = [];
  for (const { keyword, regex } of officialIdentifierPatterns) {
    for (const match of line.match(regex) ?? []) {
      identifierKeywords.push({ keyword, match });
    }
  }
  return { domainKeywords, identifierKeywords };
}

export function scanText(content) {
  const domainLines = [];
  const identifierTotals = new Map();
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const { domainKeywords, identifierKeywords } = scanLine(line);
    if (domainKeywords.length > 0) {
      domainLines.push({
        line: index + 1,
        keywords: domainKeywords.map(({ keyword }) => keyword),
        preview: line.trim().slice(0, 180),
      });
    }
    for (const { keyword } of identifierKeywords) {
      identifierTotals.set(keyword, (identifierTotals.get(keyword) ?? 0) + 1);
    }
  }
  return {
    domainHits: domainLines.reduce((sum, entry) => sum + entry.keywords.length, 0),
    domainLines,
    identifierHits: [...identifierTotals.values()].reduce((sum, count) => sum + count, 0),
    identifierTotals: Object.fromEntries([...identifierTotals.entries()].sort()),
  };
}

/** 单列统计用的汇总（只留计数，不留行明细，避免报告膨胀）。 */
function summarizeFiles(files) {
  const summary = {
    domainFiles: 0,
    domainHits: 0,
    identifierHits: 0,
    identifierTotals: {},
  };
  for (const file of files) {
    if (file.domainHits > 0) {
      summary.domainFiles += 1;
      summary.domainHits += file.domainHits;
    }
    summary.identifierHits += file.identifierHits;
    for (const [keyword, count] of Object.entries(file.identifierTotals)) {
      summary.identifierTotals[keyword] = (summary.identifierTotals[keyword] ?? 0) + count;
    }
  }
  return summary;
}

function buildReport() {
  const scopeFiles = new Map(enforcedRoots.concat(reportOnlyRoots).map((root) => [root, []]));
  for (const root of enforcedRoots.concat(reportOnlyRoots)) {
    for (const file of walk(resolve(repoRoot, root))) {
      // 拦截范围内的文件按其所在扫描根分桶；apps/dev-docs 命中单列根时改投单列桶。
      const scope = classifyPath(file.relativePath);
      const bucket = scope === "enforced" ? root : scope;
      const result = scanText(readFileSync(file.absolutePath, "utf8"));
      if (result.domainHits === 0 && result.identifierHits === 0) {
        continue;
      }
      scopeFiles.get(bucket).push({
        path: file.relativePath,
        domainHits: result.domainHits,
        domainLines: result.domainLines.slice(0, 10),
        identifierHits: result.identifierHits,
        identifierTotals: result.identifierTotals,
      });
    }
  }

  const enforcedFiles = enforcedRoots
    .flatMap((root) => scopeFiles.get(root))
    .sort((left, right) => left.path.localeCompare(right.path));
  const report = {
    enforcedRoots,
    reportOnlyRoots,
    enforced: {
      ...summarizeFiles(enforcedFiles),
      files: enforcedFiles,
    },
    reportOnly: Object.fromEntries(
      reportOnlyRoots.map((root) => [root, summarizeFiles(scopeFiles.get(root))]),
    ),
  };
  return report;
}

/** 拦截范围内的「文件 → 域名命中数」映射（基线格式，键按字典序）。 */
export function buildBaselineCounts(report) {
  const counts = {};
  for (const file of report.enforced.files) {
    if (file.domainHits > 0) {
      counts[file.path] = file.domainHits;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * 基线比较（F0.1 验收规则）：新增文件或命中数增加即失败；
 * 命中数减少不失败，只提示收紧基线。
 */
export function compareBaseline(currentCounts, baseline) {
  const failures = [];
  const decreases = [];
  const baselinePaths = new Set(Object.keys(baseline));
  const currentPaths = new Set(Object.keys(currentCounts));
  for (const path of Object.keys(currentCounts)) {
    const count = currentCounts[path];
    if (!baselinePaths.has(path)) {
      failures.push({ type: "added", path, count });
      continue;
    }
    if (count > baseline[path]) {
      failures.push({ type: "increased", path, baseline: baseline[path], count });
    } else if (count < baseline[path]) {
      decreases.push({ path, baseline: baseline[path], count });
    }
  }
  for (const path of Object.keys(baseline)) {
    if (!currentPaths.has(path)) {
      decreases.push({ path, baseline: baseline[path], count: 0 });
    }
  }
  failures.sort((left, right) => left.path.localeCompare(right.path));
  decreases.sort((left, right) => left.path.localeCompare(right.path));
  return { failures, decreases };
}

function describeFileHits(file) {
  const firstLines = file.domainLines
    .slice(0, 3)
    .map((entry) => `${file.path}:${entry.line}(${entry.keywords.join(", ")})`)
    .join(", ");
  return firstLines;
}

function printTextReport(report) {
  console.log("Official references check");
  console.log(`enforced roots: ${report.enforcedRoots.join(", ")}`);
  console.log(`report-only roots: ${report.reportOnlyRoots.join(", ")}`);
  console.log("");
  console.log("enforced scope (ratcheted by baseline):");
  console.log(
    `  domain hits: ${report.enforced.domainHits} in ${report.enforced.domainFiles} files`,
  );
  console.log(`  identifier hits (counted only): ${report.enforced.identifierHits}`);
  for (const [keyword, count] of Object.entries(report.enforced.identifierTotals)) {
    console.log(`    ${keyword}: ${count}`);
  }
  const topFiles = report.enforced.files
    .filter((file) => file.domainHits > 0)
    .sort((left, right) => right.domainHits - left.domainHits)
    .slice(0, 30);
  if (topFiles.length > 0) {
    console.log("  top files:");
    for (const file of topFiles) {
      console.log(`    ${file.path} (${file.domainHits})`);
    }
  }
  for (const [scope, summary] of Object.entries(report.reportOnly)) {
    console.log("");
    console.log(`${scope} (report-only, not ratcheted):`);
    console.log(`  domain hits: ${summary.domainHits} in ${summary.domainFiles} files`);
    console.log(`  identifier hits (counted only): ${summary.identifierHits}`);
  }
}

function printBaselineOutcome(report) {
  const { failures, decreases } = report.baseline;
  if (failures.length > 0) {
    console.log("");
    console.error(`official-refs ratchet failed: ${failures.length} file(s) regressed`);
    for (const failure of failures) {
      if (failure.type === "added") {
        const file = report.enforced.files.find((entry) => entry.path === failure.path);
        console.error(
          `  [added] ${failure.path}: ${failure.count} hit(s); ${file ? describeFileHits(file) : ""}`,
        );
      } else {
        console.error(`  [increased] ${failure.path}: ${failure.count} > ${failure.baseline}`);
      }
    }
  }
  if (decreases.length > 0) {
    console.log("");
    console.log(
      `baseline can be tightened: ${decreases.length} file(s) decreased; run \`pnpm check:official-refs -- --update-baseline\``,
    );
    for (const decrease of decreases.slice(0, 30)) {
      console.log(`  ${decrease.path}: ${decrease.count} < ${decrease.baseline}`);
    }
  }
  if (failures.length === 0 && decreases.length === 0) {
    console.log("");
    console.log("baseline up to date: no regressions");
  }
}

function readBaseline() {
  if (!existsSync(baselinePath)) {
    return null;
  }
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function writeBaseline(report) {
  const counts = buildBaselineCounts(report);
  writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
  return counts;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport();

  if (options.updateBaseline) {
    const counts = writeBaseline(report);
    console.log(
      `baseline written: ${relative(repoRoot, baselinePath)} (${Object.keys(counts).length} files, ${Object.values(counts).reduce((sum, count) => sum + count, 0)} domain hits)`,
    );
    printTextReport(report);
    return;
  }

  const baseline = readBaseline();
  if (baseline === null) {
    console.error(
      `baseline missing: ${relative(repoRoot, baselinePath)}; run \`pnpm check:official-refs -- --update-baseline\` first`,
    );
    process.exitCode = 1;
    return;
  }
  report.baseline = compareBaseline(buildBaselineCounts(report), baseline);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
    printBaselineOutcome(report);
  }
  if (report.baseline.failures.length > 0) {
    process.exitCode = 1;
  }
}

// 入口守卫：被测试导入时只暴露纯函数，不触发扫描。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
