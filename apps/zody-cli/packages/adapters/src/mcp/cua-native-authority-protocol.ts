import { handleObservationFrame } from "./cua-native-authority-observation.js";
import type { CuaSubmissionRevocationResult, CuaSubmissionTurnScope } from "@zody/contracts";
import {
  type CuaNativeAuthorityCloseReason,
  type CuaNativeAuthorityCaptureOptions,
  type CuaNativeObservationOptions,
  type CuaNativeAuthorityRevokeOutcome,
  type CuaNativeConfirmRequestOutcome,
  type CuaNativeConfirmRequestPayload,
  isBoundedString,
  parseCuaNativeAuthorityRequest,
  readCuaNativeConfirmRequestPayload,
  readCuaSubmissionRef,
  sameCuaSubmissionRef,
} from "./cua-native-authority-contract.js";
import {
  hasCuaNativeCaptureImage,
  parseCuaNativeCaptureResult,
  readCuaNativeCaptureFile,
} from "./cua-native-authority-capture.js";
import {
  UNKNOWN_CUA_SUBMISSION_PROJECTION,
  UNKNOWN_CUA_SUBMISSION_REVOCATION,
  isRealRevocationForScope,
  withTimeout,
} from "./cua-native-authority-facts.js";

/** 已受理 confirm generation 的有界记录上限；超过后淘汰最旧（每连接一张图，正常远达不到）。 */
const CONFIRM_SEEN_GENERATIONS_LIMIT = 64;

export interface CuaNativeAuthorityProtocolState {
  bootstrapStarted: boolean;
  bootstrapped: boolean;
  captureResultStarted: boolean;
  observationResultStarted: boolean;
  controlTarget?: { pid: number; windowId: number };
  controlConfirmSeen?: boolean;
  leaseWatch?: boolean;
  readTarget?: { pid: number; windowId: number };
  captureResultAccepted: boolean;
  invalidated: boolean;
  ownerRevoked: boolean;
  ownerFactSent: boolean;
  ownRevokeInFlight: boolean;
  revokeFlow: boolean;
  remoteCloseRequested: boolean;
  closed: boolean;
  lastFailure: string | null;
  authorityRevoke: CuaNativeAuthorityRevokeOutcome;
  /** 已见 confirm generation（进程内单调，同 ConfirmationState）；重复值不二次打扰用户。 */
  confirmSeenGenerations: Set<number>;
  lastRevocation?: CuaSubmissionRevocationResult;
  ownerRevocationTask?: Promise<void>;
}

export interface CuaNativeAuthorityProtocolContext {
  readonly scope: CuaSubmissionTurnScope;
  readonly producerIncarnation: string;
  readonly capture?: CuaNativeAuthorityCaptureOptions;
  readonly observation?: CuaNativeObservationOptions;
  readonly confirmControlRequest?: (
    payload: CuaNativeConfirmRequestPayload,
  ) => Promise<CuaNativeConfirmRequestOutcome>;
  readonly confirmReadRequest?: (
    payload: CuaNativeConfirmRequestPayload,
  ) => Promise<CuaNativeConfirmRequestOutcome>;
  /** App 内确认弹窗回调；与 capture 图像选项并列的会话级交互入口。 */
  readonly confirmRequest?: (
    payload: CuaNativeConfirmRequestPayload,
  ) => Promise<CuaNativeConfirmRequestOutcome>;
  readonly requestTimeoutMs: number;
  readonly state: CuaNativeAuthorityProtocolState;
  isLive(): boolean;
  write(frame: { requestId: string; method: string; result: unknown }): boolean;
  reject(requestId: string, method: string, reason: string): void;
  protocolFailure(reason: string): void;
  finish(reason: CuaNativeAuthorityCloseReason, graceful: boolean): void;
}

