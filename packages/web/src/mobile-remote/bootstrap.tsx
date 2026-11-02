/* eslint-disable max-lines -- 手机远控启动流程（配置解析 → gateway transport → 版本校验 → workspace bridge → Root 渲染）暂时集中在一个模块。 */
import {
  AppErrorBoundary,
  Root,
  WebRemoteControlMobileStartPage,
  WebRemoteControlStandaloneStoreProvider,
  ZCodeIntlProvider,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
  type WebRemoteControlMobileSettingsDraft,
} from "@zcode/ui";
import {
  connectViaProtocol,
  connectViaProtocolOwned,
  createAcknowledgedWebRemoteControlRelayProtocol,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
  sessionCreateTelemetrySchema,
  type IPlatformService,
  type MobileRemoteBridge,
  type MobileSessionContext,
  type WebRemoteControlAppPayload,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDirectoryListResult,
  type WebRemoteControlMobileNavigationIntent,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type MobileNotificationActionClick,
  type WebRemoteControlRecentProjectsResult,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import {
  createMobileNotificationPlatform,
  mobileNotificationTargetKey,
  disableGatewayNotificationSubscription,
  syncGatewayNotificationSubscription,
  sendGatewayTestNotification,
} from "./mobileRemoteNotifications.js";
import {
  resolveMobileNotificationNavigation,
  validateMobileNotificationTask,
} from "./mobileNotificationNavigation.js";
import { showMobileNotificationNotice } from "./mobileNotificationNotice.js";
import {
  createMobileNotificationActionQueue,
  createMobileNotificationClickQueue,
} from "./mobileNotificationClickQueue.js";
import { showMobileNotificationActionResult } from "./mobileNotificationActionResult.js";
import { createMobileNavigationOwner } from "./mobileNavigationOwner.js";
import { createWebRemoteControlAppPayloadRequester } from "./payloadRequester.js";
import { createWebRemoteControlRelayRequestRecovery } from "./requestRecovery.js";
import { createHomeOnlyWebRemoteControlServices } from "./homeOnlyServices.js";
import { createWebRemoteControlLifecycleRecovery } from "../webRemoteControlLifecycle.js";
import { seedWebRemoteControlThemePreference } from "../webRemoteControlThemeSeed.js";
import {
  createWebRemoteControlVersionGuard,
  retryObsoleteWebRemoteControlBootstrapCheck,
} from "../webRemoteControlVersion.js";
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
import {
  MobileRemoteSessionContextError,
  isMobileRemoteSessionBackend,
  readMobileRemoteSessionContext,
  type MobileRemoteSession,
} from "./mobileRemoteSessionContext.js";
import {
  checkMobileRemoteRelease,
  type MobileRemoteReleaseCheckResult,
} from "./mobileRemoteReleaseCheck.js";
import { installMobileRemoteNativeHost } from "./mobileRemoteNativeHost.js";
import {
  createMobileRemoteFileCapabilities,
  resolveMobileRemoteFileBridge,
} from "./mobileRemoteFileBridge.js";

/**
 * 手机 Remote 启动模块（M2-T2）。
 *
 * 启动顺序：读取并严格校验 `ZodyRemoteBridge.getSessionContext()` → 校验 release
 * manifest 支持当前 bridgeVersion → 创建 GatewayTerminalTransport → 校验桌面版本 →
 * 打开 workspace bridge → 渲染 Root 或「没有打开的项目」首页。
 *
 * Remote 不再包含配对、设置或选电脑页面：连接配置、凭证和 clientInstanceId 只由
 * Android 原生配置 store 持有；需要修改连接或切换电脑时统一调用 `returnShell`。
 */
export interface BootstrapGatewayWebRemoteControlOptions {
  /** 注入的平台实现；缺省创建带文件/通知/生命周期能力的 Web 平台。 */
  platform?: IPlatformService;
  /** 测试注入；缺省从 `globalThis.ZodyRemoteBridge` 发现。 */
  bridge?: MobileRemoteBridge;
  /** 测试注入；缺省执行真实 `/mobile-ui/release` 校验。 */
  checkRelease?: typeof checkMobileRemoteRelease;
  /** 测试注入；缺省调用 `bridge.returnShell`。 */
  returnShell?: (reason: string, sessionId: string) => void;
  /** 本地开发允许 http gateway；缺省由 bridge capability 与构建模式推导。 */
  allowInsecureTransport?: boolean;
  /** 注入生产标志，缺省使用 `import.meta.env.PROD`。 */
  isProduction?: boolean;
  /** 测试注入；缺省使用全局 fetch。 */
  fetcher?: typeof fetch;
}

type GatewaySessionContext = {
  platform: IPlatformService;
  session: MobileSessionContext;
  /** 当前 Remote 文档使用的原生桥；宿主事件对象按同一 sessionId 安装。 */
  bridge?: MobileRemoteBridge;
  /** 平台适配器与设置分区共用同一套 release 校验（release 禁止 http）。 */
  allowInsecureTransport: boolean;
  /** 修改连接/切换电脑/失败出口的统一入口；原生按 sessionId 校验。 */
  requestReturnShell(reason: string): void;
};

/**
 * 把启动阶段的平台能力透传给 Root（T6.2/T6.3）。
 * Root 会重新构造一个 Web 平台对象，前后台、返回键、文件与通知能力都必须显式带上，
 * 否则 `useOptionalPlatform()` 在 UI 层看不到原生能力。
 * 安全存储不在列表里：Remote 没有配置读写路径（M2-T2）。
 */
function pickMobileRemotePlatformCapabilities(
  platform: IPlatformService,
): Pick<
  IPlatformService,
  | "onAppLifecycleChange"
  | "onBackPressed"
  | "saveFile"
  | "maxAttachmentBytes"
  | "mobileNotifications"
> {
  return {
    ...(platform.mobileNotifications
      ? { mobileNotifications: platform.mobileNotifications }
      : {}),
    ...(platform.onAppLifecycleChange
      ? { onAppLifecycleChange: platform.onAppLifecycleChange }
      : {}),
    ...(platform.onBackPressed
      ? { onBackPressed: platform.onBackPressed }
      : {}),
    ...(platform.saveFile ? { saveFile: platform.saveFile } : {}),
    ...(platform.maxAttachmentBytes
      ? { maxAttachmentBytes: platform.maxAttachmentBytes }
      : {}),
  };
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

function renderWebRemoteControlLoading(
  state: UiWebRemoteControlTerminalTransportState,
): void {
  document.title = "Zody - Web Remote Control";
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
function isRecoverableGatewayFailure(
  reason: WebRemoteControlFailureReason,
): boolean {
  return reason === "gateway-unreachable" || reason === "desktop-disconnected";
}

function mapSessionContextErrorToFailure(
  error: unknown,
): WebRemoteControlFailure {
  if (error instanceof MobileRemoteSessionContextError) {
    switch (error.code) {
      case "native-bridge-unavailable":
      case "bridge-version-unsupported":
      case "unsupported-capability":
        return {
          ...toWebRemoteControlFailure("incompatible-version", error.message),
          upgrade: "mobile",
        };
      case "stale-session":
        // 原生已经使旧 session 失效；页面不再尝试写配置或重建会话。
        return toWebRemoteControlFailure(
          "unexpected-error",
          "The remote session is no longer active.",
        );
      default:
        return toWebRemoteControlFailure("unexpected-error", error.message);
    }
  }
  return toWebRemoteControlFailure(
    "unexpected-error",
    error instanceof Error ? error.message : String(error),
  );
}

export async function bootstrapGatewayWebRemoteControl(
  params: URLSearchParams,
  options: BootstrapGatewayWebRemoteControlOptions = {},
): Promise<void> {
  seedWebRemoteControlThemePreference(
    resolveWebRemoteControlThemeFromSearchParams(params),
  );

  const isProduction = options.isProduction ?? import.meta.env.PROD;
  let session: MobileRemoteSession;
  try {
    // M2-T2：Remote 唯一的数据入口。缺桥、JSON/schema 损坏、backend 或 bridgeVersion
    // 不兼容都在这里 fail closed，不会带着部分配置创建 transport。
    session = readMobileRemoteSessionContext({
      ...(options.bridge ? { bridge: options.bridge } : {}),
      isProduction,
      ...(options.allowInsecureTransport !== undefined
        ? { allowInsecureTransport: options.allowInsecureTransport }
        : {}),
    });
  } catch (error) {
    renderWebRemoteControlFailure(mapSessionContextErrorToFailure(error), {
      onRetry: () => window.location.reload(),
    });
    return;
  }

  // clientInstanceId 由原生配置 store 按 backendId 持久化；页面只把它作为流式 clientId，
  // 不再生成、写 localStorage 或回写 SecureStore。
  setStreamClientId(session.context.clientInstanceId);

  let returningToShell = false;
  const requestReturnShell = (reason: string): void => {
    if (returningToShell) {
      return;
    }
    returningToShell = true;
    try {
      if (options.returnShell) {
        options.returnShell(reason, session.context.sessionId);
      } else {
        session.bridge.returnShell(reason, session.context.sessionId);
      }
    } catch {
      // 原生可能已经使当前 session 失效；页面保持 fail closed，不写任何配置。
    }
  };

  // 启动业务 Channel 前校验 release manifest 支持当前 bridgeVersion（M2-T2；轮询归 M3）。
  let release: MobileRemoteReleaseCheckResult;
  try {
    release = await (options.checkRelease ?? checkMobileRemoteRelease)({
      context: session.context,
      isProduction,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  } catch {
    release = { kind: "unavailable", reason: "network-error" };
  }
  if (release.kind === "upgrade-required") {
    renderWebRemoteControlFailure(
      {
        ...toWebRemoteControlFailure(
          "incompatible-version",
          "This desktop UI requires a newer Zody app. Update the APK to continue.",
        ),
        upgrade: "mobile",
      },
      { onRetry: () => window.location.reload() },
    );
    return;
  }
  if (release.kind === "unavailable") {
    // 首次加载无法确认发布清单时按 spec 第 10 节返回 Shell；页面同时保留可手动重试的
    // 失败页，避免原生 returnShell 尚未完成时出现白屏。
    renderWebRemoteControlFailure(
      toWebRemoteControlFailure(
        "gateway-unreachable",
        "Unable to verify the desktop UI release.",
      ),
      {
        onRetry: () => window.location.reload(),
        onOpenSettings: () => requestReturnShell("settings"),
        onChooseBackend: () => requestReturnShell("backend"),
      },
    );
    requestReturnShell("release-check-failed");
    return;
  }

  // T6.2：Android 注入 ZodyRemoteBridge 后，安装宿主 → 页面的 ZodyRemoteBridgeHost
  // （前后台/返回键/通知事件）；所有事件按当前 sessionId 过滤。
  const nativeHost = installMobileRemoteNativeHost({
    sessionId: session.context.sessionId,
    bridge: session.bridge,
  });
  // T6.3：文件桥与事件桥共用同一个注入对象；每次调用携带 sessionId。
  const fileCapabilities = createMobileRemoteFileCapabilities(
    resolveMobileRemoteFileBridge(),
    { sessionId: session.context.sessionId },
  );
  // 不展开注入的平台对象：桌面/测试实现可能是带原型方法的实例。
  const platform =
    options.platform ??
    createWebPlatform({
      ...fileCapabilities,
      mobileNotifications: createMobileNotificationPlatform(globalThis, {
        sessionId: session.context.sessionId,
        ...(nativeHost
          ? { subscribePermission: nativeHost.onNotificationPermissionChanged }
          : {}),
      }),
      ...(nativeHost
        ? {
            onAppLifecycleChange: nativeHost.onAppLifecycleChange,
            onBackPressed: nativeHost.onBackPressed,
          }
        : {}),
    });

  const context: GatewaySessionContext = {
    platform,
    session: session.context,
    bridge: session.bridge,
    allowInsecureTransport: session.allowInsecureTransport,
    requestReturnShell,
  };
  await startGatewaySession(context);
}

async function startGatewaySession(
  context: GatewaySessionContext,
): Promise<void> {
  const gatewayConfig = context.session;

  const navigationOwner = createMobileNavigationOwner();
  let mobileCapabilities:
    | import("@zcode/shared").MobileCapabilities
    | undefined;
  // 第二批 E1：协商出的 appProtocol；低于 4 的桌面隐藏「打开其他项目」入口（不发未知 payload）。
  let negotiatedAppProtocol: number | undefined;
  let renderCurrentExternalRelayRoot: (() => void) | undefined;
  let connectionGeneration = 0;
  let notificationServices:
    | Awaited<ReturnType<typeof connectViaProtocol>>
    | undefined;
  let notificationMounted:
    | {
        navigationId: number;
        workspaceKey: string;
        taskId: string;
        commit(): Promise<void>;
      }
    | undefined;
  let notificationViewGeneration = 0;
  let disposeNotificationNotice: (() => void) | undefined;
  // 第二批 E4：通知按钮提交结果的自消失反馈条；新结果到来时替换旧条。
  let disposeNotificationActionResult: (() => void) | undefined;
  let retryPendingNotificationClick = () => {};
  let retryPendingNotificationAction = () => {};
  let searchHighlight:
    | {
        requestId: number;
        workspacePath: string;
        workspaceIdentity?: string;
        taskId: string;
        query: string;
        snippet?: string;
        snippetIndex?: number;
      }
    | undefined;
  let bootstrapping = false;
  let recovering = false;
  let ready = false;
  let terminated = false;
  let disposed = false;
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
  let activeBridgeClientDispose: (() => void) | undefined;
  let bridgeClientGeneration = 0;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((
        payload: WebRemoteControlAppPayload & {
          zcode_type: "mobile-diagnostic";
        },
      ) => void)
    | undefined;
  const workspaceListUpdateListeners =
    new Set<WebRemoteControlWorkspaceListUpdateListener>();
  const recentProjectsUpdateListeners =
    new Set<WebRemoteControlRecentProjectsUpdateListener>();

  const subscribeWorkspaceListUpdates = (
    listener: WebRemoteControlWorkspaceListUpdateListener,
  ) => {
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

  const applyRecentProjectsResult = (
    result: WebRemoteControlRecentProjectsResult,
  ) => {
    latestRecentProjects = {
      desktopWindowState: result.desktopWindowState,
      recentProjects: result.recentProjects,
    };
    for (const listener of recentProjectsUpdateListeners) {
      listener(latestRecentProjects);
    }
  };

  const applyRecentProjectsFromBootstrap = (
    result: WebRemoteControlWindowBootstrapResult,
  ) => {
    if (
      result.desktopWindowState === undefined &&
      result.recentProjects === undefined
    ) {
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

  const applyWorkspaceListUpdated = (
    result: WebRemoteControlWorkspaceListResult,
  ) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  const sendMobileDiagnostic = (
    diagnostic: GatewayTerminalTransportDiagnostic,
  ) => {
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

  const mapBootstrapUnknownErrorToFailure = (
    error: unknown,
  ): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  // disposeSession 依赖 transport/requester，真实实现放在建连代码之后；失败页回调只在
  // 建连完成后触发，所以先占位可以避免前置声明顺序问题。
  let disposeSession = (): void => {};

  /**
   * 已连接会话内的“连接”分区（M2-T2）。
   *
   * Remote 不再保存配置：保存和重连都统一调用 `returnShell`，由 Shell/原生配置 store
   * 完成修改；页面上已提交的草稿只用于触发退出，不写 SecureStore 或普通 Store。
   */
  const mobileConnectionSettings = {
    initial: {
      ...(gatewayConfig.gatewayUrl ? { gatewayUrl: gatewayConfig.gatewayUrl } : {}),
      ...(gatewayConfig.namespace ? { namespace: gatewayConfig.namespace } : {}),
      // 凭证不回显：只告诉表单是否已保存。
      credentialConfigured: Boolean(gatewayConfig.credential),
    },
    allowInsecureTransport: context.allowInsecureTransport,
    save: async (_draft: WebRemoteControlMobileSettingsDraft) => {
      context.requestReturnShell("connection-settings");
      // 页面正在返回 Shell；UI 不再触发本地重连。
      return { scopeChanged: false };
    },
    reconnect: () => context.requestReturnShell("connection-settings"),
  };

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
      // 连接修改/切换电脑只能回 Shell；Remote 没有配置写入路径。
      onOpenSettings: () => context.requestReturnShell("settings"),
      onChooseBackend: () => context.requestReturnShell("backend"),
      onRetry: () => window.location.reload(),
    });
  };

  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  let bootstrapPairedSession:
    | ((options?: {
        preferredWorkspaceKey?: string;
        preferredTaskId?: string;
      }) => Promise<void>)
    | undefined;

  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" ||
    reason === "pageshow" ||
    reason === "online" ||
    reason === "resume";

  const recoverVisibleSession = async (reason: string): Promise<void> => {
    if (recovering || isPageUnloading || terminated) {
      return;
    }
    recovering = true;
    const preferredWorkspaceKey = currentWorkspaceKey;
    const preferredTaskId = currentTaskId;
    currentRecoveryId = createWebRemoteControlRequestId("recovery");
    let recoveryReady = false;
    const requiresBridgeRebuild =
      !isLifecycleRecoveryReason(reason) ||
      activeRelayProtocol?.isDegraded() === true;
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
      if (
        !requiresBridgeRebuild &&
        activeRelayProtocol &&
        !activeRelayProtocol.isDegraded()
      ) {
        try {
          await checkDesktopVersion();
        } catch (error) {
          // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
          if (!activeRelayProtocol.isDegraded()) throw error;
        }
        // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
        // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已连接，正在加载工作区…”闪回。
        // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
        // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
        if (!activeRelayProtocol.isDegraded()) {
          currentRecoveryId = undefined;
          recoveryReady = true;
          return;
        }
      }
      await bootstrapPairedSession?.({
        preferredWorkspaceKey,
        preferredTaskId,
      });
      recoveryReady = !terminated && terminalTransportState === "paired";
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
      if (recoveryReady && !terminated) {
        // Android 可能在回前台重协商期间点击通知；原生 slot 仍是权威待办，
        // 仅在 recovery owner 成功后重新读取，不用定时器猜恢复时序。
        retryPendingNotificationClick();
        retryPendingNotificationAction();
      }
    }
  };

  renderWebRemoteControlLoading("connecting");

  const transport = new GatewayTerminalTransport({
    gatewayUrl: gatewayConfig.gatewayUrl,
    namespace: gatewayConfig.namespace,
    credential: gatewayConfig.credential,
    backendId: gatewayConfig.backendId,
    clientInstanceId: gatewayConfig.clientInstanceId,
    clientName: "Zody Mobile",
    appVersion: gatewayConfig.appVersion,
    onRawTransportPayload: (payload) =>
      activeRelayProtocol?.acceptPayload(payload) ?? false,
    onRawTransportFault: (reasonCode) => {
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (
        payload.zcode_type === "rpc-frame" ||
        payload.zcode_type === "rpc-frame-ack"
      ) {
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
        if (
          payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()
        ) {
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (
          payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()
        ) {
          // Bugfix: 远程 session 关闭会异步通知当前 bridge 失效，不对应任何 pending request。
          // 这里按硬恢复重建视图，让断开的远程 workspace 回到 home-only/reconnect 状态。
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(
          toWebRemoteControlFailure(payload.reason, payload.error),
        );
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
      if (
        (activeRelayProtocol && !activeRelayProtocol.isDegraded()) ||
        bootstrapping
      ) {
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
      if (
        !terminated &&
        failure.reason === "gateway-credential-invalid" &&
        context.platform.mobileNotifications
      ) {
        // 当前凭证被撤销时立即停掉当前 backend 的原生订阅；旧会话已销毁后不再清理新配置。
        void disableGatewayNotificationSubscription({
          gatewayUrl: gatewayConfig.gatewayUrl,
          backendId: gatewayConfig.backendId,
          platform: context.platform.mobileNotifications,
        }).catch(() => {});
      }
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
        console.warn(
          "[web-remote-control] terminal transport error",
          error.message,
        );
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
      connectionGeneration += 1;
      negotiatedAppProtocol = info.appProtocol;
      // 新 channel 的 capability 必须来自新 bootstrap。让旧代际检查失效，
      // 但保留上次已确认值，避免恢复期间把现有入口暂时隐藏。
      versionGuard.invalidate();
      pendingVersionCheck = undefined;
      // 旧检查返回 undefined 后，由原始 bootstrap/recovery caller 等待新 generation，
      // 这样 fresh 结果会继续原来的 Root 挂载流程，而非只刷新脱离流程的 capabilities。
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
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(
    () => transport.recoverConnection(),
  );

  const requestBootstrap =
    async (): Promise<WebRemoteControlWindowBootstrapResult> => {
      const requestGeneration = connectionGeneration;
      const requestId = createWebRemoteControlRequestId("bootstrap");
      const response = await requestAppPayload(
        { zcode_type: "bootstrap-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "bootstrap-response" }
        > =>
          payload.zcode_type === "bootstrap-response" &&
          payload.requestId === requestId,
      );
      if (requestGeneration === connectionGeneration && !terminated) {
        const previousCapabilities = mobileCapabilities;
        mobileCapabilities = response.result.mobileCapabilities;
        if (
          JSON.stringify(previousCapabilities ?? {}) !==
          JSON.stringify(mobileCapabilities ?? {})
        ) {
          renderCurrentExternalRelayRoot?.();
        }
        applyRecentProjectsFromBootstrap(response.result);
      }
      return response.result;
    };

  let pendingVersionCheck:
    | Promise<WebRemoteControlWindowBootstrapResult | undefined>
    | undefined;
  const checkDesktopVersion = (): Promise<
    WebRemoteControlWindowBootstrapResult | undefined
  > => {
    if (pendingVersionCheck) return pendingVersionCheck;
    // T4.2：版本不匹配不会返回 undefined。这里只在明确发生连接代际变化、且新 channel
    // 已 ready 时继续原 caller 的 bootstrap；普通网络失败和释放状态不会触发重试。
    const request = retryObsoleteWebRemoteControlBootstrapCheck({
      check: () =>
        requestWithRelayRecovery(() => versionGuard.check(), {
          recoverTimeout: true,
        }),
      getConnectionGeneration: () => connectionGeneration,
      isChannelReady: () => terminalTransportState === "paired",
      isDisposed: () => terminated,
    }).finally(() => {
      if (pendingVersionCheck === request) pendingVersionCheck = undefined;
    });
    pendingVersionCheck = request;
    return request;
  };

  const requestPlatformMethod = async <
    K extends WebRemoteControlPlatformMethod,
  >(
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
    const platformResponse =
      response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };
  const listWorkspaces =
    async (): Promise<WebRemoteControlWorkspaceListResult> => {
      const requestWorkspaceList = async () => {
        const requestId = createWebRemoteControlRequestId("workspace-list");
        return requestAppPayload(
          { zcode_type: "workspace-list-request", requestId },
          (
            payload,
          ): payload is Extract<
            WebRemoteControlAppPayload,
            { zcode_type: "workspace-list-response" }
          > =>
            payload.zcode_type === "workspace-list-response" &&
            payload.requestId === requestId,
        );
      };
      const response = await requestWithRelayRecovery(
        () => requestWorkspaceList(),
        {
          // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
          // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
          recoverTimeout: true,
        },
      );
      return normalizeWorkspaceListResult(response.result);
    };

  const updateMobileViewState = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    const viewGeneration = ++notificationViewGeneration;
    if (context.platform.mobileNotifications?.setActiveTarget) {
      // 异步摘要不得把旧目标写回原生可见状态；先清除，计算完成后校验 generation。
      try {
        await context.platform.mobileNotifications.setActiveTarget(null);
        if (taskId) {
          const targetKey = await mobileNotificationTargetKey(
            gatewayConfig.backendId,
            workspaceKey,
            taskId,
          );
          if (viewGeneration === notificationViewGeneration && !terminated)
            await context.platform.mobileNotifications.setActiveTarget(
              targetKey,
            );
        }
      } catch {
        /* Optional OS display support cannot break the workspace transport. */
      }
    }
    if (viewGeneration !== notificationViewGeneration || terminated) return;
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

  /** 方案「新增应用 payload」：手机只能传最近项目 id，路径由桌面解析。 */
  const requestOpenRecentProject = async (
    recentProjectId: string,
  ): Promise<string> => {
    const requestId = createWebRemoteControlRequestId("workspace-open");
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        { zcode_type: "workspace-open-request", requestId, recentProjectId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-open-response" }
        > =>
          payload.zcode_type === "workspace-open-response" &&
          payload.requestId === requestId,
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
          payload.zcode_type === "desktop-window-open-response" &&
          payload.requestId === requestId,
        { timeoutMs: 15_000 },
      ),
    );
    if (!response.success) {
      throw new Error(response.error);
    }
  };

  /**
   * 第二批 E1/E2：提交已存在的本地目录路径请求桌面打开。错误是桌面回的稳定错误码
   * （arbitrary-path-disabled / path-invalid / open-failed / timeout），由调用方映射提示。
   */
  const requestOpenWorkspacePath = async (workspacePath: string): Promise<string> => {
    const requestId = createWebRemoteControlRequestId("workspace-open-path");
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        { zcode_type: "workspace-open-path-request", requestId, workspacePath },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-open-path-response" }
        > =>
          payload.zcode_type === "workspace-open-path-response" &&
          payload.requestId === requestId,
        {
          // 与最近项目打开一致：桌面 10 秒 + 回传余量。
          timeoutMs: 12_000,
        },
      ),
    );
    if (!response.success) {
      throw new Error(response.error);
    }
    return response.workspaceKey;
  };

  /** 第二批 E3：目录选择器的 bounded 列表（app 级 payload，空态无 bridge 也可用）。 */
  const mobileDirectoryList = async (
    path?: string,
  ): Promise<WebRemoteControlMobileDirectoryListResult> => {
    const requestId = createWebRemoteControlRequestId("mobile-directory-list");
    const response = await requestAppPayload(
      { zcode_type: "mobile-directory-list-request", requestId, ...(path ? { path } : {}) },
      (
        payload,
      ): payload is Extract<
        WebRemoteControlAppPayload,
        { zcode_type: "mobile-directory-list-response" }
      > =>
        payload.zcode_type === "mobile-directory-list-response" &&
        payload.requestId === requestId,
      { timeoutMs: 10_000 },
    );
    return response.success
      ? {
          ok: true,
          resolvedPath: response.resolvedPath,
          parentPath: response.parentPath,
          entries: response.entries,
        }
      : { ok: false, error: response.error };
  };

  const openNotification = async (notificationId: string): Promise<void> => {
    const reader = notificationServices?.mobileNotificationReaderService;
    if (!reader || mobileCapabilities?.notificationFeed !== 1)
      throw new Error("notification-unavailable");
    const generation = connectionGeneration;
    const readerBridgeGeneration = bridgeClientGeneration;
    const requestNavigation = navigationOwner.begin({
      workspaceKey: currentWorkspaceKey ?? "",
      intent: "chat",
    });
    const clearAbandonedRequest = () => {
      if (navigationOwner.isCurrent(requestNavigation.id)) {
        navigationOwner.acknowledge(requestNavigation.id);
        if (readerBridgeGeneration === bridgeClientGeneration)
          renderCurrentExternalRelayRoot?.();
      }
    };
    let notification: Awaited<
      ReturnType<typeof resolveMobileNotificationNavigation>
    >;
    try {
      notification = await resolveMobileNotificationNavigation({
        backendId: gatewayConfig.backendId,
        notificationId,
        reader,
        listWorkspaces,
      });
    } catch (error) {
      clearAbandonedRequest();
      if (
        readerBridgeGeneration !== bridgeClientGeneration ||
        generation !== connectionGeneration
      )
        throw new Error("stale-notification");
      throw error;
    }
    if (
      !navigationOwner.isCurrent(requestNavigation.id) ||
      generation !== connectionGeneration ||
      readerBridgeGeneration !== bridgeClientGeneration ||
      terminated
    ) {
      clearAbandonedRequest();
      throw new Error("stale-notification");
    }
    const navigation = navigationOwner.begin({
      workspaceKey: notification.target.workspaceKey,
      taskId: notification.target.taskId,
      intent: "chat",
    });
    const result = await openWorkspaceBridge(notification.target.workspaceKey, {
      taskId: notification.target.taskId,
      mobileNavigationIntent: "chat",
    });
    const targetBridgeGeneration = bridgeClientGeneration;
    const isCurrentTarget = () =>
      navigationOwner.isCurrent(navigation.id) &&
      generation === connectionGeneration &&
      targetBridgeGeneration === bridgeClientGeneration &&
      activeRelayProtocol === result.relayProtocol &&
      !terminated;
    if (!isCurrentTarget()) throw new Error("stale-notification");
    try {
      await validateMobileNotificationTask(
        result.services,
        notification.target,
      );
    } catch (error) {
      // 目标已删除才回到首页；旧 owner 的 RPC reject 不能冒充任务已删除并覆盖新 Root。
      if (!isCurrentTarget()) throw new Error("stale-notification");
      if (navigationOwner.isCurrent(navigation.id))
        renderExternalRelayRoot(result.services, {
          ...result.bridge,
          initialTaskId: undefined,
        });
      throw error;
    }
    if (!isCurrentTarget()) throw new Error("stale-notification");
    notificationMounted = {
      navigationId: navigation.id,
      workspaceKey: notification.target.workspaceKey,
      taskId: notification.target.taskId,
      commit: async () => {
        await result.services.mobileNotificationReaderService?.markRead({
          notificationId,
        });
        await context.platform.mobileNotifications?.acknowledgeClick(
          notificationId,
        );
      },
    };
    searchHighlight = undefined;
    renderExternalRelayRoot(result.services, result.bridge, "chat");
  };

  /**
   * 第二批 E4：permission 通知按钮的快速路径。
   * 复用通知点击的定位/校验链（reader 权限、最新 workspace 路由、任务存在性），
   * 但收尾是提交 `respondPermission`（收敛 V4 resolveInteraction，duplicate/noop 幂等成功）
   * 而不是停在交互 UI；成功后 markRead + acknowledgeAction + 原生取消卡片，仍渲染目标任务。
   */
  const openNotificationAction = async (
    action: MobileNotificationActionClick,
  ): Promise<void> => {
    const reader = notificationServices?.mobileNotificationReaderService;
    if (!reader || mobileCapabilities?.notificationFeed !== 1)
      throw new Error("notification-unavailable");
    // 温启动时 gateway 连接可能处于 suspended（后台主动断开）：先幂等恢复再提交。
    await transport.recoverConnection();
    const generation = connectionGeneration;
    const notification = await resolveMobileNotificationNavigation({
      backendId: gatewayConfig.backendId,
      notificationId: action.notificationId,
      reader,
      listWorkspaces,
    });
    if (generation !== connectionGeneration || terminated) {
      throw new Error("stale-notification");
    }
    if (notification.kind !== "permission" || !notification.interactionId) {
      throw new Error("notification-action-unavailable");
    }
    const navigation = navigationOwner.begin({
      workspaceKey: notification.target.workspaceKey,
      taskId: notification.target.taskId,
      intent: "chat",
    });
    const result = await openWorkspaceBridge(notification.target.workspaceKey, {
      taskId: notification.target.taskId,
      mobileNavigationIntent: "chat",
    });
    const targetBridgeGeneration = bridgeClientGeneration;
    const isCurrentTarget = () =>
      navigationOwner.isCurrent(navigation.id) &&
      generation === connectionGeneration &&
      targetBridgeGeneration === bridgeClientGeneration &&
      activeRelayProtocol === result.relayProtocol &&
      !terminated;
    if (!isCurrentTarget()) throw new Error("stale-notification");
    try {
      await validateMobileNotificationTask(result.services, notification.target);
    } catch (error) {
      // notify-4：任务已删除/不可达时结果条「请打开任务后重试」不成立。与 openNotification 的
      // 校验失败分支保持一致：回退任务首页（不带 initialTaskId）并 rethrow，交给 onError 弹
      // notice（自带重试按钮这个明确入口），不再展示误导性的 rejected 结果条。
      if (!isCurrentTarget()) throw new Error("stale-notification");
      // 旧 owner 的 RPC reject 不能冒充任务已删除并覆盖新 Root。
      if (navigationOwner.isCurrent(navigation.id))
        renderExternalRelayRoot(result.services, {
          ...result.bridge,
          initialTaskId: undefined,
        });
      throw error;
    }
    try {
      await result.services.zcodeTaskService.respondPermission({
        taskId: notification.target.taskId,
        requestId: notification.interactionId,
        optionId: action.optionId,
        workspacePath: notification.target.workspacePath,
        ...(notification.target.workspaceIdentity
          ? { workspaceIdentity: notification.target.workspaceIdentity }
          : {}),
        // adapter 的 v4 路径只透传 optionId；decision 按 optionKind 语义给出，
        // 未来若启用 legacy response 也不至于与用户意图相悖。
        response:
          action.optionKind === "deny"
            ? { decision: "deny" as const }
            : { decision: "allow" as const },
      });
    } catch (error) {
      if (!isCurrentTarget()) throw new Error("stale-notification");
      // notify-4 修复：openWorkspaceBridge 已同步 dispose 旧 bridge 并切走路由（见其
      // previousClientDispose 注释），此处若不渲染，用户会停留在 bridge 已失效的旧界面，
      // 结果条「请打开任务后重试」也没有任何到目标任务的入口。提交被拒但目标仍当前：
      // 先渲染目标任务页给用户可达的目的地再弹结果条；不自动重试，通知保持未读，
      // 用户可在任务内直接操作或再次点击系统卡片。
      if (navigationOwner.isCurrent(navigation.id))
        renderExternalRelayRoot(result.services, result.bridge, "chat");
      disposeNotificationActionResult?.();
      disposeNotificationActionResult = showMobileNotificationActionResult("rejected");
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] notification action submit rejected", {
          notificationId: action.notificationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (!isCurrentTarget()) throw new Error("stale-notification");
    notificationMounted = {
      navigationId: navigation.id,
      workspaceKey: notification.target.workspaceKey,
      taskId: notification.target.taskId,
      commit: async () => {
        await result.services.mobileNotificationReaderService?.markRead({
          notificationId: action.notificationId,
        });
        await context.platform.mobileNotifications?.acknowledgeAction?.(
          action.notificationId,
        );
      },
    };
    searchHighlight = undefined;
    renderExternalRelayRoot(result.services, result.bridge, "chat");
    disposeNotificationActionResult?.();
    disposeNotificationActionResult = showMobileNotificationActionResult("resolved");
    // 提交成功后取消系统卡片；旧壳没有 cancel 能力时只跳过（卡片靠 setAutoCancel 消失）。
    try {
      await context.platform.mobileNotifications?.cancel?.(action.notificationId);
    } catch {
      /* 卡片可能已被用户清除或旧壳不支持取消。 */
    }
  };
  const nativeClickQueue = createMobileNotificationClickQueue({
    readPending: async () =>
      context.platform.mobileNotifications?.getPendingClick(),
    open: async (pending) => {
      disposeNotificationNotice?.();
      disposeNotificationNotice = undefined;
      if (!isMobileRemoteSessionBackend(gatewayConfig, pending.backendId)) {
        // Remote 不能自行切换 backend；返回 Shell 让原生按选中电脑重新派发 pending。
        // 不 ack：pending 槽仍由 Android 持有。
        context.requestReturnShell("notification-backend-mismatch");
        return;
      }
      await openNotification(pending.notificationId);
    },
    onError: (error, pending) => {
      if (
        terminated ||
        (error instanceof Error && error.message === "stale-notification")
      )
        return;
      disposeNotificationNotice?.();
      disposeNotificationNotice = showMobileNotificationNotice({
        onBackPressed: context.platform.onBackPressed,
        retry: () => {
          disposeNotificationNotice = undefined;
          void nativeClickQueue.enqueue(pending);
        },
        dismiss: () => {
          disposeNotificationNotice = undefined;
          void context.platform.mobileNotifications
            ?.acknowledgeClick(pending.notificationId)
            .catch(() => {});
        },
      });
    },
  });
  retryPendingNotificationClick = nativeClickQueue.retryPending;
  const consumeNativeNotification = nativeClickQueue.enqueue;
  const nativeActionQueue = createMobileNotificationActionQueue({
    readPending: async () =>
      context.platform.mobileNotifications?.getPendingAction?.() ?? null,
    open: async (pending) => {
      disposeNotificationNotice?.();
      disposeNotificationNotice = undefined;
      if (!isMobileRemoteSessionBackend(gatewayConfig, pending.backendId)) {
        // 按钮动作同样不能跨 backend 执行；保留 pending，不 ack。
        context.requestReturnShell("notification-backend-mismatch");
        return;
      }
      await openNotificationAction(pending);
    },
    onError: (error, pending) => {
      if (
        terminated ||
        (error instanceof Error && error.message === "stale-notification")
      )
        return;
      disposeNotificationNotice?.();
      disposeNotificationNotice = showMobileNotificationNotice({
        onBackPressed: context.platform.onBackPressed,
        retry: () => {
          disposeNotificationNotice = undefined;
          void nativeActionQueue.enqueue(pending);
        },
        dismiss: () => {
          disposeNotificationNotice = undefined;
          // 放弃本次按钮提交：清掉 pending 槽，系统卡片仍可点击打开任务走常规交互。
          void context.platform.mobileNotifications
            ?.acknowledgeAction?.(pending.notificationId)
            .catch(() => {});
        },
      });
    },
  });
  retryPendingNotificationAction = nativeActionQueue.retryPending;
  const consumeNativeNotificationAction = nativeActionQueue.enqueue;
  const mobileRemoteSwitcherExtras = {
    getNotificationReader: () =>
      mobileCapabilities?.notificationFeed === 1
        ? notificationServices?.mobileNotificationReaderService
        : undefined,
    openNotification,
    ...(context.platform.mobileNotifications
      ? { testNotification: () => sendGatewayTestNotification(gatewayConfig) }
      : {}),
    getMobileCapabilities: () =>
      notificationServices?.mobileNotificationReaderService
        ? mobileCapabilities
        : { ...mobileCapabilities, notificationFeed: undefined },
    getMobileConnection: () => ({
      backendId: gatewayConfig.backendId,
      connectionGeneration,
    }),
    searchMobileHistory: async (
      request: import("@zcode/shared").MobileHistorySearchRequest,
    ) => {
      if (
        mobileCapabilities?.historySearch !== 1 ||
        request.context.backendId !== gatewayConfig.backendId ||
        request.context.connectionGeneration !== connectionGeneration
      )
        throw new Error("unsupported-or-stale-search");
      const response = await requestAppPayload(
        request,
        (
          payload,
        ): payload is import("@zcode/shared").MobileHistorySearchOutcome =>
          payload.zcode_type === "mobile-history-search-outcome" &&
          payload.context.requestId === request.context.requestId,
      );
      if (request.context.connectionGeneration !== connectionGeneration)
        throw new Error("stale-search");
      return response;
    },
    getSearchHighlight: () => searchHighlight,
    acknowledgeSearchHighlight: (requestId: number) => {
      if (searchHighlight?.requestId === requestId) searchHighlight = undefined;
    },
    getRecentProjects:
      async (): Promise<WebRemoteControlRecentProjectsResult> =>
        latestRecentProjects ?? {
          desktopWindowState: "open",
          recentProjects: [],
        },
    onRecentProjectsUpdated: subscribeRecentProjectsUpdates,
    openRecentProject: requestOpenRecentProject,
    openDesktopWindow: requestOpenDesktopWindow,
    canOpenArbitraryWorkspace: () => (negotiatedAppProtocol ?? 1) >= 4,
    listMobileDirectory: mobileDirectoryList,
    openWorkspacePath: requestOpenWorkspacePath,
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<
      typeof createAcknowledgedWebRemoteControlRelayProtocol
    >;
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
    if (terminated || bridgeGeneration !== nextBridgeGeneration) {
      // 旧 bridge 响应不得替换用户较晚选择的 workspace。
      throw new Error(
        "Web remote control workspace bridge was superseded or closed.",
      );
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
    const ownedConnection = connectViaProtocolOwned(relayProtocol.protocol);
    const services = ownedConnection.services;
    const bridgeServiceRegistration =
      registerWebRemoteControlWorkspaceBridgeServices({
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
    const previousClientDispose = activeBridgeClientDispose;
    activeRelayProtocol = relayProtocol;
    activeBridgeServiceRegistration = bridgeServiceRegistration;
    activeBridgeClientDispose = ownedConnection.dispose;
    bridgeClientGeneration += 1;
    // 修复依据：ChannelClient持有在途RPC；relay adapter dispose不会拒绝这些Promise，
    // 所以替换bridge时必须先同步dispose旧client，让旧调用尽快退出并归类为stale。
    previousClientDispose?.();
    previousBridgeServiceRegistration?.dispose();
    previousRelayProtocol?.dispose();
    currentWorkspaceKey = response.bridge.workspaceKey;
    currentTaskId = response.bridge.initialTaskId;
    await updateMobileViewState(
      response.bridge.workspaceKey,
      response.bridge.initialTaskId,
    );
    return { bridge: response.bridge, services, relayProtocol };
  };

  const navigateWorkspace = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ) => {
    notificationMounted = undefined;
    const navigation = navigationOwner.begin({
      workspaceKey,
      taskId: options?.taskId,
      intent: options?.mobileNavigationIntent ?? "chat",
    });
    const result = await openWorkspaceBridge(workspaceKey, options);
    if (!navigationOwner.isCurrent(navigation.id) || terminated) return;
    searchHighlight =
      options?.searchHighlight && options.taskId
        ? {
            ...options.searchHighlight,
            requestId: navigation.id,
            taskId: options.taskId,
            workspacePath: result.bridge.workspacePath,
            ...(result.bridge.kind === "remote"
              ? { workspaceIdentity: result.bridge.workspaceIdentity }
              : {}),
          }
        : undefined;
    renderExternalRelayRoot(result.services, result.bridge, navigation.intent);
  };

  const renderExternalRelayRoot = (
    services: Awaited<ReturnType<typeof connectViaProtocol>>,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
  ) => {
    if (terminated) return;
    notificationServices = services;
    const mountedNavigationId = navigationOwner.peek()?.id;
    ready = true;
    renderStartPageIfActive = undefined;
    disposeStartPageWorkspaceSubscription?.();
    disposeStartPageWorkspaceSubscription = undefined;
    disposeStartPageRecentSubscription?.();
    disposeStartPageRecentSubscription = undefined;
    document.title = "Zody - Web Remote Control";
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
                    transport.sendPayload({
                      zcode_type: "telemetry-report",
                      event: parsed.data,
                    });
                },
              },
              ...pickMobileRemotePlatformCapabilities(context.platform),
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
            initialWebRemoteControlMobileNavigationIntent={
              initialNavigationIntent
            }
            webRemoteControlTerminalTransportState={terminalTransportState}
            webRemoteControlMobileConnectionSettings={mobileConnectionSettings}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen state="paired" />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              onNavigationMounted: (target) => {
                // Shell 可先于 activeTask 初始化挂载；只有正确聊天目标出现才确认通知已读。
                const expected = notificationMounted;
                if (
                  expected &&
                  expected.navigationId === mountedNavigationId &&
                  (expected.workspaceKey !== target.workspaceKey ||
                    expected.taskId !== target.taskId)
                )
                  return;
                if (
                  mountedNavigationId !== undefined &&
                  navigationOwner.acknowledge(mountedNavigationId)
                ) {
                  const pending = notificationMounted;
                  notificationMounted = undefined;
                  if (pending?.navigationId === mountedNavigationId)
                    void pending.commit().catch(() => {});
                }
              },
              listWorkspaces,
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              switchWorkspace: async (workspaceKey, options) => {
                await navigateWorkspace(workspaceKey, options);
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(
                  workspaceKey,
                  undefined,
                );
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                );
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
    renderCurrentExternalRelayRoot = () => {
      // 修复依据：Root 挂载会 ACK 当前导航；能力刷新不能借旧页面重渲染消费尚未完成的新导航。
      if (!terminated && !navigationOwner.peek())
        renderExternalRelayRoot(services, bridge, initialNavigationIntent);
    };
  };

  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (terminated) return;
    notificationServices = undefined;
    renderCurrentExternalRelayRoot = undefined;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "Zody - Web Remote Control";
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
                    transport.sendPayload({
                      zcode_type: "telemetry-report",
                      event: parsed.data,
                    });
                },
              },
              ...pickMobileRemotePlatformCapabilities(context.platform),
            })}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={terminalTransportState}
            webRemoteControlMobileConnectionSettings={mobileConnectionSettings}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen state="paired" />
            }
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
                await navigateWorkspace(nextWorkspaceKey, options);
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(
                  nextWorkspaceKey,
                  undefined,
                );
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                );
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
    notificationServices = undefined;
    renderCurrentExternalRelayRoot = undefined;
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
          {/* 空态页头部 ThemeMenu 需要 store 上下文；修复 A-MO-01 的 StartPage 白屏崩溃。 */}
          <WebRemoteControlStandaloneStoreProvider>
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
                  error =
                    openError instanceof Error
                      ? openError.message
                      : String(openError);
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
                  error =
                    openError instanceof Error
                      ? openError.message
                      : String(openError);
                } finally {
                  openingWindow = false;
                  // 新窗口的 tab 恢复是异步的，等 workspace-list-updated 再进入任务首页。
                  render();
                }
              })();
            }}
            onOpenSettings={() => context.requestReturnShell("settings")}
            openOtherProject={
              (negotiatedAppProtocol ?? 1) >= 4
                ? {
                    listDirectory: mobileDirectoryList,
                    openWorkspacePath: requestOpenWorkspacePath,
                    onOpened: async () => {
                      // 与最近项目打开同一条离开空态的路径：聚合列表出现 workspace 后
                      // 既有订阅会重新 bootstrap；这里主动触发一次加速收敛。
                      await bootstrapPairedSession?.();
                    },
                  }
                : undefined
            }
          />
          </WebRemoteControlStandaloneStoreProvider>
        </ZCodeIntlProvider>,
      );
    };

    renderStartPageIfActive = render;
    disposeStartPageWorkspaceSubscription?.();
    disposeStartPageRecentSubscription?.();
    // 最近项目和窗口状态由桌面主动推送；空态页面需要跟着刷新。
    disposeStartPageRecentSubscription = subscribeRecentProjectsUpdates(() =>
      render(),
    );
    // 窗口恢复/最近项目打开后，桌面会推送聚合列表；出现 workspace 就离开空态。
    disposeStartPageWorkspaceSubscription = subscribeWorkspaceListUpdates(
      (next) => {
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
      },
    );
    render();
  };

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated) return;
    applyRecentProjectsFromBootstrap(bootstrapResult);
    if (context.platform.mobileNotifications) {
      const subscriptionGeneration = connectionGeneration;
      void syncGatewayNotificationSubscription({
        gatewayUrl: gatewayConfig.gatewayUrl,
        backendId: gatewayConfig.backendId,
        credential: gatewayConfig.credential,
        platform: context.platform.mobileNotifications,
        isCurrent: () =>
          !terminated && subscriptionGeneration === connectionGeneration,
      }).catch(() => {});
    }
    if (bootstrapResult.workspaces.length === 0) {
      // 「电脑上没有窗口 / 没有打开的项目」不是失败，属于首页空态（方案「失败原因与恢复」）。
      renderMobileRemoteStartPage();
      void consumeNativeNotification();
      void consumeNativeNotificationAction();
      return;
    }
    const preferredWorkspace = options?.preferredWorkspaceKey
      ? bootstrapResult.workspaces.find(
          (workspace) =>
            resolveWebRemoteControlWorkspaceKey(workspace) ===
            options.preferredWorkspaceKey,
        )
      : undefined;
    const selectedWorkspace = preferredWorkspace
      ? {
          workspaceKey: resolveWebRemoteControlWorkspaceKey(preferredWorkspace),
          taskId: options?.preferredTaskId,
          canBridge:
            preferredWorkspace.kind !== "remote" ||
            Boolean(
              preferredWorkspace.workspaceIdentity &&
              preferredWorkspace.remoteSessionId,
            ),
        }
      : resolveWebRemoteControlInitialWorkspaceSelection(bootstrapResult);
    if (!selectedWorkspace) {
      renderMobileRemoteStartPage();
      void consumeNativeNotification();
      void consumeNativeNotificationAction();
      return;
    }
    if (!selectedWorkspace.canBridge) {
      await renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      void consumeNativeNotification();
      void consumeNativeNotificationAction();
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
    renderExternalRelayRoot(result.services, result.bridge);
    void consumeNativeNotification();
  };

  const disposeNativeNotification = (() => {
    // 同一文档/同一 session 复用启动时安装的宿主；事件仍按 sessionId 过滤。
    const host = installMobileRemoteNativeHost({
      sessionId: gatewayConfig.sessionId,
      ...(context.bridge ? { bridge: context.bridge } : {}),
    });
    const disposeClick = host?.onNotificationClick((click) => {
      void consumeNativeNotification(click);
    });
    const disposeAction = host?.onNotificationAction((action) => {
      void consumeNativeNotificationAction(action);
    });
    return () => {
      disposeAction?.();
      disposeClick?.();
    };
  })();
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

  // T6.2：Android 壳按 Activity ON_START/ON_STOP 派发前后台。复用 document 事件的同一套
  // suspended 状态机，避免两路事件各自恢复导致重复建连；后台暂停连接，回前台走完整恢复。
  const disposeNativeAppLifecycle = context.platform.onAppLifecycleChange?.(
    (state) => {
      if (state === "background") {
        lifecycle.suspend();
        return;
      }
      lifecycle.recover("resume");
    },
  );

  disposeSession = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    terminated = true;
    navigationOwner.clear();
    notificationServices = undefined;
    renderCurrentExternalRelayRoot = undefined;
    notificationViewGeneration += 1;
    void context.platform.mobileNotifications
      ?.setActiveTarget?.(null)
      .catch(() => {});
    notificationMounted = undefined;
    disposeNativeNotification?.();
    nativeClickQueue.dispose();
    disposeNotificationNotice?.();
    disposeNotificationNotice = undefined;
    searchHighlight = undefined;
    versionGuard.dispose();
    disposeVersionNotice?.();
    disposeVersionNotice = undefined;
    disposeStartPageWorkspaceSubscription?.();
    disposeStartPageWorkspaceSubscription = undefined;
    disposeStartPageRecentSubscription?.();
    disposeStartPageRecentSubscription = undefined;
    renderStartPageIfActive = undefined;
    disposeNativeAppLifecycle?.();
    activeBridgeClientDispose?.();
    activeBridgeClientDispose = undefined;
    bridgeClientGeneration += 1;
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    lifecycle.dispose();
    requester.dispose();
    transport.dispose();
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
