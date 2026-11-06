import type { MobileRemotePrepareReloadResult, MobileUiReleaseManifest } from "@zody/shared";
import type { MobileUiReleaseObservation } from "./mobileUiReleaseDto.js";
import {
  isMobileRemotePrepareReloadResult,
  type CandidateRelease,
  type DocumentReleaseRead,
  type MobileUiReleaseClock,
  type MobileUiReleaseControllerState,
  type MobileUiReleaseControllerStatus,
  type MobileUiReleaseEnvironment,
  type MobileUiReleaseLogger,
  type MobileUiReleaseTarget,
  type MobileUiReleaseThrottleStore,
  type MobileUiSafeReloadResult,
} from "./mobileUiReleaseControllerContracts.js";
import type {
  MobileUiRefreshBlockReason,
  MobileUiRefreshGuardRegistry,
} from "./mobileUiRefreshGuards.js";

/**
 * 刷新决策（spec 第 9.3、10、11 M3 节）。
 *
 * 顺序固定为：guard（未知阻塞）→ 重新 GET release 并复核目标/当前文档 → 自动限频
 * → native `prepareReload` veto → 再次求值 guard（等待期间新出现的文件保存等状态）
 * → 再次复核文档/目标 → reload。
 * 任一失败都保留当前文档；后台、pagehide、dispose 会让在途 apply 失效。
 */
export interface MobileUiReleaseApplyContext {
  state: MobileUiReleaseControllerState;
  clock: MobileUiReleaseClock;
  environment: MobileUiReleaseEnvironment;
  guards: MobileUiRefreshGuardRegistry;
  throttleStore: MobileUiReleaseThrottleStore;
  logger: MobileUiReleaseLogger;
  sessionId: string;
  bridgeVersion: number;
  confirmIntervalMs: number;
  autoReloadCooldownMs: number;
  getStatus(): MobileUiReleaseControllerStatus;
  setStatus(status: MobileUiReleaseControllerStatus): void;
  initializeBaseline(): "ok" | "missing" | "invalid";
  checkNow(reason: "manual"): Promise<void>;
  readDocumentReleaseId(): DocumentReleaseRead;
  fetchObservation(): Promise<MobileUiReleaseObservation>;
  prepareReload(
    sessionId: string,
    releaseId: string,
  ): MobileRemotePrepareReloadResult | Promise<MobileRemotePrepareReloadResult>;
  reload(target: MobileUiReleaseTarget): void;
  scheduleConfirmation(): void;
  clearConfirmTimer(): void;
}

function lifecycleGate(context: MobileUiReleaseApplyContext): MobileUiSafeReloadResult | undefined {
  const { state } = context;
  if (state.disposed) {
    return { kind: "disposed" };
  }
  if (state.suspended || !context.environment.isVisible() || !context.environment.isOnline()) {
    // 后台、页面隐藏或断网期间绝不 reload；候选目标保留，回前台/联网后重新确认。
    return { kind: "not-ready", status: context.getStatus() };
  }
  return undefined;
}

function setReadyStatus(
  context: MobileUiReleaseApplyContext,
  target: MobileUiReleaseTarget,
  extras: {
    blockedReasons?: readonly MobileUiRefreshBlockReason[];
    nativeVeto?: ReturnType<typeof getNativeVeto>;
    retryAt?: number;
  } = {},
): void {
  context.setStatus({
    kind: "ready",
    releaseId: target.releaseId,
    desktopVersion: target.manifest.desktopVersion,
    blockedReasons: extras.blockedReasons ?? [],
    ...(extras.nativeVeto ? { nativeVeto: extras.nativeVeto } : {}),
    ...(extras.retryAt === undefined ? {} : { retryAt: extras.retryAt }),
  });
}

function getNativeVeto(
  result: MobileRemotePrepareReloadResult,
): "stale-session" | "native-busy" | "unsupported" {
  return result.kind === "ready" ? "unsupported" : result.kind;
}

function isCompatible(manifest: MobileUiReleaseManifest, bridgeVersion: number): boolean {
  return manifest.supportedBridgeVersions.includes(bridgeVersion);
}

