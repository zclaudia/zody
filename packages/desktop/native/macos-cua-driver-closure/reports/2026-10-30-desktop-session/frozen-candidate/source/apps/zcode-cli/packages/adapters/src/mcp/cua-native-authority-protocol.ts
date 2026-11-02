import type { CuaSubmissionRevocationResult, CuaSubmissionTurnScope } from "@zcode/contracts";
import {
  type CuaNativeAuthorityCloseReason,
  type CuaNativeAuthorityCaptureOptions,
  type CuaNativeAuthorityRevokeOutcome,
  isBoundedString,
  parseCuaNativeAuthorityRequest,
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

export interface CuaNativeAuthorityProtocolState {
  bootstrapStarted: boolean;
  bootstrapped: boolean;
  captureResultStarted: boolean;
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
  lastRevocation?: CuaSubmissionRevocationResult;
  ownerRevocationTask?: Promise<void>;
}

export interface CuaNativeAuthorityProtocolContext {
  readonly scope: CuaSubmissionTurnScope;
  readonly producerIncarnation: string;
  readonly capture?: CuaNativeAuthorityCaptureOptions;
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
  if (ctx.state.invalidated) {
    // owner 事实已经锁存后只允许仍能返回真实回执的 revoke/close；晚到截图明确拒绝，不复活 scope。
    if (frame.method === "captureResult") {
      ctx.reject(frame.requestId, frame.method, "scope_invalidated");
    } else if (frame.method === "revoke") await handleRevoke(ctx, frame, true);
    else if (frame.method === "close") handleClose(ctx, frame);
    return;
  }
  if (frame.method === "bootstrap") await handleBootstrap(ctx, frame);
  else if (frame.method === "check") await handleCheck(ctx, frame);
  else if (frame.method === "captureResult") await handleCaptureResult(ctx, frame);
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
      ...(ctx.capture ? { target: ctx.capture.target } : {}),
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
    frame.payload.turnId !== ctx.scope.turnId
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
      projection,
    },
  });
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
