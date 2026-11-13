#!/usr/bin/env node

// CUA 测试输出构建树清理（specs/cua-output-retention.md）。
// 只删 output/ 下未被保护轮次里的解包 .app bundle 与 node_modules，
// 证据文件（json/log/png 等）永不删除；默认 dry-run，--apply 才执行。

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(import.meta.dirname, "..");

export const OUTPUT_DIR = join(repoRoot, "output");
export const RECEIPTS_DIR_NAME = "cleanup-receipts";
// 冻结归档还原目录：持久构建输入（specs/cua-output-retention.md 范围例外），
// 清理工具任何计划都不得把它当轮次目录或删除其内部 .app。
export const FROZEN_INPUT_DIR_NAME = "cua-narrow-frozen";
export const DEFAULT_KEEP = 1;
const BULKY_EXACT_DIR_NAMES = new Set(["node_modules"]);
const BULKY_DIR_SUFFIX = ".app";

export function isBulkyBuildTreeName(name) {
  return BULKY_EXACT_DIR_NAMES.has(name) || name.endsWith(BULKY_DIR_SUFFIX);
}

// 计划与执行前各调用一次；任何越界或白名单外的路径直接拒绝删除。
export function assertSafeRemoveTarget(targetPath, outputDir) {
  const resolvedOutput = resolve(outputDir);
  const resolvedTarget = resolve(targetPath);
  if (resolvedTarget === resolvedOutput || !resolvedTarget.startsWith(resolvedOutput + sep)) {
    throw new Error(`Refuse to remove path outside output directory: ${targetPath}`);
  }
  if (!isBulkyBuildTreeName(basename(resolvedTarget))) {
    throw new Error(`Refuse to remove path not matching bulky build tree names: ${targetPath}`);
  }
}

// 轮次目录 = output/ 直接子目录；回执目录与冻结输入目录例外。mtime 降序，同名按字典序稳定排序。
export function collectRoundDirs(outputDir) {
  const rounds = [];
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    // 符号链接目录不算轮次：不进入、不清理。
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === RECEIPTS_DIR_NAME || entry.name === FROZEN_INPUT_DIR_NAME) continue;
    const dir = join(outputDir, entry.name);
    rounds.push({ name: entry.name, dir, mtimeMs: statSync(dir).mtimeMs });
  }
  rounds.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return rounds;
}

// 深度遍历收集白名单构建树：命中即整树记录、不再下钻（嵌套命中不重复计数）。
// withFileTypes 下符号链接 entry.isDirectory() 为 false，天然跳过。
function collectBulkyTargetPaths(roundDir) {
  const targetPaths = [];
  const stack = [roundDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const childPath = join(dir, entry.name);
      if (isBulkyBuildTreeName(entry.name)) targetPaths.push(childPath);
      else stack.push(childPath);
    }
  }
  return targetPaths;
}

