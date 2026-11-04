import { ingestToolExecResource } from "./desktopResourceTelemetry.js";
import { ingestMcpResourceSamples } from "./processResourceMcpTelemetrySource.js";
/* eslint-disable max-lines -- host process 统一处理 main↔host 生命周期、日志、ZCode Agent，拆分前先保持跨进程消息收口。 */
import {
  type HostAgentProcessErrorResponse,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
  type HostAgentProcessReadyResponse,
  type HostAgentProcessSpawnedResponse,
  type HostCuaOperationStateResponse,
  type HostMcpTelemetryResponse,
  type HostSessionCreateTelemetryResponse,
  type TaskRealtimeHostDeliveryKind,
  type WorkspacePurpose,
  formatZodyHostProcessName,
  HostMessageTypes,
  hostResponseMessageSchema,
  HostResponseTypes,
  InternalChannels,
  LAUNCH_MARKS_QUERY_KEY,
  RUNTIME_ZCODE_DEBUG,
  serializeLaunchMarks,
  ZODY_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zody/shared";
import type {
  PluginSandboxHandle,
  PluginSandboxRegisterRequestPayload,
  PluginSandboxRegisterResultPayload,
} from "@zody/shared/mcp-apps";
import type { MessagePortMain } from "electron";
import {
  app,
  BrowserWindow,
  utilityProcess as electronUtilityProcess,
  MessageChannelMain,
} from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HostProcessHandle } from "./hostProcessHandle.js";
import {
  spawnNativeHostProcess,
  type NativeHostLaunchConfig,
  type NodeHostProcess,
} from "./nodeHostProcess.js";
import { BroadcastHub } from "./broadcastHub.js";
import { bindDatabaseStartupRelay } from "./databaseStartupRelay.js";
import { getMainLaunchPartialMarks } from "./desktopLaunchMarks.js";
import { ingestHostNetworkObservations } from "./desktopNetworkTelemetry.js";
import {
  buildHostProcessEnv,
  hostModulePath,
  resolveBundledGlmBinaryPath,
} from "./desktopRuntimeEnv.js";
import { ingestHostNetworkCapture } from "./resourceManagerNetwork.js";
import { buildHostE2ECoverageEnv } from "./e2eCoverage.js";
import { createFeedbackLogArchiveFromExportLogs } from "./exportLogs.js";
import { createHostLogRelay } from "./hostLogRelay.js";
import { ingestCliResourceSample } from "./processResourceCliSource.js";
import { ingestHostSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { resolveHostResourceUsageResult } from "./resourceManagerHostSampling.js";
import {
  registerHostAgentProcess,
  registerHostProcess,
  unregisterHostAgentProcess,
  unregisterHostProcess,
} from "./resourceManagerWindow.js";
import type { TaskRealtimeBus } from "./taskRealtimeBus.js";

export interface WindowBootstrapOptions {
  restoreSession?: boolean;
  supportsSettings?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  windowKind?: "main" | "update-status";
  locale?: string;
}

export interface HostInitMessage {
  type: typeof HostMessageTypes.InitLocal;
  hostId?: string;
  databaseStartupId?: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
  deviceMid?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  agentWarmupTargets?: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  agentSpawnFallbackCwd?: string;
  /** Main 解析后的 ZCode Built-in Provider Config 路径；Host/Services 不感知 Electron 安装布局。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** Main 提前异步采集并过滤的本机 runtime 环境；只允许传给 InitLocal。 */
  runtimeProcessEnvPatch?: Record<string, string>;
}

export interface SpawnHostProcessOptions {
  internalChannel?: typeof InternalChannels.ServicePort | typeof InternalChannels.ScopedServicePort;
  internalPayload?: unknown;
  registerBroadcast?: boolean;
  taskRealtime?: {
    workspaceKeys: Iterable<string>;
    deliveryKind?: TaskRealtimeHostDeliveryKind;
    onHostId?: (hostId: string) => void;
  };
  onPortReady?: (port: MessagePortMain) => void;
  /** 共享 SSH/WSL Host 初始化时不创建特殊的首个 workspace RPC port。 */
  attachInitialServicePort?: boolean;
}

const exitedHostProcesses = new WeakSet<HostProcessHandle>();
const disposingHostProcesses = new Set<HostProcessHandle>();

export function listDisposingHostProcesses(): HostProcessHandle[] {
  return Array.from(disposingHostProcesses);
}

export function loadWindow(
  win: BrowserWindow,
  page: "index" | "login" = "index",
  bootstrap?: WindowBootstrapOptions,
): Promise<void> {
  const query = Object.fromEntries(
    Object.entries({
      restoreSession:
        bootstrap?.restoreSession == null ? undefined : String(bootstrap.restoreSession),
      supportsSettings:
        bootstrap?.supportsSettings == null ? undefined : String(bootstrap.supportsSettings),
      initialWorkspacePath: bootstrap?.initialWorkspacePath,
      initialWorkspacePurpose: bootstrap?.initialWorkspacePurpose,
      unavailableWorkspacePath: bootstrap?.unavailableWorkspacePath,
      windowKind: bootstrap?.windowKind,
      locale: bootstrap?.locale,
    }).filter((entry): entry is [string, string] => entry[1] != null),
  );

  if (page === "index") {
    const partial = getMainLaunchPartialMarks();
    query[LAUNCH_MARKS_QUERY_KEY] = serializeLaunchMarks({
      ...partial,
      loadUrl: Date.now(), // T3
    });
  }

  // 生产包不能信任继承环境中的开发服务器地址，否则会被本机开发会话劫持为空白页。
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    const url = new URL(page === "login" ? `${base}/login.html` : base);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return win.loadURL(url.toString());
  } else {
    return win.loadFile(join(import.meta.dirname, `../renderer/${page}.html`), {
      query,
    });
  }
}

