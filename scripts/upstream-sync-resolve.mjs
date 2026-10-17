#!/usr/bin/env node

// F4.0 upstream 同步辅助脚本（specs/fork-official-deps-removal-tasks.md「F4.0」小节，
// 配套规则见 specs/fork-official-deps-removal-plan.md 阶段 4「与 upstream 同步的配套」）。
//
// 背景：fork 删除官方账号相关文件后，upstream 对这些文件的修改在每次 merge 时
// 变成 modify/delete 冲突。本脚本在 `git merge <upstream>` 冲突现场运行：
// - 已删路径清单（scripts/official-account-removed-paths.txt，随每个删除 PR 追加）
//   内路径的 modify/delete 冲突（status DU：fork 已删、upstream 修改）自动
//   `git rm` 保持删除；
// - 输出 upstream 在这些路径上相对 merge-base 的提交列表与 diff 摘要，
//   供人工判断是否需要把修复移植到保留代码；
// - 其余冲突（清单外的，或清单内非 DU 状态的）一律不动、逐条列出，交人工处理；
// - upstream 新增的账号相关文件不经过合并冲突，由 F0.1 `pnpm check:official-refs` 拦截。
//
// 用法（在 merge 冲突现场）：
//   node scripts/upstream-sync-resolve.mjs                 # 解决清单内 DU 并打印摘要
//   node scripts/upstream-sync-resolve.mjs --dry-run       # 只报告，不执行 git rm
//   node scripts/upstream-sync-resolve.mjs --show-diff     # 摘要附带完整 patch
//   node scripts/upstream-sync-resolve.mjs --json          # 机器可读输出
// 选项：
//   --repo <dir>   目标仓库根（默认脚本所属仓库根；跨仓/测试用）
//   --list <file>  清单路径（默认 <repo>/scripts/official-account-removed-paths.txt）
//
// 本脚本不执行 git commit；人工处理完剩余冲突后自行提交合并。

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const defaultRepoRoot = resolve(import.meta.dirname, "..");
const defaultListRelativePath = "scripts/official-account-removed-paths.txt";

// `git status --porcelain=v1` 文档列出的未合并（unmerged）XY 对。
// DU = deleted by us / updated by them（fork 已删、upstream 修改），
// UD = updated by us / deleted by them，以此类推。
const unmergedStatuses = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function printHelp() {
  console.log(`Usage: node scripts/upstream-sync-resolve.mjs [options]

Resolve modify/delete merge conflicts for paths listed in
scripts/official-account-removed-paths.txt by keeping them deleted,
and summarize upstream changes on those paths.

Options:
  --repo <dir>    Target repository root (default: this repository)
  --list <file>   Removed-paths list (default: <repo>/scripts/official-account-removed-paths.txt)
  --dry-run       Report only; do not run git rm
  --show-diff     Include full upstream patch in the summary
  --json          Print machine-readable JSON
  --help, -h      Show this help
`);
}

function parseArgs(argv) {
  const options = {
    repo: undefined,
    list: undefined,
    dryRun: false,
    showDiff: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      options.repo = requireValue(argv, (i += 1), arg);
      continue;
    }
    if (arg === "--list") {
      options.list = requireValue(argv, (i += 1), arg);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--show-diff") {
      options.showDiff = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`Option ${flag} requires a value`);
  }
  return value;
}

// ---------- 纯函数（供单测直接覆盖） ----------

/**
 * 解析已删路径清单：`#` 整行注释与空行忽略；每行一条 POSIX 相对路径，
 * 支持目录前缀；重复条目去重（保留首次出现）。清单是受控文件，绝对路径、
 * 含 `.`/`..` 段等写法会立刻抛错，避免静默匹配到错误范围。
 */