function blockByRefreshGuards(
  context: MobileUiReleaseApplyContext,
  target: MobileUiReleaseTarget,
  guardResult: ReturnType<MobileUiRefreshGuardRegistry["evaluate"]>,
): MobileUiSafeReloadResult {
  context.state.manualPending = false;
  setReadyStatus(context, target, { blockedReasons: guardResult.reasons });
  context.logger.info("mobile-ui reload blocked by refresh guard.", {
    reasons: [...guardResult.reasons],
    unknownGuardIds: [...guardResult.unknownGuardIds],
  });
  return { kind: "blocked", releaseId: target.releaseId, reasons: guardResult.reasons };
}

function documentReleased(
  context: MobileUiReleaseApplyContext,
  documentRelease: Exclude<DocumentReleaseRead, { kind: "invalid" | "missing" }>,
): MobileUiSafeReloadResult {
  const { state } = context;
  state.candidate = undefined;
  state.manualPending = false;
  context.clearConfirmTimer();
  if (documentRelease.releaseId === state.baselineReleaseId) {
    return { kind: "cancelled", reason: "release-changed" };
  }
  state.baselineReleaseId = documentRelease.releaseId;
  state.baselineInitialized = true;
  state.baselineInvalidReason = undefined;
  return { kind: "cancelled", reason: "document-changed" };
}

