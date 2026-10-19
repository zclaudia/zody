/**
 * MCP 用户目录模块 - 类型和常量定义
 */

import { ZCODE_DATA_ROOT_DIR_NAME, type CliMcpSource, type McpFileFormat } from "@zcode/shared";

/**
 * MCP 配置键名类型
 * - mcpServers: 通用 JSON 目录格式（.agents/mcp.json）
 * - mcp.servers: zcode CLI config.json 格式
 */
export type McpConfigKeyName = "mcpServers" | "mcp" | "mcp_servers" | "mcp.servers";

/**
 * OpenCode MCP 配置格式
 * OpenCode 使用特殊的配置格式：
 * - 键名是 "mcp" 而不是 "mcpServers"
 * - command 是数组格式 ["npx", "-y", "server"] 而不是分开的 command + args
 * - 必须有 type 字段 ("local" 或 "remote")
 */
export interface OpenCodeMcpServerConfig {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpSourceDescriptor {
  source: CliMcpSource;
  configDirSegments: string[];
  fileName: string;
  format: McpFileFormat;
  configKeyName: McpConfigKeyName;
}

export const MCP_SOURCE_DESCRIPTORS: McpSourceDescriptor[] = [
  {
    source: "zcodeagentmcp",
    // fork 数据隔离：家目录级数据根改为 .zcoder，避免与正式版 ZCode 共用。
    configDirSegments: [ZCODE_DATA_ROOT_DIR_NAME, "cli"],
    fileName: "config.json",
    format: "json",
    configKeyName: "mcp.servers",
  },
];

export function getSourceDescriptor(source: CliMcpSource): McpSourceDescriptor {
  const descriptor = MCP_SOURCE_DESCRIPTORS.find((item) => item.source === source);
  if (!descriptor) {
    throw new Error(`Unsupported MCP source: ${source}`);
  }
  return descriptor;
}
