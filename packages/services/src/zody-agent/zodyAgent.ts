import type {
  BackgroundBashOutputResult,
  SessionDebugSnapshot,
  ZodySessionContentProfile,
} from "@zody/shared";
/* eslint-disable max-lines -- ZCode agent service 接口集中声明 protocol/session/workspace 方法，拆分会增加 service descriptor 迁移成本。 */
import type { Event, IDisposable } from "@zody/rpc";
import { ServiceChannels } from "@zody/shared";
import type { AppUsageRange, AppUsageSnapshot, ZodyTaskTokenUsageResult } from "@zody/shared";
import type { DynamicWorkflowMode } from "@zody/shared";
import type { ZodyAutomation, ZodyAutomationRun } from "@zody/shared";
import type {
  ZodyStorageStartupState,
  ZodyDeliveryKind,
  ZodyAgentMcpServer,
  ZodyBackgroundTurnAttribution,
  TraceId,
  ZodySessionCompactResult,
  ZodySessionGoalAction,
  ZodySessionGoalResult,
  ZodyMessageWithParts,
  ModelSelection,
  ZodySessionImportHistory,
  ZodyPermissionRequestParams,
  AgentLaneResourceSample,
  ZodyMcpTelemetryEvent,
  ZodyMcpResourceSample,
  ZodyToolExecResource,
  ZodyProcessChildProcess,
  ZodyMcpListResult,
  ZodyPluginsListResult,
  ZodyPluginsOverviewResult,
  ZodyPluginsMarketplaceMutationResult,
  ZodyPluginsInstallResult,
  ZodyPluginsReferenceCatalogResult,
  ZodySkillsReferenceCatalogResult,
  ZodyMcpReadResourceResult,
  ZodyMcpUiCallToolResult,
  ZodyMcpUiCancelCallResult,
  ZodyMcpUiReadResourceResult,
  ZodyMcpUiListResourcesResult,
  ZodyMcpUiAppToolAcceptedResult,
  ZodyMcpUiRegisterAppToolsResult,
  ZodyMcpUiUnregisterAppToolsResult,
  ZodyMcpUiListResourceTemplatesResult,
  ZodyPluginsListUiSurfacesResult,
  ZodyWorkflowsDeleteResult,
  ZodyWorkflowsForRunResult,
  ZodyWorkflowsGetResult,
  ZodyWorkflowsListResult,
  ZodyWorkflowsMoveResult,
  ZodyWorkflowsRunsResult,
  ZodyWorkflowsSaveResult,
  ZodyWorkflowsUpdateMetaResult,
  ZodyPluginsUninstallResult,
  ZodyPluginsRestoreBuiltinResult,
  ZodyPluginsConfigureResult,
  ZodyPluginsDescribeResult,
  ZodyPluginsValidateResult,
  ZodyPluginsSetEnabledResult,
  ZodyPluginsCancelOperationResult,
  ZodyPluginOperationProgressNotification,
  ZodyProviderRuntimeHeadersRequestParams,
  ZodyProviderRuntimeHeadersCancelled,
  ZodyProviderTestModelConnectivityParams,
  ZodyProviderTestModelConnectivityResult,
  ZodyUserInputRequestParams,
  ZodyUserInputResponse,
  ZodySessionEvent,
  ZodySessionInfo,
  ZodySessionMode,
  ZodySessionPersistence,
  ZodySessionSendResult,
  ZodySessionRequestRuntimePreferencesParams,
  ZodySessionRuntimePreferencesResult,
  ZodySessionStateSnapshot,
  ZodySessionSubagentsResult,
  ZodyStateUpdatedNotification,
  ZodyTaskClientMode,
  ZodyBrowserAmbientContext,
  ZodyWorkspacePresentation,
  ZodyWorkspaceGenerateTextResult,
  ZodyWorkspaceGenerateTextParams,
  ZodyWorkspaceHookTrustGrantResult,
} from "@zody/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@zody/shared/zody-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export * from "./zodyAgentPluginParams.js";
export * from "./zodyAgentWorkflowParams.js";
import type {
  ZodyAgentAddPluginMarketplaceParams,
  ZodyAgentAutomationIdParams,
  ZodyAgentCancelPluginOperationParams,
  ZodyAgentConfigurePluginParams,
  ZodyAgentResetPluginConfigParams,
  ZodyAgentCreateAutomationParams,
  ZodyAgentDeleteAutomationRunParams,
  ZodyAgentDescribePluginParams,
  ZodyAgentInstallPluginParams,
  ZodyAgentListMcpServerStatusesParams,
  ZodyAgentPluginViewParams,
  ZodyAgentPluginReferenceCatalogParams,
  ZodyAgentSkillReferenceCatalogParams,
  ZodyAgentReadMcpResourceParams,
  ZodyAgentReadMcpResourceForUiParams,
  ZodyAgentListMcpResourcesForUiParams,
  ZodyAgentAppToolCallForUiParams,
  ZodyAgentAppToolInstanceForUiParams,
  ZodyAgentRegisterAppToolsForUiParams,
  ZodyAgentResolveAppToolCallForUiParams,
  ZodyAgentMcpResourceSubscriptionForUiParams,
  ZodyAgentCallMcpToolForUiParams,
  ZodyAgentCancelMcpToolCallForUiParams,
  ZodyAgentResolveSuggestedPluginReferenceParams,
  ZodyAgentRemovePluginMarketplaceParams,
  ZodyAgentRestoreBuiltinPluginParams,
  ZodyAgentSetPluginEnabledParams,
  ZodyAgentSetAutomationEnabledParams,
  ZodyAgentUninstallPluginParams,
  ZodyAgentUpdatePluginMarketplaceParams,
  ZodyAgentUpdatePluginParams,
  ZodyAgentUpdateAutomationParams,
  ZodyAgentValidatePluginParams,
  ZodyAgentWorkspaceTarget,
} from "./zodyAgentPluginParams.js";
import type {
  ZodyAgentDeleteSavedWorkflowParams,
  ZodyAgentFindSavedWorkflowForRunParams,
  ZodyAgentGetSavedWorkflowParams,
  ZodyAgentListSavedWorkflowRunsParams,
  ZodyAgentListSavedWorkflowsParams,
  ZodyAgentMoveSavedWorkflowParams,
  ZodyAgentSaveSavedWorkflowFromRunParams,
  ZodyAgentUpdateSavedWorkflowMetaParams,
} from "./zodyAgentWorkflowParams.js";

