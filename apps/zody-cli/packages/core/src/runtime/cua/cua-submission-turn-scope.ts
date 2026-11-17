import type {
  CuaSubmissionProducerPort,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionResolveRequest,
  CuaSubmissionRevocationResult,
  CuaSubmissionRevokeRequest,
  CuaSubmissionTurnInvalidationReason,
  CuaSubmissionTurnScope,
  TraceId,
  TurnId,
} from "@zody/contracts";
import type {
  CuaSubmissionBindTurnRequest,
  CuaSubmissionBindTurnResult,
  CuaSubmissionEndTurnRequest,
  CuaSubmissionEndTurnResult,
} from "./cua-submission-types.js";
import {
  sameFullRef,
  sameIdentity,
  unknownProjection,
  unknownRevocation,
} from "./cua-submission-helpers.js";

/**
 * runtime 提供的最小可信面。scope 只转发现有 coordinator 的 bind/end/producerPort，
 * 不持有 authority 内部 map，也不生成任何身份或授权状态。
 */
export interface RuntimeCuaSubmissionTurnScopeDependencies {
  readonly ref: CuaSubmissionRef;
  readonly traceId: TraceId;
  readonly runId: string;
  readonly turnId: TurnId;
  readonly producerPort: CuaSubmissionProducerPort;
  bindTurn(request: CuaSubmissionBindTurnRequest): CuaSubmissionBindTurnResult;
  endTurn(request: CuaSubmissionEndTurnRequest): CuaSubmissionEndTurnResult;
  /** 真实 turn/execution 仍是原对象，且 owner 仍持原 revision candidate。 */
  isBindingCurrent(): boolean;
}

/**
 * 单 turn 的 scope handle。终态 reason 一旦锁存不再改变：owner 撤销不能被随后正常
 * close 覆盖，正常 close 也不能被 adapter 误当成 control-lost 去撤销仍有效的 lineage。
 */
export class RuntimeCuaSubmissionTurnScope implements CuaSubmissionTurnScope {
  readonly #deps: RuntimeCuaSubmissionTurnScopeDependencies;
  readonly #listeners = new Set<(reason: CuaSubmissionTurnInvalidationReason) => void>();
  readonly #ref: CuaSubmissionRef;
  readonly #traceId: TraceId;
  readonly #runId: string;
  readonly #turnId: TurnId;
  readonly #producerPort: CuaSubmissionProducerPort;
  #cleanupRef: CuaSubmissionRef;
  #invalidated = false;
  #terminalReason?: CuaSubmissionTurnInvalidationReason;
  #consumers = 0;

