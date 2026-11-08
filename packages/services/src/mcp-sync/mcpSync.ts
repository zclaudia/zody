import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpSyncCandidateListResult,
  McpSyncExportResult,
  McpSyncExportedServer,
  McpSyncImportResult,
  McpSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
  SaveCliMcpToUserDirectoryRequest,
  ZodyAgentMcpServer,
  ZodyMcpListMode,
  ZodyMcpListResult,
  ZodyWorkspaceMcpTrustResult,
} from "@zody/shared";
import { ServiceChannels } from "@zody/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IMcpSyncService {
  loadMcpFromUserDirectory(
    request?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;
  /**
   * workspace MCP server 运行态状态列表（原 UI 直调 zcodeAgentService 的
   * mcp/list）。真实 connect/listTools 检查必须发生在 agent 进程（PATH/cwd 是
   * workspace 环境），本服务只是 UI 的注入面——mcp/list 词的 host 消费收拢到实现一处。
   */
  listWorkspaceMcpServerStatuses(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    mcpServers?: ZodyAgentMcpServer[];
    mode?: ZodyMcpListMode;
  }): Promise<ZodyMcpListResult>;
  /**
   * fork（F23④，上游 a60ba6a7）：workspace MCP 信任/撤销决策（spec
   * docs/specs/workspace-mcp-trust.md §6/§11）。签名与 UI 注入接缝
   * WorkspaceMcpTrustService（packages/ui/src/settings/workspaceMcpTrustActions.ts）
   * 结构一致；真实 decide 发生在 agent 进程（锁内重读声明 + 精确摘要匹配 + 用户域
   * store 落盘），本服务只是 UI 的注入面。信任是 Host 本机用户域决策：手机远控的
   * homeOnlyServices 将 mcpSyncService 整体替换为 unsupported 桩，远端默认无此写入面。
   */
  setWorkspaceMcpTrust(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    serverName: string;
    declarationDigest: string;
    trusted: boolean;
  }): Promise<ZodyWorkspaceMcpTrustResult>;
  saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void>;
  listLocalUserMcpCandidates(): Promise<McpSyncCandidateListResult>;
  listRemoteUserMcpStatuses(params: { names: string[] }): Promise<McpSyncRemoteStatusResult>;
  exportMcpServers(params: { serverIds: string[] }): Promise<McpSyncExportResult>;
  checkRemoteUserMcpWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMcpServers(params: {
    servers: McpSyncExportedServer[];
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteWorkspacePath?: string;
    overwrite?: false;
  }): Promise<McpSyncImportResult>;
}

export const IMcpSyncService = createServiceDescriptor<IMcpSyncService>(ServiceChannels.McpSync);
