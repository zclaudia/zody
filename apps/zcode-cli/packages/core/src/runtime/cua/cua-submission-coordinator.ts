import type {
  CuaSubmissionProducerPort,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionRevokeReason,
} from "@zcode/contracts";
import { CuaSubmissionAuthority } from "./cua-submission-authority.js";
import type {
  CuaSubmissionAuthorityOptions,
  CuaSubmissionBindTurnRequest,
  CuaSubmissionBindTurnResult,
  CuaSubmissionEndTurnRequest,
  CuaSubmissionEndTurnResult,
  RevokedProjection,
} from "./cua-submission-types.js";
import type {
  CuaCurrentSubmission,
  CuaTicketRecord,
} from "./cua-submission-coordinator-records.js";
import { CuaSubmissionRevocationHub } from "./cua-submission-revocation-hub.js";
import { sameFullRef, sameIdentity } from "./cua-submission-helpers.js";
import {
  DEFAULT_MAX_CONSUMED_ASSOCIATIONS,
  DEFAULT_MAX_PENDING_LIVE_SUBMISSIONS,
  cuaConsumedAssociationKey,
  readPositiveCuaLimit,
  rememberBoundedCuaKey,
  resolveCuaSubmissionOrigin,
  type CuaLiveSubmissionRegistrar,
  type CuaLiveSubmissionRegistrationRequest,
  type CuaLiveSubmissionRegistrationResult,
  type CuaLiveSubmissionTicket,
  type CuaSubmissionAdmissionObservation,
  type CuaSubmissionRuntimeOptions,
} from "./cua-submission-coordinator-contract.js";

export * from "./cua-submission-coordinator-contract.js";

/**
 * 只持当前 ref/输入关联；授权状态、revision 与撤销事实仍由 CuaSubmissionAuthority 唯一持有。
 * 本类不生成任何 Host/incarnation 标识，也不签发原生能力；turn scope 只通过本类代理同一
 * authority 的 bindTurn/endTurn 与窄 producerPort，不复制授权 map。
 */
export class CuaSubmissionCoordinator {
  readonly #authority: CuaSubmissionAuthority;
  readonly #maxPendingLiveSubmissions: number;
  readonly #maxConsumedAssociations: number;
  readonly #registrations = new Map<string, CuaTicketRecord>();
  readonly #registrationsByQueue = new Map<string, CuaTicketRecord>();
  readonly #ticketRecords = new WeakMap<CuaLiveSubmissionTicket, CuaTicketRecord>();
  readonly #tickets = new Set<CuaLiveSubmissionTicket>();
  readonly #consumedAssociations = new Map<string, true>();
  readonly #consumedSources = new Map<string, true>();
  readonly #consumedQueues = new Map<string, true>();
  readonly #registrar: CuaLiveSubmissionRegistrar;
  readonly #revocations = new CuaSubmissionRevocationHub();
  #current?: CuaCurrentSubmission;
  #disposed = false;