export interface ZodyAgentSessionTarget extends ZodyAgentWorkspaceTarget {
  sessionId: string;
}

export interface ZodyAgentResumeSessionParams extends ZodyAgentSessionTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZodyAgentMcpServer[];
  // 冷恢复会重建 runtime，工具面隔离必须和 create 保持同一安全边界（CUA 只放行 zcode-cua 工具、
  // 禁 Bash 等）。否则 resume 后模型可见工具面/执行权限会比创建时更宽。
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface ZodyAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZodyAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface ZodyAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE";

export type ZodyAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface ZodyAgentRuntimeLifecycleEvent extends ZodyAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: ZodyAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type ZodyAgentCuaPermissionObservation = CuaPermissionObservation &
  ZodyAgentWorkspaceTarget;

export interface ZodyAgentCreateSessionParams extends ZodyAgentWorkspaceTarget {
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZodySessionMode;
  model?: ModelSelection;
  persistence?: ZodySessionPersistence;
  thoughtLevel?: string;
  /** automation 执行会话关闭模型二次命名，保持首条用户 query 作为稳定标题。 */
  titleGenerationEnabled?: boolean;
  mcpServers?: ZodyAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: ZodySessionImportHistory;
}

export interface ZodyAgentListSessionsParams extends ZodyAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: ZodyAgentRuntimePolicy;
  includeArchived?: boolean;
  limit?: number;
}

export interface ZodyAgentListSessionSubagentsParams extends ZodyAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** 远程 workspace 的宿主连接身份；只用于选择现有 Host，不进入 CLI wire query。 */
  remoteSessionId?: string;
}

export interface ZodyAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

export interface ZodyAgentTaskTokenUsageParams extends ZodyAgentSessionTarget {}

export interface ZodyAgentReadSessionParams extends ZodyAgentSessionTarget {
  deliveryKind?: ZodyDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** 被动索引/观察者只能读取现有 runtime，禁止为了读快照拉起 session。 */
  runtimePolicy?: ZodyAgentRuntimePolicy;
  /** "index" 仅供 task index：返回剥离大载荷的同结构 snapshot，禁止回写 UI 状态。 */
  contentProfile?: ZodySessionContentProfile;
}

export interface ZodyAgentReadSessionMessagesParams extends ZodyAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZodyAgentReadSessionEventsParams extends ZodyAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type ZodyAgentReadWorkspacePresentationParams = ZodyAgentWorkspaceTarget;

export interface ZodyAgentGrantWorkspaceHookTrustParams extends ZodyAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface ZodyAgentSendPromptParamsBase extends ZodyAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@zody/shared/zody-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** provider-only 的当前 IAB 状态；UI/session persistence 仍使用 content 原文。 */
  browserAmbientContext?: ZodyBrowserAmbientContext;
  clientMode?: ZodyTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  // fork（bot channels 移除，specs/bot-channels-removal.md）：botDeliveryTarget 回推地址
  // 随第三方 IM bot 接入整体删除；sendPrompt 不再承载 bot 回推语义。
}