export function parseRemovedPathList(text) {
  const entries = [];
  const seen = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    // 允许 Windows 风格分隔符与尾斜杠的手滑，统一成 POSIX 无尾斜杠形态。
    const normalized = line.replaceAll("\\", "/").replace(/\/+$/u, "");
    if (normalized.length === 0) {
      throw new Error(`official-account-removed-paths.txt:${index + 1}: 条目不能只有分隔符: ${line}`);
    }
    // isAbsolute 不识别 "C:/..."（POSIX 平台），补一条盘符判定。
    if (normalized.startsWith("/") || /^[A-Za-z]:[/]/u.test(normalized)) {
      throw new Error(`official-account-removed-paths.txt:${index + 1}: 条目必须是相对路径: ${line}`);
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new Error(`official-account-removed-paths.txt:${index + 1}: 条目不得包含 . 或 .. 段: ${line}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      entries.push(normalized);
    }
  }
  return entries;
}

/** 命中清单返回对应条目（目录前缀匹配整棵子树），未命中返回 null。 */
export function matchRemovedEntry(path, entries) {
  for (const entry of entries) {
    if (path === entry || path.startsWith(`${entry}/`)) {
      return entry;
    }
  }
  return null;
}

/**
 * 解析 `git status --porcelain=v1 -z`：条目以 NUL 分隔，格式为 `XY <path>`；
 * rename/copy 条目的原始路径是紧随其后的第二个 NUL 分隔字段（须跳过，
 * 否则后续条目会整体错位）。
 */
export function parseStatusPorcelainZ(output) {
  const entries = [];
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length === 0) {
      continue;
    }
    const x = field[0];
    const y = field[1];
    if (field[2] !== " ") {
      throw new Error(`无法解析 git status --porcelain 输出条目: ${JSON.stringify(field)}`);
    }
    let origPath;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      origPath = fields[i + 1];
      i += 1;
    }
    entries.push({ x, y, status: `${x}${y}`, path: field.slice(3), origPath });
  }
  return entries;
}

/**
 * 冲突分类：
 * - DU（deleted by us：fork 已删、upstream 修改）且命中清单 → 自动保持删除；
 * - 其余未合并状态交人工：清单外冲突不在本脚本授权范围；清单内非 DU 状态
 *   说明 fork 侧实际保留了该文件（清单与事实不符），自动删除有误删风险。
 */
export function classifyConflicts(statusEntries, listEntries) {
  const keptDeleted = [];
  const manual = [];
  for (const entry of statusEntries) {
    if (!unmergedStatuses.has(entry.status)) {
      continue;
    }
    const matched = matchRemovedEntry(entry.path, listEntries);
    if (entry.status === "DU" && matched !== null) {
      keptDeleted.push({ path: entry.path, entry: matched, status: entry.status });
    } else {
      manual.push({
        path: entry.path,
        status: entry.status,
        entry: matched,
        reason:
          matched !== null
            ? `清单内路径处于 ${entry.status} 冲突状态（fork 侧仍有该文件），需人工确认清单或保留文件`
            : "清单外冲突，需人工处理",
      });
    }
  }
  return { keptDeleted, manual };
}

// ---------- git 副作用 ----------

// 参照 scripts/run-lint-staged-vitest.mjs 的 createCleanGitEnv：脚本可能以
// `--repo` 指向临时/其他仓库运行，不能继承外层的 GIT_DIR/GIT_WORK_TREE/
// GIT_INDEX_FILE，否则 rev-parse、status、rm 会误命中当前 zcoder 仓库。
const gitLocalEnvNames = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];

function cleanGitEnv(env) {
  const cleaned = { ...env };
  for (const name of gitLocalEnvNames) {
    delete cleaned[name];
  }
  return cleaned;
}

function runGit(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(process.env),
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} 执行失败: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} 失败（exit ${result.status}）: ${(result.stderr ?? "").trim()}`);
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * 主流程：读取清单 → 发现冲突 → 分类 → 对清单内 DU 执行 git rm（保持删除）→
 * 生成 upstream 侧摘要。返回结构化结果，打印与退出码由调用方处理。
 * 前置校验失败（非 merge 现场、清单缺失、非 git 仓库）时返回 error 字段。
 */
export function resolveConflicts(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const listPath = resolve(options.listPath ?? join(repoRoot, defaultListRelativePath));
  const dryRun = options.dryRun ?? false;
  const showDiff = options.showDiff ?? false;

  const result = { repoRoot, listPath, dryRun };

  const inside = runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { ...result, error: { code: "not-a-repo", message: `${repoRoot} 不是 git 工作树` } };
  }

  // 只在 merge 冲突现场生效：merge 中 HEAD 是 fork 侧、MERGE_HEAD 是 upstream 侧，
  // DU 的「fork 已删」语义才成立。rebase/cherry-pick 中 us/them 语义反转，
  // 自动删除方向会错，因此直接拒绝而不是猜测。
  const mergeHead = runGit(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    allowFailure: true,
  });
  if (mergeHead.status !== 0) {
    return {
      ...result,
      error: {
        code: "not-in-merge",
        message:
          "未处于 merge 冲突现场（无 MERGE_HEAD）；请先 `git merge <upstream>` 让冲突落地后再运行本脚本",
      },
    };
  }

  if (!existsSync(listPath)) {
    return {
      ...result,
      error: { code: "list-missing", message: `清单不存在: ${listPath}；请先创建 scripts/official-account-removed-paths.txt` },
    };
  }
  const listEntries = parseRemovedPathList(readFileSync(listPath, "utf8"));

  const head = runGit(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const mergeBase = runGit(repoRoot, ["merge-base", "HEAD", "MERGE_HEAD"]).stdout.trim();

  const statusOutput = runGit(repoRoot, ["status", "--porcelain=v1", "-z"]).stdout;
  const { keptDeleted, manual } = classifyConflicts(parseStatusPorcelainZ(statusOutput), listEntries);

  const resolved = [];
  for (const conflict of keptDeleted) {
    if (!dryRun) {
      const rm = runGit(repoRoot, ["rm", "--", conflict.path], { allowFailure: true });
      if (rm.status !== 0) {
        manual.push({
          path: conflict.path,
          status: conflict.status,
          entry: conflict.entry,
          reason: `git rm 失败: ${rm.stderr.trim()}`,
        });
        continue;
      }
    }
    resolved.push(conflict);
  }

  // upstream 相对 merge-base 在这些路径上的改动摘要：提交列表回答「为什么改」，
  // diff --stat 回答「改了多少」；需要逐行审查时用 --show-diff 取完整 patch。
  const summaries = resolved.map((conflict) => {
    const diffStat = runGit(repoRoot, [
      "diff",
      "--stat",
      mergeBase,
      "MERGE_HEAD",
      "--",
      conflict.path,
    ]).stdout.trim();
    const commits = runGit(repoRoot, [
      "log",
      "--oneline",
      "--max-count=10",
      `${mergeBase}..MERGE_HEAD`,
      "--",
      conflict.path,
    ])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const diff = showDiff
      ? runGit(repoRoot, ["diff", mergeBase, "MERGE_HEAD", "--", conflict.path]).stdout
      : undefined;
    return {
      ...conflict,
      stat: diffStat.length > 0 ? diffStat : "(无文本 diff)",
      commits,
      diff,
    };
  });

  return {
    ...result,
    head,
    mergeHead: mergeHead.stdout.trim(),
    mergeBase,
    listEntries,
    keptDeleted: summaries,
    manual,
    resolved: manual.length === 0,
  };
}

// ---------- 输出 ----------

function indentBlock(text, prefix) {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function printTextReport(result) {
  console.log("upstream-sync-resolve");
  console.log(`repo: ${result.repoRoot}`);
  console.log(`list: ${result.listPath} (${result.listEntries.length} entries)`);
  console.log(
    `merge: HEAD ${short(result.head)} <- MERGE_HEAD ${short(result.mergeHead)} (merge-base ${short(result.mergeBase)})`,
  );
  console.log("");
  const action = result.dryRun ? "将保持删除（--dry-run，未执行 git rm）" : "已保持删除（git rm）";
  console.log(`${action}: ${result.keptDeleted.length} 个`);
  for (const item of result.keptDeleted) {
    console.log(`  ${item.path}`);
    console.log(`    命中清单: ${item.entry}`);
    if (item.commits.length > 0) {
      console.log("    upstream 提交:");
      for (const commit of item.commits) {
        console.log(`      ${commit}`);
      }
    }
    console.log("    upstream diff --stat:");
    console.log(indentBlock(item.stat, "      "));
    if (item.diff !== undefined) {
      console.log("    upstream diff:");
      console.log(item.diff.trimEnd().length > 0 ? indentBlock(item.diff.trimEnd(), "      ") : "      (空)");
    }
  }
  if (result.keptDeleted.length === 0) {
    console.log("  （无）");
  }
  console.log("");
  console.log(`需人工处理: ${result.manual.length} 个`);
  for (const item of result.manual) {
    console.log(`  [${item.status}] ${item.path} — ${item.reason}`);
  }
  if (result.manual.length === 0) {
    console.log("  （无；处理完成后自行 `git commit` 完成合并）");
  }
  console.log("");
  console.log(
    "提示: upstream 新增的账号相关文件不经过合并冲突，由 `pnpm check:official-refs` 拦截，升级时人工决定删除或保留。",
  );
}

function short(revision) {
  return revision.slice(0, 12);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }
  // parseArgs 的 CLI 字段名（repo/list）与 resolveConflicts 的入参字段名
  // （repoRoot/listPath）不同，须显式映射；直接透传会让 --repo/--list 被
  // 默认值静默覆盖。
  const result = resolveConflicts({
    repoRoot: options.repo,
    listPath: options.list,
    dryRun: options.dryRun,
    showDiff: options.showDiff,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.error) {
    console.error(`upstream-sync-resolve: ${result.error.message}`);
  } else {
    printTextReport(result);
  }
  process.exitCode = result.error || !result.resolved ? 1 : 0;
}

// 入口守卫：被测试导入时只暴露纯函数与 resolveConflicts，不触发扫描
//（与 scripts/check-official-refs.mjs 相同的模式）。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
