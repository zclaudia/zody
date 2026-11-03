import { ServiceChannels } from "@zody/shared";
import type {
  TraceId,
  ZodyAgentMcpServer,
  ZodyDeliveryKind,
  ZodyMessageWithParts,
  ModelSelection,
  ZodyPermissionRequestParams,
  ZodyProviderRuntimeHeadersRequestParams,
  ZodyUserInputRequestParams,
  ZodyUserInputResponse,
  ZodySessionInfo,
  ZodySessionImportHistory,
  ZodySessionEvent,
  ZodySessionMode,
  ZodySessionPersistence,
  ZodySessionStateSnapshot,
  ZodyStateUpdatedNotification,
  ZodyWorkspacePresentation,
} from "@zody/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { ProviderRuntimeHeadersUiResponse } from "#src/zody-agent/zodyAgent.js";

export interface ZodySessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type ZodySessionReadWorkspacePresentationParams = ZodySessionWorkspaceTarget;

export interface ZodyTaskTarget extends ZodySessionWorkspaceTarget {
  sessionId: string;
}

export interface ZodySessionCreateParams extends ZodySessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZodySessionMode;
  model?: ModelSelection;
  persistence?: ZodySessionPersistence;
  thoughtLevel?: string;
  mcpServers?: ZodyAgentMcpServer[];
  importedHistory?: ZodySessionImportHistory;
}

export interface ZodySessionResumeParams extends ZodyTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZodyAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface ZodySessionListParams extends ZodySessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface ZodySessionReadParams extends ZodyTaskTarget {
  deliveryKind?: ZodyDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface ZodySessionMessagesParams extends ZodyTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZodySessionEventsParams extends ZodyTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface ZodySessionSetModelParams extends ZodyTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZodySessionSetThoughtLevelParams extends ZodyTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZodySessionSetModeParams extends ZodyTaskTarget {
  mode: ZodySessionMode;
  expectedRevision?: number;
}

export interface ZodySessionRespondProviderRuntimeHeadersParams extends ZodyTaskTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface ZodySessionSubscribeParams extends ZodyTaskTarget {
  deliveryKind: ZodyDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type ZodySessionServiceEvent =
  | { type: "session.event"; event: ZodySessionEvent }
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

export interface ZodySessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZodySessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface IZodySessionService {
  initializeWorkspace(params: ZodySessionWorkspaceTarget): Promise<ZodySessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: ZodySessionWorkspaceTarget,
  ): Promise<ZodySessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: ZodySessionReadWorkspacePresentationParams,
  ): Promise<ZodyWorkspacePresentation>;
  createSession(params: ZodySessionCreateParams): Promise<ZodySessionStateSnapshot>;
  resumeSession(params: ZodySessionResumeParams): Promise<ZodySessionStateSnapshot>;
  listSessions(params: ZodySessionListParams): Promise<ZodySessionInfo[]>;
  readSession(params: ZodySessionReadParams): Promise<ZodySessionStateSnapshot>;
  readSessionMessages(params: ZodySessionMessagesParams): Promise<ZodyMessageWithParts[]>;
  readSessionEvents(params: ZodySessionEventsParams): Promise<ZodySessionEvent[]>;
  promoteDeferredDraftSession(params: ZodyTaskTarget): Promise<void>;
  closeSession(params: ZodyTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: ZodyTaskTarget): Promise<boolean>;
  setModel(params: ZodySessionSetModelParams): Promise<ZodySessionStateSnapshot>;
  setThoughtLevel(params: ZodySessionSetThoughtLevelParams): Promise<ZodySessionStateSnapshot>;
  setMode(params: ZodySessionSetModeParams): Promise<ZodySessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: ZodySessionRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  // M5 删波次 2：onDynamicSessionEvent（旧 session/subscribe 词表的 renderer 订阅面）
  // 已删除——v4 UI 走 agentService 的 conversation/sessions-index 帧通道，
  // 该方法在 renderer 侧已无任何调用者（grep packages/ui packages/desktop 为零）。
}

export const IZodySessionService = createServiceDescriptor<IZodySessionService>(
  ServiceChannels.ZCodeSession,
);