export type ZodyAgentSendPromptParams = ZodyAgentSendPromptParamsBase &
  ZodyBackgroundTurnAttribution;

export interface ZodyAgentCompactParams extends ZodyAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface ZodyAgentGoalParams extends ZodyAgentSessionTarget {
  inputId?: string;
  action: ZodySessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface ZodyAgentSetModelParams extends ZodyAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZodyAgentSetThoughtLevelParams extends ZodyAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZodyAgentSetModeParams extends ZodyAgentSessionTarget {
  mode: ZodySessionMode;
  expectedRevision?: number;
}

export interface ZodyAgentGenerateWorkspaceTextParams extends ZodyAgentWorkspaceTarget {
  selection: ZodyWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: ZodyWorkspaceGenerateTextParams["messages"];
  tools?: ZodyWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * 协议层 RPC 超时。thinking 模型的长请求会超过协议 client 默认的
   * 3 分钟；调用方必须把自身 deadline 透传到这里，否则默认超时先触发、
   * 还会被 onRequestTimeout 误判 stale 杀进程。
   */
  requestTimeoutMs?: number;
}

export interface ZodyAgentTestModelConnectivityParams extends ZodyAgentWorkspaceTarget {
  selection: ZodyProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

// 合并时曾混用 Agent 完整鉴权响应；UI 只能回传请求校验，账号鉴权必须由 Host 合成。
export type ProviderRuntimeHeadersUiResponse =
  | { headersApplied: true; runtimeProviderHeaders: Record<string, string>; errorMessage?: string }
  | { headersApplied: false; errorMessage?: string };

export interface ZodyAgentRespondProviderRuntimeHeadersParams extends ZodyAgentSessionTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface ZodyAgentSessionRuntimePreferencesRequest extends ZodySessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface ZodyAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: ZodySessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface ZodyAgentSessionSubscribeParams extends ZodyAgentSessionTarget {
  deliveryKind: ZodyDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  /** Passive observers may replay an existing runtime without spawning one. */
  runtimePolicy?: ZodyAgentRuntimePolicy;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// ── v4 conversation 通道（竖切）──
// host 只做转发：subscribe/unsubscribe/command 透传给 CLI v4 gateway，
// v4/conversation/frame 通知按 workspace fan-out 给 renderer。

export interface ZodyAgentConversationSubscribeParams extends ZodyAgentSessionTarget {
  /** 水位不变量：仅当客户端真持有该时刻一致状态才允许带。 */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface ZodyAgentConversationUnsubscribeParams extends ZodyAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: ZodyAgentRuntimePolicy;
}

export interface ZodyAgentConversationResyncParams extends ZodyAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: ZodyAgentRuntimePolicy;
}

/** 行分页 query（rows/range）：按游标向上取一窗历史行。 */
export interface ZodyAgentConversationRowsRangeParams extends ZodyAgentSessionTarget {
  /** 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。 */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** 当前有效分支里的终态 ExitPlanMode 目录。 */
export type ZodyAgentConversationPlansParams = ZodyAgentSessionTarget;

/** workflow run 的事件日志分页（详情页审计面）；cursor = journal sequence。 */
export interface ZodyAgentConversationWorkflowRunEventsParams extends ZodyAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** dwf run 的枚举（重启后的发现查询）。 */
export interface ZodyAgentConversationWorkflowRunsParams extends ZodyAgentSessionTarget {
  limit?: number;
}

// ── dwf 用户面产物──
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出（文件 / markdown / 预置看板），
// 不是 run 的顶层返回值（引擎内部对后者的同名叫法）。

/** 产物清单；UI 冷恢复与中枢详情的 durable 读法。 */
export interface ZodyAgentConversationWorkflowRunArtifactsParams extends ZodyAgentSessionTarget {
  runId: string;
}

/** 预置看板的取数面；cursor = journal sequence（严格大于）。 */
export interface ZodyAgentConversationWorkflowRunArtifactDataParams extends ZodyAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** 内容产物的字节，一次一块（≤ 512 KiB，形状逐字照 attachmentRead）。 */
export interface ZodyAgentConversationWorkflowRunArtifactReadParams extends ZodyAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── dwf 工作区 transcript──
/** 轻行清单：一个 run 的 files.* / git.* / world.run 行，不带正文。 */
export interface ZodyAgentConversationWorkflowRunWorkspaceParams extends ZodyAgentSessionTarget {
  runId: string;
}

/** 一个工作区节点的正文，按 maxBytes 保形有界化（缺省与上限在 CLI 网关侧）。 */
export interface ZodyAgentConversationWorkflowRunNodeResultParams extends ZodyAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface ZodyAgentBackgroundBashOutputParams extends ZodyAgentSessionTarget {
  workId: string;
}

export interface ZodyAgentConversationFileChangesParams extends ZodyAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZodyAgentConversationFileRewindPreviewParams extends ZodyAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZodyAgentConversationCommandParams extends ZodyAgentWorkspaceTarget {
  envelope: CommandEnvelope;
  /** 仅 host 内部用于 Browser Use runtime 边界，不进入 v4 wire envelope。 */
  clientMode?: ZodyTaskClientMode;
}

export interface ZodyAgentCommandsQueryParams extends ZodyAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI 不携带 connectionId；connection scope 以 trusted carrier 注入 wire identity。 */
export interface ZodyAgentAttachmentBeginParams extends ZodyAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface ZodyAgentAttachmentChunkParams extends ZodyAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface ZodyAgentAttachmentTerminalParams extends ZodyAgentSessionTarget {
  uploadId: string;
}

export interface ZodyAgentAttachmentReadParams extends ZodyAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface ZodyAgentConversationAttachmentReadParams extends ZodyAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface ZodyAgentConversationAttachmentStatParams extends ZodyAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface ZodyAgentAttachmentPreviewSourceParams extends ZodyAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** host scope 内部 transport 控制面；connectionId 只能经 trusted carrier 注入。 */
export interface ZodyAgentConnectionFlowParams extends ZodyAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index：workspace 级列表订阅（无 sessionId 维度）。 */
export interface ZodyAgentSessionsIndexSubscribeParams extends ZodyAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * 订阅者作用域后缀：CLI 侧重订阅替换按 (connectionId, topic) 判定，
   * host 进程内多个独立消费者（renderer 侧栏 / task-index syncer）订阅同一 topic 时
   * 必须用不同 connectionId，否则互相替换对方的订阅代际。缺省共享 host 连接 id。
   */
  subscriberScope?: string;
  /**
   * task-list 等被动观察者必须使用 existing-only；runtime 不存在时返回稳定 unavailable，
   * 禁止为了建立列表订阅而启动 Agent。缺省保持显式会话入口的旧行为。
   */
  runtimePolicy?: ZodyAgentRuntimePolicy;
}

/** workspace-config：workspace 级配置目录订阅（config options + slash 目录）。 */
export interface ZodyAgentWorkspaceConfigSubscribeParams extends ZodyAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: ZodyAgentRuntimePolicy;
}

export type ZodyAgentServiceEvent =
  | { type: "session.event"; event: ZodySessionEvent; recovered?: boolean }
  | { type: "state.updated"; notification: ZodyStateUpdatedNotification }
  | { type: "permission.request"; request: ZodyPermissionRequestParams }
  | { type: "userInput.request"; request: ZodyUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ZodyUserInputResponse;
    }
  | { type: "providerRuntimeHeaders.request"; request: ZodyProviderRuntimeHeadersRequestParams }
  | { type: "snapshot"; snapshot: ZodySessionStateSnapshot };

export interface ZodyAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface ZodyAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: ZodyProcessChildProcess[];
}

