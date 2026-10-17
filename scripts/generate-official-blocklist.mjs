#!/usr/bin/env node

// F0.3 断网验收容器：从官方域名词表（scripts/lib/official-domains.mjs，F0.1 定义）
// 生成 docker --add-host 屏蔽清单（specs/fork-official-deps-removal-tasks.md「F0.3」、
// specs/fork-official-deps-removal-plan.md 阶段 0.3）。
//
// 为什么不只列裸域：/etc/hosts（--add-host）只支持精确主机名，请求实际打向
// 官方 API、网关、CDN 子域这类真实主机名，只屏蔽裸域拦不住任何真实请求。
// 因此在运行时扫描 F0.1 的拦截范围（enforcedRoots，复用 check-official-refs 的
// walk 与忽略规则），用域名词表正则收集代码中实际引用的官方主机名，再并上裸域。
// 好处：清单随代码自维护——后续任务新增官方引用时，容器屏蔽清单自动覆盖，
// 不需要人工维护第二份主机名表。运行期才引入、代码中不存在的主机名不在清单内，
// 但它们要么解析失败（bridge 网络下 Docker DNS 查不到 fork 环境外仍属不可达），
// 要么在 --network none 下根本没有 DNS，官方域名依旧不可达；只是 sink 无法为
// 未枚举的主机名记录日志，这是 /etc/hosts 机制的固有限制。
//
// 用法：
//   node scripts/generate-official-blocklist.mjs                              # 每行一条 host:sink
//   node scripts/generate-official-blocklist.mjs --format hosts               # 每行一个主机名
//   node scripts/generate-official-blocklist.mjs --format json                # 机器可读
//   node scripts/generate-official-blocklist.mjs --sink-address 127.0.0.1     # 自定义 sink 地址

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { enforcedRoots, walk } from "./check-official-refs.mjs";
import { officialDomainPatterns } from "./lib/official-domains.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

// DNS 主机名标签形状：不得以 `-` 开头/结尾。词表正则的尾边界是 `\b`，
// 会把 shell 默认值语法 `${VAR:-<官方CDN主机>}` 截出以 `-` 开头的非法标签
// （`:` 绕过了负向后行）；屏蔽方向多算无害，
// 但清单里保留非法主机名会误导排查，这里按形状过滤。
const hostnameLabelPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;

function isPlausibleHostname(candidate) {
  return candidate.split(".").every((label) => hostnameLabelPattern.test(label));
}

/**
 * 收集屏蔽清单主机名：裸域 + 拦截范围内代码引用到的全部官方子域。
 * 匹配前把文件内容统一转小写：屏蔽方向宁可多不可漏（F0.1 残留统计保持
 * 大小写敏感口径，与这里的放水方向不同、互不影响）。
 */
export function collectOfficialHosts(root) {
  const hosts = new Set(officialDomainPatterns.map(({ keyword }) => keyword));
  for (const enforcedRoot of enforcedRoots) {
    for (const { absolutePath } of walk(resolve(root, enforcedRoot))) {
      let content;
      // walk 已保证只产出文本文件；读失败（竞态删除等）跳过该文件而非中断。
      try {
        content = readFileSync(absolutePath, "utf8").toLowerCase();
      } catch {
        continue;
      }
      for (const { regex } of officialDomainPatterns) {
        for (const match of content.match(regex) ?? []) {
          const hostname = match.toLowerCase();
          // `<官方主机>-evil` 这类粘连串会被正则截出合法的官方主机前缀，屏蔽方向多算无害；
          // 只剔除形状非法的截取产物（如 `-cdn-...`）。
          if (isPlausibleHostname(hostname)) {
            hosts.add(hostname);
          }
        }
      }
    }
  }
  return [...hosts].sort((left, right) => left.localeCompare(right));
}

/** 生成 --add-host 参数序列：每条为 `host:sinkAddress`。 */
export function buildAddHostArgs(hosts, sinkAddress) {
  return hosts.map((host) => `${host}:${sinkAddress}`);
}

function parseArgs(argv) {
  const options = { format: "add-host", sinkAddress: "127.0.0.1" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--format") {
      if (value !== "add-host" && value !== "hosts" && value !== "json") {
        throw new Error(`--format expects add-host|hosts|json, got: ${value}`);
      }
      options.format = value;
      index += 1;
      continue;
    }
    if (arg === "--sink-address") {
      if (!value || isIP(value) === 0) {
        throw new Error(`--sink-address expects an IP literal, got: ${value}`);
      }
      options.sinkAddress = value;
      index += 1;
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
  console.log(`Usage: node scripts/generate-official-blocklist.mjs [options]

Generates the docker --add-host blocklist used by
scripts/test-desktop-e2e-container.sh --block-official (F0.3).

Options:
  --format <fmt>        add-host (default) | hosts | json
  --sink-address <ip>   IP the official hosts resolve to inside the container (default 127.0.0.1)
  --help, -h            Show this help
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const hosts = collectOfficialHosts(repoRoot);
  console.error(`[generate-official-blocklist] ${hosts.length} official host(s)`);
  if (options.format === "hosts") {
    for (const host of hosts) {
      console.log(host);
    }
    return;
  }
  if (options.format === "json") {
    console.log(JSON.stringify({ sinkAddress: options.sinkAddress, hosts }, null, 2));
    return;
  }
  for (const arg of buildAddHostArgs(hosts, options.sinkAddress)) {
    console.log(arg);
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