// 逐层 lstat 求和，不跟随符号链接。
function measureTreeBytes(rootPath) {
  let bytes = 0;
  const stack = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      let stats;
      try {
        stats = lstatSync(join(dir, entry.name));
      } catch {
        continue;
      }
      bytes += stats.size;
      if (stats.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return bytes;
}

export async function runOutputCleanup({
  outputDir,
  apply = false,
  keep = DEFAULT_KEEP,
  all = false,
  now = new Date(),
  resolveMainHead = defaultResolveMainHead,
}) {
  const rounds = collectRoundDirs(outputDir);
  // 先按轮次收集目标（跳过空树：无可回收字节，保留目录结构作为证据）。
  const targetsByRound = new Map();
  for (const round of rounds) {
    const roundTargets = [];
    for (const path of collectBulkyTargetPaths(round.dir)) {
      assertSafeRemoveTarget(path, outputDir);
      const bytes = measureTreeBytes(path);
      if (bytes > 0) roundTargets.push({ path, bytes });
    }
    targetsByRound.set(round.name, roundTargets);
  }
  // 保护槽位只由「实际含非空构建树的轮次」占用：报告/空轮次目录不占槽，
  // 否则今天的清理回执目录会把保护位从真正活跃的 CUA 轮次手上抢走。
  const protectedSet = new Set(
    all
      ? []
      : rounds
          .filter((round) => (targetsByRound.get(round.name) ?? []).length > 0)
          .slice(0, keep)
          .map((round) => round.name),
  );
  const targets = rounds.flatMap((round) =>
    protectedSet.has(round.name) ? [] : (targetsByRound.get(round.name) ?? []),
  );

  const result = {
    generatedAt: now.toISOString(),
    dryRun: !apply,
    keep,
    all,
    rounds: rounds.map((round) => ({
      name: round.name,
      mtimeMs: round.mtimeMs,
      protected: protectedSet.has(round.name),
    })),
    removals: targets.map((target) => ({ path: target.path, bytes: target.bytes })),
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    ok: true,
  };
  if (!apply) return result;

  const removed = [];
  let failedRemovals = 0;
  for (const target of targets) {
    assertSafeRemoveTarget(target.path, outputDir);
    rmSync(target.path, { force: true, recursive: true });
    const existsAfter = existsSync(target.path);
    removed.push({ path: target.path, bytes: target.bytes, existsAfter });
    if (existsAfter) failedRemovals += 1;
  }
  result.removed = removed;
  result.failedRemovals = failedRemovals;
  result.ok = failedRemovals === 0;
  if (removed.length > 0) {
    result.mainHead = await resolveMainHead();
    result.receiptPath = writeReceipt(outputDir, result);
  }
  return result;
}

function writeReceipt(outputDir, result) {
  const receiptsDir = join(outputDir, RECEIPTS_DIR_NAME);
  mkdirSync(receiptsDir, { recursive: true });
  const fileName = `cleanup-${result.generatedAt.replaceAll(/[:.]/g, "-")}.json`;
  const receiptPath = join(receiptsDir, fileName);
  writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
  return receiptPath;
}

async function defaultResolveMainHead() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function parseArgs(argv) {
  const options = { apply: false, all: false, json: false, keep: DEFAULT_KEEP };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--keep") {
      const raw = argv[i + 1];
      const keep = Number.parseInt(raw ?? "", 10);
      if (!Number.isInteger(keep) || keep < 0 || i + 1 >= argv.length) {
        throw new Error(`--keep expects a non-negative integer, got: ${raw ?? "(missing)"}`);
      }
      options.keep = keep;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/clean-output.mjs [--apply] [--keep <n>] [--all] [--json]

Prunes bulky build trees (*.app bundles, node_modules) from all but the newest
<keep> round directories under output/. Evidence files are never removed.
Defaults to a dry-run; pass --apply to delete. See specs/cua-output-retention.md.`);
}

function printTextReport(result, outputDir) {
  const removalsByRound = new Map();
  for (const removal of result.removals) {
    const roundName = relative(outputDir, removal.path).split(sep)[0];
    const list = removalsByRound.get(roundName) ?? [];
    list.push(removal);
    removalsByRound.set(roundName, list);
  }
  for (const round of result.rounds) {
    const removals = removalsByRound.get(round.name) ?? [];
    const suffix = round.protected ? " [protected]" : ` (${removals.length} build trees)`;
    console.log(`round ${round.name}${suffix}`);
    for (const removal of removals) {
      console.log(`  - ${formatBytes(removal.bytes).padStart(9)}  ${relative(outputDir, removal.path)}`);
    }
  }
  console.log(`total: ${formatBytes(result.totalBytes)} across ${result.removals.length} build trees`);
  if (result.dryRun) {
    console.log("dry-run only; pass --apply to delete");
  } else {
    console.log(`removed ${result.removed.length} build trees (${result.failedRemovals} failed)`);
    if (result.receiptPath) console.log(`receipt: ${relative(repoRoot, result.receiptPath)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!existsSync(OUTPUT_DIR)) {
    console.log(`output directory not found; nothing to clean: ${relative(repoRoot, OUTPUT_DIR)}`);
    return;
  }
  const result = await runOutputCleanup({
    outputDir: OUTPUT_DIR,
    apply: options.apply,
    keep: options.keep,
    all: options.all,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextReport(result, OUTPUT_DIR);
  }
  if (!result.ok) process.exitCode = 1;
}

// 入口守卫：被测试导入时只暴露纯函数，不触发清理。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