export async function handleCuaNativeAuthorityLine(
  line: string,
  ctx: CuaNativeAuthorityProtocolContext,
): Promise<void> {
  if (ctx.state.closed) return;
  const parsed = parseCuaNativeAuthorityRequest(line);
  if (!parsed.ok) {
    if (parsed.requestId !== undefined) {
      ctx.reject(parsed.requestId, parsed.method ?? "error", parsed.reason);
    }
    // 协议失败必须走 session 的唯一 control-lost 撤销路径；不能只做 normal scope close。
    ctx.protocolFailure(parsed.reason);
    return;
  }
  const frame = parsed.frame;
  if (ctx.state.leaseWatch && frame.method !== "revoke" && frame.method !== "close") {
    ctx.reject(frame.requestId, frame.method, "lease-watch-only");
    return;
  }
  if (ctx.state.invalidated) {
    // owner 事实已经锁存后只允许仍能返回真实回执的 revoke/close；晚到截图明确拒绝，不复活 scope。
    if (frame.method === "captureResult") {
      ctx.reject(frame.requestId, frame.method, "scope_invalidated");
    } else if (frame.method === "confirm") {
      // 晚到的确认同样不复活 scope：不发起用户请求，也不产出 allowed 事实。
      ctx.reject(frame.requestId, frame.method, "scope_invalidated");
    } else if (frame.method === "revoke") await handleRevoke(ctx, frame, true);
    else if (frame.method === "close") handleClose(ctx, frame);
    return;
  }
  if (
    frame.method === "confirmRead" ||
    frame.method === "confirmControl" ||
    frame.method === "controlResult" ||
    frame.method === "observationResult"
  ) {
    await handleObservationFrame(ctx, frame);
    return;
  }
  if (frame.method === "bootstrap") await handleBootstrap(ctx, frame);
  else if (frame.method === "check") await handleCheck(ctx, frame);
  else if (frame.method === "captureResult") await handleCaptureResult(ctx, frame);
  else if (frame.method === "confirm") await handleConfirm(ctx, frame);
  else if (frame.method === "revoke") await handleRevoke(ctx, frame, false);
  else handleClose(ctx, frame);
}

async function handleBootstrap(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: { requestId: string; method: string; payload: Record<string, unknown> },
): Promise<void> {
  if (ctx.state.bootstrapStarted) {
    ctx.reject(frame.requestId, frame.method, "duplicate_bootstrap");
    return;
  }
  if (!ctx.capture) {
    if (Object.keys(frame.payload).length > 0) {
      // 无 capture composition 时 bootstrap 仍必须是空 payload；调用方不能注入身份。
      ctx.reject(frame.requestId, frame.method, "invalid_payload");
      return;
    }
  } else if (Object.keys(frame.payload).length !== 0) {
    // target 由本次真实截图调用在 CLI 侧显式给出；native 初始只发空 bootstrap。
    ctx.reject(frame.requestId, frame.method, "invalid_payload");
    return;
  }
  ctx.state.bootstrapStarted = true;
  if (!ctx.scope.bindProducer(ctx.producerIncarnation)) {
    ctx.reject(frame.requestId, frame.method, "bind_failed");
    return;
  }
  const projection = await withTimeout(
    ctx.scope.producerPort.resolve({ ref: ctx.scope.ref }),
    ctx.requestTimeoutMs,
    UNKNOWN_CUA_SUBMISSION_PROJECTION,
  );
  if (ctx.state.invalidated || ctx.state.closed) return;
  if (projection.status !== "candidate" || !sameCuaSubmissionRef(projection.ref, ctx.scope.ref)) {
    ctx.reject(frame.requestId, frame.method, "not_candidate");
    return;
  }
  ctx.state.bootstrapped = true;
  ctx.write({
    requestId: frame.requestId,
    method: frame.method,
    result: {
      ok: true,
      traceId: ctx.scope.traceId,
      ref: ctx.scope.ref,
      producerIncarnation: ctx.producerIncarnation,
      runId: ctx.scope.runId,
      turnId: ctx.scope.turnId,
      ...(ctx.capture ? { target: ctx.capture.target, ...ctx.capture.association } : {}),
      ...(ctx.observation
        ? { observation: ctx.observation.request, ...ctx.observation.association }
        : {}),
      projection,
    },
  });
}

