import type { IPlatformService } from "@zody/shared";

type DesktopBrowserPlatformBridge = Pick<
  IPlatformService,
  | "onBrowserViewDownloadStarted"
  | "onBrowserViewReady"
  | "onBrowserViewOperation"
  | "onBrowserViewViewportChanged"
  | "onBrowserViewVisibility"
  | "onBrowserViewCloseTab"
  | "onBrowserViewSuspend"
  | "onBrowserViewRestore"
  | "browserViewAttachGuest"
  | "browserViewDetachGuest"
  | "browserViewCloseTab"
  | "browserViewReportResidency"
  | "browserViewSuspendReady"
  | "browserViewEnsureResident"
  | "browserViewRestoreTabs"
  | "browserViewUpdateViewport"
  | "importChromeBrowserData"
  | "clearEmbeddedBrowserData"
  | "getBrowserExtensionStatus"
  | "beginBrowserExtensionPairing"
  | "cancelBrowserExtensionPairing"
  | "setBrowserExtensionDefaultBackend"
  | "revokeBrowserExtensionProfile"
  | "transferBrowserExtensionProfile"
  | "setBrowserExtensionBridgePort"
  | "getPathForFile"
  | "saveFile"
  | "printPageToPdf"
>;

// Rebase 集成：browser bridge 若继续内联在 renderer 入口，会让入口越过 max-lines 门禁。
// 独立对象只做 preload 委托与旧 bridge 兼容兜底，不持有 Browser 业务状态。
export const desktopBrowserPlatformBridge = {
  getPathForFile: (file) => window.zody.getPathForFile?.(file) ?? null,
  saveFile: (payload) =>
    window.zody.saveFile?.(payload) ?? Promise.resolve({ success: false, error: "not_supported" }),
  // 条件定义而非兜底返回失败：UI 靠方法是否存在做能力检测，旧 preload 下必须保持 undefined
  printPageToPdf: window.zody.printPageToPdf ? () => window.zody.printPageToPdf!() : undefined,
  // 来源 a60ba6a7（upstream v3.17.1 F13）：guest 下载事件转发给 UI 对账下载与加载失败。
  onBrowserViewDownloadStarted: (handler) =>
    window.zody.onBrowserViewDownloadStarted?.(handler) ?? (() => {}),
  onBrowserViewReady: (handler) => window.zody.onBrowserViewReady?.(handler) ?? (() => {}),
  onBrowserViewOperation: (handler) => window.zody.onBrowserViewOperation?.(handler) ?? (() => {}),
  onBrowserViewViewportChanged: (handler) =>
    window.zody.onBrowserViewViewportChanged?.(handler) ?? (() => {}),
  onBrowserViewVisibility: (handler) =>
    window.zody.onBrowserViewVisibility?.(handler) ?? (() => {}),
  onBrowserViewCloseTab: (handler) => window.zody.onBrowserViewCloseTab?.(handler) ?? (() => {}),
  onBrowserViewSuspend: (handler) => window.zody.onBrowserViewSuspend?.(handler) ?? (() => {}),
  onBrowserViewRestore: (handler) => window.zody.onBrowserViewRestore?.(handler) ?? (() => {}),
  browserViewAttachGuest: (payload) =>
    window.zody.browserViewAttachGuest?.(payload) ??
    Promise.resolve({ ok: false, reason: "not-found", recoveryRequested: false }),
  browserViewDetachGuest: (payload) =>
    window.zody.browserViewDetachGuest?.(payload) ?? Promise.resolve(false),
  browserViewCloseTab: (payload) => window.zody.browserViewCloseTab?.(payload) ?? Promise.resolve(),
  browserViewReportResidency: (payload) =>
    window.zody.browserViewReportResidency?.(payload) ?? Promise.resolve(),
  browserViewSuspendReady: (payload) =>
    window.zody.browserViewSuspendReady?.(payload) ?? Promise.resolve(),
  browserViewEnsureResident: (payload) =>
    window.zody.browserViewEnsureResident?.(payload) ?? Promise.resolve(),
  browserViewRestoreTabs: (payload) =>
    window.zody.browserViewRestoreTabs?.(payload) ?? Promise.resolve([]),
  browserViewUpdateViewport: (payload) =>
    window.zody.browserViewUpdateViewport?.(payload) ?? Promise.resolve(),
  importChromeBrowserData: (options) =>
    window.zody.importChromeBrowserData?.(options) ??
    Promise.resolve({
      success: false,
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
      error: "unsupported",
    }),
  clearEmbeddedBrowserData: (mode) =>
    window.zody.clearEmbeddedBrowserData?.(mode) ??
    Promise.resolve({ success: false, error: "unsupported" }),
  // 旧 preload 下保持 undefined：设置页按方法存在与否决定是否展示管理操作。
  getBrowserExtensionStatus: window.zody.getBrowserExtensionStatus
    ? () => window.zody.getBrowserExtensionStatus!()
    : undefined,
  beginBrowserExtensionPairing: window.zody.beginBrowserExtensionPairing
    ? () => window.zody.beginBrowserExtensionPairing!()
    : undefined,
  cancelBrowserExtensionPairing: window.zody.cancelBrowserExtensionPairing
    ? (pairingSessionId) => window.zody.cancelBrowserExtensionPairing!(pairingSessionId)
    : undefined,
  setBrowserExtensionDefaultBackend: window.zody.setBrowserExtensionDefaultBackend
    ? (browserId) => window.zody.setBrowserExtensionDefaultBackend!(browserId)
    : undefined,
  revokeBrowserExtensionProfile: window.zody.revokeBrowserExtensionProfile
    ? (profileInstanceId) => window.zody.revokeBrowserExtensionProfile!(profileInstanceId)
    : undefined,
  transferBrowserExtensionProfile: window.zody.transferBrowserExtensionProfile
    ? (profileInstanceId) => window.zody.transferBrowserExtensionProfile!(profileInstanceId)
    : undefined,
  setBrowserExtensionBridgePort: window.zody.setBrowserExtensionBridgePort
    ? (port) => window.zody.setBrowserExtensionBridgePort!(port)
    : undefined,
} satisfies DesktopBrowserPlatformBridge;
