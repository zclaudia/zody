import type { CuaSubmissionTurnInvalidationReason, CuaSubmissionTurnScope } from "@zcode/contracts";
import {
  CUA_NATIVE_AUTHORITY_CLOSE_FLUSH_TIMEOUT_MS,
  CUA_NATIVE_AUTHORITY_DEFAULT_MAX_PENDING_REQUESTS,
  CUA_NATIVE_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS,
  CUA_NATIVE_AUTHORITY_MAX_FRAME_BYTES,
  CUA_NATIVE_AUTHORITY_MAX_PENDING_BYTES,
  type CuaNativeAuthorityCloseReason,
  type CuaNativeAuthorityCloseResult,
  type CuaNativeAuthorityDiagnostics,
  type CuaNativeAuthoritySession,
  type CuaNativeAuthoritySessionOptions,
  cuaNativeAuthorityRevocationRequestId,
  isBoundedString,
} from "./cua-native-authority-contract.js";
import {
  UNKNOWN_CUA_SUBMISSION_REVOCATION,
  isRealRevocationForScope,
  withTimeout,
} from "./cua-native-authority-facts.js";
import {
  handleCuaNativeAuthorityLine,
  type CuaNativeAuthorityProtocolContext,
  type CuaNativeAuthorityProtocolState,
} from "./cua-native-authority-protocol.js";
import { CuaNativeAuthorityWire } from "./cua-native-authority-wire.js";

interface DeferredClose {
  readonly promise: Promise<CuaNativeAuthorityCloseResult>;
  resolve(result: CuaNativeAuthorityCloseResult): void;
}

