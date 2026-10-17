/* eslint-disable max-lines -- 手机远控启动流程（配置解析 → gateway transport → 版本校验 → workspace bridge → Root 渲染）暂时集中在一个模块。 */
import {
  AppErrorBoundary,
  Root,
  WebRemoteControlMobileStartPage,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import { connectViaProtocol, createAcknowledgedWebRemoteControlRelayProtocol } from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  ZCODE_VERSION,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
  sessionCreateTelemetrySchema,
  type IPlatformService,
  type PlatformSecureStore,
  type WebRemoteControlAppPayload,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileNavigationIntent,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlRecentProjectsResult,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import { createWebRemoteControlAppPayloadRequester } from "./payloadRequester.js";
import { createWebRemoteControlRelayRequestRecovery } from "./requestRecovery.js";
import { createHomeOnlyWebRemoteControlServices } from "./homeOnlyServices.js";
import { createWebRemoteControlLifecycleRecovery } from "../webRemoteControlLifecycle.js";
import { seedWebRemoteControlThemePreference } from "../webRemoteControlThemeSeed.js";
import { createWebRemoteControlVersionGuard } from "../webRemoteControlVersion.js";
import { showWebRemoteControlVersionNotice } from "../webRemoteControlVersionNotice.js";
import { collectWebRemoteControlMobileDeviceInfo } from "../webRemoteControlDeviceInfo.js";
import {
  markCurrentWebRemoteControlBridgeTaskRead,
  markOpenedWebRemoteControlBridgeTaskRead,
} from "../webRemoteControlBridgeTaskRead.js";
import {
  registerWebRemoteControlWorkspaceBridgeServices,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
} from "../webRemoteControlWorkspaceBridgeSession.js";
import { createWebPlatform } from "../webPlatformService.js";
import { webEntryRoot } from "../webEntryRoot.js";
import {
  renderWebRemoteControlFailure,
  toWebRemoteControlFailure,
} from "../webRemoteControlFailureView.js";
import { WebRemoteControlLoadingScreen } from "../webRemoteControlLoadingScreen.js";
import {
  GatewayTerminalTransport,
  type GatewayTerminalTransportDiagnostic,
  type GatewayTerminalTransportState,
} from "./gatewayTerminalTransport.js";
import { resolveWebRemoteControlThemeFromSearchParams } from "./gatewayBootstrapConfig.js";
import { MobileRemoteConfigStore } from "./mobileRemoteConfigStore.js";
import {
  resolveMobileRemoteConnection,
  type MobileRemoteConnectionConfig,
  type MobileRemoteSetupMode,
} from "./mobileRemoteSetup.js";
import {
  createMobileRemoteSecureStore,
  resolveMobileRemoteNativeBridge,
} from "./mobileRemoteSecureStore.js";

/**
 * 手机远控启动模块（T1.2 迁出 `main.tsx`，T3.4 换成 gateway transport，T4.2 加设置/选电脑流程）。
 * 手机入口（`mobile.html`）从这里启动远控：
 * 设置页/选电脑页（首次使用）→ 建 GatewayTerminalTransport → 校验桌面版本 → 打开 workspace bridge
 * → 渲染 Root 或「没有打开的项目」首页。
 */
export interface BootstrapGatewayWebRemoteControlOptions {
  /** 注入的平台实现；缺省创建带安全存储能力的 Web 平台。 */
  platform?: IPlatformService;
  /** 安全存储覆盖；缺省从原生桥/开发模式 localStorage 创建。 */
  secureStore?: PlatformSecureStore;
  /** release 构建不允许 URL 凭证；默认 `!import.meta.env.PROD`。 */
  allowUrlConfig?: boolean;
  /** 本地开发允许 http gateway；默认 `!import.meta.env.PROD`。 */
  allowInsecureTransport?: boolean;
}

type GatewaySessionContext = {
  platform: IPlatformService;
  configStore: MobileRemoteConfigStore;
  reopenConnection(mode: MobileRemoteSetupMode): Promise<MobileRemoteConnectionConfig | null>;
};

function createDefaultSecureStore(): PlatformSecureStore {
  const bridge = resolveMobileRemoteNativeBridge();
  return createMobileRemoteSecureStore(bridge ? { bridge } : {});
}

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
) => void;
type WebRemoteControlRecentProjectsUpdateListener = (
  result: WebRemoteControlRecentProjectsResult,
) => void;

// 页面级标志：手机入口与桌面 Web 客户端各自独立打包，同一页面只会走其中一条启动路径。
let isPageUnloading = false;

