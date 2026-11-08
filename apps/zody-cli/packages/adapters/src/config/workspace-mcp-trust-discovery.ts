// fork（F23④，上游 a60ba6a7 workspace-mcp-trust 模块的 discover() 接线）：workspace
// MCP 信任门的声明发现 port。spec 见 docs/specs/workspace-mcp-trust.md §5：
// 「工作区可达文件」是审核范围的唯一判定——
// 1. CLI createConfig 解析出的 project 作用域声明（zcode.json / .zody/config.json /
//    .zcode/config.json 等，sources.mcp.serverSources[name] === "project"）；
// 2. workspace `.agents/mcp.json` fallback：上游在信任模块内直接读该文件，本仓该
//    fallback 的连接配置由桌面 mcp-sync 链路解析后随 params.mcpServers 下发（spec §5.1
//    登记差异），但摘要与 store 判定必须同源——发现层仍须看到同一份文件，否则
//    「经 params.mcpServers 下发的 workspace 声明同样必须审核」（验收 A6）无从成立。
// 上游回退条件原样保留：仅当 project 配置没有任何 MCP 条目且无条目级校验失败时回退，
// 不能用 fallback 替换校验失败的项目条目。
//
// 本文件只做发现与逐条校验，不连接任何 MCP（spec §3.1 规则 2：inspect 零副作用）。
// 输出注入 core 的 WorkspaceMcpTrustDiscoveryPort（@zody/core mcp/workspace-mcp-trust.ts）。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "@zody/contracts";
import { createConfig, type ConfigFactoryOptions, type ConfigResult } from "./config-factory.js";
import { ZodyConfigFileSchema } from "./schema.js";

export interface WorkspaceMcpTrustDeclarationInput {
  config: McpServerConfig;
  /** 声明来源文件绝对路径列表；参与摘要（改文件 = 改声明）。 */
  sourcePaths: string[];
}

export interface WorkspaceMcpTrustDiscoveryPort {
  /** 配置不可读时 throw（inspect 返回空投影、allows 拒绝、decide 拒绝落盘）。 */
  discover(): Promise<Record<string, WorkspaceMcpTrustDeclarationInput>>;
}

export interface WorkspaceMcpTrustDiscoveryOptions extends ConfigFactoryOptions {
  /**
   * createConfig 工厂注入（测试替换用）；生产缺省用 adapters 的 createConfig。
   * 结构化注入而不是 rewire，保证发现语义与真实 CLI 组装完全同源。
   */
  createConfigFn?: (options: ConfigFactoryOptions) => ConfigResult;
}

const AGENTS_MCP_FILE_SEGMENTS = [".agents", "mcp.json"] as const;

export function createWorkspaceMcpTrustDiscoveryPort(
  options: WorkspaceMcpTrustDiscoveryOptions = {},
): WorkspaceMcpTrustDiscoveryPort {
  const createConfigFn = options.createConfigFn ?? createConfig;
  return {
    async discover() {
      const result = createConfigFn({ ...options });
      // 项目配置读取失败（diagnostics error）时没有可审核的声明基线：fail-closed
      // 抛错，core 侧 inspect 返回空投影、allows 一律拒绝（spec §2.3 表：声明读取
      // 失败 ⇒ pending_trust/default-deny）。上游 workspace_mcp_config_unreadable 同构。
      if (result.sources.project.diagnostics.some((item) => item.severity === "error")) {
        throw new Error("workspace_mcp_config_unreadable");
      }
      const declarations: Record<string, WorkspaceMcpTrustDeclarationInput> = {};
      for (const [name, config] of Object.entries(result.config.mcp.servers)) {
        if (result.sources.mcp.serverSources[name] !== "project") continue;
        const sourcePaths = result.sources.project.paths;
        declarations[name] = { config, sourcePaths };
      }
      // 设置目录按条目数选择来源；空 map 也要回退，但不能用 fallback 替换校验失败的
      // 项目条目（config_mcp_server_invalid 表示项目配置想声明但条目非法）。
      if (
        result.sources.project.mcpServerNames.length === 0 &&
        !result.sources.project.diagnostics.some(
          (item) => item.code === "config_mcp_server_invalid",
        )
      ) {
        const path = join(options.workingDirectory ?? process.cwd(), ...AGENTS_MCP_FILE_SEGMENTS);
        const raw = await readJson(path);
        if (raw !== undefined) {
          const object = (raw as { mcpServers?: Record<string, unknown> }).mcpServers;
          for (const [name, value] of Object.entries(object ?? {})) {
            const source = result.sources.mcp.serverSources[name];
            // 用户作用域等更高优先级来源已认领同名时不覆盖（上游同构）。
            if (source && source !== "project") continue;
            const parsed = ZodyConfigFileSchema.safeParse({
              mcp: { servers: { [name]: value } },
            });
            if (!parsed.success) {
              // 坏邻项不得拖垮整个列表；也不能把校验失败的 workspace 声明当成可放行的
              // 用户配置。以 enabled:false 占位声明收口：core allows 对 enabled:false 的
              // 声明一律拒绝（等价上游 requiredNames 的拒连语义），投影呈 disabled、
              // 不计入 admission pending（spec §2.3 disabled 优先），decide 的锁内重读
              // 使用同一占位摘要，审核面看到的与落盘判定一致。
              declarations[name] = {
                config: {
                  type: "http",
                  url: "workspace://invalid-mcp-declaration",
                  enabled: false,
                },
                sourcePaths: [path],
              };
              continue;
            }
            const config = parsed.data.mcp?.servers?.[name];
            if (!config) continue;
            declarations[name] = { config, sourcePaths: [path] };
          }
        }
      }
      return declarations;
    },
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