function createDeferredClose(): DeferredClose {
  let resolve!: (result: CuaNativeAuthorityCloseResult) => void;
  const promise = new Promise<CuaNativeAuthorityCloseResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function boundedLimit(value: number | undefined, hardLimit: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return hardLimit;
  return Math.min(value, hardLimit);
}

function createProtocolState(): CuaNativeAuthorityProtocolState {
  return {
    bootstrapStarted: false,
    bootstrapped: false,
    captureResultStarted: false,
    captureResultAccepted: false,
    invalidated: false,
    ownerRevoked: false,
    ownerFactSent: false,
    ownRevokeInFlight: false,
    revokeFlow: false,
    remoteCloseRequested: false,
    closed: false,
    lastFailure: null,
    authorityRevoke: "not-requested",
    confirmSeenGenerations: new Set(),
  };
}

/**
 * 窄原生 authority 会话：只把可信 launcher 的私有 Duplex 接到 runtime scope。
 * 它不是认证边界，不创建 authority，不暴露模型/RPC/环境开关，也不签发可执行资格。
 */
export class CuaNativeAuthoritySessionImpl implements CuaNativeAuthoritySession {
  readonly #scope: CuaSubmissionTurnScope;
  readonly #producerIncarnation: string;
  readonly #requestTimeoutMs: number;
  readonly #state = createProtocolState();
  readonly #deferred = createDeferredClose();
  readonly #wire: CuaNativeAuthorityWire;
  readonly #context: CuaNativeAuthorityProtocolContext;
  #closeReason: CuaNativeAuthorityCloseReason = "adapter-close";
  #unsubscribeScope: () => void = () => undefined;

  constructor(options: CuaNativeAuthoritySessionOptions) {
    if (!isBoundedString(options.producerIncarnation)) {
      throw new Error("producerIncarnation must be a bounded non-empty string");
    }
    if (!options.stream || typeof options.stream.on !== "function") {
      throw new Error("stream must be an explicit private Duplex");
    }
    this.#scope = options.scope;
    this.#producerIncarnation = options.producerIncarnation;
    this.#requestTimeoutMs = boundedLimit(
      options.requestTimeoutMs,
      CUA_NATIVE_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.#context = {
      scope: this.#scope,
      producerIncarnation: this.#producerIncarnation,
      ...(options.capture ? { capture: options.capture } : {}),
      ...(options.confirmRequest ? { confirmRequest: options.confirmRequest } : {}),
      requestTimeoutMs: this.#requestTimeoutMs,
      state: this.#state,
      isLive: () =>
        !this.#state.invalidated &&
        !this.#state.closed &&
        this.#state.bootstrapped &&
        this.#state.captureResultStarted,
      write: (frame) => this.#write(frame),
      reject: (requestId, method, reason) => this.#reject(requestId, method, reason),
      protocolFailure: (reason) => this.#protocolFailure(reason),
      finish: (reason, graceful) => this.#finish(reason, graceful),
    };
    // 调用方只能收紧上限，不能突破 R11 wire 合同的固定 hard limit。
    this.#wire = new CuaNativeAuthorityWire(
      options.stream,
      {
        maxFrameBytes: boundedLimit(options.maxFrameBytes, CUA_NATIVE_AUTHORITY_MAX_FRAME_BYTES),
        maxPendingBytes: boundedLimit(
          options.maxPendingBytes,
          CUA_NATIVE_AUTHORITY_MAX_PENDING_BYTES,
        ),
        maxPendingRequests: boundedLimit(
          options.maxPendingRequests,
          CUA_NATIVE_AUTHORITY_DEFAULT_MAX_PENDING_REQUESTS,
        ),
        closeTimeoutMs: boundedLimit(
          options.closeTimeoutMs,
          CUA_NATIVE_AUTHORITY_CLOSE_FLUSH_TIMEOUT_MS,
        ),
      },
      {
        onLine: (line) => handleCuaNativeAuthorityLine(line, this.#context),
        onFailure: (reason) => this.#onWireFailure(reason),
        onWriteFailure: (reason) => this.#writeFailure(reason),
      },
    );
    // scope 可能已经终态，onInvalidated 会同步回调；wire 已装配后再订阅。
    this.#unsubscribeScope = this.#scope.onInvalidated((reason) => {
      this.#onScopeInvalidated(reason);
    });
    if (this.#state.closed) {
      this.#unsubscribeScope();
      this.#unsubscribeScope = () => undefined;
    }
  }

  get scope(): CuaSubmissionTurnScope {
    return this.#scope;
  }

  get diagnostics(): CuaNativeAuthorityDiagnostics {
    return Object.freeze({
      traceId: this.#scope.traceId,
      state: this.#state.closed
        ? "closed"
        : this.#state.invalidated
          ? "invalidated"
          : this.#state.bootstrapped
            ? "bound"
            : "starting",
      invalidated: this.#state.invalidated,
      ownerRevoked: this.#state.ownerRevoked,
      lastFailure: this.#state.lastFailure,
      executable: false,
      candidateIsGrant: false,
      nativeHelper: "unavailable",
      nativeFence: "unknown",
      machineLease: "unavailable",
      stopComplete: false,
    });
  }

  waitForClose(): Promise<CuaNativeAuthorityCloseResult> {
    return this.#deferred.promise;
  }

  close(): void {
    if (this.#state.closed) return;
    // 正常 consumer 关闭只结束本次 binding；不调用 revoke，不把正常收尾说成 owner 撤销。
    this.#finish("adapter-close", true);
    this.#scope.close();
  }

  #onScopeInvalidated(reason: CuaSubmissionTurnInvalidationReason): void {
    if (this.#state.invalidated || this.#state.closed) return;
    this.#state.invalidated = true;
    if (reason === "scope-closed") {
      this.#finish(this.#state.remoteCloseRequested ? "remote-close" : "scope-closed", true);
      return;
    }
    this.#state.ownerRevoked = true;
    if (this.#state.revokeFlow || this.#state.ownRevokeInFlight) return;
    this.#state.ownerRevocationTask = this.#forwardOwnerRevocation().catch(() => {
      this.#state.authorityRevoke = "unknown";
      this.#state.lastFailure = "owner_revocation_failed";
      this.#finish("owner-revoked", false);
    });
  }

  async #forwardOwnerRevocation(): Promise<void> {
    this.#state.revokeFlow = true;
    const result = await withTimeout(
      this.#scope.producerPort.revoke({ ref: this.#scope.ref, reason: "user-stop" }),
      this.#requestTimeoutMs,
      UNKNOWN_CUA_SUBMISSION_REVOCATION,
    );
    this.#state.revokeFlow = false;
    if (isRealRevocationForScope(result, this.#scope.ref)) {
      this.#state.lastRevocation = result;
      this.#state.authorityRevoke = "revoked";
      if (!this.#state.ownerFactSent) {
        this.#state.ownerFactSent = this.#write({
          requestId: cuaNativeAuthorityRevocationRequestId(this.#scope.ref),
          method: "revoked",
          result: { ok: true, traceId: this.#scope.traceId, projection: result.projection },
        });
      }
      this.#finish("owner-revoked", true);
      return;
    }
    // shutdown/owner dispose 可能先清空事实；查不到完整 projection 时只能 fail-closed 关闭流，
    // 保持 nativeFence 为 unknown，绝不伪造 revoked frame。
    this.#state.authorityRevoke = "unknown";
    this.#state.lastFailure = "owner_revocation_unknown";
    this.#finish("owner-revoked", false);
  }

  #onWireFailure(reason: string): void {
    if (this.#state.closed || this.#state.invalidated) return;
    if (reason === "eof") {
      this.#transportFailure("eof");
      return;
    }
    if (reason === "transport-error") {
      this.#transportFailure("transport-error");
      return;
    }
    this.#protocolFailure(reason);
  }

  #protocolFailure(reason: string): void {
    this.#state.lastFailure = reason;
    this.#transportFailure("protocol-error");
  }

  #transportFailure(reason: "eof" | "transport-error" | "protocol-error"): void {
    if (this.#state.closed || this.#state.invalidated) return;
    this.#state.lastFailure ??= reason;
    this.#state.invalidated = true;
    this.#state.revokeFlow = true;
    void withTimeout(
      this.#scope.producerPort.revoke({ ref: this.#scope.ref, reason: "control-lost" }),
      this.#requestTimeoutMs,
      UNKNOWN_CUA_SUBMISSION_REVOCATION,
    )
      .then((result) => {
        if (isRealRevocationForScope(result, this.#scope.ref)) {
          this.#state.ownerRevoked = true;
          this.#state.authorityRevoke = "revoked";
          this.#state.lastRevocation = result;
          this.#state.ownerFactSent = this.#write({
            requestId: cuaNativeAuthorityRevocationRequestId(this.#scope.ref),
            method: "revoked",
            result: { ok: true, traceId: this.#scope.traceId, projection: result.projection },
          });
        } else {
          this.#state.authorityRevoke = "unknown";
        }
      })
      .catch(() => {
        this.#state.authorityRevoke = "unknown";
        this.#state.lastFailure = "control_lost_revoke_failed";
      })
      .finally(() => {
        this.#state.revokeFlow = false;
        this.#finish(reason, false);
      });
  }

  #write(frame: { requestId: string; method: string; result: unknown }): boolean {
    return this.#wire.write(frame);
  }

  #reject(requestId: string, method: string, reason: string): void {
    this.#write({ requestId, method, result: { ok: false, reason } });
  }

  /** 写失败必须统一 fail-closed；清理阶段已 invalidated 时只忽略，避免递归。 */
  #writeFailure(reason: string): void {
    this.#state.lastFailure ??= reason;
    if (!this.#state.invalidated && !this.#state.closed) {
      this.#transportFailure("transport-error");
    }
  }

  #finish(reason: CuaNativeAuthorityCloseReason, graceful: boolean): void {
    if (this.#state.closed) return;
    this.#state.closed = true;
    this.#closeReason = reason;
    this.#unsubscribeScope();
    this.#unsubscribeScope = () => undefined;
    // 失败 cleanup（撤销 unknown/timeout）也必须结束本 scope 捕获的 binding；owner 已撤销
    // 或 scope 正常结束时 close 幂等无副作用，不会把首因改写成 scope-closed。
    this.#scope.close();
    void this.#wire.close(graceful).then((facts) => {
      this.#deferred.resolve(
        Object.freeze({
          reason: this.#closeReason,
          ownerRevoked: this.#state.ownerRevoked,
          revocationForwarded: this.#state.ownerFactSent,
          authorityRevoke: this.#state.authorityRevoke,
          transportClosed: facts.transportClosed,
          cleanupPending: facts.cleanupPending,
          nativeFence: "unknown",
          machineLease: "unavailable",
          stopComplete: false,
        }),
      );
    });
  }
}