  constructor(options: CuaSubmissionRuntimeOptions) {
    const userOnRevocation = options.onRevocation;
    const authorityOptions: CuaSubmissionAuthorityOptions = {
      appIncarnation: options.appIncarnation,
      hostInstanceId: options.hostInstanceId,
      runtimeInstanceId: options.runtimeInstanceId,
      sessionId: options.sessionId,
      workspaceKey: options.workspaceKey,
      ...(options.maxLineages === undefined ? {} : { maxLineages: options.maxLineages }),
      ...(options.maxActiveTurnsPerLineage === undefined
        ? {}
        : { maxActiveTurnsPerLineage: options.maxActiveTurnsPerLineage }),
      onRevocation: (projection: RevokedProjection) => {
        // 外部 producer/control 撤销会推进 owner revision；coordinator 只同步引用，不复制状态。
        this.syncCurrentRevision(projection);
        // scope 观察者必须与 owner 撤销同步；先于用户回调。
        this.#revocations.notify(projection);
        userOnRevocation?.(projection);
      },
    };
    this.#authority = new CuaSubmissionAuthority(authorityOptions);
    this.#maxPendingLiveSubmissions = readPositiveCuaLimit(
      options.maxPendingLiveSubmissions,
      DEFAULT_MAX_PENDING_LIVE_SUBMISSIONS,
    );
    this.#maxConsumedAssociations = DEFAULT_MAX_CONSUMED_ASSOCIATIONS;
    this.#registrar = Object.freeze({
      register: (input: CuaLiveSubmissionRegistrationRequest) => this.registerLiveSubmission(input),
      cancel: (ticket: CuaLiveSubmissionTicket) => this.cancelLiveSubmission(ticket),
    });
  }

  get registrar(): CuaLiveSubmissionRegistrar {
    return this.#registrar;
  }

  registerLiveSubmission(
    input: CuaLiveSubmissionRegistrationRequest,
  ): CuaLiveSubmissionRegistrationResult {
    if (this.#disposed) return { accepted: false, reason: "disposed" };
    if (input.origin !== "desktop") return { accepted: false, reason: "ineligible_origin" };
    if (input.inputKind !== "new-submission") {
      return { accepted: false, reason: "ineligible_input_kind" };
    }
    const sourceCommandId = input.sourceCommandId?.trim();
    const queueItemId = input.queueItemId?.trim();
    if (!sourceCommandId || (input.queueItemId !== undefined && !queueItemId)) {
      return { accepted: false, reason: "invalid_input" };
    }
    if (this.#registrations.has(sourceCommandId)) {
      return { accepted: false, reason: "duplicate" };
    }
    if (queueItemId !== undefined && this.#registrationsByQueue.has(queueItemId)) {
      return { accepted: false, reason: "duplicate" };
    }
    if (this.#consumedSources.has(sourceCommandId)) {
      return { accepted: false, reason: "consumed" };
    }
    if (queueItemId !== undefined && this.#consumedQueues.has(queueItemId)) {
      return { accepted: false, reason: "consumed" };
    }
    if (this.#registrations.size >= this.#maxPendingLiveSubmissions) {
      return { accepted: false, reason: "capacity" };
    }

    const ticket = Object.freeze(Object.create(null) as CuaLiveSubmissionTicket);
    const record: CuaTicketRecord = {
      owner: this,
      sourceCommandId,
      ...(queueItemId === undefined ? {} : { queueItemId }),
    };
    this.#ticketRecords.set(ticket, record);
    this.#tickets.add(ticket);
    this.#registrations.set(sourceCommandId, record);
    if (record.queueItemId !== undefined) {
      this.#registrationsByQueue.set(record.queueItemId, record);
    }
    return { accepted: true, ticket };
  }

  cancelLiveSubmission(ticket: CuaLiveSubmissionTicket): boolean {
    const record = this.#ticketRecords.get(ticket);
    if (!record || record.owner !== this || this.#disposed) return false;
    if (!this.#tickets.delete(ticket)) return false;
    this.unlinkRegistration(record);
    return true;
  }

  /** queue 项被用户删除/取消后，其尚未消费的 ticket 必须同步失效，不能等提升再判断。 */
  dropPendingLiveSubmissionByQueueItem(queueItemId: string): boolean {
    const record = this.#registrationsByQueue.get(queueItemId.trim());
    if (!record) return false;
    this.unlinkRegistration(record);
    return true;
  }

  /**
   * 在任何 admission 分支前调用。mobile/unknown 只锁存撤销，不消费 desktop 凭证；
   * 该路径只降低权限，不建立 candidate。
   */
  observeAdmission(input: CuaSubmissionAdmissionObservation): void {
    if (this.#disposed) return;
    const origin = resolveCuaSubmissionOrigin(input.inputOrigin);
    if (origin === "desktop") return;
    this.revokeCurrent(origin === "mobile" ? "mobile-steer" : "unknown-input");
    this.dropRegistration(input.sourceCommandId, input.queueItemId);
  }

  /** 本地 steer 附着原 lineage；mobile/unknown 已在上一步撤销。steer 永不新建 candidate。 */
  observeSteer(input: CuaSubmissionAdmissionObservation): void {
    if (this.#disposed) return;
    const origin = resolveCuaSubmissionOrigin(input.inputOrigin);
    this.dropRegistration(input.sourceCommandId, input.queueItemId);
    if (origin !== "desktop") {
      this.revokeCurrent(origin === "mobile" ? "mobile-steer" : "unknown-input");
      return;
    }
    const current = this.#current;
    if (!current) return;
    const result = this.#authority.steer({ ref: current.ref, origin: "desktop" });
    if (!result.ok) {
      this.#current = undefined;
      return;
    }
    this.#current = { ...current, ref: result.ref };
  }

  /**
   * 只在 admitPrompt 实际开始一个独立 turn（含 queue promotion）时调用。
   * 同一 source/queue 凭证最多消费一次；没有凭证不会新建 candidate。
   */
  onTurnStarting(input: CuaSubmissionAdmissionObservation): CuaSubmissionRef | undefined {
    if (this.#disposed) return undefined;
    const origin = resolveCuaSubmissionOrigin(input.inputOrigin);
    if (origin !== "desktop") {
      // 新 mobile/unknown 独立 turn 即使没有凭证，也必须先撤销旧 current；仅降低权限。
      this.observeAdmission(input);
      return undefined;
    }

    const sourceCommandId = input.sourceCommandId?.trim();
    if (!sourceCommandId) {
      this.revokeCurrent("unknown-input");
      return undefined;
    }
    const associationKey = cuaConsumedAssociationKey(sourceCommandId, input.queueItemId);
    if (!this.consumeRegistration(sourceCommandId, input.queueItemId)) {
      // 只有精确同一 current 关联才允许幂等；旧 A 不能指向后来建立的 B lineage。
      if (
        this.#consumedAssociations.has(associationKey) &&
        this.#current?.sourceCommandId === sourceCommandId &&
        this.#current.queueItemId === input.queueItemId
      ) {
        return this.currentCandidateRef();
      }
      this.revokeCurrent("unknown-input");
      return undefined;
    }

    this.rememberConsumedAssociation(sourceCommandId, input.queueItemId);
    const admission = this.#authority.admitLive({
      origin: "desktop",
      inputKind: "new-submission",
      sourceCommandId,
      ...(input.queueItemId === undefined ? {} : { queueItemId: input.queueItemId }),
    });
    if (admission.accepted) {
      this.#current = {
        ref: admission.ref,
        sourceCommandId,
        ...(input.queueItemId === undefined ? {} : { queueItemId: input.queueItemId }),
      };
      return admission.ref;
    }
    if (admission.reason === "duplicate" && admission.existingRef) {
      if (this.#authority.projectNow({ ref: admission.existingRef }).status === "candidate") {
        this.#current = {
          ref: admission.existingRef,
          sourceCommandId,
          ...(input.queueItemId === undefined ? {} : { queueItemId: input.queueItemId }),
        };
        return admission.existingRef;
      }
      this.#current = undefined;
      return undefined;
    }
    // 容量/非法/已 dispose 只让本次 CUA 无 candidate；普通 turn 不受影响。
    this.revokeCurrent("unknown-input");
    return undefined;
  }

  currentProjection(): CuaSubmissionProjection {
    const current = this.#current;
    if (!current || this.#disposed) {
      return Object.freeze({
        status: "unknown",
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      });
    }
    return this.#authority.projectNow({ ref: current.ref });
  }

  currentRef(): CuaSubmissionRef | undefined {
    return this.#current?.ref;
  }

  /** 同一 authority 的 bind 代理；scope 只借此固定本轮 producer/run/turn，不复制授权 map。 */
  bindTurn(request: CuaSubmissionBindTurnRequest): CuaSubmissionBindTurnResult {
    if (this.#disposed) return { ok: false, reason: "disposed" };
    return this.#authority.bindTurn(request);
  }

  /** 清理固定使用创建 scope 时的 ref/run/turn，绝不回读新的 current ref。 */
  endTurn(request: CuaSubmissionEndTurnRequest): CuaSubmissionEndTurnResult {
    if (this.#disposed) return { ok: false, reason: "disposed" };
    return this.#authority.endTurn(request);
  }

  /** 仅当 owner 当前仍持同一完整 candidate ref 时允许绑定，防止旧 handle 清到新 lineage。 */
  isCurrentCandidateRef(ref: CuaSubmissionRef): boolean {
    const current = this.#current;
    if (this.#disposed || !current || !sameFullRef(current.ref, ref)) return false;
    return this.#authority.projectNow({ ref }).status === "candidate";
  }

  /** runtime turn scope 只订阅撤销事实；返回值用于 scope 终态时退订。 */
  subscribeRevocation(listener: (projection: RevokedProjection) => void): () => void {
    return this.#revocations.subscribe(listener);
  }

  /**
   * 用户 stop 在 abort 前调用。clearPending 时同时作废未消费凭证，保证撤销后的 queued
   * promotion 不能复活 CUA；内部 queue promotion 抢占不得走这里。
   */
  revokeCurrent(reason: CuaSubmissionRevokeReason, options: { clearPending?: boolean } = {}): void {
    if (options.clearPending === true) this.clearPendingRegistrations();
    if (this.#disposed) return;
    const current = this.#current;
    if (!current) return;
    const result = this.#authority.revokeNow({ ref: current.ref, reason });
    if (result.status === "revoked") {
      this.#current = { ...current, ref: result.ref };
    } else {
      this.#current = undefined;
    }
  }

  producerPort(): CuaSubmissionProducerPort {
    return this.#authority.createProducerPort();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#current = undefined;
    this.clearPendingRegistrations();
    this.#authority.dispose();
  }

  private consumeRegistration(
    sourceCommandId: string,
    queueItemId: string | undefined,
  ): CuaTicketRecord | undefined {
    const record = this.#registrations.get(sourceCommandId);
    if (!record) return undefined;
    if (record.queueItemId !== undefined && record.queueItemId !== queueItemId) return undefined;
    this.unlinkRegistration(record);
    return record;
  }

  private dropRegistration(
    sourceCommandId: string | undefined,
    queueItemId: string | undefined,
  ): void {
    const source = sourceCommandId?.trim();
    if (!source) return;
    const record = this.#registrations.get(source);
    if (!record) return;
    if (record.queueItemId !== undefined && record.queueItemId !== queueItemId) return;
    this.unlinkRegistration(record);
  }

  private unlinkRegistration(record: CuaTicketRecord): void {
    this.removeTicketRecord(record);
    if (this.#registrations.get(record.sourceCommandId) === record) {
      this.#registrations.delete(record.sourceCommandId);
    }
    if (
      record.queueItemId !== undefined &&
      this.#registrationsByQueue.get(record.queueItemId) === record
    ) {
      this.#registrationsByQueue.delete(record.queueItemId);
    }
  }

  private clearPendingRegistrations(): void {
    this.#registrations.clear();
    this.#registrationsByQueue.clear();
    this.#tickets.clear();
  }

  private removeTicketRecord(record: CuaTicketRecord): void {
    for (const ticket of this.#tickets) {
      if (this.#ticketRecords.get(ticket) === record) {
        this.#tickets.delete(ticket);
        this.#ticketRecords.delete(ticket);
      }
    }
  }

  private rememberConsumedAssociation(
    sourceCommandId: string,
    queueItemId: string | undefined,
  ): void {
    rememberBoundedCuaKey(
      this.#consumedAssociations,
      cuaConsumedAssociationKey(sourceCommandId, queueItemId),
      this.#maxConsumedAssociations,
    );
    rememberBoundedCuaKey(this.#consumedSources, sourceCommandId, this.#maxConsumedAssociations);
    if (queueItemId !== undefined) {
      rememberBoundedCuaKey(this.#consumedQueues, queueItemId, this.#maxConsumedAssociations);
    }
  }

  private syncCurrentRevision(projection: RevokedProjection): void {
    const current = this.#current;
    if (!current || !sameIdentity(current.ref, projection.ref)) return;
    this.#current = { ...current, ref: projection.ref };
  }

  private currentCandidateRef(): CuaSubmissionRef | undefined {
    const current = this.#current;
    if (!current) return undefined;
    const projection = this.#authority.projectNow({ ref: current.ref });
    return projection.status === "candidate" ? projection.ref : undefined;
  }
}
