// F4.0 upstream 同步辅助脚本的定向测试（specs/fork-official-deps-removal-tasks.md「F4.0」）。
// 任务要求：用临时 git 仓库构造 modify/delete 冲突验证脚本行为——fork 删除、
// upstream 修改 → 清单内路径自动「保持删除」并输出 upstream 摘要；
// 清单外冲突、清单内非 DU 状态交人工；dry-run 不改状态；CLI 退出码与 JSON 可用。
//
// 本测试会连续 spawn 真实 git 子进程，按 vitest.config.ts 的既有口径隔离在
// fork-isolated 串行组（与 gitService.test.ts 同理，避免 threads 并发下进程
// 启动队列饥饿）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import {
  classifyConflicts,
  matchRemovedEntry,
  parseRemovedPathList,
  parseStatusPorcelainZ,
  resolveConflicts,
} from "./upstream-sync-resolve.mjs";

// ---------- 临时 git 仓库基座 ----------

const tempRoot = mkdtempSync(join(tmpdir(), "zcode-upstream-sync-resolve-"));
const tempDirs = [tempRoot];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Bugfix（与 packages/services/test/gitCheckpointService.test.ts 同因）：
// pre-push 等外层环境可能携带 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE，会让
// 临时仓库里的 git 命令「串仓」。这里一并清理 GIT_COMMON_DIR。
const gitLocalEnvVars = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];

