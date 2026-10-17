import type { MobileSessionCreateTelemetry } from "./sessionCreateTelemetry.js";
/* eslint-disable max-lines -- Web 远程控制共享协议同时维护 app payload 与 payload 类型，后续拆分时再按 transport/app payload 分文件。 */
import type { DockerContainerInfo, SSHConfigAliasOption, WSLDistro } from "./platform.js";
import type {
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
} from "./platform.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { SessionWorkflowActivity } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import type { WebRemoteControlRpcTransportPayload } from "./web-remote-control-rpc-transport.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";

export const WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS = 120_000;
export const WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS = 5_000;

export type WebRemoteControlThemeSeed = "light" | "dark" | "zai-light" | "zai-dark" | "system";

export interface WebRemoteControlContext {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlThemeSeed;
}

export type WebRemoteControlStatusKind =
  | "idle"
  | "starting"
  | "running"
  | "connecting"
  | "active"
  | "error";

/**
 * 手机远控失败原因（spec「失败原因与恢复」）。
 *
 * gateway 链路删除了 relay 专属的 `session-not-found`、`session-expired`、
 * `invalid-mobile-connection`、`relay-unavailable`，新增：
 * - `gateway-unreachable`：控制连接持续失败超过 30 秒（可恢复）；
 * - `gateway-credential-invalid`：首次 connect 被 UNAUTHORIZED 拒绝，或关闭后复核得到 401/403（终态）；
 * - `incompatible-version`：收到 `close{incompatible-version}`（终态，按 `upgrade` 提示升级一端）；
 * - `backend-unsupported`：选中的电脑在线但 registry 能力位里没有 `zcode-remote-control`（终态）。
 */
export type WebRemoteControlFailureReason =
  | "session-conflict"
  | "workspace-closed"
  | "desktop-disconnected"
  | "desktop-bootstrap-timeout"
  | "connection-recovery-timeout"
  | "gateway-unreachable"
  | "gateway-credential-invalid"
  | "incompatible-version"
  | "backend-unsupported"
  | "unsupported-action"
  | "unexpected-error";

export interface WebRemoteControlFailure {
  reason: WebRemoteControlFailureReason;
  message?: string;
  /**
   * `incompatible-version` 时指明需要升级的一端：来自 channel `close{incompatible-version, upgrade}`。
   * `mobile` 表示手机 App 太旧，`desktop` 表示电脑端需要升级。
   */
  upgrade?: "mobile" | "desktop";
}

export function createWebRemoteControlConnectionRecoveryTimeoutFailure(
  message: string,
): WebRemoteControlFailure {
  return {
    // Bugfix: 手机端长时间后台后恢复超时，真实问题是手机连接未恢复，
    // 不能映射成 desktop-disconnected，否则错误页会误导用户以为电脑端离线。
    reason: "connection-recovery-timeout",
    message,
  };
}

export interface WebRemoteControlMobileViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface WebRemoteControlMobileScreenInfo {
  width: number;
  height: number;
}

export interface WebRemoteControlMobileDeviceInfo {
  /** 手机浏览器上报的 platform/version/name，仅用于桌面展示。 */
  platform: string;
  version: string;
  name: string;
  userAgent?: string;
  language?: string;
  languages?: string[];
  browserPlatform?: string;
  viewport?: WebRemoteControlMobileViewportInfo;
  screen?: WebRemoteControlMobileScreenInfo;
  timezone?: string;
  online?: boolean;
  updatedAt: number;
}

export function isWebRemoteControlThemeSeed(value: unknown): value is WebRemoteControlThemeSeed {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "system"
  );
}

export interface WebRemoteControlStatus {
  status: WebRemoteControlStatusKind;
  mobileConnected?: boolean;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  error?: string;
  failure?: WebRemoteControlFailure;
}

export interface WebRemoteControlPlatformMethodArgsMap {
  isDockerAvailable: undefined;
  listWSLDistros: undefined;
  listDockerContainers: undefined;
  listSSHConfigAliases: undefined;
  createTempTextAttachment: CreateTempTextAttachmentRequest;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryRequest | undefined;
  saveMcpToUserDirectory: SaveCliMcpToUserDirectoryRequest;
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpRequest | undefined;
}