function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bugfix: iOS private mode 等环境可能禁用 localStorage。
    // 这里保留前面注入的物理指纹 fallback，避免远控首屏因 clientId 持久化失败而中断。
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

function renderWebRemoteControlLoading(state: UiWebRemoteControlTerminalTransportState): void {
  document.title = "ZCode - Web Remote Control";
  webEntryRoot.render(<WebRemoteControlLoadingScreen state={state} />);
}

/** 新的 gateway transport 状态映射到现有手机壳/加载页使用的 UI 状态。 */
function toUiTerminalTransportState(
  state: GatewayTerminalTransportState,
): UiWebRemoteControlTerminalTransportState {
  switch (state) {
    case "connecting":
      return "connecting";
    case "ready":
      return "paired";
    case "reconnecting":
      return "reconnecting";
    case "suspended":
      return "suspended";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** 可恢复失败不卸载页面：transport 继续监听 registry，电脑恢复在线后自动重连。 */
function isRecoverableGatewayFailure(reason: WebRemoteControlFailureReason): boolean {
  return reason === "gateway-unreachable" || reason === "desktop-disconnected";
}

export async function bootstrapGatewayWebRemoteControl(
  params: URLSearchParams,
  options: BootstrapGatewayWebRemoteControlOptions = {},
): Promise<void> {
  const allowUrlConfig = options.allowUrlConfig ?? !import.meta.env.PROD;
  const allowInsecureTransport = options.allowInsecureTransport ?? !import.meta.env.PROD;
  const secureStore =
    options.secureStore ?? options.platform?.secureStore ?? createDefaultSecureStore();
  // 不展开注入的平台对象：桌面/测试实现可能是带原型方法的实例。能力缺省时只补 secureStore。
  const platform = options.platform ?? createWebPlatform({ secureStore });
  if (!platform.secureStore) {
    platform.secureStore = secureStore;
  }
  const configStore = new MobileRemoteConfigStore(platform.secureStore, {
    allowInsecureTransport,
  });
  const setupOptions = {
    store: configStore,
    allowUrlConfig,
    allowInsecureTransport,
  };

  seedWebRemoteControlThemePreference(resolveWebRemoteControlThemeFromSearchParams(params));

  let config: MobileRemoteConnectionConfig | null;
  try {
    config = await resolveMobileRemoteConnection(params, setupOptions);
  } catch (error) {
    // 设置流程本身失败（例如安全存储不可用）时给用户可重试的失败页，而不是白屏。
    renderWebRemoteControlFailure(
      toWebRemoteControlFailure(
        "unexpected-error",
        error instanceof Error ? error.message : String(error),
      ),
    );
    return;
  }
  if (!config) {
    return;
  }

  const context: GatewaySessionContext = {
    platform,
    configStore,
    reopenConnection: (mode) =>
      resolveMobileRemoteConnection(null, setupOptions, {
        mode,
        readUrlConfig: false,
      }),
  };
  await startGatewaySession(config, context);
}

async function startGatewaySession(
  gatewayConfig: MobileRemoteConnectionConfig,
  context: GatewaySessionContext,
): Promise<void> {
  let clientInstanceId: string;
  try {
    clientInstanceId = await context.configStore.getClientInstanceId(gatewayConfig.backendId);
  } catch (error) {
    renderWebRemoteControlFailure(
      toWebRemoteControlFailure(
        "unexpected-error",
        error instanceof Error ? error.message : String(error),
      ),
    );
    return;
  }

  seedStableWebRemoteControlClientId(clientInstanceId);

  let bootstrapping = false;
  let recovering = false;
  let ready = false;
  let terminated = false;
  let disposed = false;
  let restarting = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let nextBridgeGeneration = 0;
  let latestRecentProjects: WebRemoteControlRecentProjectsResult | undefined;
  let renderStartPageIfActive: (() => void) | undefined;
  let disposeStartPageWorkspaceSubscription: (() => void) | undefined;
  let disposeStartPageRecentSubscription: (() => void) | undefined;
  let disposeVersionNotice: (() => void) | undefined;
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    isPageReady: () => ready,
    onVersionChanged: (version) => {
      // 页面打进 APK 后没有版本化 URL 可导航；这里只提示，是否重新加载由用户决定，
      // 真正的协议不兼容由 channel 的 appProtocol 协商处理（见 webRemoteControlVersion.ts）。
      disposeVersionNotice?.();
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        window.location.reload(),
      );
    },
  });
  let activeRelayProtocol:
    | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
    | undefined;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((payload: WebRemoteControlAppPayload & { zcode_type: "mobile-diagnostic" }) => void)
    | undefined;
  const workspaceListUpdateListeners = new Set<WebRemoteControlWorkspaceListUpdateListener>();
  const recentProjectsUpdateListeners = new Set<WebRemoteControlRecentProjectsUpdateListener>();

  const subscribeWorkspaceListUpdates = (listener: WebRemoteControlWorkspaceListUpdateListener) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
  };

  const subscribeRecentProjectsUpdates = (
    listener: WebRemoteControlRecentProjectsUpdateListener,
  ) => {
    recentProjectsUpdateListeners.add(listener);
    return () => {
      recentProjectsUpdateListeners.delete(listener);
    };
  };

  const applyRecentProjectsResult = (result: WebRemoteControlRecentProjectsResult) => {
    latestRecentProjects = {
      desktopWindowState: result.desktopWindowState,
      recentProjects: result.recentProjects,
    };
    for (const listener of recentProjectsUpdateListeners) {
      listener(latestRecentProjects);
    }
  };

  const applyRecentProjectsFromBootstrap = (result: WebRemoteControlWindowBootstrapResult) => {
    if (result.desktopWindowState === undefined && result.recentProjects === undefined) {
      return;
    }
    applyRecentProjectsResult({
      desktopWindowState: result.desktopWindowState ?? "open",
      recentProjects: result.recentProjects ?? [],
    });
  };

  const normalizeWorkspaceListResult = (
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult => ({
    ...result,
    activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
    activeTaskId: result.activeTaskId ?? currentTaskId,
  });

  const applyWorkspaceListUpdated = (result: WebRemoteControlWorkspaceListResult) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  const sendMobileDiagnostic = (diagnostic: GatewayTerminalTransportDiagnostic) => {
    const base = {
      zcode_type: "mobile-diagnostic" as const,
      timestamp: diagnostic.timestamp,
      state: diagnostic.state,
      visibilityState: diagnostic.visibilityState,
      online: diagnostic.online,
      hiddenDurationMs: diagnostic.hiddenDurationMs,
    };
    switch (diagnostic.type) {
      case "state-transition":
        sendMobileDiagnosticPayload?.({
          ...base,
          event: "state-transition",
          previousState: diagnostic.previousState,
        });
        break;
      case "socket-close":
        sendMobileDiagnosticPayload?.({
          ...base,
          event: "socket-close",
          closeCode: diagnostic.code,
          closeReason: diagnostic.reason,
          wasClean: diagnostic.wasClean,
          // mobile-diagnostic 的历史字段名保留 wasPaired；gateway 语义是 channel 曾 ready。
          wasPaired: diagnostic.wasReady,
        });
        break;
      case "socket-error":
        sendMobileDiagnosticPayload?.({ ...base, event: "socket-error" });
        break;
      case "recover-start":
        sendMobileDiagnosticPayload?.({ ...base, event: "recover-start" });
        break;
      case "recover-scheduled":
        sendMobileDiagnosticPayload?.({ ...base, event: "recover-scheduled" });
        break;
      default:
        // credential-reverify/protocol-error/heartbeat-timeout/channel-rejected 不属于
        // mobile-diagnostic 现有事件集，避免为了诊断扩展 appProtocol 1 的 payload schema。
        break;
    }
  };

  const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: "failure",
      timestamp: Date.now(),
      state: terminalTransportState,
      failureReason: failure.reason,
      failureMessage: failure.message,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
    });
  };

  const mapBootstrapUnknownErrorToFailure = (error: unknown): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  // 这两个动作依赖 transport/requester，真实实现放在建连代码之后；失败页回调只在
  // 建连完成后触发，所以先占位可以避免前置声明顺序问题。
  let disposeSession = (): void => {};
  let reopenSetup = (_mode: MobileRemoteSetupMode): void => {};

  const renderBootstrapFailure = (
    failure: WebRemoteControlFailure,
    behavior: { recoverable?: boolean } = {},
  ) => {
    if (terminated) {
      return;
    }
    sendMobileFailureDiagnostic(failure);
    if (behavior.recoverable) {
      // 可恢复失败不卸载已挂载的页面（草稿和输入状态保留）；还没进入首页时给出
      // 手动重试入口，transport 仍会按 registry 自动重连。
      if (!ready) {
        renderWebRemoteControlFailure(failure, {
          onRetry: () => {
            void recoverVisibleSession("manual-retry");
          },
        });
      }
      return;
    }
    disposeSession();
    renderWebRemoteControlFailure(failure, {
      onOpenSettings: () => reopenSetup("settings"),
      onChooseBackend: () => reopenSetup("backend"),
      onRetry: () => window.location.reload(),
    });
  };

  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  let bootstrapPairedSession:
    | ((options?: { preferredWorkspaceKey?: string; preferredTaskId?: string }) => Promise<void>)
    | undefined;

  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" || reason === "pageshow" || reason === "online" || reason === "resume";

  const recoverVisibleSession = async (reason: string): Promise<void> => {
    if (recovering || isPageUnloading || terminated) {
      return;
    }
    recovering = true;
    const preferredWorkspaceKey = currentWorkspaceKey;
    const preferredTaskId = currentTaskId;
    currentRecoveryId = createWebRemoteControlRequestId("recovery");
    const requiresBridgeRebuild =
      !isLifecycleRecoveryReason(reason) || activeRelayProtocol?.isDegraded() === true;
    if (requiresBridgeRebuild) {
      activeRelayProtocol?.markDegraded();
    }
    bootstrapping = true;
    try {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] recover terminal session", {
          reason,
          recoveryId: currentRecoveryId,
          currentWorkspaceKey: preferredWorkspaceKey,
          currentTaskId: preferredTaskId,
        });
      }
      await transport.recoverConnection();
      if (!requiresBridgeRebuild && activeRelayProtocol && !activeRelayProtocol.isDegraded()) {
        try {
          await checkDesktopVersion();
        } catch (error) {
          // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
          if (!activeRelayProtocol.isDegraded()) throw error;
        }
        // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
        // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已配对，正在加载工作区…”闪回。
        // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
        // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
        if (!activeRelayProtocol.isDegraded()) {
          currentRecoveryId = undefined;
          return;
        }
      }
      await bootstrapPairedSession?.({
        preferredWorkspaceKey,
        preferredTaskId,
      });
    } catch (error) {
      if (!import.meta.env.PROD) {
        console.warn(
          "[web-remote-control] terminal recover timed out, keeping current page for retry",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!terminated && !isPageUnloading) {
        // Bugfix: 手机长时间切到后台后，recoverConnection 可能超过单次等待窗口。
        // 这不代表桌面端离线，也不应该卸载当前 React 页面；否则输入框草稿会被错误页打断。
        // 这里保留原页面和输入状态，继续让 transport 的重连状态机自动恢复。
        transport.recoverInBackground();
      }
    } finally {
      recovering = false;
      bootstrapping = false;
    }
  };

  renderWebRemoteControlLoading("connecting");

  const transport = new GatewayTerminalTransport({
    gatewayUrl: gatewayConfig.gatewayUrl,
    namespace: gatewayConfig.namespace,
    credential: gatewayConfig.credential,
    backendId: gatewayConfig.backendId,
    clientInstanceId,
    clientName: "ZCode Mobile",
    appVersion: ZCODE_VERSION,
    onRawTransportPayload: (payload) => activeRelayProtocol?.acceptPayload(payload) ?? false,
    onRawTransportFault: (reasonCode) => {
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        activeRelayProtocol?.acceptPayload(payload);
        return;
      }
      if (requester.acceptPayload(payload)) {
        return;
      }
      if (payload.zcode_type === "workspace-list-updated") {
        applyWorkspaceListUpdated(payload.result);
        return;
      }
      if (payload.zcode_type === "recent-projects-updated") {
        applyRecentProjectsResult(payload.result);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          // Bugfix: 远程 session 关闭会异步通知当前 bridge 失效，不对应任何 pending request。
          // 这里按硬恢复重建视图，让断开的远程 workspace 回到 home-only/reconnect 状态。
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(toWebRemoteControlFailure(payload.reason, payload.error));
      }
    },
    onStateChange: (state) => {
      if (terminated) {
        return;
      }
      const uiState = toUiTerminalTransportState(state);
      terminalTransportState = uiState;
      if (uiState !== "paired") versionGuard.invalidate();
      setWebRemoteControlTerminalTransportState(uiState);
      if (!ready) {
        renderWebRemoteControlLoading(uiState);
      }
      if (uiState !== "paired") {
        return;
      }
      // 已有校验操作自行跨重连消费一次重试；配对事件不能启动另一个恢复 owner。
      if (bootstrapping && pendingVersionCheck) return;
      // healthy bridge 与在途初始化都不能并发新建 bridge，但新配对仍必须检查桌面版本。
      if ((activeRelayProtocol && !activeRelayProtocol.isDegraded()) || bootstrapping) {
        // T4.2：版本检查不再阻塞业务；这里只观察桌面版本变化（版本化 URL 已删除）。
        void checkDesktopVersion().catch((error) => {
          // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
          if (!terminated) {
            void recoverVisibleSession("visible");
            if (!import.meta.env.PROD)
              console.warn("[web-remote-control] version check failed", error);
          }
        });
        return;
      }
      if (!bootstrapPairedSession) {
        return;
      }
      bootstrapping = true;
      void bootstrapPairedSession()
        .catch((error) => {
          renderBootstrapError(error);
        })
        .finally(() => {
          bootstrapping = false;
        });
    },
    onFailure: (failure) => {
      if (isRecoverableGatewayFailure(failure.reason)) {
        // 可恢复失败：保留当前页面，transport 继续按 registry 自动重连；
        // 还没进入首页时渲染带手动重试的失败页。
        renderBootstrapFailure(failure, { recoverable: true });
        return;
      }
      renderBootstrapFailure(failure);
    },
    onError: (error) => {
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] terminal transport error", error.message);
      }
    },
    onDiagnostic: (diagnostic) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] terminal diagnostic", diagnostic);
      }
      sendMobileDiagnostic(diagnostic);
    },
    onSendReady: () => {
      if (activeRelayProtocol?.isDegraded()) return;
      // Bug 修复：channel 重新 ready 只说明链路恢复，desktop peer 可能已经换代，
      // 也可能只丢了上一批 data/ACK。重放同 bridge 未 ACK 批次，由 messageSeq 去重；
      // adapter 继续保留原始 45 秒 age，避免心跳把不可恢复链路无限续命。
      activeRelayProtocol?.replayUnacknowledged();
    },
    onVersionNegotiated: (info) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] negotiated app protocol", info);
      }
    },
  });
  sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
  const requester = createWebRemoteControlAppPayloadRequester({
    sendPayload: (payload) => transport.sendPayload(payload),
  });

  const requestAppPayload = requester.requestAppPayload;
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(() =>
    transport.recoverConnection(),
  );

  const requestBootstrap = async (): Promise<WebRemoteControlWindowBootstrapResult> => {
    const requestId = createWebRemoteControlRequestId("bootstrap");
    const response = await requestAppPayload(
      { zcode_type: "bootstrap-request", requestId },
      (
        payload,
      ): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "bootstrap-response" }> =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === requestId,
    );
    applyRecentProjectsFromBootstrap(response.result);
    return response.result;
  };

  let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
  const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
    if (pendingVersionCheck) return pendingVersionCheck;
    // T4.2：check() 不再因版本不匹配返回 undefined；undefined 只表示连接已换代/已释放，
    // 由调用方按一次可恢复失败处理，不能在这里循环重试（APK 没有版本化 URL 可导航）。
    const request = requestWithRelayRecovery(() => versionGuard.check(), {
      recoverTimeout: true,
    }).finally(() => {
      if (pendingVersionCheck === request) pendingVersionCheck = undefined;
    });
    pendingVersionCheck = request;
    return request;
  };

  const requestPlatformMethod = async <K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("platform");
      const request = {
        zcode_type: "platform-request",
        requestId,
        method,
        args,
      } as WebRemoteControlPlatformRequestPayload;
      return requestAppPayload(
        request,
        (
          payload,
        ): payload is Extract<
          WebRemoteControlPlatformResponsePayload,
          { zcode_type: "platform-response" }
        > =>
          payload.zcode_type === "platform-response" &&
          payload.requestId === requestId &&
          payload.method === method,
      );
    });
    const platformResponse = response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };
  const listWorkspaces = async (): Promise<WebRemoteControlWorkspaceListResult> => {
    const requestWorkspaceList = async () => {
      const requestId = createWebRemoteControlRequestId("workspace-list");
      return requestAppPayload(
        { zcode_type: "workspace-list-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-list-response" }
        > => payload.zcode_type === "workspace-list-response" && payload.requestId === requestId,
      );
    };
    const response = await requestWithRelayRecovery(() => requestWorkspaceList(), {
      // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
      // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
      recoverTimeout: true,
    });
    return normalizeWorkspaceListResult(response.result);
  };

  const updateMobileViewState = async (workspaceKey: string, taskId?: string): Promise<void> => {
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    transport.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: collectWebRemoteControlMobileDeviceInfo({
        appVersion: ZCODE_VERSION,
      }),
    });
  };

  const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("workspace-reconnect");
      return requestAppPayload(
        {
          zcode_type: "workspace-reconnect-request",
          requestId,
          workspaceKey,
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-reconnect-response" }
        > =>
          payload.zcode_type === "workspace-reconnect-response" &&
          payload.requestId === requestId &&
          payload.workspaceKey === workspaceKey,
        {
          // 远程重连会启动或部署 host，Docker/SSH 首连可能超过默认 10 秒；这里放宽等待，避免桌面端成功后手机端先误报超时。
          timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
        },
      );
    });
    if (!response.success) {
      throw new Error(response.error);
    }
  };

  /** 方案「新增应用 payload」：手机只能传最近项目 id，路径由桌面解析。 */
  const requestOpenRecentProject = async (recentProjectId: string): Promise<string> => {
    const requestId = createWebRemoteControlRequestId("workspace-open");
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        { zcode_type: "workspace-open-request", requestId, recentProjectId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-open-response" }
        > => payload.zcode_type === "workspace-open-response" && payload.requestId === requestId,
        {
          // 桌面侧以「workspace 出现在聚合列表」为成功标志，自身超时 10 秒；
          // 这里留出响应回传余量，避免两端同时超时。
          timeoutMs: 12_000,
        },
      ),
    );
    if (!response.success) {
      throw new Error(response.error);
    }
    return response.workspaceKey;
  };

  const requestOpenDesktopWindow = async (): Promise<void> => {
    const requestId = createWebRemoteControlRequestId("desktop-window-open");
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        { zcode_type: "desktop-window-open-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "desktop-window-open-response" }
        > =>
          payload.zcode_type === "desktop-window-open-response" && payload.requestId === requestId,
        { timeoutMs: 15_000 },
      ),
    );
    if (!response.success) {
      throw new Error(response.error);
    }
  };

  const mobileRemoteSwitcherExtras = {
    getRecentProjects: async (): Promise<WebRemoteControlRecentProjectsResult> =>
      latestRecentProjects ?? { desktopWindowState: "open", recentProjects: [] },
    onRecentProjectsUpdated: subscribeRecentProjectsUpdates,
    openRecentProject: requestOpenRecentProject,
    openDesktopWindow: requestOpenDesktopWindow,
    onOpenSettings: () => reopenSetup("settings"),
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
  }> => {
    const bridgeSessionId = createWebRemoteControlRequestId("bridge");
    const bridgeGeneration = ++nextBridgeGeneration;
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        {
          zcode_type: "workspace-bridge-open",
          requestId: createWebRemoteControlRequestId("workspace-bridge"),
          bridgeSessionId,
          bridgeGeneration,
          ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
          workspaceKey,
          ...(options?.taskId ? { taskId: options.taskId } : {}),
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-bridge-ready" }
        > =>
          payload.zcode_type === "workspace-bridge-ready" &&
          payload.bridgeSessionId === bridgeSessionId,
      ),
    );
    currentRecoveryId = undefined;
    if (terminated) {
      throw new Error("Web remote control session closed before the workspace bridge was ready.");
    }
    const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: response.bridge.bridgeSessionId,
      bridgeGeneration: response.bridge.bridgeGeneration,
      recoveryId: response.bridge.recoveryId,
      measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
      sendFrame: (frame) => {
        const result = transport.sendPayloadResult(frame);
        if (result.kind === "oversize") {
          throw new Error("remote.rpcFrame.envelopeTooLarge");
        }
        return result.kind === "sent";
      },
    });
    relayProtocol.onDegraded((fault) => {
      if (activeRelayProtocol !== relayProtocol) return;
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] raw relay bridge degraded", {
          bridgeSessionId: relayProtocol.getBridgeSessionId(),
          reasonCode: fault.reasonCode,
        });
      }
      void recoverVisibleSession(fault.reasonCode);
    });
    const services = connectViaProtocol(relayProtocol.protocol);
    const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: response.bridge,
      services,
    });
    // 已读写入是打开 task 的伴随动作，不等待它完成，避免慢磁盘/远程 IO 阻塞 bridge 切换。
    void markOpenedWebRemoteControlBridgeTaskRead({
      bridge: response.bridge,
      expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
      services,
    });
    const previousRelayProtocol = activeRelayProtocol;
    const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
    activeRelayProtocol = relayProtocol;
    activeBridgeServiceRegistration = bridgeServiceRegistration;
    previousRelayProtocol?.dispose();
    previousBridgeServiceRegistration?.dispose();
    currentWorkspaceKey = response.bridge.workspaceKey;
    currentTaskId = response.bridge.initialTaskId;
    await updateMobileViewState(response.bridge.workspaceKey, response.bridge.initialTaskId);
    return { bridge: response.bridge, services, relayProtocol };
  };

  const renderExternalRelayRoot = (
    services: Awaited<ReturnType<typeof connectViaProtocol>>,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
  ) => {
    if (terminated) return;
    ready = true;
    renderStartPageIfActive = undefined;
    disposeStartPageWorkspaceSubscription?.();
    disposeStartPageWorkspaceSubscription = undefined;
    disposeStartPageRecentSubscription?.();
    disposeStartPageRecentSubscription = undefined;
    document.title = "ZCode - Web Remote Control";
    webEntryRoot.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema.safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
              ...(context.platform.secureStore
                ? { secureStore: context.platform.secureStore }
                : {}),
            })}
            // Bug 原因：手机复用 Desktop Host 中已持久化的 Assistant row，但 Root 默认关闭
            // code-comment 投影，导致 replay hydration 暴露原始 directive。该开关只修正展示能力，
            // 不进入 relay、Host 或 replayable 状态。
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={
              bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
            }
            initialTaskId={bridge.initialTaskId}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces,
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              switchWorkspace: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, options);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
              ...mobileRemoteSwitcherExtras,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (terminated) return;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    const initialResult = await listWorkspaces();
    if (terminated) return;
    ready = true;
    renderStartPageIfActive = undefined;
    disposeStartPageWorkspaceSubscription?.();
    disposeStartPageWorkspaceSubscription = undefined;
    disposeStartPageRecentSubscription?.();
    disposeStartPageRecentSubscription = undefined;
    webEntryRoot.render(
      <AppErrorBoundary key={`home-only-${workspaceKey}`}>
        <ZCodeIntlProvider>
          <Root
            services={createHomeOnlyWebRemoteControlServices()}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema.safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
              ...(context.platform.secureStore
                ? { secureStore: context.platform.secureStore }
                : {}),
            })}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces: async () => ({
                ...(await listWorkspaces()),
                activeWorkspaceKey: currentWorkspaceKey,
                activeTaskId: currentTaskId,
              }),
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              switchWorkspace: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, options);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
              ...mobileRemoteSwitcherExtras,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
            initialWebRemoteControlWorkspaceList={initialResult}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  /**
   * 桌面没有打开任何 workspace 时的手机首页（T4.2）。
   *
   * 不挂 Root：Root 依赖初始 workspace，没有 tab 时无法进入任务壳。这里展示最近项目
   * 和无窗口空态；打开项目/窗口后由桌面推送 `workspace-list-updated`，再回到正常 bootstrap。
   */
  const renderMobileRemoteStartPage = (): void => {
    // 已经显示空态时不要重建局部状态：否则打开项目失败后的错误会被一次
    // `workspace-list-updated` 刷新覆盖掉。最近项目和列表变化通过订阅原地更新。
    if (terminated || renderStartPageIfActive) {
      return;
    }
    ready = true;
    let openingProjectId: string | null = null;
    let openingWindow = false;
    let error: string | null = null;

    const render = () => {
      if (terminated || renderStartPageIfActive !== render) {
        return;
      }
      const recent = latestRecentProjects ?? {
        desktopWindowState: "open" as const,
        recentProjects: [],
      };
      webEntryRoot.render(
        <ZCodeIntlProvider>
          <WebRemoteControlMobileStartPage
            desktopWindowState={recent.desktopWindowState}
            recentProjects={recent.recentProjects}
            openingProjectId={openingProjectId}
            openingWindow={openingWindow}
            error={error}
            onOpenRecentProject={(projectId) => {
              if (openingProjectId || openingWindow) {
                return;
              }
              openingProjectId = projectId;
              error = null;
              render();
              void (async () => {
                try {
                  await requestOpenRecentProject(projectId);
                } catch (openError) {
                  error = openError instanceof Error ? openError.message : String(openError);
                } finally {
                  openingProjectId = null;
                  // 打开成功后桌面会推送 workspace 列表；这里也主动 bootstrap 一次，
                  // 避免列表推送晚于响应时停留在空态。失败时保留错误提示，不重建页面。
                  if (!error) {
                    void bootstrapPairedSession?.().catch((bootstrapError) => {
                      error =
                        bootstrapError instanceof Error
                          ? bootstrapError.message
                          : String(bootstrapError);
                      render();
                    });
                  }
                  render();
                }
              })();
            }}
            onOpenDesktopWindow={() => {
              if (openingProjectId || openingWindow) {
                return;
              }
              openingWindow = true;
              error = null;
              render();
              void (async () => {
                try {
                  await requestOpenDesktopWindow();
                } catch (openError) {
                  error = openError instanceof Error ? openError.message : String(openError);
                } finally {
                  openingWindow = false;
                  // 新窗口的 tab 恢复是异步的，等 workspace-list-updated 再进入任务首页。
                  render();
                }
              })();
            }}
            onOpenSettings={() => reopenSetup("settings")}
          />
        </ZCodeIntlProvider>,
      );
    };

    renderStartPageIfActive = render;
    disposeStartPageWorkspaceSubscription?.();
    disposeStartPageRecentSubscription?.();
    // 最近项目和窗口状态由桌面主动推送；空态页面需要跟着刷新。
    disposeStartPageRecentSubscription = subscribeRecentProjectsUpdates(() => render());
    // 窗口恢复/最近项目打开后，桌面会推送聚合列表；出现 workspace 就离开空态。
    disposeStartPageWorkspaceSubscription = subscribeWorkspaceListUpdates((next) => {
      if (terminated || next.workspaces.length === 0) {
        return;
      }
      disposeStartPageWorkspaceSubscription?.();
      disposeStartPageWorkspaceSubscription = undefined;
      disposeStartPageRecentSubscription?.();
      disposeStartPageRecentSubscription = undefined;
      renderStartPageIfActive = undefined;
      void bootstrapPairedSession?.().catch((bootstrapError) => {
        renderBootstrapError(bootstrapError);
      });
    });
    render();
  };

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated) return;
    applyRecentProjectsFromBootstrap(bootstrapResult);
    if (bootstrapResult.workspaces.length === 0) {
      // 「电脑上没有窗口 / 没有打开的项目」不是失败，属于首页空态（方案「失败原因与恢复」）。
      renderMobileRemoteStartPage();
      return;
    }
    const preferredWorkspace = options?.preferredWorkspaceKey
      ? bootstrapResult.workspaces.find(
          (workspace) =>
            resolveWebRemoteControlWorkspaceKey(workspace) === options.preferredWorkspaceKey,
        )
      : undefined;
    const selectedWorkspace = preferredWorkspace
      ? {
          workspaceKey: resolveWebRemoteControlWorkspaceKey(preferredWorkspace),
          taskId: options?.preferredTaskId,
          canBridge:
            preferredWorkspace.kind !== "remote" ||
            Boolean(preferredWorkspace.workspaceIdentity && preferredWorkspace.remoteSessionId),
        }
      : resolveWebRemoteControlInitialWorkspaceSelection(bootstrapResult);
    if (!selectedWorkspace) {
      renderMobileRemoteStartPage();
      return;
    }
    if (!selectedWorkspace.canBridge) {
      await renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
    renderExternalRelayRoot(result.services, result.bridge);
  };

  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: document,
    windowTarget: window,
    onSuspend: () => {
      // Bugfix: 移动端 hidden/pagehide 后 JS 定时器和 WebSocket 都可能被系统暂停。
      // 这里只保存当前 workspace/task 并暂停心跳，不做刷新；回到前台后再重连并重新 bootstrap。
      transport.suspend();
    },
    onRecover: (reason) => {
      void recoverVisibleSession(reason);
    },
  });

  disposeSession = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    terminated = true;
    versionGuard.dispose();
    disposeVersionNotice?.();
    disposeVersionNotice = undefined;
    disposeStartPageWorkspaceSubscription?.();
    disposeStartPageWorkspaceSubscription = undefined;
    disposeStartPageRecentSubscription?.();
    disposeStartPageRecentSubscription = undefined;
    renderStartPageIfActive = undefined;
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    lifecycle.dispose();
    requester.dispose();
    transport.dispose();
  };

  reopenSetup = (mode: MobileRemoteSetupMode) => {
    if (restarting) {
      return;
    }
    restarting = true;
    disposeSession();
    void (async () => {
      const next = await context.reopenConnection(mode);
      if (next) {
        // 新会话有独立的 transport/root 生命周期；旧会话已经释放。
        await startGatewaySession(next, context);
      }
    })();
  };

  window.addEventListener(
    "beforeunload",
    () => {
      isPageUnloading = true;
      disposeSession();
    },
    { once: true },
  );
  transport.start();
}
