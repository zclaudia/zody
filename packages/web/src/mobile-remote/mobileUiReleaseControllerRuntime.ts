import { MOBILE_UI_RELEASE_ID_PATTERN } from "@zody/shared";
import {
  readMobileUiReleaseMetaReleaseId,
  type MobileUiReleaseObservation,
} from "./mobileUiReleaseDto.js";
import {
  performMobileUiReleaseApply,
  requestMobileUiSafeReload,
  type MobileUiReleaseApplyContext,
} from "./mobileUiReleaseControllerApply.js";
import {
  DEFAULT_MOBILE_UI_RELEASE_CLOCK,
  DEFAULT_MOBILE_UI_RELEASE_SCHEDULER,
  MOBILE_UI_RELEASE_AUTO_RELOAD_COOLDOWN_MS,
  MOBILE_UI_RELEASE_CONFIRM_INTERVAL_MS,
  MOBILE_UI_RELEASE_NOOP_LOGGER,
  MOBILE_UI_RELEASE_POLL_INTERVAL_MS,
  createDefaultMobileUiReleaseEnvironment,
  createDefaultMobileUiReleaseThrottleStore,
  type DocumentReleaseRead,
  type MobileUiReleaseCheckReason,
  type MobileUiReleaseController,
  type MobileUiReleaseControllerOptions,
  type MobileUiReleaseControllerState,
  type MobileUiReleaseControllerStatus,
  type MobileUiSafeReloadResult,
} from "./mobileUiReleaseControllerContracts.js";
import type { MobileUiRefreshGuardRegistry } from "./mobileUiRefreshGuards.js";

/**
 * 控制器运行时：前台 60s 轮询、回前台/联网/业务重连立即检查、后台/pagehide/dispose
 * 停止并使在途响应失效。刷新决策委托给 `mobileUiReleaseControllerApply.ts`，避免
 * 生命周期代码和 guard/native 判断互相复制。
 */
