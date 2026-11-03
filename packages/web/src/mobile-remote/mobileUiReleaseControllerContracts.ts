import type {
  MobileRemotePrepareReloadResult,
  MobileRemotePrepareReloadResultKind,
  MobileUiReleaseManifest,
} from "@zcode/shared";
import type {
  MobileUiReleaseFailureReason,
  MobileUiReleaseObservation,
} from "./mobileUiReleaseDto.js";
import type {
  MobileUiRefreshBlockReason,
  MobileUiRefreshGuardRegistry,
} from "./mobileUiRefreshGuards.js";

/**
 * `MobileUiReleaseController` 的公开契约与平台默认适配器（M3-T1）。
 *
 * 控制器实现拆成三个文件，避免单文件无限增长：
 * - 本文件：稳定类型、常量、可注入 clock/scheduler/environment/throttle；
 * - `mobileUiReleaseControllerApply.ts`：guard → 重新请求 → native veto → reload 决策；
 * - `mobileUiReleaseControllerRuntime.ts`：轮询、生命周期、二次确认与手动入口。
 *
 * 产品规则与事件顺序见 spec 第 9.3、10、11 M3 节。
 */

export const MOBILE_UI_RELEASE_POLL_INTERVAL_MS = 60_000;
export const MOBILE_UI_RELEASE_CONFIRM_INTERVAL_MS = 5_000;
export const MOBILE_UI_RELEASE_AUTO_RELOAD_COOLDOWN_MS = 60_000;

/** 同一标签页的自动刷新限频记录；跨 reload 保留，避免升级/回滚循环。 */
export const MOBILE_UI_RELEASE_AUTO_RELOAD_STORAGE_KEY =
  "zody.mobile-ui.release.last-auto-reload-at";

export type MobileUiReleaseCheckReason =
  | "poll"
  | "visible"
  | "pageshow"
  | "online"
  | "business-reconnect"
  | "manual";

export interface MobileUiReleaseClock {
  now(): number;
}

export interface MobileUiReleaseScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type MobileUiReleaseEnvironmentEvent =
  | "visibilitychange"
  | "pagehide"
  | "pageshow"
  | "online"
  | "offline";

export interface MobileUiReleaseEnvironment {
  isVisible(): boolean;
  isOnline(): boolean;
  subscribe(event: MobileUiReleaseEnvironmentEvent, listener: () => void): () => void;
}

export interface MobileUiReleaseThrottleStore {
  readLastAutoReloadAt(): number | undefined;
  writeLastAutoReloadAt(epochMs: number): void;
}

export interface MobileUiReleaseLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type MobileUiReleaseControllerStatus =
  | { kind: "idle" }
  | { kind: "checking"; reason: MobileUiReleaseCheckReason }
  | { kind: "up-to-date"; checkedAt: number }
  | {
      kind: "pending-confirmation";
      releaseId: string;
      firstSeenAt: number;
      confirmAt: number;
    }
  | {
      kind: "ready";
      releaseId: string;
      desktopVersion: string;
      blockedReasons: readonly MobileUiRefreshBlockReason[];
      nativeVeto?: MobileRemotePrepareReloadResultKind;
      retryAt?: number;
    }
  | { kind: "reloading"; releaseId: string; manual: boolean }
  | {
      kind: "check-failed";
      reason: MobileUiReleaseFailureReason;
      status?: number;
    }
  | { kind: "invalid-baseline"; reason: "missing" | "invalid" }
  | {
      kind: "incompatible";
      releaseId: string;
      supportedBridgeVersions: readonly number[];
    }
  | { kind: "disposed" };

export type MobileUiSafeReloadResult =
  | { kind: "reloaded"; releaseId: string }
  | { kind: "pending-confirmation"; releaseId: string; confirmAt: number }
  | {
      kind: "blocked";
      releaseId: string;
      reasons: readonly MobileUiRefreshBlockReason[];
      nativeVeto?: MobileRemotePrepareReloadResultKind;
    }
  | { kind: "throttled"; releaseId: string; retryAt: number }
  | { kind: "failed"; reason: MobileUiReleaseFailureReason }
  | {
      kind: "incompatible";
      releaseId: string;
      supportedBridgeVersions: readonly number[];
    }
  | { kind: "invalid-baseline"; reason: "missing" | "invalid" }
  | { kind: "cancelled"; reason: "up-to-date" | "release-changed" | "document-changed" }
  | { kind: "not-ready"; status: MobileUiReleaseControllerStatus }
  | { kind: "disposed" };

export interface MobileUiReleaseTarget {
  releaseId: string;
  manifest: MobileUiReleaseManifest;
}

