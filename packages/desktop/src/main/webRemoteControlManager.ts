import type { RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制 manager 承担 gateway app payload 路由与 workspace bridge 编排。 */
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { MessagePortProtocol, type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  buildWebRemoteControlBridgeResultTelemetry,
  buildWebRemoteControlPairResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlContext,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlDesktopWindowOpenRequestPayload,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDeviceInfo,
  type WebRemoteControlMobileViewState,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlRecentProjectsResult,
  type WebRemoteControlRpcTransportPayload,
  type WebRemoteControlStatus,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridgeOpenPayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceOpenRequestPayload,
  type WebRemoteControlWorkspaceTarget,
  type RemoteAccessGatewayConnectionStatus,
  type RemoteAccessStatus,
  type RemoteUsageRemoteKind,
  type TelemetryEventPayload,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
} from "@zcode/shared";
import type {
  GatewayDeviceTransportSession,
  GatewayDeviceTransportSessionOptions,
  GatewayDeviceTransportState,
} from "./remote-access/gatewayDeviceTransportTypes.js";
import type { WebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";
import type { RemoteWorkspaceDirectory } from "./remote-access/remoteWorkspaceDirectory.js";
import { createWebRemoteControlRecentProjectsRegistry } from "./remote-access/recentProjects.js";

interface WebRemoteControlHostAttachmentHandle {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

interface WorkspaceBridgeRuntime {
  /**
   * bridge 所属窗口的 `BrowserWindow.id`（T2.3）。
   * runtime 是 App 级单实例，不再有「本窗口 runtime」；attach、释放和
   * `workspace-reconnect-request` 都按这个 id 路由。
   */
  windowId: number;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  hostEntryId: string;
  attachmentId: string;
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  hostProtocol?: MessagePortProtocol;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  disposeBridge?: () => void;
  readyAnnounced: boolean;
  degraded: boolean;
}

/**
 * App 级唯一远控 runtime（T2.3）。
 *
 * 原来每个窗口一个 runtime（`Map<windowId, WindowControlRuntime>`），窗口关闭就停掉整条远控；
 * 现在整个 Electron 进程只有一个 runtime：`currentBridge` 自己记住所属 `windowId`，
 * 窗口关闭只释放它自己的 bridge。启动上下文（`workspacePath` 等）只用于状态回显和
 * 无 bridge 时的路由兜底，不代表 runtime 归属于某个窗口。
 */
interface AppControlRuntime {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlContext["theme"];
  /** 触发启动/自动恢复的窗口，仅用于遥测归属和路由兜底。 */
  originWindowId?: number;
  status: WebRemoteControlStatus["status"];
  error?: string;
  failure?: WebRemoteControlFailure;
  transport: GatewayDeviceTransportSession;
  mobileConnected: boolean;
  hasEverPaired: boolean;
  transportState?: GatewayDeviceTransportState;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  currentBridge?: WorkspaceBridgeRuntime;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileDisconnectGraceTimer?: ReturnType<typeof setTimeout>;
}

interface PendingWorkspaceOpen {
  runtime: AppControlRuntime;
  requestId: string;
  workspacePath: string;
  timer: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlManagerDependencies {
  appVersion: string;
  /**
   * `AppSettings.remoteAccess` 的读写口（Main 是开关唯一写入方）。
   * 启动恢复不再读旧的 `webRemoteControlLastEnabledContext`（T2.3）。
   */
  remoteAccessSettings: {
    isEnabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<void>;
  };
  featureGate: WebRemoteControlFeatureGate;
  /**
   * gateway backend 连接状态（T3.2 的 `RemoteGatewayBackend` 是唯一所有者）。
   * 没注入时按 `disabled` 处理，方便单测只关心 runtime。
   */
  getGatewayConnectionStatus?: () => RemoteAccessGatewayConnectionStatus;
  /**
   * 各窗口 workspace / 任务快照的唯一投影（App 级，T2.2）。
   * renderer 的 `syncAvailableWorkspaces` / `syncAvailableTasks` 直接写它，不依赖本窗口是否有 runtime。
   */
  remoteWorkspaceDirectory: RemoteWorkspaceDirectory;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  platformHandlers: {
    [K in WebRemoteControlPlatformMethod]: (
      args: WebRemoteControlPlatformMethodArgsMap[K],
    ) => Promise<WebRemoteControlPlatformMethodResultMap[K]>;
  };
  reconnectWorkspace: (windowId: number, workspaceKey: string) => Promise<void>;
  /** `windowId` 是 bridge 所属窗口或启动来源窗口；App 级事件可能没有窗口，由调用方回退到最近 renderer context。 */
  reportRemoteUsageEvent?: (windowId: number | undefined, event: TelemetryEventPayload) => void;
  reportRendererTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  /** App 级状态变化：调用方负责广播给所有窗口。 */
  onStatusChanged?: (status: WebRemoteControlStatus) => void;
  attachWorkspaceHost: (
    windowId: number,
    context: WebRemoteControlContext & { kind: "local" | "remote" },
  ) => Promise<WebRemoteControlHostAttachmentHandle>;
  releaseWorkspaceHostAttachment: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  /** T5.1：gateway channel transport 是唯一实现，必须由 Main 注入。 */
  createDeviceTransport: (
    options: GatewayDeviceTransportSessionOptions,
  ) => GatewayDeviceTransportSession;
  /** T2.4：`AppSettings.recentProjects`（最近优先）。缺省视为没有最近项目。 */
  getRecentProjects?: () => Promise<readonly string[]>;
  /** T2.4：当前是否至少有一个桌面应用窗口；缺省视为有窗口。 */
  hasOpenWindow?: () => boolean;
  /** T2.4：强制升级等进程级 gate；返回 false 时不能创建主窗口。 */
  canCreateWindow?: (reason: string) => boolean;
  /** T2.4：`ensurePrimaryWindow("remote-control")`。 */
  ensurePrimaryWindow?: (reason: string) => Promise<void>;
  /**
   * T2.4：通过 Main 的内部路径打开本地 workspace（复用 OpenWorkspacePath 投递，
   * 不经过 deep link 的外部确认框）。返回 false 表示路径无效或窗口不可用。
   */
  openWorkspacePath?: (workspacePath: string) => boolean;
}

const MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000;
/** 打开最近项目以「聚合列表出现该 workspace」为成功判定，最多等 10 秒。 */
export const WEB_REMOTE_CONTROL_WORKSPACE_OPEN_TIMEOUT_MS = 10_000;
/** 主窗口创建 reason：与既有 ensurePrimaryWindow 入口保持同一措辞。 */
const REMOTE_CONTROL_WINDOW_REASON = "remote-control";

function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mapWorkspaceBridgeFailureReason(error: unknown): WebRemoteControlFailureReason {
  switch (getErrorCode(error)) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
      return "unsupported-action";
    default:
      return "unexpected-error";
  }
}

function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

function getPathLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

function isBridgeableRemoteTarget(target: WebRemoteControlWorkspaceTarget): boolean {
  return target.kind !== "remote" || Boolean(target.workspaceIdentity && target.remoteSessionId);
}

function isBridgeableRemoteTask(task: WebRemoteControlTaskTarget): boolean {
  return task.workspaceKind !== "remote" || Boolean(task.workspaceIdentity && task.remoteSessionId);
}

function toExternalBridge(
  runtime: WorkspaceBridgeRuntime,
): WebRemoteControlExternalWorkspaceBridge {
  const base = {
    bridgeSessionId: runtime.bridgeSessionId,
    ...(runtime.bridgeGeneration !== undefined
      ? { bridgeGeneration: runtime.bridgeGeneration }
      : {}),
    ...(runtime.recoveryId ? { recoveryId: runtime.recoveryId } : {}),
    workspaceKey: runtime.workspaceKey,
    workspacePath: runtime.workspacePath,
    initialTaskId: runtime.initialTaskId,
  };

  if (runtime.kind === "remote") {
    if (!runtime.workspaceIdentity || !runtime.remoteSessionId) {
      throw new Error("远程 workspace bridge 缺少 workspaceIdentity 或 remoteSessionId。");
    }
    return {
      ...base,
      kind: "remote",
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
    };
  }

  return {
    ...base,
    kind: "local",
  };
}

export function createWebRemoteControlManager(dependencies: WebRemoteControlManagerDependencies) {
  /** App 级唯一 runtime；生命周期与窗口解耦。 */
  let appRuntime: AppControlRuntime | undefined;
  /**
   * T2.4：最近项目快照。路径缓存只在 runtime 活跃时用于同步构造 bootstrap；
   * 每次 workspace 同步 / 设置变更都会异步刷新，保证列表事实仍来自 `recentProjects`。
   */
  const recentProjectsRegistry = createWebRemoteControlRecentProjectsRegistry();
  let recentProjectPaths: readonly string[] = [];
  let pushedRecentProjectsSignature: string | undefined;
  let recentProjectsRefreshSequence = 0;
  /** 已经受理、等待 workspace 出现在聚合列表里的打开请求。 */
  const pendingWorkspaceOpens = new Map<string, PendingWorkspaceOpen>();
  /**
   * 显式关闭（旧 Stop IPC / 新开关关闭）后压制 renderer 快照同步触发的自动启动；
   * 只有下一次显式开启或进程重启才重新允许自动启动。
   */
  let autoStartSuppressed = false;
  /** 自动启动只尝试一次：成功后等显式重启；失败时复位，允许下一次快照同步重试。 */
  let autoStartAttempted = false;

  /** 旧 runtime 的 transport 回调在替换/停止后仍可能触发，必须按当前实例过滤。 */
  function isCurrentRuntime(runtime: AppControlRuntime): boolean {
    return appRuntime === runtime;
  }

  function reportRemoteUsageEvent(
    windowId: number | undefined,
    event: TelemetryEventPayload,
  ): void {
    try {
      dependencies.reportRemoteUsageEvent?.(windowId, event);
    } catch (error) {
      // 埋点是旁路能力，任何异常都不能改变远控配对和 bridge 的业务结果。
      dependencies.logger.warn("[web-remote-control] remote usage telemetry failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  function resolveRemoteKind(
    target: WebRemoteControlWorkspaceTarget,
    acquired?: WebRemoteControlHostAttachmentHandle,
  ): RemoteUsageRemoteKind | undefined {
    if (target.kind !== "remote") {
      return undefined;
    }
    return (
      acquired?.remoteKind ??
      (target.workspaceIdentity
        ? parseRemoteWorkspaceIdentity(target.workspaceIdentity)?.kind
        : undefined)
    );
  }

  function resolveRuntimeWorkspaceDimensions(runtime: AppControlRuntime): {
    workspaceKind: "local" | "remote";
    remoteKind?: RemoteUsageRemoteKind;
  } {
    const remoteKind = runtime.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(runtime.workspaceIdentity)?.kind
      : undefined;
    return {
      workspaceKind:
        runtime.workspaceIdentity?.trim() || runtime.remoteSessionId ? "remote" : "local",
      remoteKind,
    };
  }
  /** App 级推送去重签名：只有一个 runtime，不再按窗口保存。 */
  let pushedWorkspaceListSignature: string | undefined;

  function createTransport(
    options: GatewayDeviceTransportSessionOptions,
  ): GatewayDeviceTransportSession {
    return dependencies.createDeviceTransport(options);
  }

  function disposeRuntimeBridgeResources(runtime: AppControlRuntime): void {
    const bridge = runtime.currentBridge;
    if (!bridge) {
      return;
    }

    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    try {
      bridge.hostProtocol?.disconnect();
    } catch {
      // MessagePortProtocol 已经关闭时 dispose 失败不影响主流程。
    }
    if (bridge.attachmentId) {
      dependencies.releaseWorkspaceHostAttachment(bridge.attachmentId);
    }

    runtime.currentBridge = undefined;
  }

  function isCurrentBridgeRuntime(
    runtime: AppControlRuntime,
    bridge: WorkspaceBridgeRuntime,
  ): boolean {
    return appRuntime === runtime && runtime.currentBridge === bridge;
  }

  function degradeBridgeAfterRawFault(
    runtime: AppControlRuntime,
    bridge: WorkspaceBridgeRuntime,
    reasonCode: string,
  ): void {
    if (!isCurrentBridgeRuntime(runtime, bridge) || bridge.degraded) return;
    bridge.degraded = true;
    dependencies.logger.warn("[web-remote-control] raw rpc bridge degraded", {
      windowId: bridge.windowId,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    sendAppPayload(runtime, {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix：checksum/oversize/future ACK 等 fault 不能伪装成 frame gap；
      // app control 只传通用恢复原因，typed reasonCode 留在上面的安全日志。
      reason: "rpc-transport-fault",
    });
  }

  function clearPendingOutboundPayloadTimer(runtime: AppControlRuntime): void {
    if (!runtime.pendingOutboundPayloadTimer) {
      return;
    }
    clearTimeout(runtime.pendingOutboundPayloadTimer);
    runtime.pendingOutboundPayloadTimer = undefined;
  }

  function clearMobileDisconnectGraceTimer(runtime: AppControlRuntime): void {
    if (!runtime.mobileDisconnectGraceTimer) {
      return;
    }
    clearTimeout(runtime.mobileDisconnectGraceTimer);
    runtime.mobileDisconnectGraceTimer = undefined;
  }

  function buildRuntimeStatus(runtime: AppControlRuntime): WebRemoteControlStatus {
    const target = getRuntimeStatusTarget(runtime);
    return {
      status: runtime.status,
      mobileConnected: runtime.mobileConnected,
      mobileViewState: runtime.mobileViewState,
      mobileDeviceInfo: runtime.mobileDeviceInfo,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: runtime.currentBridge?.initialTaskId ?? runtime.initialTaskId,
      error: runtime.error,
      failure: runtime.failure,
    };
  }

  function emitRuntimeStatus(runtime: AppControlRuntime): void {
    // T2.3：状态是 App 级事实，调用方负责广播给所有窗口。
    dependencies.onStatusChanged?.(buildRuntimeStatus(runtime));
  }

  function emitIdleStatus(): void {
    dependencies.onStatusChanged?.({ status: "idle" });
  }

  function scheduleMobileDisconnectGrace(runtime: AppControlRuntime): void {
    if (runtime.mobileDisconnectGraceTimer) {
      return;
    }
    runtime.mobileDisconnectGraceTimer = setTimeout(() => {
      runtime.mobileDisconnectGraceTimer = undefined;
      if (appRuntime !== runtime || runtime.status === "error") {
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
    }, MOBILE_DISCONNECT_STATUS_GRACE_MS);
  }

  function schedulePendingOutboundPayloadTimeout(runtime: AppControlRuntime): void {
    if (runtime.pendingOutboundPayloadTimer || runtime.pendingOutboundPayloads.length === 0) {
      return;
    }
    runtime.pendingOutboundPayloadTimer = setTimeout(() => {
      runtime.pendingOutboundPayloadTimer = undefined;
      const droppedCount = runtime.pendingOutboundPayloads.splice(0).length;
      dependencies.logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.currentBridge?.windowId ?? runtime.originWindowId,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  function sendPayloadToTransport(
    runtime: AppControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult {
    return runtime.transport.sendPayloadResult(payload);
  }

  function bufferOutboundPayload(
    runtime: AppControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length >= 50) {
      const droppedCount = runtime.pendingOutboundPayloads.length + 1;
      runtime.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(runtime);
      dependencies.logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
        windowId: runtime.currentBridge?.windowId ?? runtime.originWindowId,
        droppedCount,
      });
      return;
    }
    runtime.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(runtime);
  }

  function flushPendingOutboundPayloads(runtime: AppControlRuntime): void {
    while (runtime.pendingOutboundPayloads.length > 0) {
      const payload = runtime.pendingOutboundPayloads[0];
      if (!payload) {
        break;
      }
      const result = sendPayloadToTransport(runtime, payload);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(runtime);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix：永久 oversize 不能伪装成临时不可发送后反复进入 50 项 buffer。
        dependencies.logger.warn("[web-remote-control] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      runtime.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(runtime);
  }

  function sendAppPayload(runtime: AppControlRuntime, payload: WebRemoteControlAppPayload): void {
    if (runtime.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(runtime, payload);
      flushPendingOutboundPayloads(runtime);
      return;
    }
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "sent") {
      return;
    }
    if (result.kind === "oversize") {
      dependencies.logger.warn("[web-remote-control] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: channel 不可发送时 sendPayloadResult 会返回 unavailable。
    // desktop 发出的响应/RPC 帧不能静默丢弃，先短暂缓冲，等 paired 恢复后再 flush。
    bufferOutboundPayload(runtime, payload);
  }

  async function stopRuntime(reason: string): Promise<void> {
    const runtime = appRuntime;
    if (!runtime) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: "desktop-disconnected",
      error: "Desktop disconnected this Web remote control session.",
    });
    appRuntime = undefined;
    pushedWorkspaceListSignature = undefined;
    pushedRecentProjectsSignature = undefined;
    clearPendingWorkspaceOpens();
    const attachmentWindowId = runtime.currentBridge?.windowId ?? runtime.originWindowId;
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    if (attachmentWindowId !== undefined) {
      // 幂等清理该窗口遗留的 shared-host attachment（bridge 自身的 attachment 已在上面释放）。
      dependencies.disposeWorkspaceHostAttachmentsForWindow(attachmentWindowId, reason);
    }

    dependencies.logger.info(`[web-remote-control] stopped app runtime reason=${reason}`);
    emitIdleStatus();
  }

  function getRuntimeWorkspaceTarget(runtime: AppControlRuntime): WebRemoteControlWorkspaceTarget {
    const bridge = runtime.currentBridge;
    if (bridge) {
      return {
        workspacePath: bridge.workspacePath,
        workspaceIdentity: bridge.workspaceIdentity,
        remoteSessionId: bridge.remoteSessionId,
        label: getPathLabel(bridge.workspacePath),
        kind: bridge.kind,
      };
    }

    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getRuntimeStatusTarget(runtime: AppControlRuntime): WebRemoteControlWorkspaceTarget {
    // Bugfix: 手机端可以在同一个远控会话里切到窗口内的其他 workspace。
    // 之前 getStatus() 复用了当前 bridge 目标，导致桌面弹层按启动 workspace 轮询时误判为“不是同一会话”，
    // 再次打开弹层会重启远控并把手机端踢成离线。状态接口保持窗口远控会话的原始目标，
    // 手机当前 workspace 仍通过 mobileViewState / workspace list 表达。
    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getAvailableWorkspaces(runtime: AppControlRuntime): WebRemoteControlWorkspaceTarget[] {
    const workspaceByKey = new Map<string, WebRemoteControlWorkspaceTarget>();

    // T2.3：runtime 是 App 级，列表读跨窗口聚合（按 workspaceKey 去重）而不是本窗口快照。
    for (const workspace of dependencies.remoteWorkspaceDirectory.listWorkspaces()) {
      // Bugfix: 手机端 workspace 列表需要和桌面端一致展示已断开的 SSH 项目。
      // 这里仅保留列表项；真正创建 bridge 时仍会校验 remoteSessionId，避免未连接项目被直接打开聊天。
      workspaceByKey.set(resolveWebRemoteControlWorkspaceKey(workspace), workspace);
    }

    const currentTarget = getRuntimeWorkspaceTarget(runtime);
    if (isBridgeableRemoteTarget(currentTarget)) {
      const currentKey = resolveWebRemoteControlWorkspaceKey(currentTarget);
      if (!workspaceByKey.has(currentKey)) {
        workspaceByKey.set(currentKey, currentTarget);
      }
    }

    return [...workspaceByKey.values()];
  }

  function getAvailableTasks(runtime: AppControlRuntime): WebRemoteControlTaskTarget[] {
    const availableWorkspaceKeys = new Set(
      getAvailableWorkspaces(runtime).map((workspace) =>
        resolveWebRemoteControlWorkspaceKey(workspace),
      ),
    );

    return dependencies.remoteWorkspaceDirectory
      .listTasks()
      .filter(
        (task) =>
          isBridgeableRemoteTask(task) &&
          availableWorkspaceKeys.has(resolveWebRemoteControlWorkspaceKey(task)),
      )
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        if (right.createdAt !== left.createdAt) {
          return right.createdAt - left.createdAt;
        }
        return right.taskId.localeCompare(left.taskId);
      });
  }

  function getRuntimeInitialViewState(
    runtime: AppControlRuntime,
  ): WebRemoteControlMobileViewState | undefined {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    if (!runtime.initialTaskId || !isBridgeableRemoteTarget(activeTarget)) {
      return undefined;
    }

    return {
      activeWorkspaceKey: resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId: runtime.initialTaskId,
      updatedAt: Date.now(),
    };
  }

  function getOpenWorkspacePaths(runtime: AppControlRuntime): Set<string> {
    return new Set(getAvailableWorkspaces(runtime).map((workspace) => workspace.workspacePath));
  }

  function buildRecentProjectsResult(
    runtime: AppControlRuntime,
  ): WebRemoteControlRecentProjectsResult {
    return recentProjectsRegistry.buildResult({
      paths: recentProjectPaths,
      openWorkspacePaths: getOpenWorkspacePaths(runtime),
      desktopWindowState: (dependencies.hasOpenWindow?.() ?? true) ? "open" : "none",
    });
  }

  function buildRecentProjectsSignature(result: WebRemoteControlRecentProjectsResult): string {
    return JSON.stringify([
      result.desktopWindowState,
      result.recentProjects.map((project) => [project.id, project.label, project.location]),
    ]);
  }

  function pushRecentProjectsUpdated(runtime: AppControlRuntime): void {
    const result = buildRecentProjectsResult(runtime);
    const signature = buildRecentProjectsSignature(result);
    if (signature === pushedRecentProjectsSignature) {
      return;
    }
    pushedRecentProjectsSignature = signature;
    sendAppPayload(runtime, {
      zcode_type: "recent-projects-updated",
      result,
    });
  }

  async function readRecentProjectPaths(): Promise<readonly string[]> {
    try {
      return (await dependencies.getRecentProjects?.()) ?? [];
    } catch (error) {
      dependencies.logger.warn("[web-remote-control] failed to read recent projects", {
        message: error instanceof Error ? error.message : String(error),
      });
      return recentProjectPaths;
    }
  }

  /** 设置变化或 workspace 快照变化后刷新最近项目；只采用最新一次读取的结果。 */
  async function refreshRecentProjects(runtime: AppControlRuntime): Promise<void> {
    const sequence = ++recentProjectsRefreshSequence;
    const paths = await readRecentProjectPaths();
    if (sequence !== recentProjectsRefreshSequence || !isCurrentRuntime(runtime)) {
      return;
    }
    recentProjectPaths = paths;
    pushRecentProjectsUpdated(runtime);
  }

  function isWorkspaceOpen(runtime: AppControlRuntime, workspacePath: string): boolean {
    return getAvailableWorkspaces(runtime).some(
      (workspace) => workspace.workspacePath === workspacePath,
    );
  }

  function completePendingWorkspaceOpen(
    pending: PendingWorkspaceOpen,
    outcome: { error?: string },
  ): void {
    // 同一个 requestId 可能被后续请求替换，旧 timer 不能覆盖新请求的结果。
    if (pendingWorkspaceOpens.get(pending.requestId) !== pending) {
      return;
    }
    pendingWorkspaceOpens.delete(pending.requestId);
    clearTimeout(pending.timer);
    const runtime = pending.runtime;
    if (!isCurrentRuntime(runtime)) {
      return;
    }

    if (outcome.error) {
      dependencies.logger.info("[web-remote-control] recent project open failed", {
        requestId: pending.requestId,
        label: getPathLabel(pending.workspacePath),
        error: outcome.error,
      });
      sendAppPayload(runtime, {
        zcode_type: "workspace-open-response",
        requestId: pending.requestId,
        success: false,
        error: outcome.error,
      });
      return;
    }

    const target = getAvailableWorkspaces(runtime).find(
      (workspace) => workspace.workspacePath === pending.workspacePath,
    );
    const workspaceKey = target
      ? resolveWebRemoteControlWorkspaceKey(target)
      : pending.workspacePath;
    dependencies.logger.info("[web-remote-control] recent project open succeeded", {
      requestId: pending.requestId,
      label: getPathLabel(pending.workspacePath),
    });
    sendAppPayload(runtime, {
      zcode_type: "workspace-open-response",
      requestId: pending.requestId,
      success: true,
      workspaceKey,
    });
  }

  function completePendingWorkspaceOpens(runtime: AppControlRuntime): void {
    // completePendingWorkspaceOpen 只删除当前项，删除后继续迭代 Map 是安全的。
    for (const pending of pendingWorkspaceOpens.values()) {
      if (pending.runtime !== runtime) {
        continue;
      }
      if (isWorkspaceOpen(runtime, pending.workspacePath)) {
        completePendingWorkspaceOpen(pending, {});
      }
    }
  }

  function clearPendingWorkspaceOpens(): void {
    for (const pending of pendingWorkspaceOpens.values()) {
      clearTimeout(pending.timer);
    }
    pendingWorkspaceOpens.clear();
  }

  function buildBootstrapResult(runtime: AppControlRuntime): WebRemoteControlWindowBootstrapResult {
    const recentProjects = buildRecentProjectsResult(runtime);
    return {
      // 旧 relay 会话标识，gateway 链路保留固定占位值，手机侧不使用。
      windowControlSessionId: "gateway",
      desktopAppVersion: dependencies.appVersion,
      workspaces: getAvailableWorkspaces(runtime),
      tasks: getAvailableTasks(runtime),
      initialViewState: getRuntimeInitialViewState(runtime),
      mobileViewState: runtime.mobileViewState,
      desktopWindowState: recentProjects.desktopWindowState,
      recentProjects: recentProjects.recentProjects,
    };
  }

  function buildWorkspaceListResult(
    runtime: AppControlRuntime,
  ): WebRemoteControlWorkspaceListResult {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    const initialViewState = getRuntimeInitialViewState(runtime);
    return {
      workspaces: getAvailableWorkspaces(runtime),
      tasks: getAvailableTasks(runtime),
      activeWorkspaceKey:
        runtime.mobileViewState?.activeWorkspaceKey ??
        initialViewState?.activeWorkspaceKey ??
        resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId:
        runtime.mobileViewState?.activeTaskId ??
        runtime.currentBridge?.initialTaskId ??
        initialViewState?.activeTaskId,
    };
  }

  function buildWorkspaceListPushSignature(result: WebRemoteControlWorkspaceListResult): string {
    const workspaceSignatureEntries = result.workspaces
      .map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        return JSON.stringify([
          workspaceKey,
          workspace.kind,
          workspace.connectionState ?? "connected",
          workspace.remoteSessionId ?? "",
          // Bugfix：连接状态不只包含枚举值；同一 disconnected 状态下错误原因也会变化，
          // 手机 workspace card 直接展示 lastConnectionError，必须触发新快照。
          workspace.lastConnectionError ?? "",
        ]);
      })
      .sort();
    const taskSignatureEntries = result.tasks
      .map((task) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(task);
        return JSON.stringify([
          workspaceKey,
          task.taskId,
          // Bugfix：自动标题和用户重命名不会改变 task identity/membership；标题本身必须参与
          // 首页快照去重，否则手机会一直保留旧文案。
          task.title,
          // Bugfix：远程 workspace 重连后 workspaceKey 可以保持不变，但 task target 绑定的
          // remoteSessionId 会轮换；手机必须采用新连接身份，不能把它当成重复任务。
          task.remoteSessionId ?? "",
          // Bugfix：手机首页状态来自 renderer 已计算的 displayStatus；旧签名只比较 membership，
          // running/completed/error 迁移会被误判为重复快照。缺失值按手机 fallback 归一为 idle。
          task.displayStatus ?? "idle",
          // 后台工作起止决定手机列表运行层归属（排序），displayStatus 不变也要出新快照。
          Boolean(task.hasBackgroundWork),
          // 工作流运行行的数据：phase 灯翻转、run 结束、子代理数变化都要让手机重画那一行。
          task.workflowActivity ?? null,
          // Bugfix：unreadAt 是手机蓝点的事实字段；打开任务清除未读时 task membership 不变，
          // 必须让时间戳到缺失值的迁移触发新快照。
          typeof task.unreadAt === "number" ? task.unreadAt : "",
          Boolean(task.pinned),
          Boolean(task.archived),
        ]);
      })
      .sort();

    // Bugfix：title / connection error 是任意用户可见字符串，不能再用控制字符拼接 tuple；
    // 否则字段值本身包含分隔符时不同快照可能得到相同签名。JSON tuple 保持字段边界且仍忽略数组顺序。
    return JSON.stringify([workspaceSignatureEntries, taskSignatureEntries]);
  }

  function pushWorkspaceListUpdated(runtime: AppControlRuntime): void {
    const result = buildWorkspaceListResult(runtime);
    const signature = buildWorkspaceListPushSignature(result);
    if (pushedWorkspaceListSignature === signature) {
      return;
    }

    pushedWorkspaceListSignature = signature;
    sendAppPayload(runtime, {
      zcode_type: "workspace-list-updated",
      result,
    });
  }

  async function respondToPlatformRequest(
    runtime: AppControlRuntime,
    request: WebRemoteControlPlatformRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlPlatformResponsePayload;

    try {
      const result = await dependencies.platformHandlers[request.method](request.args as never);
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: true,
        result,
      } as WebRemoteControlPlatformResponsePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] platform request failed method=${request.method} error=${message}`,
      );
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: false,
        error: message,
      };
    }

    sendAppPayload(runtime, response);
  }

  async function createWorkspaceBridge(
    runtime: AppControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    const target = getAvailableWorkspaces(runtime).find(
      (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
    );
    if (!target) {
      throw new Error("目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。");
    }
    if (!isBridgeableRemoteTarget(target)) {
      throw new Error("目标远程工作区尚未连接，无法创建 bridge，请先重连。");
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    // T2.3：先按 workspaceKey 解析目标窗口，再 attach。
    // 命中当前 bridge 目标或启动来源窗口只是兜底（目标来自 aggregator 的当前目标补充项时，
    // 它未必出现在任何窗口快照里）。id 空间统一是 BrowserWindow.id。
    const targetWindowId =
      dependencies.remoteWorkspaceDirectory.resolveWindow(targetWorkspaceKey) ??
      (runtime.currentBridge?.workspaceKey === targetWorkspaceKey
        ? runtime.currentBridge.windowId
        : undefined) ??
      runtime.originWindowId;
    if (targetWindowId === undefined) {
      throw new Error("目标工作区没有所属桌面窗口，无法创建 Web 远程控制 bridge。");
    }

    disposeRuntimeBridgeResources(runtime);
    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.failure = undefined;
    emitRuntimeStatus(runtime);

    const bridgeRuntime: WorkspaceBridgeRuntime = {
      windowId: targetWindowId,
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      hostEntryId: "",
      attachmentId: "",
      kind: target.kind,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    runtime.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control] attaching workspace bridge window=${targetWindowId} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    let acquired: WebRemoteControlHostAttachmentHandle | undefined;
    try {
      acquired = await dependencies.attachWorkspaceHost(targetWindowId, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        initialTaskId: request.taskId,
        kind: target.kind,
      });
      if (!isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
        acquired = undefined;
        throw new Error("Workspace bridge request was superseded.");
      }
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(acquired.port));
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        measureFrameBytes: (frame) =>
          runtime.transport.measurePayloadBytes?.(frame) ??
          measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result = sendPayloadToTransport(runtime, payload);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });

      // Bugfix：raw adapter 是唯一 replay owner；main 不再把 rpc-frame 放进普通 50 项 buffer。
      const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
        relayProtocol.protocol.send(buffer);
      });
      const disposeRelayToHost = relayProtocol.protocol.onMessage((buffer) => {
        hostProtocol.send(buffer);
      });
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(runtime, bridgeRuntime, fault.reasonCode);
      });
      const disposeSaturated = relayProtocol.onSaturated(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("saturated");
      });
      const disposeDrained = relayProtocol.onDrained(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("drained");
      });

      bridgeRuntime.hostEntryId = acquired.entryId;
      bridgeRuntime.attachmentId = acquired.attachmentId;
      bridgeRuntime.hostProtocol = hostProtocol;
      bridgeRuntime.relayProtocol = relayProtocol;
      bridgeRuntime.disposeBridge = () => {
        disposeHostToRelay.dispose();
        disposeRelayToHost.dispose();
        disposeDegraded.dispose();
        disposeSaturated.dispose();
        disposeDrained.dispose();
      };
      runtime.status = "active";
      runtime.error = undefined;
      runtime.failure = undefined;
      emitRuntimeStatus(runtime);

      dependencies.logger.info(
        `[web-remote-control] workspace bridge active window=${targetWindowId} bridgeSession=${request.bridgeSessionId}`,
      );
      reportRemoteUsageEvent(
        targetWindowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "success",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
        }),
      );

      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      reportRemoteUsageEvent(
        targetWindowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "failure",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
          errorCategory: classifyRemoteUsageError(error),
        }),
      );
      if (acquired) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
      }
      if (isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        disposeRuntimeBridgeResources(runtime);
        runtime.status = runtime.mobileConnected ? "active" : "running";
        emitRuntimeStatus(runtime);
      }
      throw error;
    }
  }

  async function respondToWorkspaceBridgeOpen(
    runtime: AppControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(runtime, request);
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge,
      });
      const currentBridge = runtime.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready 必须先进入 ordinary app transport，才允许 queued raw frames 开闸。
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace bridge failed workspaceKey=${request.workspaceKey} error=${message}`,
      );
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: mapWorkspaceBridgeFailureReason(error),
        error: message,
      });
    }
  }

  /**
   * 按 `workspaceKey` 把手机的重连请求转发给所属窗口（T2.3）。
   * 目录里没有该 workspace 时依次回退到当前 bridge 窗口、启动来源窗口。
   */
  function resolveRequestWindow(
    runtime: AppControlRuntime,
    workspaceKey: string,
  ): number | undefined {
    return (
      dependencies.remoteWorkspaceDirectory.resolveWindow(workspaceKey) ??
      runtime.currentBridge?.windowId ??
      runtime.originWindowId
    );
  }

  async function respondToWorkspaceReconnectRequest(
    runtime: AppControlRuntime,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    try {
      const windowId = resolveRequestWindow(runtime, request.workspaceKey);
      if (windowId === undefined) {
        throw new Error("没有找到该工作区所属的桌面窗口，无法重连。");
      }
      await dependencies.reconnectWorkspace(windowId, request.workspaceKey);
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: true,
      });
    } catch (error) {
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function respondToWorkspaceOpenRequest(
    runtime: AppControlRuntime,
    request: WebRemoteControlWorkspaceOpenRequestPayload,
  ): Promise<void> {
    try {
      // 每次请求都按当前设置重建列表：只接受此刻列表里的 id。
      // 手机端只传 recentProjectId；带 workspacePath 等字段的整帧已被 strict schema 丢弃。
      recentProjectPaths = await readRecentProjectPaths();
      if (!isCurrentRuntime(runtime)) {
        return;
      }
      buildRecentProjectsResult(runtime);
      const workspacePath = recentProjectsRegistry.resolvePath(request.recentProjectId);
      if (!workspacePath) {
        throw new Error("recentProjectId is not part of the current recent project list.");
      }

      if (!(dependencies.hasOpenWindow?.() ?? true)) {
        if (
          dependencies.canCreateWindow &&
          !dependencies.canCreateWindow(REMOTE_CONTROL_WINDOW_REASON)
        ) {
          throw new Error("Desktop window creation is blocked by the current app state.");
        }
        await dependencies.ensurePrimaryWindow?.(REMOTE_CONTROL_WINDOW_REASON);
        if (!isCurrentRuntime(runtime)) {
          return;
        }
      }

      // 内部路径：复用 renderer 的 OpenWorkspacePath 投递，不触发 deep link 的外部确认弹窗。
      const accepted = dependencies.openWorkspacePath?.(workspacePath) ?? false;
      if (!accepted) {
        throw new Error("Desktop could not open the recent project.");
      }

      const existing = pendingWorkspaceOpens.get(request.requestId);
      if (existing) {
        clearTimeout(existing.timer);
        pendingWorkspaceOpens.delete(request.requestId);
      }
      const pending: PendingWorkspaceOpen = {
        runtime,
        requestId: request.requestId,
        workspacePath,
        timer: setTimeout(() => {
          completePendingWorkspaceOpen(pending, {
            error: "Desktop did not open the workspace within 10 seconds.",
          });
        }, WEB_REMOTE_CONTROL_WORKSPACE_OPEN_TIMEOUT_MS),
      };
      pendingWorkspaceOpens.set(request.requestId, pending);
      dependencies.logger.info("[web-remote-control] recent project open accepted", {
        requestId: request.requestId,
        label: getPathLabel(workspacePath),
      });
      // 并发场景下该 workspace 可能已经在聚合列表里，不必等下一次快照同步。
      if (isWorkspaceOpen(runtime, workspacePath)) {
        completePendingWorkspaceOpen(pending, {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.info("[web-remote-control] recent project open failed", {
        requestId: request.requestId,
        error: message,
      });
      if (isCurrentRuntime(runtime)) {
        sendAppPayload(runtime, {
          zcode_type: "workspace-open-response",
          requestId: request.requestId,
          success: false,
          error: message,
        });
      }
    }
  }

  async function respondToDesktopWindowOpenRequest(
    runtime: AppControlRuntime,
    request: WebRemoteControlDesktopWindowOpenRequestPayload,
  ): Promise<void> {
    try {
      // ensurePrimaryWindow 内部复用同一个 canCreateWindow gate；这里先判一次，
      // 以便 gate 阻断时能给手机一个明确的失败响应，而不是静默无窗口。
      if (
        dependencies.canCreateWindow &&
        !dependencies.canCreateWindow(REMOTE_CONTROL_WINDOW_REASON)
      ) {
        throw new Error("Desktop window creation is blocked by the current app state.");
      }
      await dependencies.ensurePrimaryWindow?.(REMOTE_CONTROL_WINDOW_REASON);
      if (!isCurrentRuntime(runtime)) {
        return;
      }
      dependencies.logger.info("[web-remote-control] desktop window open request completed", {
        requestId: request.requestId,
      });
      sendAppPayload(runtime, {
        zcode_type: "desktop-window-open-response",
        requestId: request.requestId,
        success: true,
      });
      // 窗口状态可能从 none 变成 open，主动推送一次（签名去重）。
      pushRecentProjectsUpdated(runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.info("[web-remote-control] desktop window open request failed", {
        requestId: request.requestId,
        error: message,
      });
      if (isCurrentRuntime(runtime)) {
        sendAppPayload(runtime, {
          zcode_type: "desktop-window-open-response",
          requestId: request.requestId,
          success: false,
          error: message,
        });
      }
    }
  }

  function applyMobileViewStateUpdate(
    runtime: AppControlRuntime,
    viewState: WebRemoteControlMobileViewState,
    deviceInfo?: WebRemoteControlMobileDeviceInfo,
  ): void {
    runtime.mobileViewState = viewState;
    if (deviceInfo) {
      runtime.mobileDeviceInfo = deviceInfo;
    }
  }

  function routeRpcTransportPayload(
    runtime: AppControlRuntime,
    frame: WebRemoteControlRpcTransportPayload,
  ): void {
    routeRawTransportCandidate(runtime, frame);
  }

  function routeRawTransportCandidate(runtime: AppControlRuntime, payload: unknown): boolean {
    if (!isCurrentRuntime(runtime)) return false;
    const bridge = runtime.currentBridge;
    if (!bridge || bridge.degraded) return false;
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  function logMobileDiagnostic(
    runtime: AppControlRuntime,
    payload: Extract<WebRemoteControlAppPayload, { zcode_type: "mobile-diagnostic" }>,
  ): void {
    dependencies.logger.info("[web-remote-control] mobile diagnostic", {
      originWindow: runtime.originWindowId,
      bridgeWindow: runtime.currentBridge?.windowId,
      event: payload.event,
      state: payload.state,
      previousState: payload.previousState,
      closeCode: payload.closeCode,
      closeReason: payload.closeReason,
      wasClean: payload.wasClean,
      wasPaired: payload.wasPaired,
      failureReason: payload.failureReason,
      failureMessage: payload.failureMessage,
      visibilityState: payload.visibilityState,
      online: payload.online,
      hiddenDurationMs: payload.hiddenDurationMs,
      timestamp: payload.timestamp,
    });
  }

  function routePayload(runtime: AppControlRuntime, payload: WebRemoteControlAppPayload): void {
    if (!isCurrentRuntime(runtime)) {
      return;
    }
    switch (payload.zcode_type) {
      case "bootstrap-request": {
        const result = buildBootstrapResult(runtime);
        // bootstrap 响应已经携带最近项目快照，把它记为已推送基线，避免紧接着重复推送。
        pushedRecentProjectsSignature = buildRecentProjectsSignature({
          desktopWindowState: result.desktopWindowState ?? "none",
          recentProjects: result.recentProjects ?? [],
        });
        sendAppPayload(runtime, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result,
        });
        break;
      }
      case "workspace-list-request":
        sendAppPayload(runtime, {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: buildWorkspaceListResult(runtime),
        });
        break;
      case "platform-request":
        void respondToPlatformRequest(runtime, payload);
        break;
      case "mobile-view-state-update":
        applyMobileViewStateUpdate(runtime, payload.viewState, payload.deviceInfo);
        break;
      case "workspace-bridge-open":
        void respondToWorkspaceBridgeOpen(runtime, payload);
        break;
      case "workspace-open-request":
        void respondToWorkspaceOpenRequest(runtime, payload);
        break;
      case "desktop-window-open-request":
        void respondToDesktopWindowOpenRequest(runtime, payload);
        break;
      case "workspace-reconnect-request":
        void respondToWorkspaceReconnectRequest(runtime, payload);
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        routeRpcTransportPayload(runtime, payload);
        break;
      case "telemetry-report":
        // 手机已在创建边界构造事件；Main 只转发，不维护会话事实或干预 replayable 链路。
        dependencies.reportRendererTelemetryEvent?.(payload.event);
        break;
      case "mobile-diagnostic":
        logMobileDiagnostic(runtime, payload);
        break;
      default:
        break;
    }
  }

  function mapTransportState(runtime: AppControlRuntime, state: GatewayDeviceTransportState): void {
    if (!isCurrentRuntime(runtime)) {
      // 已被新的 start/disable 替换的 transport 不能再改写 App 级状态。
      return;
    }
    const previousTransportState = runtime.transportState;
    runtime.transportState = state;
    if (state === "waiting_terminal") {
      if (runtime.mobileConnected) {
        // Bugfix: 已连接会话短暂回 waiting 时先防抖，避免对话框立刻从 active
        // 退回「等待手机」；宽限期内仍未 paired 才降级。
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "paired") {
      if (previousTransportState !== "paired") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.originWindowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "success",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
          }),
        );
      }
      runtime.hasEverPaired = true;
      clearMobileDisconnectGraceTimer(runtime);
      runtime.status = "active";
      runtime.mobileConnected = true;
      emitRuntimeStatus(runtime);
      // Bugfix: 普通断线重连重新 paired 时 transport 不一定触发 onSendReady。
      // 这里在状态恢复为可发送后主动 flush，避免重连窗口内缓冲的响应/RPC 帧超时丢弃。
      flushPendingOutboundPayloads(runtime);
    }
  }

  /** 从 App 级目录里取自动启动的上下文：优先当前聚焦窗口的 workspace，其次最近同步的。 */
  function resolveAutoStartContext(): WebRemoteControlContext | undefined {
    const workspace = dependencies.remoteWorkspaceDirectory.listWorkspaces()[0];
    if (!workspace) {
      return undefined;
    }
    return {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    };
  }

  return {
    /**
     * 启动 App 级唯一 runtime（T2.3）。
     *
     * `originWindowId` 只是发起方/遥测归属：runtime 不随该窗口关闭而停止，bridge 路由仍由
     * `RemoteWorkspaceDirectory.resolveWindow(workspaceKey)` 决定。
     */
    async start(context: WebRemoteControlContext, originWindowId?: number): Promise<void> {
      dependencies.featureGate.assertEnabled();
      autoStartSuppressed = false;
      autoStartAttempted = true;
      await stopRuntime("restart");
      // T2.4：启动时读一次最近项目；之后的设置变更/快照同步会继续刷新。
      recentProjectPaths = await readRecentProjectPaths();

      dependencies.logger.info(
        `[web-remote-control] start app runtime originWindow=${originWindowId ?? "none"} workspace=${context.workspacePath} remoteSession=${context.remoteSessionId ?? "none"}`,
      );

      let runtime: AppControlRuntime;
      const transport = createTransport({
        onStateChange: (state) => mapTransportState(runtime, state),
        onPayload: (payload) => routePayload(runtime, payload),
        onRawTransportPayload: (payload) => routeRawTransportCandidate(runtime, payload),
        onRawTransportFault: (reasonCode) => {
          runtime.currentBridge?.relayProtocol?.markDegraded(reasonCode);
        },
        onSendReady: () => {
          if (!isCurrentRuntime(runtime)) return;
          flushPendingOutboundPayloads(runtime);
          const relayProtocol = runtime.currentBridge?.relayProtocol;
          if (!relayProtocol || relayProtocol.isDegraded()) return;
          // Bug 修复：gateway channel 的 onSendReady 只证明当前 channel 可发送，不证明此前
          // data 已交付。必须重放同 bridge 的未 ACK 批次；adapter 会按 messageSeq 去重，
          // 且重放不刷新原始 45 秒 queued age。
          relayProtocol.replayUnacknowledged();
        },
        onError: (error) => {
          dependencies.logger.warn("[web-remote-control] gateway device error", {
            message: error.message,
          });
        },
      });

      runtime = {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        remoteSessionId: context.remoteSessionId,
        initialTaskId: context.initialTaskId,
        theme: context.theme,
        originWindowId,
        status: "starting",
        transport,
        mobileConnected: false,
        hasEverPaired: false,
        pendingOutboundPayloads: [],
      };
      appRuntime = runtime;
      emitRuntimeStatus(runtime);
      try {
        transport.start();
      } catch (error) {
        if (appRuntime === runtime) {
          appRuntime = undefined;
        }
        clearPendingOutboundPayloadTimer(runtime);
        clearMobileDisconnectGraceTimer(runtime);
        runtime.pendingOutboundPayloads.length = 0;
        transport.dispose();
        throw error;
      }

      // 并发 start（自动恢复/开关）时，后一次 start 已替换 appRuntime；
      // 前一次不能再把旧 transport 的结果当成当前状态。
      if (appRuntime !== runtime) {
        transport.dispose();
        clearPendingOutboundPayloadTimer(runtime);
        clearMobileDisconnectGraceTimer(runtime);
        throw new Error("Web remote control start was superseded.");
      }
    },

    async suspend(reason: string): Promise<void> {
      await stopRuntime(reason);
    },

    /**
     * 启动恢复（T2.3）：不再读旧的 `webRemoteControlLastEnabledContext`，改为
     * `AppSettings.remoteAccess.enabled`。renderer 完成标签页恢复后同步 workspace 时调用；
     * 第一个可用上下文作为 App 级 runtime 的初始目标，不再要求与持久化目标匹配。
     */
    async restorePreviouslyEnabled(
      windowId: number,
      candidates: WebRemoteControlContext[],
    ): Promise<boolean> {
      if (autoStartSuppressed || autoStartAttempted || appRuntime) {
        return false;
      }
      if (!dependencies.featureGate.isEnabled()) {
        return false;
      }
      // 先占位再 await：多个窗口同时完成标签页恢复时只能有一个调用启动 runtime。
      autoStartAttempted = true;
      try {
        if (!(await dependencies.remoteAccessSettings.isEnabled())) {
          autoStartAttempted = false;
          return false;
        }
        if (autoStartSuppressed || appRuntime) {
          // await 期间被显式关闭或已被另一个并发调用启动。
          return false;
        }

        const currentContext = candidates[0] ?? resolveAutoStartContext();
        if (!currentContext) {
          autoStartAttempted = false;
          return false;
        }

        dependencies.logger.info(
          `[web-remote-control] auto-starting app runtime window=${windowId} workspace=${currentContext.workspacePath} remoteSession=${currentContext.remoteSessionId ?? "none"}`,
        );
        await this.start(
          {
            workspacePath: currentContext.workspacePath,
            workspaceIdentity: currentContext.workspaceIdentity,
            remoteSessionId: currentContext.remoteSessionId,
          },
          windowId,
        );
        return true;
      } catch (error) {
        autoStartAttempted = false;
        dependencies.logger.warn("[web-remote-control] auto-start app runtime failed", error);
        return false;
      }
    },

    /** App 级状态（旧窗口级 IPC 的转调目标）：所有窗口看到同一份事实。 */
    getStatus(): WebRemoteControlStatus {
      if (!dependencies.featureGate.isEnabled()) {
        return {
          status: "idle",
          failure: createFailure(
            "unsupported-action",
            "Web remote control is disabled in this build.",
          ),
        };
      }

      const runtime = appRuntime;
      if (!runtime) {
        return { status: "idle" };
      }

      return buildRuntimeStatus(runtime);
    },

    /** App 级远程访问状态：开关 + 唯一 runtime 的全局状态 + gateway 连接状态（T2.3/T3.2）。 */
    async getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
      return {
        enabled: await dependencies.remoteAccessSettings.isEnabled(),
        status: this.getStatus(),
        gateway: dependencies.getGatewayConnectionStatus?.() ?? { state: "disabled" },
      };
    },

    /**
     * 显式设置远程访问开关：先持久化，再启停 App 级 runtime。
     * Main 是开关的唯一写入方，renderer 不直接改 settings 里的 remoteAccess。
     */
    async setRemoteAccessEnabled(enabled: boolean): Promise<void> {
      await dependencies.remoteAccessSettings.setEnabled(enabled);
      await this.applyRemoteAccessEnabled(enabled);
    },

    /**
     * 只对开关值做出反应（不写设置）。renderer 通过设置页写入后经 SyncAppSettings 到达这里，
     * 与 `setRemoteAccessEnabled` 共用同一条启停路径，避免出现第二条 runtime 控制路径。
     */
    async applyRemoteAccessEnabled(enabled: boolean): Promise<void> {
      if (!enabled) {
        autoStartSuppressed = true;
        autoStartAttempted = false;
        await stopRuntime("remote-access-disabled");
        return;
      }

      autoStartSuppressed = false;
      if (appRuntime || autoStartAttempted) {
        return;
      }
      // 同步占位，避免两条设置同步路径同时启动。
      autoStartAttempted = true;
      const context = resolveAutoStartContext();
      if (!context) {
        // 还没有任何窗口同步过 workspace：等下一次快照同步走 restorePreviouslyEnabled。
        autoStartAttempted = false;
        return;
      }
      try {
        await this.start(context);
      } catch (error) {
        autoStartAttempted = false;
        dependencies.logger.warn(
          "[web-remote-control] start for enabled remote access failed",
          error,
        );
      }
    },

    /**
     * 断开当前手机（T2.3）。释放当前 bridge 并把 App 级 runtime 恢复为「等待手机」；
     * gateway channel transport 通过关闭当前 channel 实现，设备凭证与 backend 连接保持不变。
     */
    disconnectRemoteClient(): void {
      const runtime = appRuntime;
      if (!runtime) {
        return;
      }

      const bridge = runtime.currentBridge;
      if (bridge) {
        sendAppPayload(runtime, {
          zcode_type: "workspace-bridge-error",
          requestId: `disconnect-remote-client:${bridge.bridgeSessionId}`,
          bridgeSessionId: bridge.bridgeSessionId,
          ...(bridge.bridgeGeneration !== undefined
            ? { bridgeGeneration: bridge.bridgeGeneration }
            : {}),
          ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
          reason: "desktop-disconnected",
          error: "Desktop disconnected the mobile client.",
        });
        disposeRuntimeBridgeResources(runtime);
      }
      clearPendingOutboundPayloadTimer(runtime);
      clearMobileDisconnectGraceTimer(runtime);
      runtime.pendingOutboundPayloads.length = 0;
      runtime.mobileConnected = false;
      runtime.mobileViewState = undefined;
      runtime.mobileDeviceInfo = undefined;
      runtime.status = "running";
      runtime.error = undefined;
      runtime.failure = undefined;
      runtime.transport.disconnectClient();
      emitRuntimeStatus(runtime);
    },

    syncAvailableWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void {
      // T2.2：同步不再依赖「本窗口存在远控 runtime」（旧实现没有 runtime 就直接 return）。
      // 远控改为 App 级后目录是所有窗口的共同投影，没有 runtime 只是暂时没有手机可推送，
      // 快照本身必须留下来，供聚合、bridge 路由和「打开最近项目」的成功判定读取。
      dependencies.remoteWorkspaceDirectory.syncWorkspaces(windowId, workspaces);
      const runtime = appRuntime;
      if (!runtime) {
        return;
      }
      pushWorkspaceListUpdated(runtime);
      // T2.4：打开最近项目的成功判定就是「该 workspace 出现在聚合列表」。
      completePendingWorkspaceOpens(runtime);
      // 最近项目可能刚被打开动作写入设置（旧路径不经过 SyncAppSettings），按需刷新。
      void refreshRecentProjects(runtime);
    },

    syncAvailableTasks(windowId: number, tasks: WebRemoteControlTaskTarget[]): void {
      dependencies.remoteWorkspaceDirectory.syncTasks(windowId, tasks);
      const runtime = appRuntime;
      if (!runtime) {
        return;
      }
      pushWorkspaceListUpdated(runtime);
    },

    /**
     * 窗口关闭（T2.3）：只释放属于该窗口的 bridge 和快照，不停止 App 级 runtime。
     * 手机侧收到 `workspace-bridge-error`，随后收到聚合后的 workspace-list。
     */
    async disposeWindow(windowId: number): Promise<void> {
      const runtime = appRuntime;
      const bridge = runtime?.currentBridge;
      if (runtime && bridge?.windowId === windowId) {
        disposeRuntimeBridgeResources(runtime);
        sendAppPayload(runtime, {
          zcode_type: "workspace-bridge-error",
          requestId: `window-disposed:${bridge.bridgeSessionId}`,
          bridgeSessionId: bridge.bridgeSessionId,
          ...(bridge.bridgeGeneration !== undefined
            ? { bridgeGeneration: bridge.bridgeGeneration }
            : {}),
          ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
          reason: "workspace-closed",
          error: "The desktop window that owned this workspace was closed.",
        });
        runtime.status = runtime.mobileConnected ? "active" : "running";
        runtime.error = undefined;
        runtime.failure = undefined;
        emitRuntimeStatus(runtime);
      }
      dependencies.remoteWorkspaceDirectory.removeWindow(windowId);
      dependencies.disposeWorkspaceHostAttachmentsForWindow(windowId, "window-disposed");
      if (runtime) {
        pushWorkspaceListUpdated(runtime);
        // 窗口关闭可能让 desktopWindowState 从 open 变成 none。
        pushRecentProjectsUpdated(runtime);
      }
    },

    /** T2.4：设置里的 recentProjects 变化后刷新并推送最近项目快照。 */
    notifyRecentProjectsChanged(): void {
      const runtime = appRuntime;
      if (!runtime) {
        return;
      }
      void refreshRecentProjects(runtime);
    },

    failRemoteSession(
      remoteSessionId: string,
      reason: string,
      failure: WebRemoteControlFailure,
    ): void {
      const runtime = appRuntime;
      if (runtime) {
        const bridge = runtime.currentBridge;
        const bridgeUsesRemoteSession = bridge?.remoteSessionId === remoteSessionId;
        if (bridgeUsesRemoteSession) {
          // Bugfix: 远程 workspace session 只是某个 workspace/bridge 的依赖，不能把它的断开升级成
          // App 级远控 device WS 失败；否则单个远端空闲退出会错误关闭电脑端全局远控入口。
          disposeRuntimeBridgeResources(runtime);
          sendAppPayload(runtime, {
            zcode_type: "workspace-bridge-error",
            bridgeSessionId: bridge.bridgeSessionId,
            ...(bridge.bridgeGeneration !== undefined
              ? { bridgeGeneration: bridge.bridgeGeneration }
              : {}),
            ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
            requestId: `remote-session-closed:${remoteSessionId}`,
            reason: failure.reason,
            error: failure.message ?? failure.reason,
          });
          runtime.status = runtime.mobileConnected ? "active" : "running";
          runtime.error = undefined;
          runtime.failure = undefined;
          emitRuntimeStatus(runtime);
        }
        // 启动上下文只是状态兜底，不再决定远控会话存亡；同步清掉失效的 remoteSessionId。
        if (runtime.remoteSessionId === remoteSessionId) {
          runtime.remoteSessionId = undefined;
        }
      }
      dependencies.disposeWorkspaceHostAttachmentsForRemoteSession(remoteSessionId, reason);
    },
  };
}