async function handleCaptureResult(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: { requestId: string; method: string; payload: Record<string, unknown> },
): Promise<void> {
  if (!ctx.state.bootstrapped) {
    rejectCapture(ctx, frame, "not_bootstrapped");
    return;
  }
  if (!ctx.capture) {
    rejectCapture(ctx, frame, "capture_not_configured");
    return;
  }
  if (ctx.state.captureResultStarted) {
    rejectCapture(ctx, frame, "capture_result_consumed");
    return;
  }
  ctx.state.captureResultStarted = true;
  if (!ctx.isLive()) {
    rejectCapture(ctx, frame, "scope_invalidated");
    return;
  }
  const parsed = parseCuaNativeCaptureResult(frame.payload, {
    scope: ctx.scope,
    producerIncarnation: ctx.producerIncarnation,
    target: ctx.capture.target,
    ...(ctx.capture.association ? { association: ctx.capture.association } : {}),
  });
  if (!parsed.ok) {
    rejectCapture(ctx, frame, parsed.reason);
    return;
  }
  let verified;
  try {
    verified = await readCuaNativeCaptureFile({
      capture: ctx.capture,
      payload: parsed.payload,
      isLive: () => ctx.isLive(),
    });
  } catch {
    if (!ctx.state.invalidated && !ctx.state.closed) {
      rejectCapture(ctx, frame, "capture_file_read_failed");
    }
    return;
  }
  if (!verified.ok) {
    if (ctx.state.invalidated || ctx.state.closed) return;
    rejectCapture(ctx, frame, verified.reason);
    return;
  }
  if (!ctx.isLive()) return;
  let result;
  try {
    result = await ctx.capture.accept(verified.payload, verified.bytes);
  } catch {
    if (!ctx.state.invalidated && !ctx.state.closed) {
      rejectCapture(ctx, frame, "capture_delivery_failed");
    }
    return;
  }
  if (!ctx.isLive()) return;
  if (!hasCuaNativeCaptureImage(result)) {
    rejectCapture(ctx, frame, "capture_delivery_invalid");
    return;
  }
  ctx.state.captureResultAccepted = true;
  const written = ctx.write({
    requestId: frame.requestId,
    method: frame.method,
    result: { ok: true, accepted: true },
  });
  if (!written) return;
  try {
    ctx.capture.onAccepted?.();
  } catch {
    // 确认回调只控制组合等待，不改变已写出的 authority 事实。
  }
  // 每连接一张图：交付后正常结束本次 consumer，不撤销仍有效的 lineage。
  ctx.finish("adapter-close", true);
}

function rejectCapture(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: { requestId: string; method: string },
  reason: string,
): void {
  ctx.reject(frame.requestId, frame.method, reason);
  try {
    ctx.capture?.onRejected?.(reason);
  } catch {
    // 观测回调不能改变 authority 的真实拒绝结果。
  }
}

async function handleCheck(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: { requestId: string; method: string; payload: Record<string, unknown> },
): Promise<void> {
  if (!ctx.state.bootstrapped) {
    ctx.reject(frame.requestId, frame.method, "not_bootstrapped");
    return;
  }
  const ref = readCuaSubmissionRef(frame.payload.ref);
  if (!ref) {
    ctx.reject(frame.requestId, frame.method, "invalid_ref");
    return;
  }
  if (frame.payload.traceId !== ctx.scope.traceId) {
    ctx.reject(frame.requestId, frame.method, "trace_mismatch");
    return;
  }
  if (!sameCuaSubmissionRef(ref, ctx.scope.ref)) {
    ctx.reject(frame.requestId, frame.method, "ref_mismatch");
    return;
  }
  // check 必须携带完整 producer/run/turn；只有 revoke 沿用 R11 的 {traceId, ref} 兼容形态。
  if (
    frame.payload.producerIncarnation !== ctx.producerIncarnation ||
    frame.payload.runId !== ctx.scope.runId ||
    frame.payload.turnId !== ctx.scope.turnId ||
    frame.payload.workspaceIdentity !==
      (ctx.observation?.association ?? ctx.capture?.association)?.workspaceIdentity ||
    frame.payload.remoteSessionId !==
      (ctx.observation?.association ?? ctx.capture?.association)?.remoteSessionId
  ) {
    ctx.reject(frame.requestId, frame.method, "association_mismatch");
    return;
  }
  const projection = await withTimeout(
    ctx.scope.producerPort.resolve({ ref }),
    ctx.requestTimeoutMs,
    UNKNOWN_CUA_SUBMISSION_PROJECTION,
  );
  // await 之后必须重核失效状态与当前投影，晚到 candidate 不能重新放行。
  if (ctx.state.invalidated || ctx.state.closed) return;
  if (projection.status !== "candidate" || !sameCuaSubmissionRef(projection.ref, ctx.scope.ref)) {
    ctx.reject(frame.requestId, frame.method, "not_candidate");
    return;
  }
  ctx.write({
    requestId: frame.requestId,
    method: frame.method,
    result: {
      ok: true,
      traceId: ctx.scope.traceId,
      ref: ctx.scope.ref,
      producerIncarnation: ctx.producerIncarnation,
      runId: ctx.scope.runId,
      turnId: ctx.scope.turnId,
      ...(ctx.observation?.association ?? ctx.capture?.association),
      projection,
    },
  });
}