export interface MobileUiReleaseControllerOptions {
  /** 当前 Remote 会话；只用于 prepareReload，不写入日志或 URL。 */
  sessionId: string;
  /** 当前原生桥版本；manifest 不支持时只提示升级 APK，不 reload。 */
  bridgeVersion: number;
  /** 发布 DTO 请求；由 M3-T2 用 `fetchMobileUiReleaseObservation` 构造。 */
  fetchRelease: () => Promise<MobileUiReleaseObservation>;
  /** 原生 veto；缺省/抛错/未知结果按 unsupported 处理。 */
  prepareReload: (
    sessionId: string,
    releaseId: string,
  ) => MobileRemotePrepareReloadResult | Promise<MobileRemotePrepareReloadResult>;
  /** 真正执行页面 reload；生产实现是 `window.location.reload()`。 */
  reload: (target: MobileUiReleaseTarget) => void;
  /** 可注入以便 M3-T2 在同一个注册表登记草稿/文件/弹层 guard。 */
  guards?: MobileUiRefreshGuardRegistry;
  /** 读取当前 HTML release meta；缺省读取 M1 注入的 `<meta>`。 */
  readCurrentReleaseId?: () => string | undefined;
  logger?: MobileUiReleaseLogger;
  clock?: MobileUiReleaseClock;
  scheduler?: MobileUiReleaseScheduler;
  environment?: MobileUiReleaseEnvironment;
  throttleStore?: MobileUiReleaseThrottleStore;
  pollIntervalMs?: number;
  confirmIntervalMs?: number;
  autoReloadCooldownMs?: number;
}

export interface MobileUiReleaseController {
  readonly guards: MobileUiRefreshGuardRegistry;
  start(): void;
  dispose(): void;
  /** 立即检查；显式手动刷新走 `requestSafeReload`。 */
  checkNow(reason?: MobileUiReleaseCheckReason): Promise<void>;
  /** 业务 Channel 重连后由 M3-T2 调用，立即检查发布。 */
  notifyBusinessReconnect(): void;
  /** 手动“安全刷新”：复用同一 guard、5 秒确认和 native veto。 */
  requestSafeReload(): Promise<MobileUiSafeReloadResult>;
  getStatus(): MobileUiReleaseControllerStatus;
  subscribe(listener: (status: MobileUiReleaseControllerStatus) => void): () => void;
}

export interface CandidateRelease {
  releaseId: string;
  manifest: MobileUiReleaseManifest;
  firstSeenAt: number;
}

export type DocumentReleaseRead =
  | { kind: "valid"; releaseId: string }
  | { kind: "missing" | "invalid" };

/** 控制器内部唯一可变状态；apply/runtime 两个实现文件共享此对象，不另建副本。 */
export interface MobileUiReleaseControllerState {
  started: boolean;
  disposed: boolean;
  suspended: boolean;
  baselineInitialized: boolean;
  baselineReleaseId: string | undefined;
  baselineInvalidReason: "missing" | "invalid" | undefined;
  candidate: CandidateRelease | undefined;
  manualPending: boolean;
  pollTimer: unknown;
  confirmTimer: unknown;
  activeCheck: Promise<void> | undefined;
  queuedCheckReason: MobileUiReleaseCheckReason | undefined;
  checkGeneration: number;
  applyToken: number;
}

export function createMobileUiReleaseControllerState(): MobileUiReleaseControllerState {
  return {
    started: false,
    disposed: false,
    suspended: false,
    baselineInitialized: false,
    baselineReleaseId: undefined,
    baselineInvalidReason: undefined,
    candidate: undefined,
    manualPending: false,
    pollTimer: undefined,
    confirmTimer: undefined,
    activeCheck: undefined,
    queuedCheckReason: undefined,
    checkGeneration: 0,
    applyToken: 0,
  };
}

export const MOBILE_UI_RELEASE_NOOP_LOGGER: MobileUiReleaseLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function createDefaultMobileUiReleaseEnvironment(): MobileUiReleaseEnvironment {
  return {
    isVisible: () =>
      typeof document === "undefined" ? true : document.visibilityState === "visible",
    isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    subscribe(event, listener) {
      const target =
        event === "visibilitychange"
          ? typeof document === "undefined"
            ? undefined
            : document
          : typeof window === "undefined"
            ? undefined
            : window;
      if (!target || typeof target.addEventListener !== "function") {
        return () => {};
      }
      target.addEventListener(event, listener);
      return () => target.removeEventListener(event, listener);
    },
  };
}

export const DEFAULT_MOBILE_UI_RELEASE_SCHEDULER: MobileUiReleaseScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DEFAULT_MOBILE_UI_RELEASE_CLOCK: MobileUiReleaseClock = {
  now: () => Date.now(),
};

export function createDefaultMobileUiReleaseThrottleStore(): MobileUiReleaseThrottleStore {
  return {
    readLastAutoReloadAt() {
      try {
        const raw = globalThis.sessionStorage?.getItem(MOBILE_UI_RELEASE_AUTO_RELOAD_STORAGE_KEY);
        const value = raw === null || raw === undefined ? Number.NaN : Number(raw);
        return Number.isFinite(value) && value > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    },
    writeLastAutoReloadAt(epochMs) {
      try {
        globalThis.sessionStorage?.setItem(
          MOBILE_UI_RELEASE_AUTO_RELOAD_STORAGE_KEY,
          String(epochMs),
        );
      } catch {
        // 私有模式/存储被禁用时退化为进程内状态；不因存储异常阻断页面。
      }
    },
  };
}

export function isMobileRemotePrepareReloadResult(
  value: unknown,
): value is MobileRemotePrepareReloadResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "ready" || kind === "stale-session" || kind === "native-busy" || kind === "unsupported"
  );
}
