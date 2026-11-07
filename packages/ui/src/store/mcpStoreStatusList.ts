import type {
  McpServerStatus,
  WorkspaceMcpTrustReview,
  ZodyMcpServer,
  ZodyMcpServerStatusSnapshot,
} from "@zody/shared";

type MappedMcpServerStatus = {
  authorization?: ZodyMcpServerStatusSnapshot["authorization"];
  error?: string;
  failureKind?: ZodyMcpServerStatusSnapshot["failureKind"];
  serverRequestId?: string;
  status: McpServerStatus;
  workspaceTrust?: WorkspaceMcpTrustReview;
};

function mapRuntimeStatusToUi(snapshot: ZodyMcpServerStatusSnapshot): MappedMcpServerStatus {
  switch (snapshot.status) {
    case "connected":
    case "connecting":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        // fork（F23，上游 a60ba6a7）：workspace 声明的审核摘要随状态快照原样投影
        // （spec docs/specs/workspace-mcp-trust.md §8.2），所有状态分支统一携带。
        workspaceTrust: snapshot.workspaceTrust,
      };
    case "disconnected":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        workspaceTrust: snapshot.workspaceTrust,
      };
    case "failed":
      return {
        status: "error",
        error: snapshot.error,
        failureKind: snapshot.failureKind ?? "connection_failed",
        serverRequestId: snapshot.serverRequestId,
        workspaceTrust: snapshot.workspaceTrust,
      };
    case "disabled":
      return { status: "unknown", error: snapshot.error, workspaceTrust: snapshot.workspaceTrust };
    case "untrusted":
      return {
        status: "unknown",
        error: snapshot.error ?? "Project MCP server requires explicit connection before use.",
        failureKind: snapshot.failureKind ?? "status_unavailable",
        serverRequestId: snapshot.serverRequestId,
        workspaceTrust: snapshot.workspaceTrust,
      };
    // fork（F23，上游 a60ba6a7）：workspace MCP 信任门新状态（裁决 2 new-state，
    // 不复用 untrusted 槽位）。呈带安全说明的非成功配置态；完整横幅/行级 UI 在
    // UI 步（②）落地，此处先保证枚举扩展后映射完备。
    case "pending_trust":
      return {
        authorization: snapshot.authorization,
        status: "unknown",
        error: snapshot.error ?? "Workspace MCP server is pending trust review.",
        failureKind: snapshot.failureKind ?? "status_unavailable",
        serverRequestId: snapshot.serverRequestId,
        workspaceTrust: snapshot.workspaceTrust,
      };
  }
}

export function mergeMcpServerStatusSnapshots(
  servers: ZodyMcpServer[],
  statuses: Record<string, ZodyMcpServerStatusSnapshot>,
  options: { markMissingConnectingAsError?: boolean } = {},
): ZodyMcpServer[] {
  const markMissingConnectingAsError = options.markMissingConnectingAsError ?? true;
  return servers.map((server) => {
    if (server.source !== "zcodeagentmcp") {
      return server;
    }
    const snapshot = statuses[server.name];
    if (!snapshot) {
      if (markMissingConnectingAsError && server.enabled && server.status === "connecting") {
        return {
          ...server,
          // mcp/list 正常返回但缺少当前行时，继续保留 connecting 会让设置页无限转圈。
          status: "error",
          failureKind: "status_unavailable",
          toolCount: undefined,
        };
      }
      return server;
    }
    const mapped = mapRuntimeStatusToUi(snapshot);
    return {
      ...server,
      status: mapped.status,
      authorization: mapped.authorization,
      error: mapped.error,
      failureKind: mapped.failureKind,
      serverRequestId: mapped.serverRequestId,
      workspaceTrust: mapped.workspaceTrust,
      toolCount: snapshot.toolCount,
      changed: false,
      lastConnected:
        mapped.status === "connected" ? new Date(snapshot.updatedAt) : server.lastConnected,
    };
  });
}