export interface WebRemoteControlPlatformMethodResultMap {
  isDockerAvailable: boolean;
  listWSLDistros: WSLDistro[];
  listDockerContainers: DockerContainerInfo[];
  listSSHConfigAliases: SSHConfigAliasOption[];
  createTempTextAttachment: CreateTempTextAttachmentResult;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryResult;
  saveMcpToUserDirectory: { success: boolean; error?: string };
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpResult;
}

export type WebRemoteControlPlatformMethod = keyof WebRemoteControlPlatformMethodResultMap;

export type WebRemoteControlPlatformRequest = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

export type WebRemoteControlPlatformSuccessResponse = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-response";
    requestId: string;
    method: K;
    success: true;
    result: WebRemoteControlPlatformMethodResultMap[K];
  };
}[WebRemoteControlPlatformMethod];

export interface WebRemoteControlPlatformErrorResponse {
  type: "platform-response";
  requestId: string;
  method: WebRemoteControlPlatformMethod;
  success: false;
  error: string;
}

export type WebRemoteControlPlatformResponse =
  | WebRemoteControlPlatformSuccessResponse
  | WebRemoteControlPlatformErrorResponse;

export interface WebRemoteControlExternalLocalWorkspaceBridge {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
}

export interface WebRemoteControlExternalRemoteWorkspaceBridge {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
}

export type WebRemoteControlExternalWorkspaceBridge =
  | WebRemoteControlExternalLocalWorkspaceBridge
  | WebRemoteControlExternalRemoteWorkspaceBridge;

export interface WebRemoteControlBootstrapRequestPayload {
  zcode_type: "bootstrap-request";
  requestId: string;
}

export interface WebRemoteControlBootstrapResponsePayload {
  zcode_type: "bootstrap-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWindowBootstrapResult;
}

export interface WebRemoteControlWorkspaceListRequestPayload {
  zcode_type: "workspace-list-request";
  requestId: string;
}

export interface WebRemoteControlWorkspaceListResponsePayload {
  zcode_type: "workspace-list-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceListUpdatedPayload {
  zcode_type: "workspace-list-updated";
  result: WebRemoteControlWorkspaceListResult;
}

/** 桌面是否有可接收打开请求的主窗口。 */
export type WebRemoteControlDesktopWindowState = "open" | "none";

/**
 * 最近项目条目。`id` 是桌面在本次进程会话内生成的不透明标识，不携带路径；
 * 手机只能用当前列表里出现过的 id 发起打开请求，不能自行构造路径。
 */
export interface WebRemoteControlRecentProjectTarget {
  id: string;
  /** 目录名，仅用于展示。 */
  label: string;
  /** 父路径，仅用于展示。 */
  location: string;
}

export interface WebRemoteControlRecentProjectsResult {
  desktopWindowState: WebRemoteControlDesktopWindowState;
  recentProjects: WebRemoteControlRecentProjectTarget[];
}

export interface WebRemoteControlRecentProjectsUpdatedPayload {
  zcode_type: "recent-projects-updated";
  result: WebRemoteControlRecentProjectsResult;
}

export interface WebRemoteControlWorkspaceOpenRequestPayload {
  zcode_type: "workspace-open-request";
  requestId: string;
  /** 必须来自桌面最近一次下发的列表；手机不传路径。 */
  recentProjectId: string;
}

