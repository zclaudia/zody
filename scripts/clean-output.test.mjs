// clean-output 的定向测试（specs/cua-output-retention.md 验收场景）：
// 保护最新轮次、仅删 .app/node_modules 构建树、证据保留、dry-run 默认、
// 符号链接跳过、回执目录不算轮次、越界路径拒绝。
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RECEIPTS_DIR_NAME,
  assertSafeRemoveTarget,
  collectRoundDirs,
  parseArgs,
  runOutputCleanup,
} from "./clean-output.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

let workDir;
let outputDir;

async function writeTree(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function createFixture() {
  const now = Date.now();
  const oldRound = join(outputDir, "round-old");
  const newRound = join(outputDir, "round-new");
  await writeTree(oldRound, {
    "controller-x/Candidate.app/Contents/MacOS/Candidate": "x".repeat(4096),
    "controller-x/node_modules/pkg/index.js": "module.exports = 1;",
    "controller-x/node_modules/dep/Nested.app/Contents/MacOS/Nested": "n".repeat(16),
    "home/Library/prefs/com.zody.json": "{}",
    "cargo/target/debug/sketch": "binary",
    "evidence.json": '{"pass": true}',
    "run.log": "ok\n",
  });
  await writeTree(newRound, {
    "controller-y/Fresh.app/Contents/MacOS/Fresh": "f".repeat(2048),
    "notes.md": "# keep",
  });
  // 内容写完后再设置轮次目录 mtime，保证排序确定。
  await utimes(oldRound, new Date(now - 10 * DAY_MS), new Date(now - 10 * DAY_MS));
  await utimes(newRound, new Date(now - 1 * DAY_MS), new Date(now - 1 * DAY_MS));
  return { oldRound, newRound };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "zody-clean-output-"));
  outputDir = join(workDir, "output");
  await mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { force: true, recursive: true });
});