export interface ZodyAgentStorageStartupSnapshot {
  generation: number;
  state: ZodyStorageStartupState | null;
}

export interface IZodyAgentService {
  /** 控制面不需要账号或模型，且不发送普通协议请求。 */
  prepareStorage(params: ZodyAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: ZodyAgentWorkspaceTarget,
  ): Promise<ZodyAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: ZodyAgentWorkspaceTarget,
  ): Event<ZodyAgentStorageStartupSnapshot>;
  initialize(params: ZodyAgentWorkspaceTarget): Promise<ZodyAgentInitializeResult>;
  /**
   * 同步 App 全局运行时偏好到所有已活动 workspace；不得为此启动空闲 Agent。
   */
  syncAppRuntimePreferences(preferences: ZodyAgentAppRuntimePreferences): Promise<void>;
  /**
   * 动态工作流用户选择变化的信号（docs/dynamic-workflow/launch.md「The user's choice」）：Host 重新计算
   * 生效模式并串行重发 workspace/updateDynamicWorkflowPolicy。有本机设置权威的 Host 以设置文件为准；
   * desktop-attached remote Host 以传入值为准（缺席 = 跟随服务端）。不得为此启动空闲 Agent。
   */
  syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: ZodyAgentWorkspaceTarget,
  ): Promise<ZodyAgentWorkspaceRuntimeIdentity>;
  createSession(params: ZodyAgentCreateSessionParams): Promise<ZodySessionStateSnapshot>;
  resumeSession(params: ZodyAgentResumeSessionParams): Promise<ZodySessionStateSnapshot>;
  listSessions(params: ZodyAgentListSessionsParams): Promise<ZodySessionInfo[]>;
  listSessionSubagents(
    params: ZodyAgentListSessionSubagentsParams,
  ): Promise<ZodySessionSubagentsResult>;
  getAppUsageStats(params: ZodyAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: ZodyAgentTaskTokenUsageParams): Promise<ZodyTaskTokenUsageResult>;
  readSession(params: ZodyAgentReadSessionParams): Promise<ZodySessionStateSnapshot>;
  readSessionMessages(
    params: ZodyAgentReadSessionMessagesParams,
  ): Promise<ZodyMessageWithParts[]>;
  readSessionDebug(params: ZodyAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: ZodyAgentReadSessionEventsParams): Promise<ZodySessionEvent[]>;
  readWorkspacePresentation(
    params: ZodyAgentReadWorkspacePresentationParams,
  ): Promise<ZodyWorkspacePresentation>;
  /** 无 task/session 的 Settings 预信任；Agent 会重新发现并校验 canonical snapshot。 */
  grantWorkspaceHookTrust(
    params: ZodyAgentGrantWorkspaceHookTrustParams,
  ): Promise<ZodyWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: ZodyAgentListMcpServerStatusesParams): Promise<ZodyMcpListResult>;
  listPlugins(params: ZodyAgentPluginViewParams): Promise<ZodyPluginsListResult>;
  /**
   * Plugin 对话引用 catalog：session-scoped 只读投影。
   * 走 workspace 级 agent client（session 记录只存在于该进程），不走独立插件管理进程。
   */
  getPluginReferenceCatalog(
    params: ZodyAgentPluginReferenceCatalogParams,
  ): Promise<ZodyPluginsReferenceCatalogResult>;
  /** Composer Skill 引用 catalog；带 sessionId 时读取该 runtime 的冻结快照。 */
  getSkillReferenceCatalog(
    params: ZodyAgentSkillReferenceCatalogParams,
  ): Promise<ZodySkillsReferenceCatalogResult>;
  /** 插件 UI：读取插件 MCP 的 `ui://` 资源；走 session 所在 workspace agent 进程。 */
  openMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPrepareSandboxParams & {
      accountContext?: string;
    },
  ): Promise<import("@zody/shared/mcp-apps").McpAppInstance>;
  validateMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  recycleMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<boolean>;
  closeMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  readMcpResource(params: ZodyAgentReadMcpResourceParams): Promise<ZodyMcpReadResourceResult>;
  /** 插件 UI：UI 发起的工具调用；复用既有权限审批，不产生 transcript row。 */
  sampleMcpApp(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiSamplingParams,
  ): Promise<import("@zody/shared/mcp-apps").McpAppsSamplingResult>;
  cancelMcpAppSampling(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiCancelSamplingParams,
  ): Promise<{ cancelled: boolean }>;
  callMcpToolForUi(params: ZodyAgentCallMcpToolForUiParams): Promise<ZodyMcpUiCallToolResult>;
  /** 插件 UI 取消带 callId 的进行中 UI 工具调用；agent 侧 abort 到 MCP client。 */
  cancelMcpToolCallForUi(
    params: ZodyAgentCancelMcpToolCallForUiParams,
  ): Promise<ZodyMcpUiCancelCallResult>;
  /** 插件 UI 页面发起的 `resources/read`，agent 侧限同插件服务器、8 MiB、mimeType 白名单。 */
  readMcpResourceForUi(
    params: ZodyAgentReadMcpResourceForUiParams,
  ): Promise<ZodyMcpUiReadResourceResult>;
  /** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe 代理。 */
  listMcpResourcesForUi(
    params: ZodyAgentListMcpResourcesForUiParams,
  ): Promise<ZodyMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi(
    params: ZodyAgentListMcpResourcesForUiParams,
  ): Promise<ZodyMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi(params: ZodyAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  unsubscribeMcpResourceForUi(params: ZodyAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  /** App-Provided Tools：页面工具登记 / 注销与模型调用的认领 / 回传（信箱投递走 v4 live 增量）。 */
  registerAppToolsForUi(
    params: ZodyAgentRegisterAppToolsForUiParams,
  ): Promise<ZodyMcpUiRegisterAppToolsResult>;
  unregisterAppToolsForUi(
    params: ZodyAgentAppToolInstanceForUiParams,
  ): Promise<ZodyMcpUiUnregisterAppToolsResult>;
  claimAppToolCallForUi(
    params: ZodyAgentAppToolCallForUiParams,
  ): Promise<ZodyMcpUiAppToolAcceptedResult>;
  resolveAppToolCallForUi(
    params: ZodyAgentResolveAppToolCallForUiParams,
  ): Promise<ZodyMcpUiAppToolAcceptedResult>;
  /** 插件 UI 工作区级面板入口（已启用插件清单 `ui.surfaces[]`）。 */
  listPluginUiSurfaces(
    params: ZodyAgentWorkspaceTarget,
  ): Promise<ZodyPluginsListUiSurfacesResult>;
  // 已保存工作流的 GUI 中枢：workspace 级、无会话，每次调用现扫 `<cwd>/.zody/workflows/`。
  // 全局档传 `scope: "global"`：带 workspace 就用它当载体，不带则由 services 层自选本机载体运行时。
  listSavedWorkflows(params: ZodyAgentListSavedWorkflowsParams): Promise<ZodyWorkflowsListResult>;
  getSavedWorkflow(params: ZodyAgentGetSavedWorkflowParams): Promise<ZodyWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: ZodyAgentUpdateSavedWorkflowMetaParams,
  ): Promise<ZodyWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: ZodyAgentDeleteSavedWorkflowParams,
  ): Promise<ZodyWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: ZodyAgentListSavedWorkflowRunsParams,
  ): Promise<ZodyWorkflowsRunsResult>;
  // 在项目档 / 全局档之间移动同名文件：
  // `workspace` 是载体（移到项目传目标项目、移到全局传源项目），`to` 是落点档；不覆盖已存在的目标。
  moveSavedWorkflow(params: ZodyAgentMoveSavedWorkflowParams): Promise<ZodyWorkflowsMoveResult>;
  // 完成卡的「直接保存」（docs/dynamic-workflow/transcript-and-notifications.md）：按 runId 从
  // journal 取这次 run 实际跑过的脚本落盘，不经模型回合。两者都必带 workspace（journal 在那里）。
  saveSavedWorkflowFromRun(
    params: ZodyAgentSaveSavedWorkflowFromRunParams,
  ): Promise<ZodyWorkflowsSaveResult>;
  /** 这次 run 对应哪个已保存工作流（推导，不记忆）；顺带回 run 的实参供「再次运行」预填。 */
  findSavedWorkflowForRun(
    params: ZodyAgentFindSavedWorkflowForRunParams,
  ): Promise<ZodyWorkflowsForRunResult>;
  resolveSuggestedPluginReference(
    params: ZodyAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zody/shared").ZodyPluginsResolveSuggestedReferenceResult>;
  /** 推荐项 Plugin 首次本地检查缺失后的 operation-scoped 刷新进度。 */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZodyPluginOperationProgressNotification>;
  getPluginsOverview(params: ZodyAgentPluginViewParams): Promise<ZodyPluginsOverviewResult>;
  /**
   * 资源管理器：枚举本 Host 内全部本地 Agent 进程（含 plugin / mcp-status 泳道），
   * 并向每个存活 runtime 请求 `process/childProcesses`；单个 runtime 失败只让它的 children 为空。
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<ZodyAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: ZodyAgentAddPluginMarketplaceParams,
  ): Promise<ZodyPluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZodyAgentRemovePluginMarketplaceParams,
  ): Promise<ZodyPluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZodyAgentUpdatePluginMarketplaceParams,
  ): Promise<ZodyPluginsMarketplaceMutationResult>;
  installPlugin(params: ZodyAgentInstallPluginParams): Promise<ZodyPluginsInstallResult>;
  cancelPluginOperation(
    params: ZodyAgentCancelPluginOperationParams,
  ): Promise<ZodyPluginsCancelOperationResult>;
  uninstallPlugin(params: ZodyAgentUninstallPluginParams): Promise<ZodyPluginsUninstallResult>;
  updatePlugin(params: ZodyAgentUpdatePluginParams): Promise<ZodyPluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZodyAgentRestoreBuiltinPluginParams,
  ): Promise<ZodyPluginsRestoreBuiltinResult>;
  configurePlugin(params: ZodyAgentConfigurePluginParams): Promise<ZodyPluginsConfigureResult>;
  resetPluginConfig(
    params: ZodyAgentResetPluginConfigParams,
  ): Promise<ZodyPluginsConfigureResult>;
  validatePlugin(params: ZodyAgentValidatePluginParams): Promise<ZodyPluginsValidateResult>;
  describePlugin(params: ZodyAgentDescribePluginParams): Promise<ZodyPluginsDescribeResult>;
  setPluginEnabled(params: ZodyAgentSetPluginEnabledParams): Promise<ZodyPluginsSetEnabledResult>;
  // ---- 定时任务(automation)管理 ----
  listAutomations(params: ZodyAgentWorkspaceTarget): Promise<ZodyAutomation[]>;
  listAllAutomations(): Promise<ZodyAutomation[]>;
  createAutomation(params: ZodyAgentCreateAutomationParams): Promise<ZodyAutomation>;
  updateAutomation(params: ZodyAgentUpdateAutomationParams): Promise<ZodyAutomation | null>;
  deleteAutomation(params: ZodyAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: ZodyAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: ZodyAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: ZodyAgentAutomationIdParams): Promise<ZodyAgentRunAutomationNowResult>;
  listAutomationRuns(params: ZodyAgentAutomationIdParams): Promise<ZodyAutomationRun[]>;
  deleteAutomationRun(params: ZodyAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: ZodyAgentGenerateWorkspaceTextParams,
  ): Promise<ZodyWorkspaceGenerateTextResult>;
  testModelConnectivity(
    params: ZodyAgentTestModelConnectivityParams,
  ): Promise<ZodyProviderTestModelConnectivityResult>;
  /**
   * @deprecated：send 主路径已收敛 v4 sendText 命令。仅剩 adapter 带附件输入回退（待附件命令面落地后移除）；新代码禁止回用。
   */
  sendPrompt(params: ZodyAgentSendPromptParams): Promise<ZodySessionSendResult>;
  compactSession(params: ZodyAgentCompactParams): Promise<ZodySessionCompactResult>;
  goalSession(params: ZodyAgentGoalParams): Promise<ZodySessionGoalResult>;
  closeSession(
    params: ZodyAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  setModel(params: ZodyAgentSetModelParams): Promise<ZodySessionStateSnapshot>;
  setThoughtLevel(params: ZodyAgentSetThoughtLevelParams): Promise<ZodySessionStateSnapshot>;
  setMode(params: ZodyAgentSetModeParams): Promise<ZodySessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: ZodyAgentRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  respondSessionRuntimePreferences(
    params: ZodyAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  /**
   * v4 UI 的 Start Plan runtime-auth bridge 只需要本地 pending request 事件，
   * 不能为此额外打开旧 `session/subscribe`，否则会把旧 replay/continuous 读路径
   * 重新带回 v4 pane。
   */
  onDynamicProviderRuntimeHeadersRequest(
    params: ZodyAgentSessionTarget,
  ): Event<ZodyProviderRuntimeHeadersRequestParams>;
  /**
   * Start Plan runtime headers 的 workspace 级订阅入口（生产应答方使用）。
   * Bug 原因（2026-08-16 web 远控卡死）：session 级入口只随桌面 pane 挂载订阅，
   * web 远控新建会话在桌面没有 pane、web 端无应答方，请求校验请求滞留 pending，
   * 任务永久「工作中」。桌面窗口用本入口为每个打开的 workspace tab 维持常驻应答方；
   * 订阅时先注册 live listener 再按 workspaceKey 前缀补投 pending，与 session 级同语义。
   */
  onDynamicWorkspaceProviderRuntimeHeadersRequest(
    params: ZodyAgentWorkspaceTarget,
  ): Event<ZodyProviderRuntimeHeadersRequestParams>;
  /** 只投递本 workspace 的校验取消，不属于 conversation stream。 */
  onDynamicWorkspaceProviderRuntimeHeadersCancelled(
    params: ZodyAgentWorkspaceTarget,
  ): Event<ZodyProviderRuntimeHeadersCancelled>;
  onDynamicSessionRuntimePreferencesRequest(): Event<ZodyAgentSessionRuntimePreferencesRequest>;
  /**
   * CLI 进程级资源样本，带 services 打的 lane 标签（CLI 自己不知道 lane）。
   * 使用 dynamic event 避免 RPC 服务在无人订阅时缓冲周期事件；
   * 该事件不属于 session/conversation continuous 或 replayable 状态。
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP 进程生命周期与低频内存事件，仅供可信 Host relay 上报 ARMS。 */
  onDynamicMcpTelemetry(): Event<ZodyMcpTelemetryEvent>;
  /** MCP 进程树资源事实，只供可信 Host 汇总上报。 */
  onDynamicMcpResourceSamples(): Event<ZodyMcpResourceSample[]>;
  /** Bash 完成事实，仅可信 Host 资源旁路订阅。 */
  onDynamicToolExecResource(): Event<ZodyToolExecResource>;
  /**
   * @deprecated 旧协议订阅面（session/subscribe + session/event + state.updated）。
   * task-index syncer 已迁 v4 sessions-index/workspace-config 帧；
   * 仅剩 zcodeTaskServiceAdapter.onDynamicTaskEvent（replayable 读路径）消费。
   * 写路径已收敛 v4 命令面；本订阅是读路径投影源。
   */
  onDynamicSessionEvent(params: ZodyAgentSessionSubscribeParams): Event<ZodyAgentServiceEvent>;
  // ── v4 conversation 通道（竖切）──
  /** RPC attachment 建立后先读取 host 可信 hello。 */
  helloConversationV4(): Promise<HelloMessage>;
  /** hello 校验后回送 clientHello；metadata 不能覆盖 connection mode/profile。 */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** 仅供 trusted host relay/facade；terminal RPC caller 必须被 connection scope 拒绝。 */
  setConnectionFlowStateV4(params: ZodyAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: ZodyAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: ZodyAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: ZodyAgentConversationUnsubscribeParams): Promise<void>;
  /** rows/range 行分页 query（loadOlder 游标向上补历史）。 */
  conversationRowsRangeV4(
    params: ZodyAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: ZodyAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** workflow run 事件日志分页；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunEventsV4(
    params: ZodyAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** workflow run 枚举；journal-backed 的重启后发现面。 */
  conversationWorkflowRunsV4(
    params: ZodyAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** workflow run 的用户面产物清单；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunArtifactsV4(
    params: ZodyAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页；hook 以 itemCount 变化为信号增量拉取。 */
  conversationWorkflowRunArtifactDataV4(
    params: ZodyAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块；授权在 CLI 侧（journal 行才是取字节的依据）。 */
  conversationWorkflowRunArtifactReadV4(
    params: ZodyAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** dwf 工作区 transcript 的清单。 */
  conversationWorkflowRunWorkspaceV4(
    params: ZodyAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** 一个工作区节点的有界正文。 */
  conversationWorkflowRunNodeResultV4(
    params: ZodyAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: ZodyAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: ZodyAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: ZodyAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: ZodyAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: ZodyAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: ZodyAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ZodyAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ZodyAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: ZodyAgentAttachmentTerminalParams): Promise<void>;
  /** Desktop local 已发送视频 source query；远端与 Web 返回 chunked。 */
  attachmentPreviewSourceV4(
    params: ZodyAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** 已发送 image/video 只读分块查询；connection scope 注入可信 workspace 连接。 */
  attachmentReadV4(params: ZodyAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Share 读取 userInput 附件，允许 text/plain 等非媒体类型。 */
  conversationAttachmentReadV4(
    params: ZodyAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** Share 选择阶段只读 userInput 附件元数据，不读取完整内容。 */
  conversationAttachmentStatV4(
    params: ZodyAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** workspace 级下行帧流（v4/conversation/frame），renderer 侧按 topic 自行路由。 */
  onDynamicConversationFrame(
    params: ZodyAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** workspace 级 live telemetry 事实；connection facade 仅向可信 desktop-continuous 下游暴露。 */
  onDynamicLocalTtftFacts(
    params: ZodyAgentWorkspaceTarget,
  ): Event<import("@zody/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: ZodyAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** 当前窗口全部本地 live task 的 CUA 权限观察；历史、远程与 replayable 不在此事件面。 */
  onDynamicCuaPermissionObservation(): Event<ZodyAgentCuaPermissionObservation>;
  // ── sessions-index 通道（列表活性）──
  subscribeSessionsIndexV4(
    params: ZodyAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: ZodyAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: ZodyAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 sessions-index 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicSessionsIndexFrame(
    params: ZodyAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config 通道（配置目录活性；task-index syncer 消费）──
  subscribeWorkspaceConfigV4(
    params: ZodyAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: ZodyAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: ZodyAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 workspace-config 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicWorkspaceConfigFrame(
    params: ZodyAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * （CLI 重连重订）：agent 进程换代通知（超时回收/崩溃后重新拉起）。
   * v4 订阅活在 CLI 进程内存，进程换代即失效；订阅方（task-index syncer 等）
   * 收到后必须对该 workspaceKey 重发 subscribe，否则帧流静默中断。
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Agent client 在 service 内完成登记后发布 available，当前 client 关闭后发布 unavailable。
   * 这是被动 observer attach/detach 的唯一生命周期信号，不表达用户使用租约。
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: ZodyAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** 当前 desktop-local CUA turn 是否仍在执行，用于 Helper recovery 避免中途回收 Agent。 */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: ZodyAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const IZodyAgentService = createServiceDescriptor<IZodyAgentService>(
  ServiceChannels.ZCodeAgent,
);
