/* eslint-disable max-lines -- 手机远控启动流程（配置解析 → gateway transport → 版本校验 → workspace bridge → Root 渲染）暂时集中在一个模块。 */
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import { connectViaProtocol, createAcknowledgedWebRemoteControlRelayProtocol } from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
  sessionCreateTelemetrySchema,
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
import { resolveWebRemoteControlGatewayBootstrapConfig } from "./gatewayBootstrapConfig.js";

/**
 * 手机远控启动模块（T1.2 迁出 `main.tsx`，T3.4 换成 gateway transport）。
 * 桌面 Web 客户端的 `/remote*` 路由和手机入口（`mobile.html`）都从这里启动远控：
 * 解析 gateway 连接配置 → 建 GatewayTerminalTransport → 校验桌面版本 → 打开 workspace bridge → 渲染 Root。
 * 配置的持久化与设置页属于 T4.2；这里只消费注入的配置。
 */

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
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
export async function bootstrapGatewayWebRemoteControl(params: URLSearchParams): Promise<void> {
  const gatewayConfig = resolveWebRemoteControlGatewayBootstrapConfig(params);
  if (!gatewayConfig) {
    renderWebRemoteControlFailure(
      toWebRemoteControlFailure(
        "gateway-credential-invalid",
        "Missing gateway URL, device credential, or backend id.",
      ),
    );
    return;
  }

  seedWebRemoteControlThemePreference(gatewayConfig.theme);
  seedStableWebRemoteControlClientId(gatewayConfig.clientInstanceId);

  let bootstrapping = false;
  let recovering = false;
  let ready = false;
  let terminated = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let nextBridgeGeneration = 0;
  const checkVersionOnRecovery = window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
  let disposeVersionNotice: (() => void) | undefined;
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    getUrl: () => window.location.href,
    isPageReady: () => ready,
    navigate: (url) => window.location.replace(url),
    onMismatch: (version) => {
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        versionGuard.confirm(),
      );
    },
  });
  // 必须先于 Root 的全局捕获阶段快捷键注册；原生 modal 只能隔离背景元素，不能隔离 window listener。
  const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
    if (versionGuard.isBlocked()) event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
  const disposeVersionInputGuard = () =>
    window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
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

  const subscribeWorkspaceListUpdates = (listener: WebRemoteControlWorkspaceListUpdateListener) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
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

  const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
    if (terminated || versionGuard.isBlocked()) {
      return;
    }
    sendMobileFailureDiagnostic(failure);
    terminated = true;
    versionGuard.dispose();
    disposeVersionInputGuard();
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    requester.dispose();
    transport.dispose();
    renderWebRemoteControlFailure(failure);
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
    if (recovering || isPageUnloading || terminated || versionGuard.isBlocked()) {
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
        if (checkVersionOnRecovery) {
          try {
            await checkDesktopVersion();
          } catch (error) {
            // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
            if (!activeRelayProtocol.isDegraded()) throw error;
          }
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
    clientInstanceId: gatewayConfig.clientInstanceId,
    clientName: gatewayConfig.clientName,
    appVersion: gatewayConfig.appVersion,
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
      if (terminated || versionGuard.isBlocked()) {
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
        if (!checkVersionOnRecovery) return;
        void checkDesktopVersion().catch((error) => {
          // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
          if (!terminated && !versionGuard.isBlocked()) {
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
        // 可恢复失败：保留当前页面，transport 继续按 registry 自动重连。
        sendMobileFailureDiagnostic(failure);
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
      if (versionGuard.isBlocked()) return;
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
    sendPayload: (payload) => !versionGuard.isBlocked() && transport.sendPayload(payload),
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
    return response.result;
  };

  let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
  const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
    if (pendingVersionCheck) return pendingVersionCheck;
    const readCurrentVersion = async () => {
      let result = await versionGuard.check();
      // 配对变化可能发生在旧 bootstrap 等待期间；旧响应失效后在当前连接重新读取。
      while (
        !result &&
        !terminated &&
        !versionGuard.isBlocked() &&
        terminalTransportState === "paired"
      ) {
        result = await versionGuard.check();
      }
      return result;
    };
    const request = requestWithRelayRecovery(readCurrentVersion, { recoverTimeout: true }).finally(
      () => {
        if (pendingVersionCheck === request) pendingVersionCheck = undefined;
      },
    );
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
        appVersion: gatewayConfig.appVersion,
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
    if (terminated || versionGuard.isBlocked()) {
      throw new Error("Web remote control version changed before the workspace bridge was ready.");
    }
    const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: response.bridge.bridgeSessionId,
      bridgeGeneration: response.bridge.bridgeGeneration,
      recoveryId: response.bridge.recoveryId,
      measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
      sendFrame: (frame) => {
        if (versionGuard.isBlocked()) return false;
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
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
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
    if (terminated || versionGuard.isBlocked()) return;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    const initialResult = await listWorkspaces();
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
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

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
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
      throw toWebRemoteControlFailure(
        "workspace-closed",
        "No opened desktop workspace is available for Web remote control.",
      );
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
  window.addEventListener(
    "beforeunload",
    () => {
      isPageUnloading = true;
      terminated = true;
      versionGuard.dispose();
      disposeVersionInputGuard();
      disposeVersionNotice?.();
      activeBridgeServiceRegistration?.dispose();
      activeBridgeServiceRegistration = undefined;
      lifecycle.dispose();
    },
    { once: true },
  );
  transport.start();
}