/**
 * App 内确认弹窗（替代 Helper 原生 NSAlert，spec 2026-10-31）：Helper 在截图前发
 * confirm 帧，CLI 经 confirmRequest 发起一次用户交互并把决定原样写回。校验风格对齐
 * handleCheck：关联字段必须与 scope 完全匹配，generation 必须是未见过的正整数。
 */
async function handleConfirm(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: { requestId: string; method: string; payload: Record<string, unknown> },
): Promise<void> {
  if (!ctx.state.bootstrapped) {
    ctx.reject(frame.requestId, frame.method, "not_bootstrapped");
    return;
  }
  const payload = readCuaNativeConfirmRequestPayload(frame.payload);
  const ref = payload ? readCuaSubmissionRef(frame.payload.ref) : undefined;
  if (
    !payload ||
    !ref ||
    frame.payload.traceId !== ctx.scope.traceId ||
    !sameCuaSubmissionRef(ref, ctx.scope.ref) ||
    frame.payload.producerIncarnation !== ctx.producerIncarnation ||
    frame.payload.runId !== ctx.scope.runId ||
    frame.payload.turnId !== ctx.scope.turnId ||
    frame.payload.workspaceIdentity !==
      (ctx.observation?.association ?? ctx.capture?.association)?.workspaceIdentity ||
    frame.payload.remoteSessionId !==
      (ctx.observation?.association ?? ctx.capture?.association)?.remoteSessionId
  ) {
    ctx.reject(frame.requestId, frame.method, "confirmation-invalid");
    return;
  }
  if (!ctx.capture || !ctx.confirmRequest) {
    ctx.reject(frame.requestId, frame.method, "confirmation-unavailable");
    return;
  }
  if (ctx.state.confirmSeenGenerations.has(payload.generation)) {
    // 同 generation 只打扰用户一次；重复帧按幂等拒绝，不二次发起弹窗。
    ctx.reject(frame.requestId, frame.method, "confirmation-duplicate");
    return;
  }
  recordSeenConfirmGeneration(ctx.state, payload.generation);
  let outcome: CuaNativeConfirmRequestOutcome;
  try {
    outcome = await ctx.confirmRequest({ generation: payload.generation, target: payload.target });
  } catch {
    // 会话仍 live 时才写失败回执；invalidated/closed 或 signal abort 时不写——
    // 连接关闭中，Helper 靠 EOF 收口。
    if (!ctx.state.invalidated && !ctx.state.closed) {
      ctx.reject(frame.requestId, frame.method, "confirmation-failed");
    }
    return;
  }
  if (ctx.state.invalidated || ctx.state.closed) return;
  // CLI 侧拒绝/失败必须保留固定 reason 写成 ok:false，不能被压平成 allowed:false：
  // Helper 对 ok:false 走 app-confirm-failed 审计桶，与用户拒绝分账。
  if ("ok" in outcome) {
    ctx.reject(frame.requestId, frame.method, outcome.reason);
    return;
  }
  ctx.write({
    requestId: frame.requestId,
    method: frame.method,
    result: { ok: true, allowed: outcome.allowed === true },
  });
}