export function spawnHostProcess(
  win: BrowserWindow,
  label: string,
  initMessage: HostInitMessage,
  dependencies: {
    publishMobileNotification?: (
      message: import("@zody/shared").MobileNotificationPublish,
    ) => Promise<import("@zody/shared").MobileNotificationReceipt>;
    getMobileNotificationContext?: () => { enabled: boolean; backendId?: string };
    hostProcessLocalEnv: Record<string, string>;
    logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    };
    broadcastHub: BroadcastHub;
    taskRealtimeBus?: TaskRealtimeBus;
    windowHostProcessMap: Map<number, HostProcessHandle>;
    hostRunningTaskCountMap: Map<HostProcessHandle, number>;
    /**
     * Compile-time candidate composition. Undefined keeps the default Electron
     * utilityProcess path. The native launcher verifies signatures/resources itself;
     * Main only selects the transport.
     */
    nativeHostLaunch?: NativeHostLaunchConfig;
    onWorkspaceRunningTaskCountChanged?: (
      child: HostProcessHandle,
      event: {
        workspacePath: string;
        workspaceIdentity?: string;
        runningTaskCount: number;
      },
    ) => void;
    onAgentProcessExited?: (event: HostAgentProcessExitedResponse) => void;
    onAgentProcessError?: (event: HostAgentProcessErrorResponse) => void;
    onAgentProcessException?: (event: HostAgentProcessExceptionResponse) => void;
    onAgentProcessReady?: (event: HostAgentProcessReadyResponse) => void;
    onAgentProcessSpawned?: (event: HostAgentProcessSpawnedResponse) => void;
    onMcpTelemetry?: (event: HostMcpTelemetryResponse) => void;
    onSessionCreateTelemetry?: (event: HostSessionCreateTelemetryResponse) => void;
    onCuaOperationStateChanged?: (
      source: HostProcessHandle,
      event: HostCuaOperationStateResponse,
    ) => void;
    onCuaOperationStateSourceExited?: (source: HostProcessHandle) => void;
    // fork（bot channels 移除，specs/bot-channels-removal.md）：三个
    // handleBotRemoteWorkspace* 依赖注入槽位随第三方 IM bot 远端 workspace 链删除。
    /** host → main：定时任务派发结果，转交给 cron scheduler 结算调度状态机。 */
    onCronRunResult?: (result: {
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }) => void;
    /** host 中 manual run 落库后请求 main 立即唤醒 scheduler。 */
    onCronSchedulerWakeRequested?: (automationId: string) => void;
    // fork（F4.3）：onOffPeakRunResult / onOffPeakSchedulerWakeRequested 随闲时任务全链路删除。
    // browser-use：main 用 WebContentsView+CDP 执行一条命令。实现由宿主注入；缺省则 backend_unavailable。
    handleBrowserExecuteRequest?: (params: {
      win: BrowserWindow;
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey?: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode?: "desktop-continuous" | "web-remote-replayable";
      sessionContext?: "live" | "cached";
      command: unknown;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
    /** browser-use：Host 请求转发 Chrome 扩展传输消息；Main 只做窗口绑定与 requestId 关联。 */
    handleExtensionTransportRequest?: (params: {
      win: BrowserWindow;
      request: {
        type: typeof HostResponseTypes.ExtensionTransportRequest;
        requestId: string;
        op: "list" | "request" | "send";
        profileInstanceId?: string;
        message?: unknown;
      };
    }) => Promise<{
      ok: boolean;
      connections?: unknown[];
      message?: unknown;
      error?: { code: string; message: string };
    }>;
    /** window Host 建立/退出时登记扩展传输投递句柄。 */
    onExtensionHostReady?: (win: BrowserWindow, child: HostProcessHandle) => void;
    onExtensionHostExited?: (win: BrowserWindow, child: HostProcessHandle) => void;
    /** Host 已完成附件授权后，由 Main 将本地视频 realpath 加入精确协议授权集合。 */
    authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
    /** Host 校验完插件 UI HTML 后交给 Main 沙箱注册表登记，返回句柄。 */
    registerPluginSandbox?: (
      input: PluginSandboxRegisterRequestPayload,
    ) => PluginSandboxHandle | Promise<PluginSandboxHandle>;
  },
  options?: SpawnHostProcessOptions,
): HostProcessHandle {
  const utilityHostId = randomUUID();
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const execArgv = [
    ...(RUNTIME_ZCODE_DEBUG ? [`--inspect-brk=${RUNTIME_ZCODE_DEBUG}`] : []),
    "--no-warnings",
  ];
  const nativeHost: NodeHostProcess | undefined = dependencies.nativeHostLaunch
    ? spawnNativeHostProcess({
        config: {
          ...dependencies.nativeHostLaunch,
          env: {
            ...buildHostProcessEnv(dependencies.hostProcessLocalEnv),
            ...buildHostE2ECoverageEnv(),
            ...dependencies.nativeHostLaunch.env,
          },
        },
        label,
        logger: {
          info: (...args: unknown[]) => dependencies.logger.info(...args),
          warn: (...args: unknown[]) => dependencies.logger.warn(...args),
          error: (...args: unknown[]) => dependencies.logger.warn(...args),
        },
      })
    : undefined;
  const child: HostProcessHandle =
    nativeHost ??
    electronUtilityProcess.fork(hostModulePath, [], {
      serviceName: formatZodyHostProcessName(label),
      execArgv,
      env: {
        ...buildHostProcessEnv(dependencies.hostProcessLocalEnv),
        ...buildHostE2ECoverageEnv(),
        ZODY_PROCESS_LABEL: label,
        // macOS-only: the Computer Use Helper launcher runs inside this forked host utilityProcess, whose
        // code-signing identity is a nested Electron helper (NOT dev.zcode.app). Publish THIS (main
        // Electron) process's pid — which IS dev.zcode.app — so helperLauncher passes it as
        // `--launcher-pid` and the Helper's signature/peer verification succeeds instead of
        // health-timing out. Env-name mirror of services' LAUNCHER_PID_ENV. Not set on
        // Windows/Linux (CUA is macOS-only; nothing reads it there) to keep the host env pristine.
        ...(process.platform === "darwin" ? { ZODY_CUA_LAUNCHER_PID: String(process.pid) } : {}),
        // fork（F2.6a，spec D1b）：桌面上下文提示固定开启，不再由 Main 读取远端灰度后
        // 经依赖注入决定；Host env 恒为 1，下游 services/node.ts 的三态解析（"1"/"0"/缺省）
        // 保持不变，Host/Agent 侧语义不受影响。
        [ZODY_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]: "1",
      },
    });

  dependencies.onExtensionHostReady?.(win, child);
  dependencies.logger.info(
    `[spawnHostProcess] started ${nativeHost ? "native candidate" : "utility"} host process for (${label}), pid=${child.pid}`,
  );
  dependencies.logger.info(
    nativeHost
      ? `[spawnHostProcess] native launcher path: ${dependencies.nativeHostLaunch?.launcherPath}`
      : `[spawnHostProcess] host module path: ${hostModulePath}`,
  );
  dependencies.logger.info(`[spawnHostProcess] glm binary path: ${glmBinaryPath ?? "<not found>"}`);
  dependencies.logger.info(
    `[spawnHostProcess] BIGMODEL_OAUTH_APP_SECRET source: ${process.env.BIGMODEL_OAUTH_APP_SECRET ? "process" : dependencies.hostProcessLocalEnv.BIGMODEL_OAUTH_APP_SECRET ? "dotenv" : "fallback"}`,
  );

  // 远程连接与本地服务共享 window Host，进程级 stdout 没有请求身份。
  // 连接进度改由 HostResponseTypes.RemoteWorkspaceConnectionLog 按 requestId 上报。
  const hostLogRelay = createHostLogRelay(
    label,
    dependencies.logger as Parameters<typeof createHostLogRelay>[1],
  );

  child.stderr?.on("data", (data: Buffer) => {
    hostLogRelay.onStderr(data.toString());
  });
  child.stdout?.on("data", (data: Buffer) => {
    hostLogRelay.onStdout(data.toString());
  });

  const databaseStartupId = nativeHost ? randomUUID() : utilityHostId;
  const databaseStartupRelay = bindDatabaseStartupRelay(win, child, databaseStartupId);
  child.on("message", (message: unknown) => {
    const result = hostResponseMessageSchema.safeParse(message);
    if (!result.success) {
      return;
    }

    if (result.data.type === "mobile-notification-publish") {
      const request = result.data;
      void (
        dependencies.publishMobileNotification?.(request) ??
        Promise.resolve({ status: "terminal" as const, code: "unsupported" })
      )
        .then((receipt) => {
          child.postMessage({
            type: "mobile-notification-result",
            requestId: request.requestId,
            receipt,
          });
        })
        .catch(() => {
          child.postMessage({
            type: "mobile-notification-result",
            requestId: request.requestId,
            receipt: { status: "retryable", code: "transport-error" },
          });
        });
      return;
    }
    if (result.data.type === HostResponseTypes.DatabaseStartupState) {
      databaseStartupRelay.receive(result.data.state);
      return;
    }

    if (result.data.type === HostResponseTypes.Log) {
      hostLogRelay.onStructuredLog(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.NetworkTelemetryBatch) {
      ingestHostNetworkObservations(result.data.observations);
      return;
    }
    if (result.data.type === HostResponseTypes.NetworkCaptureBatch) {
      ingestHostNetworkCapture(result.data.batch, child.pid ?? 0);
      return;
    }
    // CLI 自采的 60 秒样本：按 services 打的 lane 归入 cli_chat / cli_aux 角色。
    if (result.data.type === HostResponseTypes.AgentResourceSample) {
      ingestCliResourceSample(
        result.data.sample,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      return;
    }

    // Host 自采的 60 秒样本：main 只取 heap 作 host 角色事件的 heap 维度。
    if (result.data.type === HostResponseTypes.HostResourceSample) {
      ingestHostSelfResourceSample(result.data.sample);
      return;
    }

    if (result.data.type === HostResponseTypes.ResourceUsageSnapshotResult) {
      resolveHostResourceUsageResult(label, result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.ToolExecResource) {
      ingestToolExecResource(result.data.sample, result.data.runtimeSurface);
      return;
    }

    if (result.data.type === HostResponseTypes.McpResourceSamples) {
      ingestMcpResourceSamples(
        result.data.samples,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      return;
    }

    if (result.data.type === HostResponseTypes.McpTelemetry) {
      dependencies.onMcpTelemetry?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.SessionCreateTelemetry) {
      dependencies.onSessionCreateTelemetry?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest) {
      const request = result.data;
      const authorize = dependencies.authorizeLocalMediaPreviewPath;
      if (!authorize) {
        child.postMessage({
          type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
          requestId: request.requestId,
          ok: false,
          error: "Local media preview path authorization is unavailable.",
        });
        return;
      }
      void authorize(request.path)
        .then((path) => {
          child.postMessage({
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            requestId: request.requestId,
            ok: true,
            path,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.PluginSandboxRegisterRequest) {
      const request = result.data;
      const register = dependencies.registerPluginSandbox;
      const reply = (payload: PluginSandboxRegisterResultPayload) =>
        child.postMessage({ type: HostMessageTypes.PluginSandboxRegisterResult, ...payload });
      if (!register || win.isDestroyed() || request.ownerWebContentsId !== win.webContents.id) {
        reply({
          requestId: request.requestId,
          ok: false,
          error: "Plugin UI sandbox is unavailable.",
        });
        return;
      }
      void Promise.resolve()
        .then(() => register(request))
        .then((handle) => reply({ requestId: request.requestId, ok: true, ...handle }))
        .catch((error: unknown) =>
          reply({
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }

    if (result.data.type === HostResponseTypes.CuaOperationState) {
      // Main 只投影 Host 已经判定的 turn 状态，不在这里重复解析 session/tool 业务事件。
      dependencies.onCuaOperationStateChanged?.(child, result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.FeedbackLogArchiveRequest) {
      const request = result.data;
      void createFeedbackLogArchiveFromExportLogs(request.sourceDir)
        .then((archive) => {
          child.postMessage({
            type: HostMessageTypes.FeedbackLogArchiveResult,
            requestId: request.requestId,
            ok: true,
            path: archive.path,
            size: archive.size,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.FeedbackLogArchiveResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.ExtensionTransportRequest) {
      const request = result.data;
      const handler = dependencies.handleExtensionTransportRequest;
      void (
        handler
          ? handler({ win, request })
          : Promise.resolve({
              ok: false,
              error: { code: "backend_unavailable", message: "extension bridge not ready" },
            })
      )
        .catch((error: unknown) => ({
          ok: false,
          error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          },
        }))
        .then((payload) => {
          child.postMessage({
            type: HostMessageTypes.ExtensionTransportResult,
            requestId: request.requestId,
            ...payload,
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.BrowserExecuteRequest) {
      // browser-use：main 用 WebContentsView+CDP 执行命令（handleBrowserExecuteRequest）。
      // 缺省实现时返回 backend_unavailable，保证通道打通但不阻塞。
      const requestId = result.data.requestId;
      const handler = dependencies.handleBrowserExecuteRequest;
      const fallback = {
        ok: false as const,
        error: {
          code: "backend_unavailable",
          message: "browser executor not ready",
        },
        elapsedMs: 0,
      };
      void (
        handler
          ? handler({
              win,
              requestId,
              browserId: result.data.browserId,
              browserGeneration: result.data.browserGeneration,
              sessionId: result.data.sessionId,
              turnId: result.data.turnId,
              workspaceKey: result.data.workspaceKey,
              workspacePath: result.data.workspacePath,
              workspaceIdentity: result.data.workspaceIdentity,
              remoteSessionId: result.data.remoteSessionId,
              clientMode: result.data.clientMode,
              sessionContext: result.data.sessionContext,
              command: result.data.command,
            }).catch((error: unknown) => ({
              ok: false as const,
              error: {
                code: "execution_error",
                message: error instanceof Error ? error.message : String(error),
              },
              elapsedMs: 0,
            }))
          : Promise.resolve(fallback)
      ).then((commandResult) => {
        child.postMessage({
          type: HostMessageTypes.BrowserExecuteResult,
          requestId,
          result: commandResult,
        });
      });
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessSpawned) {
      registerHostAgentProcess(label, {
        pid: result.data.pid,
        provider: result.data.provider,
        workspacePath: result.data.workspacePath,
        command: result.data.command,
        args: result.data.args,
        startedAt: result.data.startedAt,
      });
      dependencies.onAgentProcessSpawned?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessReady) {
      dependencies.onAgentProcessReady?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessExited) {
      unregisterHostAgentProcess(label, result.data.pid);
      dependencies.onAgentProcessExited?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessError) {
      dependencies.onAgentProcessError?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessException) {
      dependencies.onAgentProcessException?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.CronRunResult) {
      dependencies.onCronRunResult?.({
        runId: result.data.runId,
        ok: result.data.ok,
        taskId: result.data.taskId,
        sessionId: result.data.sessionId,
        error: result.data.error,
        failureKind: result.data.failureKind,
      });
      return;
    }

    if (result.data.type === HostResponseTypes.CronSchedulerWakeRequest) {
      dependencies.onCronSchedulerWakeRequested?.(result.data.automationId);
      return;
    }

    // fork（F4.3）：OffPeakRunResult / OffPeakSchedulerWakeRequest 响应分支随闲时任务全链路删除。

    if (result.data.type === HostResponseTypes.AgentRunningTaskCountChanged) {
      if (result.data.runningTaskCount > 0) {
        dependencies.hostRunningTaskCountMap.set(child, result.data.runningTaskCount);
      } else {
        dependencies.hostRunningTaskCountMap.delete(child);
      }
      dependencies.logger.info(
        `[app-quit] host running agent sessions updated (${label}) count=${result.data.runningTaskCount}`,
      );
      return;
    }

    if (result.data.type === HostResponseTypes.WorkspaceRunningTaskCountChanged) {
      dependencies.onWorkspaceRunningTaskCountChanged?.(child, {
        workspacePath: result.data.workspacePath,
        workspaceIdentity: result.data.workspaceIdentity,
        runningTaskCount: result.data.runningTaskCount,
      });
      return;
    }

    // fork（bot channels 移除，specs/bot-channels-removal.md）：BotRemoteWorkspace
    // 三段 host→main 请求分发（Reconnect/ConnectionStatus/RuntimePort）随第三方 IM bot
    // 远端 workspace 链删除；手机 replayable attachment 走 AttachServicePort，不经此路径。
  });

  const publishNotificationContext = () =>
    child.postMessage({
      type: "mobile-notification-context",
      ...(dependencies.getMobileNotificationContext?.() ?? { enabled: false }),
    });
  const shouldAttachRealtimeHost = options?.taskRealtime != null;
  // Host 实例身份属于整个 Host 进程生命周期，不是 taskRealtime 的附属能力。
  // Local services / Agent 启动身份必须始终拿到同一个真实 hostId。Native Host 的
  // hostId 只来自桥接 hello，Main 不能用自己生成的 id 替代或改写给业务初始化。
  const sendHostInit = (hostId: string) => {
    const hostInitMessage: HostInitMessage = {
      ...initMessage,
      databaseStartupId: databaseStartupRelay.startupId,
      hostId,
      ...(shouldAttachRealtimeHost && options?.taskRealtime?.deliveryKind
        ? { deliveryKind: options.taskRealtime.deliveryKind }
        : {}),
    };

    if (options?.attachInitialServicePort === false) {
      child.postMessage(hostInitMessage);
      publishNotificationContext();
      return;
    }

    const { port1, port2 } = new MessageChannelMain();
    child.postMessage(hostInitMessage, [port2]);
    publishNotificationContext();

    if (options?.onPortReady) {
      options.onPortReady(port1);
    } else {
      win.webContents.postMessage(
        options?.internalChannel ?? InternalChannels.ServicePort,
        options?.internalChannel === InternalChannels.ScopedServicePort
          ? (options.internalPayload ?? null)
          : { databaseStartupId: databaseStartupRelay.startupId },
        [port1],
      );
    }
  };

  const attachRealtimeHost = (hostId: string) => {
    if (shouldAttachRealtimeHost && dependencies.taskRealtimeBus && options?.taskRealtime) {
      dependencies.taskRealtimeBus.registerHost({
        hostId,
        windowId: win.id,
        child,
        workspaceKeys: options.taskRealtime.workspaceKeys,
        deliveryKind: options.taskRealtime.deliveryKind,
      });
      options.taskRealtime.onHostId?.(hostId);
    }
  };

  const windowId = win.webContents.id;
  const shouldRegisterBroadcast = options?.registerBroadcast ?? true;
  const registerBroadcast = () => {
    if (shouldRegisterBroadcast) {
      dependencies.broadcastHub.register(windowId, child);
    }
  };

  const attachExitHandler = () => {
    child.on("exit", (code) => {
      exitedHostProcesses.add(child);
      // Host exit 是 fail-hidden 权威边界；不能依赖即将退出的 Host 再补发 inactive。
      dependencies.onCuaOperationStateSourceExited?.(child);
      hostLogRelay.flushRawLogs();
      dependencies.onExtensionHostExited?.(win, child);
      dependencies.logger.info(
        `[spawnHostProcess] host process (${label}) exited with code ${code}`,
      );
      dependencies.hostRunningTaskCountMap.delete(child);
      if (shouldRegisterBroadcast) {
        dependencies.broadcastHub.unregister(windowId);
      }
      unregisterHostProcess(label);
      for (const [wcId, process] of dependencies.windowHostProcessMap) {
        if (process === child) {
          dependencies.windowHostProcessMap.delete(wcId);
          break;
        }
      }
    });
  };

  if (nativeHost) {
    // Native Host 先连桥并宣告 hostId；窗口路由/监听先登记，避免初始化期间的
    // 早期广播丢失。InitLocal 必须等真实 hello 后再发。
    registerBroadcast();
    registerHostProcess(label, child);
    attachExitHandler();
    void nativeHost
      .waitForHostId()
      .then((hostId) => {
        sendHostInit(hostId);
        attachRealtimeHost(hostId);
      })
      .catch((error: unknown) => {
        dependencies.logger.warn(
          `[spawnHostProcess] native host (${label}) did not announce hostId`,
          error,
        );
      });
  } else {
    // 默认 utilityProcess 路径保持原有同步顺序。
    sendHostInit(utilityHostId);
    registerBroadcast();
    attachRealtimeHost(utilityHostId);
    registerHostProcess(label, child);
    attachExitHandler();
  }

  return child;
}

export function disposeHostProcess(
  child: HostProcessHandle,
  label: string,
  disposingHostProcessTimers: WeakMap<HostProcessHandle, ReturnType<typeof setTimeout>>,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  forceKillDelayMs = 300,
) {
  if (disposingHostProcessTimers.has(child)) {
    return;
  }
  disposingHostProcesses.add(child);

  logger.info(
    `[disposeHostProcess] disposing host process (${label}), pid=${child.pid ?? "unknown"}`,
  );

  try {
    child.postMessage({ type: HostMessageTypes.Dispose });
  } catch (error) {
    logger.warn(`[disposeHostProcess] failed to post dispose to (${label}):`, error);
  }

  // host 收到 Dispose 后需要等待 agent 进程树的 SIGTERM/SIGKILL 兜底完成。
  // 如果 main 仍按 150/300ms 强杀 host，host 会先退出，zcode-cli/app-server 子进程就可能被 init 接管成孤儿。
  const effectiveForceKillDelayMs = Math.max(forceKillDelayMs, 3_500);
  const killTimer = setTimeout(() => {
    disposingHostProcessTimers.delete(child);
    try {
      child.kill();
    } catch (error) {
      logger.warn(`[disposeHostProcess] failed to kill host process (${label}):`, error);
    }
  }, effectiveForceKillDelayMs);

  disposingHostProcessTimers.set(child, killTimer);
  child.once("exit", () => {
    exitedHostProcesses.add(child);
    disposingHostProcesses.delete(child);
    clearTimeout(killTimer);
    disposingHostProcessTimers.delete(child);
  });
}
export function disposeHostProcessAndWait(
  child: HostProcessHandle,
  label: string,
  disposingHostProcessTimers: WeakMap<HostProcessHandle, ReturnType<typeof setTimeout>>,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: {
    forceKillDelayMs?: number;
    waitTimeoutMs?: number;
  } = {},
): Promise<void> {
  // Electron UtilityProcess 不是 Node ChildProcess，没有 exitCode 字段。
  // 右键 Dock 退出会走 before-quit -> disposeHostProcessAndWait；旧判断把运行中的 host
  // 的 undefined exitCode 当成“已退出”。这里改为记录 exit 事件，避免第一次退出漏发 Dispose。
  if (exitedHostProcesses.has(child)) {
    return Promise.resolve();
  }

  const waitTimeoutMs = Math.max(options.waitTimeoutMs ?? 0, 0);

  return new Promise((resolve) => {
    let settled = false;
    let waitTimeout: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (waitTimeout) {
        clearTimeout(waitTimeout);
        waitTimeout = null;
      }
      resolve();
    };

    child.once("exit", () => {
      exitedHostProcesses.add(child);
      settle();
    });

    if (waitTimeoutMs > 0) {
      waitTimeout = setTimeout(() => {
        logger.warn(
          `[disposeHostProcessAndWait] host process exit wait timed out (${label}), pid=${child.pid ?? "unknown"}`,
        );
        settle();
      }, waitTimeoutMs);
      waitTimeout.unref?.();
    }

    disposeHostProcess(child, label, disposingHostProcessTimers, logger, options.forceKillDelayMs);
  });
}