export async function performMobileUiReleaseApply(
  context: MobileUiReleaseApplyContext,
  mode: "auto" | "manual",
): Promise<MobileUiSafeReloadResult> {
  const { state, clock } = context;
  const lifecycle = lifecycleGate(context);
  if (lifecycle) {
    state.manualPending = false;
    return lifecycle;
  }

  const candidate = state.candidate;
  const target: MobileUiReleaseTarget | undefined = candidate
    ? { releaseId: candidate.releaseId, manifest: candidate.manifest }
    : undefined;
  if (!target || !candidate) {
    return { kind: "not-ready", status: context.getStatus() };
  }
  if (clock.now() - candidate.firstSeenAt < context.confirmIntervalMs) {
    context.scheduleConfirmation();
    const confirmAt = candidate.firstSeenAt + context.confirmIntervalMs;
    context.setStatus({
      kind: "pending-confirmation",
      releaseId: candidate.releaseId,
      firstSeenAt: candidate.firstSeenAt,
      confirmAt,
    });
    return { kind: "pending-confirmation", releaseId: target.releaseId, confirmAt };
  }

  const token = ++state.applyToken;

  const guardResult = context.guards.evaluate();
  if (!guardResult.allowed) {
    return blockByRefreshGuards(context, target, guardResult);
  }

  // 刷新前重新请求 release：目标必须仍是待刷新 release，且不能与当前文档混淆。
  const observation = await context.fetchObservation();
  const afterFetch = lifecycleGate(context);
  if (afterFetch) {
    state.manualPending = false;
    return afterFetch;
  }
  if (token !== state.applyToken) {
    return { kind: "cancelled", reason: "release-changed" };
  }
  if (observation.kind === "failed") {
    state.manualPending = false;
    context.setStatus({
      kind: "check-failed",
      reason: observation.reason,
      ...(observation.status === undefined ? {} : { status: observation.status }),
    });
    return { kind: "failed", reason: observation.reason };
  }

  const fresh = observation.manifest;
  if (!isCompatible(fresh, context.bridgeVersion)) {
    state.candidate = undefined;
    state.manualPending = false;
    context.clearConfirmTimer();
    context.setStatus({
      kind: "incompatible",
      releaseId: fresh.releaseId,
      supportedBridgeVersions: fresh.supportedBridgeVersions,
    });
    return {
      kind: "incompatible",
      releaseId: fresh.releaseId,
      supportedBridgeVersions: fresh.supportedBridgeVersions,
    };
  }
  if (fresh.releaseId === state.baselineReleaseId) {
    // 服务端回滚到当前文档对应 release；取消待刷新目标。
    state.candidate = undefined;
    state.manualPending = false;
    context.clearConfirmTimer();
    context.setStatus({ kind: "up-to-date", checkedAt: clock.now() });
    return { kind: "cancelled", reason: "up-to-date" };
  }
  if (fresh.releaseId !== target.releaseId) {
    // 刷新前目标已变化：丢弃旧目标，按新的 releaseId 重新进入 5 秒确认。
    const nextCandidate: CandidateRelease = {
      releaseId: fresh.releaseId,
      manifest: fresh,
      firstSeenAt: clock.now(),
    };
    state.candidate = nextCandidate;
    context.scheduleConfirmation();
    const confirmAt = nextCandidate.firstSeenAt + context.confirmIntervalMs;
    context.setStatus({
      kind: "pending-confirmation",
      releaseId: fresh.releaseId,
      firstSeenAt: nextCandidate.firstSeenAt,
      confirmAt,
    });
    return { kind: "pending-confirmation", releaseId: fresh.releaseId, confirmAt };
  }
  state.candidate = { ...target, firstSeenAt: candidate.firstSeenAt };

  const documentBeforeNative = context.readDocumentReleaseId();
  if (
    documentBeforeNative.kind !== "valid" ||
    documentBeforeNative.releaseId !== state.baselineReleaseId
  ) {
    if (documentBeforeNative.kind !== "valid") {
      state.candidate = undefined;
      state.manualPending = false;
      context.clearConfirmTimer();
      state.baselineInvalidReason = documentBeforeNative.kind;
      context.setStatus({
        kind: "invalid-baseline",
        reason: documentBeforeNative.kind,
      });
      return { kind: "invalid-baseline", reason: documentBeforeNative.kind };
    }
    if (documentBeforeNative.releaseId === target.releaseId) {
      state.candidate = undefined;
      state.manualPending = false;
      context.clearConfirmTimer();
      context.setStatus({ kind: "up-to-date", checkedAt: clock.now() });
      return { kind: "cancelled", reason: "up-to-date" };
    }
    return documentReleased(context, documentBeforeNative);
  }

  const autoReloadCheck = (): MobileUiSafeReloadResult | undefined => {
    if (mode !== "auto") {
      return undefined;
    }
    const lastAutoReloadAt = context.throttleStore.readLastAutoReloadAt();
    if (
      lastAutoReloadAt !== undefined &&
      clock.now() - lastAutoReloadAt < context.autoReloadCooldownMs
    ) {
      const retryAt = lastAutoReloadAt + context.autoReloadCooldownMs;
      setReadyStatus(context, target, { retryAt });
      return { kind: "throttled", releaseId: target.releaseId, retryAt };
    }
    return undefined;
  };

  const throttledBeforeNative = autoReloadCheck();
  if (throttledBeforeNative) {
    return throttledBeforeNative;
  }

  let nativeResult: MobileRemotePrepareReloadResult;
  try {
    const raw = await context.prepareReload(context.sessionId, target.releaseId);
    nativeResult = isMobileRemotePrepareReloadResult(raw) ? raw : { kind: "unsupported" };
  } catch {
    nativeResult = { kind: "unsupported" };
  }
  const afterNative = lifecycleGate(context);
  if (afterNative) {
    state.manualPending = false;
    return afterNative;
  }
  if (token !== state.applyToken) {
    return { kind: "cancelled", reason: "release-changed" };
  }
  if (nativeResult.kind !== "ready") {
    state.manualPending = false;
    setReadyStatus(context, target, { nativeVeto: getNativeVeto(nativeResult) });
    context.logger.info("mobile-ui reload vetoed by native bridge.", {
      releaseId: target.releaseId,
      veto: nativeResult.kind,
    });
    return {
      kind: "blocked",
      releaseId: target.releaseId,
      reasons: [],
      nativeVeto: nativeResult.kind,
    };
  }

  // fetchObservation/prepareReload 是异步等待窗口：文件保存等 guard 可能刚在此间开始。
  // 第一次 guard 结果已经过期，reload 前必须重新求值，不能只信 native ready。
  const guardResultAfterAsync = context.guards.evaluate();
  if (!guardResultAfterAsync.allowed) {
    return blockByRefreshGuards(context, target, guardResultAfterAsync);
  }

  // prepareReload 可能跨过 generation/session 变化；reload 前再次复核文档与目标。
  if (!state.candidate || state.candidate.releaseId !== target.releaseId) {
    return { kind: "cancelled", reason: "release-changed" };
  }
  const documentAtReload = context.readDocumentReleaseId();
  if (documentAtReload.kind !== "valid" || documentAtReload.releaseId !== state.baselineReleaseId) {
    if (documentAtReload.kind !== "valid") {
      state.candidate = undefined;
      state.manualPending = false;
      context.clearConfirmTimer();
      state.baselineInvalidReason = documentAtReload.kind;
      context.setStatus({
        kind: "invalid-baseline",
        reason: documentAtReload.kind,
      });
      return { kind: "invalid-baseline", reason: documentAtReload.kind };
    }
    if (documentAtReload.releaseId === target.releaseId) {
      state.candidate = undefined;
      state.manualPending = false;
      context.clearConfirmTimer();
      context.setStatus({ kind: "up-to-date", checkedAt: clock.now() });
      return { kind: "cancelled", reason: "up-to-date" };
    }
    return documentReleased(context, documentAtReload);
  }

  const throttledAtReload = autoReloadCheck();
  if (throttledAtReload) {
    return throttledAtReload;
  }
  if (mode === "auto") {
    context.throttleStore.writeLastAutoReloadAt(clock.now());
  }

  state.manualPending = false;
  state.candidate = undefined;
  context.clearConfirmTimer();
  context.setStatus({
    kind: "reloading",
    releaseId: target.releaseId,
    manual: mode === "manual",
  });
  try {
    context.reload(target);
  } catch (error) {
    context.logger.error("mobile-ui reload failed to start.", {
      releaseId: target.releaseId,
      error: error instanceof Error ? error.message : String(error),
    });
    // reload 未真正开始时恢复候选，避免一次同步异常永久丢失待刷新目标。
    state.candidate = { ...target, firstSeenAt: candidate.firstSeenAt };
    setReadyStatus(context, target);
    return { kind: "not-ready", status: context.getStatus() };
  }
  return { kind: "reloaded", releaseId: target.releaseId };
}