export type WebRemoteControlWorkspaceOpenResponsePayload =
  | {
      zcode_type: "workspace-open-response";
      requestId: string;
      success: true;
      /** 打开成功后该 workspace 在聚合列表里的 key。 */
      workspaceKey: string;
    }
  | {
      zcode_type: "workspace-open-response";
      requestId: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlDesktopWindowOpenRequestPayload {
  zcode_type: "desktop-window-open-request";
  requestId: string;
}

export type WebRemoteControlDesktopWindowOpenResponsePayload =
  | {
      zcode_type: "desktop-window-open-response";
      requestId: string;
      success: true;
    }
  | {
      zcode_type: "desktop-window-open-response";
      requestId: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlWorkspaceBridgeOpenPayload {
  zcode_type: "workspace-bridge-open";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceBridgeReadyPayload {
  zcode_type: "workspace-bridge-ready";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  bridge: WebRemoteControlExternalWorkspaceBridge;
}

export interface WebRemoteControlWorkspaceBridgeErrorPayload {
  zcode_type: "workspace-bridge-error";
  requestId: string;
  bridgeSessionId?: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export interface WebRemoteControlWorkspaceReconnectRequestPayload {
  zcode_type: "workspace-reconnect-request";
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlWorkspaceReconnectResponsePayload =
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlMobileViewStatePayload {
  zcode_type: "mobile-view-state-update";
  viewState: WebRemoteControlMobileViewState;
  deviceInfo?: WebRemoteControlMobileDeviceInfo;
}

export type WebRemoteControlPlatformRequestPayload = {
  [K in WebRemoteControlPlatformMethod]: {
    zcode_type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

export type WebRemoteControlPlatformResponsePayload =
  | {
      [K in WebRemoteControlPlatformMethod]: {
        zcode_type: "platform-response";
        requestId: string;
        method: K;
        success: true;
        result: WebRemoteControlPlatformMethodResultMap[K];
      };
    }[WebRemoteControlPlatformMethod]
  | {
      zcode_type: "platform-response";
      requestId: string;
      method: WebRemoteControlPlatformMethod;
      success: false;
      error: string;
    };

/** @deprecated 仅供 legacy adapter 单测/迁移使用；production parser 自 04D-3 起拒绝。 */
export interface WebRemoteControlRpcFramePayload {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  dataBase64: string;
}

export interface WebRemoteControlBridgeDegradedPayload {
  zcode_type: "bridge-degraded";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason: "rpc-transport-fault" | "rpc-frame-gap" | "buffer-overflow" | "buffer-timeout";
  seq?: number;
  expectedSeq?: number;
  droppedCount?: number;
}

export interface WebRemoteControlAppErrorPayload {
  zcode_type: "app-error";
  requestId?: string;
  bridgeSessionId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export type WebRemoteControlMobileDiagnosticEvent =
  | "state-transition"
  | "socket-close"
  | "socket-error"
  | "recover-start"
  | "recover-scheduled"
  | "failure";

export interface WebRemoteControlMobileDiagnosticPayload {
  zcode_type: "mobile-diagnostic";
  event: WebRemoteControlMobileDiagnosticEvent;
  timestamp: number;
  state?: string;
  previousState?: string;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  failureReason?: WebRemoteControlFailureReason;
  failureMessage?: string;
  visibilityState?: string;
  online?: boolean;
  hiddenDurationMs?: number;
}

export type WebRemoteControlAppPayload =
  | { zcode_type: "telemetry-report"; event: MobileSessionCreateTelemetry }
  | WebRemoteControlBootstrapRequestPayload
  | WebRemoteControlBootstrapResponsePayload
  | WebRemoteControlWorkspaceListRequestPayload
  | WebRemoteControlWorkspaceListResponsePayload
  | WebRemoteControlWorkspaceListUpdatedPayload
  | WebRemoteControlRecentProjectsUpdatedPayload
  | WebRemoteControlWorkspaceOpenRequestPayload
  | WebRemoteControlWorkspaceOpenResponsePayload
  | WebRemoteControlDesktopWindowOpenRequestPayload
  | WebRemoteControlDesktopWindowOpenResponsePayload
  | WebRemoteControlWorkspaceBridgeOpenPayload
  | WebRemoteControlWorkspaceBridgeReadyPayload
  | WebRemoteControlWorkspaceBridgeErrorPayload
  | WebRemoteControlWorkspaceReconnectRequestPayload
  | WebRemoteControlWorkspaceReconnectResponsePayload
  | WebRemoteControlMobileViewStatePayload
  | WebRemoteControlPlatformRequestPayload
  | WebRemoteControlPlatformResponsePayload
  | WebRemoteControlRpcTransportPayload
  | WebRemoteControlBridgeDegradedPayload
  | WebRemoteControlAppErrorPayload
  | WebRemoteControlMobileDiagnosticPayload;

export interface WebRemoteControlWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  workspacePurpose?: WorkspacePurpose;
  kind: "local" | "remote";
  connectionState?: "connected" | "disconnected" | "reconnecting";
  lastConnectionError?: string;
}

export interface WebRemoteControlReconnectWorkspaceRequest {
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlReconnectWorkspaceResult =
  | {
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

export type WebRemoteControlTaskDisplayStatus = "idle" | "running" | "completed" | "error";

export interface WebRemoteControlTaskTarget {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspaceLabel: string;
  workspaceKind: "local" | "remote";
  createdAt: number;
  updatedAt: number;
  provider?: ZCodeProvider;
  unreadAt?: number;
  displayStatus?: WebRemoteControlTaskDisplayStatus;
  // 会话挂着后台工作（动态工作流 run / 后台 bash / 分离子代理）。只参与列表运行层排序，
  // 不影响 displayStatus 图标；缺省视为 false，旧 desktop 快照照常解析。
  hasBackgroundWork?: boolean;
  // 工作流运行摘要（docs/dynamic-workflow/presentation.md「The sidebar run line」）：手机行在标题下
  // 画与桌面一致的运行行。只绘制，不参与排序或状态 pill；无 run 时缺席，旧 desktop 快照照常解析。
  workflowActivity?: SessionWorkflowActivity;
  pinned?: boolean;
  archived?: boolean;
}

export interface WebRemoteControlWorkspaceListResult {
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks?: WebRemoteControlTaskTarget[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

export type WebRemoteControlMobileNavigationIntent = "chat";

export interface WebRemoteControlWorkspaceSwitchOptions {
  taskId?: string;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  /** 仅由手机任务首页使用；目标 bridge 建立后只清除这次快照对应的未读。 */
  markTaskReadExpectedUnreadAt?: number;
}

export interface WebRemoteControlMobileViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface WebRemoteControlWindowBootstrapResult {
  /** 旧 relay 会话标识；gateway 链路只保留固定占位值，手机不使用。 */
  windowControlSessionId: string;
  /** 当前连接的桌面实际版本；旧桌面缺失时手机保留原 URL。 */
  desktopAppVersion?: string;
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks: WebRemoteControlTaskTarget[];
  initialViewState?: WebRemoteControlMobileViewState;
  mobileViewState?: WebRemoteControlMobileViewState;
  // 以下两个字段自 appProtocol 2 起加入。旧对端按协商版本 1 收包时发送方必须省略，
  // 因此这里保持可选；字段引入版本登记在 web-remote-control-channel.ts 的清单里。
  desktopWindowState?: WebRemoteControlDesktopWindowState;
  recentProjects?: WebRemoteControlRecentProjectTarget[];
}

export function resolveWebRemoteControlWorkspaceKey(
  target: Pick<WebRemoteControlWorkspaceTarget, "workspacePath" | "workspaceIdentity">,
): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function isWebRemoteControlBridgeableWorkspaceTarget(
  workspace: WebRemoteControlWorkspaceTarget,
): boolean {
  return (
    workspace.kind !== "remote" || Boolean(workspace.workspaceIdentity && workspace.remoteSessionId)
  );
}

export function resolveWebRemoteControlInitialWorkspaceSelection({
  workspaces,
  mobileViewState,
  initialViewState,
}: {
  workspaces: WebRemoteControlWorkspaceTarget[];
  mobileViewState?: WebRemoteControlMobileViewState;
  initialViewState?: WebRemoteControlMobileViewState;
}): { workspaceKey: string; taskId?: string; canBridge: boolean } | null {
  const bridgeableWorkspaces = workspaces.filter(isWebRemoteControlBridgeableWorkspaceTarget);
  const workspaceKeys = new Set(
    bridgeableWorkspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const allWorkspaceKeys = new Set(
    workspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const selectedViewState = mobileViewState ?? initialViewState;
  const selectedWorkspaceKey = selectedViewState?.activeWorkspaceKey;

  if (selectedWorkspaceKey && workspaceKeys.has(selectedWorkspaceKey)) {
    return {
      workspaceKey: selectedWorkspaceKey,
      ...(selectedViewState.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
      canBridge: true,
    };
  }

  // Bugfix: 手机端列表会展示已断开的 SSH workspace，但这类项没有 remoteSessionId，
  // 不能作为初始 bridge 目标。否则重连状态尚未同步时会反复进入“尚未连接”的错误页。
  const firstWorkspace = bridgeableWorkspaces[0];
  if (!firstWorkspace) {
    if (selectedWorkspaceKey && allWorkspaceKeys.has(selectedWorkspaceKey)) {
      return {
        workspaceKey: selectedWorkspaceKey,
        ...(selectedViewState?.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
        canBridge: false,
      };
    }

    const firstDisconnectedWorkspace = workspaces[0];
    if (!firstDisconnectedWorkspace) {
      return null;
    }

    return {
      workspaceKey: resolveWebRemoteControlWorkspaceKey(firstDisconnectedWorkspace),
      canBridge: false,
    };
  }

  return {
    workspaceKey: resolveWebRemoteControlWorkspaceKey(firstWorkspace),
    canBridge: true,
  };
}
