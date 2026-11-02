import type {
  CuaSubmissionProducerPort,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionTurnInvalidationReason,
} from "@zody/contracts";
import {
  adoptCuaSubmissionRevocationRef,
  type CuaSubmissionControlFailure,
} from "./cua-submission-control-contract.js";

type RevokedProjection = Extract<CuaSubmissionProjection, { status: "revoked" }>;

/**
 * owner 撤销与 scope 失效的状态归并。它只操作既有 authority producerPort 和调用方
 * 已持有的 binding 引用，不创建第二份授权状态。
 */
export interface CuaSubmissionRevocationHost {
  readonly producerPort: CuaSubmissionProducerPort;
  originalRef(): CuaSubmissionRef;
  currentRef(): CuaSubmissionRef;
  adoptRef(ref: CuaSubmissionRef): void;
  isClosed(): boolean;
  isStarting(): boolean;
  isStopping(): boolean;
  isInboundAuthorityRevoke(): boolean;
  isInvalidated(): boolean;
  latchOwnerRevoked(): void;
  latchScopeOwnerRevoked(): void;
  latchScopeClosed(): void;
  beginExternalOwnerInvalidation(): void;
  forwardOwnerRevocation(): Promise<void>;
  scheduleCleanup(): void;
  setLastFailure(failure: CuaSubmissionControlFailure): void;
  recordCleanupFailure(message: string): void;
}

export class CuaSubmissionRevocationController {
  readonly #host: CuaSubmissionRevocationHost;

  constructor(host: CuaSubmissionRevocationHost) {
    this.#host = host;
  }

  handleOwnerProjection(projection: RevokedProjection): void {
    const host = this.#host;
    if (host.isClosed()) return;
    const next = adoptCuaSubmissionRevocationRef(host.currentRef(), projection.ref);
    if (!next) return;
    host.adoptRef(next);
    host.latchOwnerRevoked();
    // 本 inbound 自己调用 authority 时的同步 owner 回调不是外部终止，由 inbound 结果统一结算 ACK。
    if (host.isInboundAuthorityRevoke() || host.isStopping() || host.isInvalidated()) return;
    host.beginExternalOwnerInvalidation();
    void host.forwardOwnerRevocation();
  }

  handleScope(reason: CuaSubmissionTurnInvalidationReason): void {
    const host = this.#host;
    if (host.isClosed()) return;
    if (reason === "owner-revoked") {
      host.latchScopeOwnerRevoked();
      // stop/inbound 自己触发的同步 owner 回调由原流程结算，不能提前推进 epoch 或 cleanup。
      if (host.isInboundAuthorityRevoke() || host.isStopping() || host.isInvalidated()) return;
      void this.#forwardScopeOwnerRevocation();
      return;
    }
    // 正常 turn 结束/显式 scope close 只关闭 consumer 和本次 binding。
    host.latchScopeClosed();
    host.scheduleCleanup();
  }

  async #forwardScopeOwnerRevocation(): Promise<void> {
    const host = this.#host;
    if (host.isClosed()) return;
    host.beginExternalOwnerInvalidation();
    let canForward = false;
    // 外部 owner 撤销不携带新 ref：用同原 ref 发起幂等 revoke 取回已提交事实，
    // 再向 producer 转发真实 revoked ref；只关 child 不构成 owner 撤销转发。
    try {
      const result = await host.producerPort.revoke({
        ref: host.originalRef(),
        reason: "control-lost",
      });
      if (result.status === "revoked") {
        const next = adoptCuaSubmissionRevocationRef(host.originalRef(), result.ref);
        if (next) {
          host.adoptRef(next);
          canForward = true;
        } else {
          host.setLastFailure("authority_revoke_failed");
          host.recordCleanupFailure("scope owner revoke returned a mismatched ref");
        }
      } else {
        host.setLastFailure("authority_revoke_failed");
        host.recordCleanupFailure("scope owner revoke did not return revoked");
      }
    } catch {
      host.setLastFailure("authority_revoke_failed");
      host.recordCleanupFailure("scope owner revoke failed");
    }
    // 只有拿到真实 revoked 且成功 adopt 后才能向 producer 转发；unknown/throw/mismatch
    // 不能把旧 candidate ref 冒充成 revoked 事实，只做失败标记与 cleanup。
    if (!canForward) {
      host.scheduleCleanup();
      return;
    }
    if (!host.isStarting()) await host.forwardOwnerRevocation();
    else host.scheduleCleanup();
  }
}