/**
 * 手动“安全刷新”。与自动路径使用同一 apply；不绕过 guard、5 秒确认或 native veto。
 * 手动点击不消耗自动限频额度，但仍必须在可见、在线且文档基线有效时执行。
 */
export async function requestMobileUiSafeReload(
  context: MobileUiReleaseApplyContext,
): Promise<MobileUiSafeReloadResult> {
  const { state } = context;
  if (state.disposed) {
    return { kind: "disposed" };
  }
  const baseline = context.initializeBaseline();
  if (baseline !== "ok") {
    return { kind: "invalid-baseline", reason: baseline };
  }
  if (state.suspended || !context.environment.isVisible() || !context.environment.isOnline()) {
    return { kind: "not-ready", status: context.getStatus() };
  }

  state.manualPending = true;
  if (state.activeCheck) {
    await state.activeCheck;
  }
  if (state.disposed) {
    state.manualPending = false;
    return { kind: "disposed" };
  }
  if (!state.candidate) {
    // 手动刷新不绕过二次确认：先按同一路径观察一次。
    await context.checkNow("manual");
  }
  if (!state.candidate) {
    state.manualPending = false;
    return { kind: "not-ready", status: context.getStatus() };
  }
  if (context.clock.now() - state.candidate.firstSeenAt < context.confirmIntervalMs) {
    const confirmAt = state.candidate.firstSeenAt + context.confirmIntervalMs;
    context.scheduleConfirmation();
    context.setStatus({
      kind: "pending-confirmation",
      releaseId: state.candidate.releaseId,
      firstSeenAt: state.candidate.firstSeenAt,
      confirmAt,
    });
    return {
      kind: "pending-confirmation",
      releaseId: state.candidate.releaseId,
      confirmAt,
    };
  }
  return performMobileUiReleaseApply(context, "manual");
}