describe("clean-output 保留策略", () => {
  it("默认计划只删旧轮次的 .app 与 node_modules，最新轮次受保护", async () => {
    await createFixture();
    const result = await runOutputCleanup({ outputDir });
    const paths = result.removals.map((removal) => removal.path);

    expect(paths).toContain(join(outputDir, "round-old/controller-x/Candidate.app"));
    expect(paths).toContain(join(outputDir, "round-old/controller-x/node_modules"));
    // 嵌套在 node_modules 内的 .app 不重复计数。
    expect(paths).toHaveLength(2);
    expect(paths.some((path) => path.includes("round-new"))).toBe(false);
    expect(result.rounds.find((round) => round.name === "round-new")?.protected).toBe(true);
  });

  it("keep 覆盖全部轮次时无目标；--all 连最新轮次也清理", async () => {
    await createFixture();
    const keepAll = await runOutputCleanup({ outputDir, keep: 2 });
    expect(keepAll.removals).toHaveLength(0);

    const all = await runOutputCleanup({ outputDir, all: true });
    expect(all.removals.some((removal) => removal.path.includes("round-new"))).toBe(true);
  });

  it("白名单外目录（target/home）不进入计划", async () => {
    await createFixture();
    const result = await runOutputCleanup({ outputDir, all: true });
    for (const removal of result.removals) {
      expect(removal.path).not.toMatch(/[/\\](target|home)$/);
    }
  });

  it("dry-run 不删除任何内容", async () => {
    await createFixture();
    const result = await runOutputCleanup({ outputDir });
    expect(result.dryRun).toBe(true);
    expect(existsSync(join(outputDir, "round-old/controller-x/Candidate.app/Contents/MacOS/Candidate"))).toBe(true);
    expect(existsSync(join(outputDir, "round-new/controller-y/Fresh.app"))).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("apply 删除构建树、保留证据并写回执", async () => {
    await createFixture();
    const result = await runOutputCleanup({
      outputDir,
      apply: true,
      resolveMainHead: async () => "deadbeef",
    });

    expect(result.removed).toHaveLength(2);
    for (const entry of result.removed) {
      expect(entry.existsAfter).toBe(false);
    }
    expect(existsSync(join(outputDir, "round-old/evidence.json"))).toBe(true);
    expect(existsSync(join(outputDir, "round-old/run.log"))).toBe(true);
    expect(existsSync(join(outputDir, "round-old/home/Library/prefs/com.zody.json"))).toBe(true);
    expect(existsSync(join(outputDir, "round-old/cargo/target/debug/sketch"))).toBe(true);
    expect(existsSync(join(outputDir, "round-new/controller-y/Fresh.app"))).toBe(true);

    expect(result.receiptPath).toContain(RECEIPTS_DIR_NAME);
    const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
    expect(receipt.mainHead).toBe("deadbeef");
    expect(receipt.removed).toHaveLength(2);
    expect(receipt.ok).toBe(true);
  });

  it("名为 .app 的符号链接目录被跳过且不影响指向目标", async () => {
    await createFixture();
    const outside = join(workDir, "outside-app");
    await mkdir(join(outside, "Contents"), { recursive: true });
    await writeFile(join(outside, "Contents", "Info.plist"), "plist");
    await symlink(outside, join(outputDir, "round-old", "Fake.app"));

    const result = await runOutputCleanup({ outputDir, apply: true, resolveMainHead: async () => null });
    expect(result.removals.some((removal) => removal.path.endsWith("Fake.app"))).toBe(false);
    expect(existsSync(join(outside, "Contents", "Info.plist"))).toBe(true);
  });

  it("回执目录不被识别为轮次目录", async () => {
    await createFixture();
    const receiptsRound = join(outputDir, RECEIPTS_DIR_NAME);
    await mkdir(join(receiptsRound, "legacy.app", "Contents"), { recursive: true });
    await writeFile(join(receiptsRound, "legacy.app", "Contents", "MacOS"), "bin");

    const names = collectRoundDirs(outputDir).map((round) => round.name);
    expect(names).not.toContain(RECEIPTS_DIR_NAME);
    const result = await runOutputCleanup({ outputDir });
    expect(result.removals.some((removal) => removal.path.includes(RECEIPTS_DIR_NAME))).toBe(false);
  });

  it("冻结归档还原目录不参与清理也不占保护槽（持久构建输入）", async () => {
    await createFixture();
    const frozenApp = join(outputDir, "cua-narrow-frozen", "controller-prepared", "stage", "Zody CUA Desktop Session.app");
    await mkdir(join(frozenApp, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(frozenApp, "Contents", "MacOS", "launcher"), "bin");
    const now = Date.now();
    await utimes(join(outputDir, "cua-narrow-frozen"), new Date(now - 90 * 24 * 3600 * 1000), new Date(now - 90 * 24 * 3600 * 1000));

    const names = collectRoundDirs(outputDir).map((round) => round.name);
    expect(names).not.toContain("cua-narrow-frozen");
    const result = await runOutputCleanup({ outputDir, apply: true });
    expect(result.removals.some((removal) => removal.path.includes("cua-narrow-frozen"))).toBe(false);
    expect(existsSync(join(frozenApp, "Contents", "MacOS", "launcher"))).toBe(true);
  });

  it("当日报告目录不抢占保护槽位", async () => {
    await createFixture();
    const report = join(outputDir, "disk-report-today");
    await mkdir(report, { recursive: true });
    await writeFile(join(report, "result.json"), "{}");
    const now = Date.now();
    await utimes(report, new Date(now), new Date(now));

    const result = await runOutputCleanup({ outputDir });
    expect(result.rounds.find((round) => round.name === "round-new")?.protected).toBe(true);
    expect(result.rounds.find((round) => round.name === "disk-report-today")?.protected).toBe(false);
  });

  it("空构建树不计为目标、也不占保护槽", async () => {
    await createFixture();
    await mkdir(join(outputDir, "round-new", "Empty.app"), { recursive: true });

    const result = await runOutputCleanup({ outputDir });
    expect(result.removals.some((removal) => removal.path.endsWith("Empty.app"))).toBe(false);
    expect(result.rounds.find((round) => round.name === "round-new")?.protected).toBe(true);
  });
});

describe("clean-output 安全边界", () => {
  it("拒绝 output 目录之外的删除目标", () => {
    expect(() => assertSafeRemoveTarget(join(outputDir, "..", "escape.app"), outputDir)).toThrow(
      /outside output directory/,
    );
  });

  it("拒绝白名单外的目录名", () => {
    expect(() => assertSafeRemoveTarget(join(outputDir, "round", "target"), outputDir)).toThrow(
      /not matching bulky build tree names/,
    );
  });
});

describe("clean-output CLI 参数", () => {
  it("解析 --apply/--all/--json 与 --keep", () => {
    expect(parseArgs(["--apply", "--keep", "3"])).toMatchObject({ apply: true, keep: 3 });
    expect(parseArgs(["--all", "--json"])).toMatchObject({ all: true, json: true });
  });

  it("拒绝未知参数与非法 keep 值", () => {
    expect(() => parseArgs(["--noise"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--keep", "x"])).toThrow(/--keep/);
    expect(() => parseArgs(["--keep"])).toThrow(/--keep/);
    expect(() => parseArgs(["--keep", "-1"])).toThrow(/--keep/);
  });
});
