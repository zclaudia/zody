#!/usr/bin/env node

// F0.3 断网验收容器的断言工具（specs/fork-official-deps-removal-tasks.md「F0.3」、
// specs/fork-official-deps-removal-plan.md 阶段 0.3）。
//
// 读取 scripts/official-request-sink.mjs 产出的 official-requests.jsonl
// （每行一条 { timestamp, kind, host, note }），按两种语义判定：
// - empty：必须为空——容器内不得出现任何打到官方域名的连接（阶段 2/3 验收）；
// - whitelist：仅白名单——只允许 --allow 列出的主机（含其子域）出现，
//   其余一律判失败（如 BYOK 直连的公开 API 主机名允许、官方账号域不允许）。
// report 模式只打印摘要不判定，用于 `--block-official` 跑完后的默认观察。
//
// 文件缺失时按失败处理（fail-closed）：sink 没跑起来时不能把「没证据」
// 当成「无官方请求」通过断言。
//
// 用法：
//   node scripts/assert-official-requests.mjs <official-requests.jsonl> \
//     [--mode empty|whitelist|report] [--allow <host1>,<host2>]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MODES = ["empty", "whitelist", "report"];

/** 归一化记录/白名单主机：去端口、去空白、转小写；空值返回 null。 */
export function normalizeHost(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }
  // Host 头可能带端口（`host:443`）；只剥纯数字端口后缀。
  return trimmed.replace(/:\d+$/u, "") || null;
}

/** 白名单命中：主机等于条目，或是条目的子域（子域命中裸域条目）。 */
export function isHostAllowed(host, allowList) {
  if (host === null) {
    return false;
  }
  return allowList.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
}

/** 解析 JSONL 文本；空行跳过；坏行直接抛错（记录不完整时宁报失败不给假通过）。 */
export function loadRecords(text) {
  const records = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid JSONL at line ${index + 1}: ${line.slice(0, 120)}`);
    }
  }
  return records;
}

/** 打印用的主机名：记录缺 host 时归为 (unknown)，仍然计入失败。 */
function displayHost(host) {
  return host ?? "(unknown)";
}

/**
 * 核心判定。返回 { pass, summary, offenders }：
 * - summary：{ total, byHost }（host 已归一化）；
 * - offenders：判失败的主机去重计数（host null 归为 "(unknown)"）。
 * 语义：empty 模式任何记录都失败；whitelist 模式不在白名单（含 null host）
 * 的记录失败；report 模式恒通过。
 */
export function evaluateRecords(records, { mode, allow = [] }) {
  if (!MODES.includes(mode)) {
    throw new Error(`unknown mode: ${mode}`);
  }
  const byHost = new Map();
  const offenders = new Map();
  const allowList = allow.map((entry) => normalizeHost(entry)).filter((entry) => entry !== null);
  for (const record of records) {
    const host = normalizeHost(record.host) ?? "(unknown)";
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
    const allowed =
      mode === "report" ||
      (mode === "empty" ? false : isHostAllowed(host === "(unknown)" ? null : host, allowList));
    if (!allowed) {
      offenders.set(host, (offenders.get(host) ?? 0) + 1);
    }
  }
  return {
    pass: offenders.size === 0,
    summary: { total: records.length, byHost: Object.fromEntries([...byHost.entries()].sort()) },
    offenders: Object.fromEntries([...offenders.entries()].sort()),
  };
}

function parseArgs(argv) {
  const options = { mode: "report", allow: [], path: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--mode") {
      if (!MODES.includes(value)) {
        throw new Error(`--mode expects ${MODES.join("|")}, got: ${value}`);
      }
      options.mode = value;
      index += 1;
      continue;
    }
    if (arg === "--allow") {
      if (!value) {
        throw new Error("--allow expects a comma-separated host list");
      }
      options.allow = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (options.path !== null) {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
    options.path = arg;
  }
  if (options.path === null) {
    throw new Error("missing <official-requests.jsonl> argument");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/assert-official-requests.mjs <official-requests.jsonl> [options]

Asserts on the sink output produced by scripts/official-request-sink.mjs (F0.3).

Options:
  --mode <mode>      empty | whitelist | report (default: report)
                     empty:     fail when any request was recorded
                     whitelist: fail unless every recorded host is in --allow
                     report:    print summary only, never fails
  --allow <hosts>    comma-separated allowlist for whitelist mode
                     (entry also covers its subdomains)
  --help, -h         Show this help

Exit codes: 0 pass, 1 fail (including missing/unreadable JSONL file).
`);
}

function printSummary(label, summary) {
  console.log(`[assert-official-requests] ${label}: ${summary.total} record(s)`);
  for (const [host, count] of Object.entries(summary.byHost)) {
    console.log(`  ${host}: ${count}`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  let text;
  try {
    text = await readFile(options.path, "utf8");
  } catch (error) {
    console.error(
      `[assert-official-requests] cannot read ${options.path}: ${error.message}; ` +
        "the sink may not have run — refusing to pass (fail-closed)",
    );
    process.exitCode = 1;
    return;
  }
  let evaluation;
  try {
    evaluation = evaluateRecords(loadRecords(text), { mode: options.mode, allow: options.allow });
  } catch (error) {
    console.error(`[assert-official-requests] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  printSummary("summary", evaluation.summary);
  if (options.mode === "report") {
    return;
  }
  if (evaluation.pass) {
    console.log(
      options.mode === "empty"
        ? "[assert-official-requests] PASS: no official request was recorded"
        : `[assert-official-requests] PASS: all recorded hosts are allowlisted (${options.allow.join(", ")})`,
    );
    return;
  }
  console.error(
    `[assert-official-requests] FAIL (mode=${options.mode}): unexpected official request host(s):`,
  );
  for (const [host, count] of Object.entries(evaluation.offenders)) {
    console.error(`  ${host}: ${count} record(s)`);
  }
  process.exitCode = 1;
}

// 入口守卫：被测试导入时只暴露纯函数，不读文件。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