function createDetachedGitEnv() {
  const env = { ...process.env };
  for (const name of gitLocalEnvVars) {
    delete env[name];
  }
  return env;
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: createDetachedGitEnv(),
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败（exit ${result.status}）: ${(result.stderr ?? "").trim()}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let repoSequence = 0;

function makeRepo(name) {
  // 同一场景 builder 会被多个用例调用，目录名带序号保证每次都是全新仓库，
  // 避免上一个用例遗留的 merge 现场污染下一个用例。
  const repo = join(tempRoot, `${name}-${(repoSequence += 1)}`);
  mkdirSync(repo, { recursive: true });
  git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  git(repo, ["config", "user.email", "fork-sync-test@example.com"]);
  git(repo, ["config", "user.name", "fork-sync-test"]);
  return repo;
}

function commitFile(repo, relPath, content, message) {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(repo, ["add", "--", relPath]);
  git(repo, ["commit", "-q", "-m", message]);
}

function deleteFile(repo, relPath, message) {
  git(repo, ["rm", "-q", "--", relPath]);
  git(repo, ["commit", "-q", "-m", message]);
}

function branchFrom(repo, name, from) {
  git(repo, ["checkout", "-q", "-b", name, from]);
}

function checkout(repo, name) {
  git(repo, ["checkout", "-q", name]);
}

function writeListFile(name, lines) {
  const listPath = join(tempRoot, name);
  writeFileSync(listPath, lines.join("\n"));
  return listPath;
}

/** 典型 modify/delete 现场：fork 删 pkg/removed.ts，upstream 改它并新增文件。 */
function createSimpleConflictRepo() {
  const repo = makeRepo("simple");
  commitFile(repo, "pkg/removed.ts", "line\nsecond\n", "base: add pkg/removed.ts");
  commitFile(repo, "keep.txt", "keep\n", "base: add keep.txt");
  branchFrom(repo, "fork", "main");
  deleteFile(repo, "pkg/removed.ts", "fork: delete pkg/removed.ts");
  branchFrom(repo, "upstream", "main");
  commitFile(repo, "pkg/removed.ts", "line\nsecond changed\n", "upstream: modify pkg/removed.ts");
  commitFile(repo, "upstreamOnly.txt", "new\n", "upstream: add upstreamOnly.txt");
  checkout(repo, "fork");
  git(repo, ["merge", "upstream"], { allowFailure: true });
  return repo;
}

/** 目录前缀场景：fork 删 lib/a 子树下两个文件，upstream 都有修改。 */
function createSubtreeConflictRepo() {
  const repo = makeRepo("subtree");
  commitFile(repo, "lib/a/one.ts", "one\n", "base: add lib/a/one.ts");
  commitFile(repo, "lib/a/two/b.ts", "b\n", "base: add lib/a/two/b.ts");
  commitFile(repo, "lib/b/keep.ts", "keep\n", "base: add lib/b/keep.ts");
  branchFrom(repo, "fork", "main");
  deleteFile(repo, "lib/a/one.ts", "fork: delete lib/a/one.ts");
  deleteFile(repo, "lib/a/two/b.ts", "fork: delete lib/a/two/b.ts");
  branchFrom(repo, "upstream", "main");
  commitFile(repo, "lib/a/one.ts", "one upstream\n", "upstream: modify lib/a/one.ts");
  commitFile(repo, "lib/a/two/b.ts", "b upstream\n", "upstream: modify lib/a/two/b.ts");
  checkout(repo, "fork");
  git(repo, ["merge", "upstream"], { allowFailure: true });
  return repo;
}

/** 清单外冲突：fork 删 other.ts、upstream 改 other.ts，清单只登记别的路径。 */
function createUnlistedConflictRepo() {
  const repo = makeRepo("unlisted");
  commitFile(repo, "other.ts", "other\n", "base: add other.ts");
  branchFrom(repo, "fork", "main");
  deleteFile(repo, "other.ts", "fork: delete other.ts");
  branchFrom(repo, "upstream", "main");
  commitFile(repo, "other.ts", "other upstream\n", "upstream: modify other.ts");
  checkout(repo, "fork");
  git(repo, ["merge", "upstream"], { allowFailure: true });
  return repo;
}

/** 双方都改同一文件（UU）：清单误登记 fork 侧仍存在的文件。 */
function createBothModifiedConflictRepo() {
  const repo = makeRepo("both-modified");
  commitFile(repo, "shared.ts", "a\n", "base: add shared.ts");
  branchFrom(repo, "fork", "main");
  commitFile(repo, "shared.ts", "fork\n", "fork: edit shared.ts");
  branchFrom(repo, "upstream", "main");
  commitFile(repo, "shared.ts", "upstream\n", "upstream: edit shared.ts");
  checkout(repo, "fork");
  git(repo, ["merge", "upstream"], { allowFailure: true });
  return repo;
}

function unmergedPaths(repo) {
  return git(repo, ["status", "--porcelain=v1", "-z"])
    .stdout.split("\0")
    .filter((field) => field.length >= 2 && "UDA".includes(field[0]) && "UDA".includes(field[1]));
}

// ---------- 纯函数 ----------

describe("parseRemovedPathList", () => {
  it("注释与空行忽略，尾斜杠与反斜杠规范化，重复条目去重", () => {
    expect(parseRemovedPathList("# 注释\n\npkg/a.ts\npkg/a.ts/\npkg/b\n")).toEqual([
      "pkg/a.ts",
      "pkg/b",
    ]);
    expect(parseRemovedPathList("win\\path.ts")).toEqual(["win/path.ts"]);
  });

  it("绝对路径与含 . / .. 段的条目抛错（受控文件写错立即暴露）", () => {
    expect(() => parseRemovedPathList("/etc/passwd")).toThrow(/相对路径/u);
    expect(() => parseRemovedPathList("C:/abs")).toThrow(/相对路径/u);
    expect(() => parseRemovedPathList("a/../b")).toThrow(/\.\./u);
    expect(() => parseRemovedPathList("./a")).toThrow(/\. 或 \.\./u);
    expect(() => parseRemovedPathList("/")).toThrow(/分隔符/u);
  });
});

describe("matchRemovedEntry", () => {
  it("精确命中与目录前缀命中，返回命中的清单条目", () => {
    expect(matchRemovedEntry("pkg/a.ts", ["pkg/a.ts"])).toBe("pkg/a.ts");
    expect(matchRemovedEntry("pkg/sub/deep/a.ts", ["pkg"])).toBe("pkg");
  });

  it("不误匹配同级前缀", () => {
    expect(matchRemovedEntry("pkgx/a.ts", ["pkg"])).toBeNull();
    expect(matchRemovedEntry("pkg", ["pkg/a.ts"])).toBeNull();
    expect(matchRemovedEntry("keep.ts", ["pkg"])).toBeNull();
  });
});

describe("parseStatusPorcelainZ", () => {
  it("解析冲突条目，rename 条目跳过第二个原始路径字段", () => {
    expect(parseStatusPorcelainZ("DU pkg/a.ts\0R  new.ts\0old.ts\0 M keep.ts\0")).toEqual([
      { x: "D", y: "U", status: "DU", path: "pkg/a.ts", origPath: undefined },
      { x: "R", y: " ", status: "R ", path: "new.ts", origPath: "old.ts" },
      { x: " ", y: "M", status: " M", path: "keep.ts", origPath: undefined },
    ]);
  });

  it("畸形条目抛错而不是静默错位", () => {
    expect(() => parseStatusPorcelainZ("garbage\0")).toThrow(/无法解析/u);
  });
});

describe("classifyConflicts", () => {
  it("清单内 DU 保持删除；清单内非 DU 与清单外冲突交人工；非未合并状态忽略", () => {
    const status = [
      { x: "D", y: "U", status: "DU", path: "a.ts" },
      { x: "U", y: "U", status: "UU", path: "b.ts" },
      { x: "D", y: "U", status: "DU", path: "c.ts" },
      { x: "A", y: "A", status: "AA", path: "d.ts" },
      { x: " ", y: "M", status: " M", path: "e.ts" },
    ];
    const { keptDeleted, manual } = classifyConflicts(status, ["a.ts", "b.ts"]);
    expect(keptDeleted).toEqual([{ path: "a.ts", entry: "a.ts", status: "DU" }]);
    expect(manual).toEqual([
      {
        path: "b.ts",
        status: "UU",
        entry: "b.ts",
        reason: expect.stringContaining("UU"),
      },
      { path: "c.ts", status: "DU", entry: null, reason: "清单外冲突，需人工处理" },
      { path: "d.ts", status: "AA", entry: null, reason: "清单外冲突，需人工处理" },
    ]);
  });
});

// ---------- 临时 git 仓库行为验证 ----------

describe("resolveConflicts（临时 git 仓库构造 modify/delete 冲突）", () => {
  it("清单内 modify/delete 冲突保持删除，并输出 upstream 提交与 diff 摘要", () => {
    const repo = createSimpleConflictRepo();
    const listPath = writeListFile("simple-list.txt", ["# 注释", "pkg/removed.ts", ""]);

    const result = resolveConflicts({ repoRoot: repo, listPath });

    expect(result.error).toBeUndefined();
    expect(result.resolved).toBe(true);
    expect(result.manual).toEqual([]);
    expect(result.keptDeleted.map(({ path }) => path)).toEqual(["pkg/removed.ts"]);
    expect(result.keptDeleted[0].entry).toBe("pkg/removed.ts");

    // 保持删除：工作树与 index 中该文件被移除，无剩余未合并条目。
    expect(() => readFileSync(join(repo, "pkg/removed.ts"), "utf8")).toThrow();
    expect(unmergedPaths(repo)).toEqual([]);

    // upstream 摘要：提交列表与 diffstat 指向 upstream 侧的修改。
    // --oneline 的元素是 "<sha> <subject>"，拼接后做子串断言。
    expect(result.keptDeleted[0].commits.join("\n")).toContain("upstream: modify pkg/removed.ts");
    expect(result.keptDeleted[0].stat).toContain("pkg/removed.ts");

    // upstream 新增的账号相关文件不属于本脚本职责（由 F0.1 拦截），合并不受影响。
    expect(readFileSync(join(repo, "upstreamOnly.txt"), "utf8")).toBe("new\n");
  });

  it("目录前缀条目匹配整棵子树", () => {
    const repo = createSubtreeConflictRepo();
    const listPath = writeListFile("subtree-list.txt", ["lib/a"]);

    const result = resolveConflicts({ repoRoot: repo, listPath });

    expect(result.error).toBeUndefined();
    expect(result.resolved).toBe(true);
    expect(result.keptDeleted.map(({ path, entry }) => ({ path, entry }))).toEqual([
      { path: "lib/a/one.ts", entry: "lib/a" },
      { path: "lib/a/two/b.ts", entry: "lib/a" },
    ]);
    expect(() => readFileSync(join(repo, "lib/a/one.ts"), "utf8")).toThrow();
    expect(() => readFileSync(join(repo, "lib/a/two/b.ts"), "utf8")).toThrow();
    // 清单前缀之外的文件不受影响。
    expect(readFileSync(join(repo, "lib/b/keep.ts"), "utf8")).toBe("keep\n");
    expect(unmergedPaths(repo)).toEqual([]);
  });

  it("清单外 modify/delete 冲突保留冲突现场交人工", () => {
    const repo = createUnlistedConflictRepo();
    const listPath = writeListFile("unlisted-list.txt", ["pkg/removed.ts"]);

    const result = resolveConflicts({ repoRoot: repo, listPath });

    expect(result.error).toBeUndefined();
    expect(result.resolved).toBe(false);
    expect(result.keptDeleted).toEqual([]);
    expect(result.manual).toEqual([
      { path: "other.ts", status: "DU", entry: null, reason: "清单外冲突，需人工处理" },
    ]);
    // 冲突原样保留：文件仍以 upstream 版本留在工作树，未合并状态未解除。
    expect(readFileSync(join(repo, "other.ts"), "utf8")).toBe("other upstream\n");
    expect(unmergedPaths(repo)).toEqual(["DU other.ts"]);
  });

  it("清单内非 DU 状态（UU）交人工，不破坏冲突现场", () => {
    const repo = createBothModifiedConflictRepo();
    const listPath = writeListFile("both-list.txt", ["shared.ts"]);

    const result = resolveConflicts({ repoRoot: repo, listPath });

    expect(result.error).toBeUndefined();
    expect(result.resolved).toBe(false);
    expect(result.keptDeleted).toEqual([]);
    expect(result.manual).toEqual([
      {
        path: "shared.ts",
        status: "UU",
        entry: "shared.ts",
        reason: expect.stringContaining("fork 侧仍有该文件"),
      },
    ]);
    // 冲突标记仍在工作树，脚本未擅自取舍。
    expect(readFileSync(join(repo, "shared.ts"), "utf8")).toContain("<<<<<<<");
  });

  it("dry-run 只报告计划，不执行 git rm", () => {
    const repo = createSimpleConflictRepo();
    const listPath = writeListFile("dry-list.txt", ["pkg/removed.ts"]);

    const result = resolveConflicts({ repoRoot: repo, listPath, dryRun: true });

    expect(result.error).toBeUndefined();
    expect(result.dryRun).toBe(true);
    expect(result.keptDeleted.map(({ path }) => path)).toEqual(["pkg/removed.ts"]);
    expect(result.manual).toEqual([]);
    // 状态未动：文件仍在（upstream 版本），冲突未解除。
    expect(readFileSync(join(repo, "pkg/removed.ts"), "utf8")).toContain("second changed");
    expect(unmergedPaths(repo)).toEqual(["DU pkg/removed.ts"]);
  });

  it("非 merge 现场返回 not-in-merge，不做任何写操作", () => {
    const repo = makeRepo("no-merge");
    commitFile(repo, "a.txt", "a\n", "base: add a.txt");
    const listPath = writeListFile("no-merge-list.txt", ["a.txt"]);

    const result = resolveConflicts({ repoRoot: repo, listPath });

    expect(result.error?.code).toBe("not-in-merge");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
  });

  it("清单缺失返回 list-missing", () => {
    const repo = createSimpleConflictRepo();
    const result = resolveConflicts({
      repoRoot: repo,
      listPath: join(tempRoot, "missing-list.txt"),
    });

    expect(result.error?.code).toBe("list-missing");
  });

  it("--show-diff 附带 upstream 完整 patch", () => {
    const repo = createSimpleConflictRepo();
    const listPath = writeListFile("diff-list.txt", ["pkg/removed.ts"]);

    const result = resolveConflicts({ repoRoot: repo, listPath, showDiff: true });

    expect(result.error).toBeUndefined();
    expect(result.keptDeleted[0].diff).toContain("diff --git");
    expect(result.keptDeleted[0].diff).toContain("+second changed");
  });
});

describe("CLI 端到端（子进程）", () => {
  const scriptPath = join(import.meta.dirname, "upstream-sync-resolve.mjs");

  function runCli(args) {
    return spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      env: createDetachedGitEnv(),
      windowsHide: true,
    });
  }

  it("冲突现场：--json 输出 resolved 结果，退出码 0", () => {
    const repo = createSimpleConflictRepo();
    const listPath = writeListFile("cli-list.txt", ["pkg/removed.ts"]);

    const cli = runCli(["--repo", repo, "--list", listPath, "--json"]);

    expect(cli.status).toBe(0);
    const parsed = JSON.parse(cli.stdout);
    expect(parsed.resolved).toBe(true);
    expect(parsed.keptDeleted.map(({ path }) => path)).toEqual(["pkg/removed.ts"]);
  });

  it("非 merge 现场：退出码 1，JSON 标注 not-in-merge", () => {
    const repo = makeRepo("cli-no-merge");
    commitFile(repo, "a.txt", "a\n", "base: add a.txt");
    const listPath = writeListFile("cli-no-merge-list.txt", ["a.txt"]);

    const cli = runCli(["--repo", repo, "--list", listPath, "--json"]);

    expect(cli.status).toBe(1);
    expect(JSON.parse(cli.stdout).error.code).toBe("not-in-merge");
  });
});