function recordSeenConfirmGeneration(
  state: CuaNativeAuthorityProtocolState,
  generation: number,
): void {
  if (state.confirmSeenGenerations.size >= CONFIRM_SEEN_GENERATIONS_LIMIT) {
    const oldest = state.confirmSeenGenerations.values().next().value;
    if (oldest !== undefined) state.confirmSeenGenerations.delete(oldest);
  }
  state.confirmSeenGenerations.add(generation);
}

async function handleRevoke(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: { requestId: string; method: string; payload: Record<string, unknown> },
  alreadyInvalidated: boolean,
): Promise<void> {
  const ref = readCuaSubmissionRef(frame.payload.ref);
  if (!ref) {
    ctx.reject(frame.requestId, frame.method, "invalid_ref");
    return;
  }
  if (!sameCuaSubmissionRef(ref, ctx.scope.ref)) {
    ctx.reject(frame.requestId, frame.method, "ref_mismatch");
    return;
  }
  if (frame.payload.traceId !== ctx.scope.traceId) {
    ctx.reject(frame.requestId, frame.method, "trace_mismatch");
    return;
  }
  if (!associationMatches(ctx, frame.payload)) {
    ctx.reject(frame.requestId, frame.method, "association_mismatch");
    return;
  }
  if (alreadyInvalidated && ctx.state.ownerRevocationTask) {
    await ctx.state.ownerRevocationTask;
    const result = ctx.state.lastRevocation;
    if (result?.status === "revoked") {
      ctx.write({
        requestId: frame.requestId,
        method: frame.method,
        result: { ok: true, traceId: ctx.scope.traceId, revocation: result },
      });
    } else {
      ctx.reject(frame.requestId, frame.method, "unknown_ref");
    }
    return;
  }

  ctx.state.ownRevokeInFlight = true;
  ctx.state.revokeFlow = true;
  const result = await withTimeout(
    ctx.scope.producerPort.revoke({ ref, reason: "user-stop" }),
    ctx.requestTimeoutMs,
    UNKNOWN_CUA_SUBMISSION_REVOCATION,
  );
  ctx.state.ownRevokeInFlight = false;
  ctx.state.revokeFlow = false;
  if (isRealRevocationForScope(result, ctx.scope.ref)) {
    ctx.state.ownerRevoked = true;
    ctx.state.lastRevocation = result;
    ctx.state.authorityRevoke = "revoked";
    // 先写出真实撤销回执，再允许关闭；scope 自身的 owner-revoked 通知不能抢在回执前 destroy。
    ctx.state.ownerFactSent = ctx.write({
      requestId: frame.requestId,
      method: frame.method,
      result: { ok: true, traceId: ctx.scope.traceId, revocation: result },
    });
    ctx.finish("owner-revoked", true);
    return;
  }
  ctx.reject(frame.requestId, frame.method, "unknown_ref");
  if (ctx.state.invalidated || ctx.state.ownerRevoked) {
    ctx.finish("owner-revoked", ctx.state.ownerRevoked);
  }
}

function handleClose(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: { requestId: string; method: string },
): void {
  ctx.state.remoteCloseRequested = true;
  ctx.write({
    requestId: frame.requestId,
    method: frame.method,
    result: { ok: true, closed: true },
  });
  ctx.scope.close();
  ctx.finish("remote-close", true);
}

function associationMatches(
  ctx: CuaNativeAuthorityProtocolContext,
  payload: Record<string, unknown>,
): boolean {
  if (
    payload.producerIncarnation !== undefined &&
    payload.producerIncarnation !== ctx.producerIncarnation
  ) {
    return false;
  }
  if (payload.runId !== undefined && payload.runId !== ctx.scope.runId) return false;
  if (payload.turnId !== undefined && payload.turnId !== ctx.scope.turnId) return false;
  return true;
}

export function isBoundedProducerIncarnation(value: unknown): value is string {
  return isBoundedString(value);
}
