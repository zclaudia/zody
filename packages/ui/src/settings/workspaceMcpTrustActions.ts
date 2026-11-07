import type { ZodyMcpServer, ZodyWorkspaceMcpTrustResult } from "@zody/shared";

/**
 * fork（F23，上游 a60ba6a7）：设置页 workspace MCP 信任/撤销（横幅 B）的动作面。
 *
 * spec docs/specs/workspace-mcp-trust.md §4/§11：services（mcp-sync
 * setWorkspaceMcpTrust 转发、zcodeAgentService）与 desktop host 接线属后续
 * wiring 卡，不在本卡落点。本文件在 UI 侧定义注入接缝（结构化类型，与
 * IMcpSyncService 未来方法签名一致）：wiring 落地前该服务不可用，行内只展示
 * 审核状态与脱敏摘要，不渲染动作按钮；落地后由设置页注入即可启用，无需改行级
 * 组件。信任是 Host 本机用户域决策（spec §11 建议远控不放开），与 hook 信任的
 * useWorkspaceHookInlineTrust 注入先例同构。
 */
export interface WorkspaceMcpTrustDecisionParams {
  workspacePath: string;
  workspaceIdentity?: string;
  serverName: string;
  /** 精确声明摘要：Host 侧 decide 在锁内重读并逐字匹配，陈旧摘要拒绝落盘。 */
  declarationDigest: string;
  trusted: boolean;
}

export interface WorkspaceMcpTrustService {
  setWorkspaceMcpTrust(
    params: WorkspaceMcpTrustDecisionParams,
  ): Promise<ZodyWorkspaceMcpTrustResult>;
}

/** 拒绝原因 → i18n message id（zh/en 双侧均在 locales 定义）。 */
export function resolveWorkspaceMcpTrustReasonMessageId(
  reasonCode: ZodyWorkspaceMcpTrustResult["reasonCode"],
): string {
  if (reasonCode === "workspace_mcp_declaration_changed") {
    return "settings.mcp.trust.rejectedDeclarationChanged";
  }
  if (reasonCode === "workspace_mcp_trust_unavailable") {
    return "settings.mcp.trust.rejectedUnavailable";
  }
  return "settings.mcp.trust.rejectedUnavailable";
}

/**
 * 从行级 server 提取可执行的信任决策输入；非 workspace 声明（无审核摘要）或
 * 声明未随快照下发时返回 null——此时不得发起决策（无摘要可绑定）。
 */
export function resolveWorkspaceMcpTrustTarget(
  server: ZodyMcpServer,
  workspacePath: string | null | undefined,
  trusted: boolean,
  workspaceIdentity?: string,
): WorkspaceMcpTrustDecisionParams | null {
  const review = server.workspaceTrust;
  if (!review || !workspacePath) return null;
  return {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    serverName: server.name,
    declarationDigest: review.declarationDigest,
    trusted,
  };
}
