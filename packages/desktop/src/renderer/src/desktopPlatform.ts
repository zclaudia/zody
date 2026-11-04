import { recordArmsCustomEventForE2E } from "@zody/ui";
import { DesktopCommandIds, buildLocalMediaPreviewUrl, type IPlatformService } from "@zody/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";
import { createDesktopPluginSandboxPlatform } from "./plugin-sandbox/desktopPluginSandboxPlatform.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    pluginSandbox: createDesktopPluginSandboxPlatform(),
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.zody.selectDirectory(),
    selectFile: () => window.zody.selectFile(),
    selectFiles: () => window.zody.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.zody.createTempTextAttachment(payload),
    materializeWorkflowArtifactFile: (payload) =>
      window.zody.materializeWorkflowArtifactFile(payload),
    onRemoteConnectionLog: (handler) => window.zody.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.zody.onRemoteSessionClosed(handler),
    // fork（bot channels 移除，specs/bot-channels-removal.md）：onBotRemoteWorkspaceReconnected
    // 透传随第三方 IM bot 远端 workspace 重连链删除（IPlatformService 方法由 shared 包同波摘除）。
    activateOrSetWorkspace: (path) =>
      window.zody.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.zody.connectRemote(remoteOptions, requestId, context),
    cancelPendingRemoteConnection: (requestId) =>
      window.zody.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.zody.bindRemoteWorkspaceSessionContext?.(context) ?? Promise.resolve(),
    getWebRemoteControlStatus: () => window.zody.getWebRemoteControlStatus(),
    onWebRemoteControlStatusChanged: (handler) =>
      window.zody.onWebRemoteControlStatusChanged?.(handler) ?? (() => {}),
    setRemoteAccessEnabled: (enabled) =>
      window.zody.setRemoteAccessEnabled?.(enabled) ?? Promise.resolve(),
    disconnectRemoteClient: () => window.zody.disconnectRemoteClient?.() ?? Promise.resolve(),
    getRemoteAccessStatus: () =>
      window.zody.getRemoteAccessStatus?.() ??
      Promise.resolve({
        enabled: false,
        status: { status: "idle" as const },
        // T3.2：旧 preload / 浏览器开发模式下没有 gateway backend，按关闭处理。
        gateway: { state: "disabled" as const },
      }),
    getRemoteAccessCredentialStatus: () =>
      window.zody.getRemoteAccessCredentialStatus?.() ?? Promise.resolve({ configured: false }),
    saveRemoteAccessCredential: (credential) => {
      if (!window.zody.saveRemoteAccessCredential) {
        return Promise.reject(new Error("Remote access credentials are not supported"));
      }
      return window.zody.saveRemoteAccessCredential(credential);
    },
    clearRemoteAccessCredential: () =>
      window.zody.clearRemoteAccessCredential?.() ?? Promise.resolve(),
    testRemoteAccessConnection: (input) => {
      if (!window.zody.testRemoteAccessConnection) {
        return Promise.resolve({ ok: false as const, reason: "unconfigured" as const });
      }
      return window.zody.testRemoteAccessConnection(input);
    },
    disposeRemoteSession: (sessionId) => window.zody.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.zody.isDockerAvailable(),
    listWSLDistros: () => window.zody.listWSLDistros(),
    listDockerContainers: () => window.zody.listDockerContainers(),
    listSSHConfigAliases: () => window.zody.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.zody.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.zody.saveMcpToUserDirectory(payload),
    openExternal: (url) => window.zody.openExternal(url),
    openFeedback: () => window.zody.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.zody.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.zody.canOpenCommunity(locale),
    openInFileManager: (path) => window.zody.openInFileManager(path),
    openExternalFile: (path) => window.zody.openExternalFile(path),
    openCuaPermissionOnboarding: window.zody.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.zody.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.zody.prepareCuaHelperPermissionDrag
      ? () =>
          window.zody.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.zody.startCuaHelperPermissionDrag
      ? () => window.zody.startCuaHelperPermissionDrag?.()
      : undefined,
    // fork（F4.11）：registerOAuthState / onOAuthCallback / onPaymentCallback 随官方账号
    // OAuth 与购买深链删除（preload 实现已在 F4.7 移除）。
    // fork（F4.8）：onShareImport 随会话分享功能删除。
    notifyRendererReady: () => window.zody.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.zody.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.zody.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.zody.getRendererActionTraceConfig
      ? () => window.zody.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.zody.onRendererActionTraceConfigChanged
      ? (callback) => window.zody.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.zody.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.zody.reportRendererActionTraceBatch
      ? (batch) => window.zody.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.zody.reportRendererHeapSample
      ? (sample) => window.zody.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.zody.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.zody.syncWindowTabs(paths),
    syncWebRemoteControlWorkspaces: (workspaces) =>
      window.zody.syncWebRemoteControlWorkspaces?.(workspaces),
    syncWebRemoteControlTasks: (tasks) => window.zody.syncWebRemoteControlTasks?.(tasks),
    onWebRemoteControlReconnectWorkspace: (handler) =>
      window.zody.onWebRemoteControlReconnectWorkspace?.(handler) ?? (() => {}),
    syncWindowUnreadCount: (count) => window.zody.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.zody.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.zody.syncAppSettings?.(patch),
    // 桥缺失（旧 preload 升级窗口）时按 supported 兜底，与 Windows 现状一致，设置开关可用。
    getCloseToTrayCapability: () =>
      window.zody.getCloseToTrayCapability?.() ??
      Promise.resolve({ supported: true, gnomeLikeWithoutTray: false }),
    setShortcutRecordingActive: (active) => window.zody.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.zody.onFocusTab(handler),
    onNewTab: (handler) => window.zody.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.zody.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.zody.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onEmbeddedBrowserPermissionPrompt: (handler) =>
      window.zody.onEmbeddedBrowserPermissionPrompt?.(handler) ?? (() => {}),
    resolveEmbeddedBrowserPermissionPrompt: (request) =>
      window.zody.resolveEmbeddedBrowserPermissionPrompt?.(request),
    getEmbeddedBrowserSitePermissions: () =>
      window.zody.getEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    setEmbeddedBrowserSitePermission: (request) =>
      window.zody.setEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    clearEmbeddedBrowserSitePermissions: () =>
      window.zody.clearEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    resetEmbeddedBrowserSitePermission: (request) =>
      window.zody.resetEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.zody.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.zody.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.zody.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.zody.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.zody.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.zody.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.zody.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.zody.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.zody.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.zody.getDesktopWindowChromeState
      ? () => window.zody.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.zody.onDesktopWindowChromeStateChanged
      ? (handler) => window.zody.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.zody.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.zody.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.zody.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.zody.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.zody.onTaskNotificationClick(handler),
    exportLogs: () => window.zody.exportLogs(),
    captureWindowScreenshot: () =>
      window.zody.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.zody.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.zody.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.zody.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.zody.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.zody.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.zody.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.zody.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.zody.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.zody.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.zody.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getZCodeStdioTapDevState: () =>
      window.zody.getZCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.zody.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.zody.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.zody.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.zody.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.zody.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.zody.quitAndInstallUpdate(),
    getInstalledEditors: () => window.zody.getInstalledEditors(),
    getApplicationIcon: (bundleId) =>
      window.zody.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.zody.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.zody.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.zody.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.zody.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.zody.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __ZODY_DEVICE_ID__?: string }).__ZODY_DEVICE_ID__ ?? "",
  };
}
