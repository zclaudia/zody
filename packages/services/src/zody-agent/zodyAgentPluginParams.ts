import type {
  ModelSelection,
  ZodyAgentMcpServer,
  ZodyAutomationScheduleRule,
  ZodyMcpListMode,
} from "@zody/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zody/shared/mcp-apps";

export interface ZodyAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface ZodyAgentPluginViewParams extends ZodyAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface ZodyAgentListMcpServerStatusesParams extends ZodyAgentWorkspaceTarget {
  mcpServers?: ZodyAgentMcpServer[];
  mode?: ZodyMcpListMode;
}

export interface ZodyAgentAddPluginMarketplaceParams extends ZodyAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface ZodyAgentRemovePluginMarketplaceParams extends ZodyAgentWorkspaceTarget {
  marketplace: string;
}

export interface ZodyAgentUpdatePluginMarketplaceParams extends ZodyAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface ZodyAgentInstallPluginParams extends ZodyAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface ZodyAgentCancelPluginOperationParams {
  operationId: string;
}

export interface ZodyAgentUninstallPluginParams extends ZodyAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface ZodyAgentUpdatePluginParams extends ZodyAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface ZodyAgentRestoreBuiltinPluginParams extends ZodyAgentWorkspaceTarget {
  pluginId: string;
}

export interface ZodyAgentConfigurePluginParams extends ZodyAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZodyAgentResetPluginConfigParams extends ZodyAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZodyAgentValidatePluginParams extends ZodyAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface ZodyAgentDescribePluginParams extends ZodyAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface ZodyAgentSetPluginEnabledParams extends ZodyAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface ZodyAgentPluginReferenceCatalogParams extends ZodyAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface ZodyAgentSkillReferenceCatalogParams extends ZodyAgentWorkspaceTarget {
  sessionId?: string;
}

/** 插件 UI：UI 发起的 `ui://` 资源读取。 */
export interface ZodyAgentReadMcpResourceParams extends ZodyAgentWorkspaceTarget {
  instance: import("@zody/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  uri: string;
}

/** 插件 UI 页面发起的 `resources/read`；参数与 readMcpResource 同形，结果受 8 MiB 与 mimeType 白名单约束。 */
export type ZodyAgentReadMcpResourceForUiParams = ZodyAgentReadMcpResourceParams;

/** 插件 UI：UI 回调本插件工具；不进审批流，归属由 agent 侧 catalog fail closed。 */
export interface ZodyAgentCallMcpToolForUiParams extends ZodyAgentWorkspaceTarget {
  instance: import("@zody/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 宿主生成的调用 id，配合 cancelMcpToolCallForUi。 */
  callId: string;
}
/** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe。 */
export interface ZodyAgentListMcpResourcesForUiParams extends ZodyAgentWorkspaceTarget {
  instance: import("@zody/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  cursor?: string;
}
/** App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际。 */
export interface ZodyAgentAppToolInstanceForUiParams extends ZodyAgentWorkspaceTarget {
  instance: import("@zody/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
}
export interface ZodyAgentRegisterAppToolsForUiParams extends ZodyAgentAppToolInstanceForUiParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface ZodyAgentAppToolCallForUiParams extends ZodyAgentAppToolInstanceForUiParams {
  callId: string;
}
export interface ZodyAgentResolveAppToolCallForUiParams extends ZodyAgentAppToolCallForUiParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface ZodyAgentMcpResourceSubscriptionForUiParams extends ZodyAgentWorkspaceTarget {
  instance: import("@zody/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
  uri: string;
}
export interface ZodyAgentCancelMcpToolCallForUiParams extends ZodyAgentWorkspaceTarget {
  instance: import("@zody/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  callId: string;
}
export interface ZodyAgentResolveSuggestedPluginReferenceParams extends ZodyAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface ZodyAgentCreateAutomationParams extends ZodyAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZodyAutomationScheduleRule;
}

export interface ZodyAgentUpdateAutomationParams extends ZodyAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZodyAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface ZodyAgentAutomationIdParams extends ZodyAgentWorkspaceTarget {
  automationId: string;
}

export interface ZodyAgentSetAutomationEnabledParams extends ZodyAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface ZodyAgentDeleteAutomationRunParams extends ZodyAgentWorkspaceTarget {
  runId: string;
}