export function createMobileUiReleaseRuntime(
  options: MobileUiReleaseControllerOptions,
  state: MobileUiReleaseControllerState,
  guards: MobileUiRefreshGuardRegistry,
): MobileUiReleaseController {
  const logger = options.logger ?? MOBILE_UI_RELEASE_NOOP_LOGGER;
  const clock = options.clock ?? DEFAULT_MOBILE_UI_RELEASE_CLOCK;
  const scheduler = options.scheduler ?? DEFAULT_MOBILE_UI_RELEASE_SCHEDULER;
  const environment = options.environment ?? createDefaultMobileUiReleaseEnvironment();
  const throttleStore = options.throttleStore ?? createDefaultMobileUiReleaseThrottleStore();
  const pollIntervalMs = options.pollIntervalMs ?? MOBILE_UI_RELEASE_POLL_INTERVAL_MS;
  const confirmIntervalMs = options.confirmIntervalMs ?? MOBILE_UI_RELEASE_CONFIRM_INTERVAL_MS;
  const autoReloadCooldownMs =
    options.autoReloadCooldownMs ?? MOBILE_UI_RELEASE_AUTO_RELOAD_COOLDOWN_MS;
  const readCurrentReleaseId =
    options.readCurrentReleaseId ?? (() => readMobileUiReleaseMetaReleaseId());

  const listeners = new Set<(status: MobileUiReleaseControllerStatus) => void>();
  const unsubscribers: Array<() => void> = [];
  let status: MobileUiReleaseControllerStatus = { kind: "idle" };

  function setStatus(next: MobileUiReleaseControllerStatus): void {
    status = next;
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // UI 订阅者的异常不能中断发布检测/刷新决策。
      }
    }
  }

  function readDocumentReleaseId(): DocumentReleaseRead {
    let raw: string | undefined;
    try {
      raw = readCurrentReleaseId();
    } catch {
      raw = undefined;
    }
    const value = raw?.trim();
    if (!value) {
      return { kind: "missing" };
    }
    return MOBILE_UI_RELEASE_ID_PATTERN.test(value)
      ? { kind: "valid", releaseId: value }
      : { kind: "invalid" };
  }

  function initializeBaseline(): "ok" | "missing" | "invalid" {
    if (state.baselineInitialized) {
      return state.baselineInvalidReason ?? "ok";
    }
    state.baselineInitialized = true;
    const documentRelease = readDocumentReleaseId();
    if (documentRelease.kind === "valid") {
      state.baselineReleaseId = documentRelease.releaseId;
      state.baselineInvalidReason = undefined;
      return "ok";
    }
    state.baselineReleaseId = undefined;
    state.baselineInvalidReason = documentRelease.kind;
    setStatus({ kind: "invalid-baseline", reason: documentRelease.kind });
    logger.warn("mobile-ui release baseline is invalid; auto reload disabled.", {
      reason: documentRelease.kind,
    });
    return documentRelease.kind;
  }

  function clearPollTimer(): void {
    if (state.pollTimer !== undefined) {
      scheduler.clearTimeout(state.pollTimer);
      state.pollTimer = undefined;
    }
  }

  function clearConfirmTimer(): void {
    if (state.confirmTimer !== undefined) {
      scheduler.clearTimeout(state.confirmTimer);
      state.confirmTimer = undefined;
    }
  }

  function invalidateInFlight(): void {
    state.checkGeneration += 1;
    state.queuedCheckReason = undefined;
  }

  function suspend(): void {
    if (state.disposed) {
      return;
    }
    state.suspended = true;
    state.manualPending = false;
    clearPollTimer();
    clearConfirmTimer();
    invalidateInFlight();
    // 后台/页面隐藏后，已经在途的 apply 不得继续调用 reload。
    state.applyToken += 1;
  }

  function isPaused(): boolean {
    return state.disposed || state.suspended || !environment.isVisible() || !environment.isOnline();
  }

  function schedulePoll(): void {
    if (state.disposed || !state.started || state.suspended) {
      return;
    }
    if (!environment.isVisible() || !environment.isOnline() || state.baselineInvalidReason) {
      return;
    }
    clearPollTimer();
    state.pollTimer = scheduler.setTimeout(() => {
      state.pollTimer = undefined;
      void checkNow("poll").finally(() => {
        // 前一次检查结束（无论成功/失败）后继续前台轮询；事件检查会重置本计时器。
        schedulePoll();
      });
    }, pollIntervalMs);
  }

  function scheduleConfirmation(): void {
    clearConfirmTimer();
    if (!state.candidate || state.disposed || state.suspended) {
      return;
    }
    const confirmAt = state.candidate.firstSeenAt + confirmIntervalMs;
    const delay = Math.max(0, confirmAt - clock.now());
    state.confirmTimer = scheduler.setTimeout(() => {
      state.confirmTimer = undefined;
      void checkNow("poll");
    }, delay);
  }

  async function fetchObservation(): Promise<MobileUiReleaseObservation> {
    try {
      return await options.fetchRelease();
    } catch {
      return { kind: "failed", reason: "network-error" };
    }
  }

  const applyContext: MobileUiReleaseApplyContext = {
    state,
    clock,
    environment,
    guards,
    throttleStore,
    logger,
    sessionId: options.sessionId,
    bridgeVersion: options.bridgeVersion,
    confirmIntervalMs,
    autoReloadCooldownMs,
    getStatus: () => status,
    setStatus,
    initializeBaseline,
    checkNow,
    readDocumentReleaseId,
    fetchObservation,
    prepareReload: options.prepareReload,
    reload: options.reload,
    scheduleConfirmation,
    clearConfirmTimer,
  };

  async function runCheck(reason: MobileUiReleaseCheckReason): Promise<void> {
    if (state.disposed || isPaused()) {
      return;
    }
    if (initializeBaseline() !== "ok") {
      return;
    }

    const generation = state.checkGeneration;
    setStatus({ kind: "checking", reason });
    const observation = await fetchObservation();
    if (
      state.disposed ||
      generation !== state.checkGeneration ||
      state.suspended ||
      !environment.isVisible() ||
      !environment.isOnline()
    ) {
      logger.debug("mobile-ui release response discarded after lifecycle change.", { reason });
      return;
    }

    if (observation.kind === "failed") {
      setStatus({
        kind: "check-failed",
        reason: observation.reason,
        ...(observation.status === undefined ? {} : { status: observation.status }),
      });
      logger.warn("mobile-ui release check failed; keeping current document.", {
        reason: observation.reason,
        status: observation.status,
      });
      return;
    }

    const manifest = observation.manifest;
    if (!manifest.supportedBridgeVersions.includes(options.bridgeVersion)) {
      state.candidate = undefined;
      state.manualPending = false;
      clearConfirmTimer();
      setStatus({
        kind: "incompatible",
        releaseId: manifest.releaseId,
        supportedBridgeVersions: manifest.supportedBridgeVersions,
      });
      return;
    }

    if (manifest.releaseId === state.baselineReleaseId) {
      state.candidate = undefined;
      state.manualPending = false;
      clearConfirmTimer();
      setStatus({ kind: "up-to-date", checkedAt: clock.now() });
      return;
    }

    const existing = state.candidate;
    if (existing && existing.releaseId === manifest.releaseId) {
      state.candidate = { ...existing, manifest };
    } else {
      state.candidate = {
        releaseId: manifest.releaseId,
        manifest,
        firstSeenAt: clock.now(),
      };
      clearConfirmTimer();
    }

    const current = state.candidate;
    const elapsed = clock.now() - current.firstSeenAt;
    if (elapsed < confirmIntervalMs) {
      scheduleConfirmation();
      setStatus({
        kind: "pending-confirmation",
        releaseId: current.releaseId,
        firstSeenAt: current.firstSeenAt,
        confirmAt: current.firstSeenAt + confirmIntervalMs,
      });
      return;
    }

    await performMobileUiReleaseApply(applyContext, state.manualPending ? "manual" : "auto");
  }

  function checkNow(reason: MobileUiReleaseCheckReason = "manual"): Promise<void> {
    if (state.disposed || isPaused()) {
      return Promise.resolve();
    }
    if (state.activeCheck) {
      state.queuedCheckReason = reason;
      return state.activeCheck.then(() => {
        const queued = state.queuedCheckReason;
        state.queuedCheckReason = undefined;
        return queued ? checkNow(queued) : undefined;
      });
    }
    const task = runCheck(reason).finally(() => {
      if (state.activeCheck === task) {
        state.activeCheck = undefined;
      }
    });
    state.activeCheck = task;
    return task;
  }

  function requestSafeReload(): Promise<MobileUiSafeReloadResult> {
    return requestMobileUiSafeReload(applyContext);
  }

  function start(): void {
    if (state.started || state.disposed) {
      return;
    }
    state.started = true;
    initializeBaseline();
    unsubscribers.push(
      environment.subscribe("visibilitychange", () => {
        if (environment.isVisible()) {
          state.suspended = false;
          void checkNow("visible");
          schedulePoll();
        } else {
          suspend();
        }
      }),
      environment.subscribe("pagehide", () => {
        suspend();
      }),
      environment.subscribe("pageshow", () => {
        if (environment.isVisible()) {
          state.suspended = false;
          void checkNow("pageshow");
          schedulePoll();
        }
      }),
      environment.subscribe("online", () => {
        if (environment.isVisible()) {
          state.suspended = false;
          void checkNow("online");
          schedulePoll();
        }
      }),
      environment.subscribe("offline", () => {
        state.manualPending = false;
        clearPollTimer();
        clearConfirmTimer();
        invalidateInFlight();
        state.applyToken += 1;
      }),
    );
    if (environment.isVisible() && environment.isOnline()) {
      schedulePoll();
    }
  }

  function dispose(): void {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    state.suspended = true;
    state.manualPending = false;
    clearPollTimer();
    clearConfirmTimer();
    invalidateInFlight();
    state.applyToken += 1;
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 宿主事件目标已被销毁时忽略。
      }
    }
    setStatus({ kind: "disposed" });
    listeners.clear();
  }

  function notifyBusinessReconnect(): void {
    void checkNow("business-reconnect").finally(() => state.started && schedulePoll());
  }

  return {
    guards,
    start,
    dispose,
    checkNow,
    notifyBusinessReconnect,
    requestSafeReload,
    getStatus: () => status,
    subscribe(listener) {
      if (state.disposed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