  constructor(deps: RuntimeCuaSubmissionTurnScopeDependencies) {
    this.#deps = deps;
    this.#ref = Object.freeze({ ...deps.ref });
    this.#cleanupRef = this.#ref;
    this.#traceId = deps.traceId;
    this.#runId = deps.runId;
    this.#turnId = deps.turnId;
    this.#producerPort = Object.freeze({
      resolve: (request: CuaSubmissionResolveRequest) => this.#resolve(request),
      revoke: (request: CuaSubmissionRevokeRequest) => this.#revoke(request),
    });
    // readonly 只是 TS 约束；运行时冻结实例，防止调用方改写 ref/ids/producerPort 后
    // 把已 pin 的 facade 指向别的 lineage。私有字段仍可维护失效状态。
    Object.freeze(this);
  }

  /** 多个 consumer 共用唯一 owner/binding；每个关闭只释放自身，最后一个才结束 binding。 */
  acquireConsumer(): CuaSubmissionTurnScope {
    this.#consumers++;
    let terminal: CuaSubmissionTurnInvalidationReason | undefined;
    const listeners = new Set<(reason: CuaSubmissionTurnInvalidationReason) => void>();
    let unsubscribe = () => {};
    const finish = (reason: CuaSubmissionTurnInvalidationReason) => {
      if (terminal) return;
      terminal = reason;
      unsubscribe();
      this.#consumers--;
      for (const listener of listeners) {
        try {
          listener(reason);
        } catch {
          /* 隔离消费者 */
        }
      }
      listeners.clear();
      if (this.#consumers === 0 && !this.#invalidated) this.close();
    };
    unsubscribe = this.onInvalidated(finish);
    return Object.freeze({
      ref: this.ref,
      traceId: this.traceId,
      runId: this.runId,
      turnId: this.turnId,
      get invalidated() {
        return terminal !== undefined;
      },
      get terminalReason() {
        return terminal;
      },
      producerPort: Object.freeze({
        resolve: (request: CuaSubmissionResolveRequest) =>
          terminal ? Promise.resolve(unknownProjection()) : this.producerPort.resolve(request),
        revoke: (request: CuaSubmissionRevokeRequest) =>
          terminal && terminal !== "owner-revoked"
            ? Promise.resolve(unknownRevocation())
            : this.producerPort.revoke(request),
      }),
      bindProducer: (producer: string) => !terminal && this.bindProducer(producer),
      onInvalidated: (listener: (reason: CuaSubmissionTurnInvalidationReason) => void) => {
        if (terminal) {
          listener(terminal);
          return () => {};
        }
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: () => finish("scope-closed"),
    });
  }

  get ref(): CuaSubmissionRef {
    return this.#ref;
  }

  get traceId(): TraceId {
    return this.#traceId;
  }

  get runId(): string {
    return this.#runId;
  }

  get turnId(): TurnId {
    return this.#turnId;
  }

  get producerPort(): CuaSubmissionProducerPort {
    return this.#producerPort;
  }

  get invalidated(): boolean {
    return this.#invalidated;
  }

  get terminalReason(): CuaSubmissionTurnInvalidationReason | undefined {
    return this.#terminalReason;
  }

  bindProducer(producerIncarnation: string): boolean {
    if (this.#invalidated || !this.#deps.isBindingCurrent()) return false;
    const result = this.#deps.bindTurn({
      ref: this.#ref,
      producerIncarnation,
      runId: this.#runId,
      turnId: this.#turnId,
    });
    if (!result.ok) return false;
    // 绑定结果必须仍代表创建 scope 时捕获的原 revision；若 owner 已前进，旧 handle
    // 不能借新结果继续存活，立即按 owner 失效并让 adapter 走撤销/清理。
    if (!sameFullRef(this.#ref, result.ref)) {
      this.invalidate("owner-revoked");
      return false;
    }
    this.#cleanupRef = result.ref;
    return true;
  }

  onInvalidated(listener: (reason: CuaSubmissionTurnInvalidationReason) => void): () => void {
    if (this.#invalidated && this.#terminalReason !== undefined) {
      this.#notify(listener, this.#terminalReason);
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.invalidate("scope-closed");
  }

  /** runtime 生命周期 hook 的同步失效入口；重复调用只保留首个 reason。 */
  invalidate(reason: CuaSubmissionTurnInvalidationReason): void {
    if (this.#invalidated) return;
    this.#invalidated = true;
    this.#terminalReason = reason;
    // 先释放本次 binding，再通知 consumer；endTurn 固定使用创建/绑定时捕获的 ref/run/turn，
    // 绝不回读新的 currentRef，因此不会误清后来建立的 lineage。
    try {
      this.#deps.endTurn({
        ref: this.#cleanupRef,
        runId: this.#runId,
        turnId: this.#turnId,
      });
    } catch {
      // 清理异常不能阻止 consumer 收到失效；binding 清理失败由 owner 后续 dispose 兜底。
    }
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) this.#notify(listener, reason);
  }

  async #resolve(request: CuaSubmissionResolveRequest): Promise<CuaSubmissionProjection> {
    if (!this.#canResolve(request.ref)) return unknownProjection();
    const result = await this.#deps.producerPort.resolve(request);
    // 等待期间 turn/owner 可能已经失效；除失效标记外还必须复核真实 binding 仍是原对象，
    // 防止生命周期 hook 漏调或异步交错时把晚到 candidate 重新交给 consumer。
    return this.#canResolve(request.ref) ? result : unknownProjection();
  }

  async #revoke(request: CuaSubmissionRevokeRequest): Promise<CuaSubmissionRevocationResult> {
    if (!this.#canRevoke(request.ref)) return unknownRevocation();
    const result = await this.#deps.producerPort.revoke(request);
    // owner.revoke 成功会同步触发 onRevocation→scope.invalidate(owner-revoked)，随后可能再来
    // 一次同 ref 的幂等 revoke。已发生的同 owner revoked 事实必须如实返回，避免 adapter 把
    // 成功清理误报成 authority_revoke_failed。
    if (
      result.status === "revoked" &&
      sameIdentity(result.ref, this.#ref) &&
      result.ref.authorizationRevision >= this.#ref.authorizationRevision
    ) {
      return result;
    }
    if (!this.#invalidated && this.#deps.isBindingCurrent()) return result;
    return unknownRevocation();
  }

  #canResolve(ref: CuaSubmissionRef): boolean {
    return !this.#invalidated && sameFullRef(ref, this.#ref) && this.#deps.isBindingCurrent();
  }

  /**
   * normal close 后不再接受新的 revoke；但 owner-revoked 后同原 ref 的幂等 revoke 仍需转发，
   * 让 adapter 的 cleanup 拿到真实 owner 撤销回执而不是失败。
   */
  #canRevoke(ref: CuaSubmissionRef): boolean {
    if (!sameFullRef(ref, this.#ref)) return false;
    if (this.#invalidated) return this.#terminalReason === "owner-revoked";
    return this.#deps.isBindingCurrent();
  }

  #notify(
    listener: (reason: CuaSubmissionTurnInvalidationReason) => void,
    reason: CuaSubmissionTurnInvalidationReason,
  ): void {
    try {
      listener(reason);
    } catch {
      // 观察者异常不得恢复 scope 或阻断其它观察者。
    }
  }
}
