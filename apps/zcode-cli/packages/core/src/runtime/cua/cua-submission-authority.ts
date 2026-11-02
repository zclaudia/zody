import { randomUUID } from "node:crypto";
import type {
  CuaLiveAdmissionRequest,
  CuaSubmissionAdmissionResult,
  CuaSubmissionProducerPort,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionResolveRequest,
  CuaSubmissionRevocationResult,
  CuaSubmissionRevokeReason,
  CuaSubmissionRevokeRequest,
} from "@zcode/contracts";
import {
  candidateProjection,
  copyRef,
  isNonEmpty,
  isRevokeReason,
  isSubmissionInputKind,
  isSubmissionOrigin,
  isValidRef,
  readCapacity,
  revokedProjection,
  sameIdentity,
  submissionDedupKeys,
  turnBindingKey,
  unknownProjection,
  unknownRevocation,
} from "./cua-submission-helpers.js";
import {
  DEFAULT_MAX_ACTIVE_TURNS_PER_LINEAGE,
  DEFAULT_MAX_DEAD_PRODUCER_INCARNATIONS,
  DEFAULT_MAX_LINEAGES,
  type CleanupFailureReason,
  type CuaSubmissionAuthorityOptions,
  type CuaSubmissionBindTurnRequest,
  type CuaSubmissionBindTurnResult,
  type CuaSubmissionEndTurnRequest,
  type CuaSubmissionEndTurnResult,
  type CuaSubmissionProducerLossRequest,
  type CuaSubmissionSteerRequest,
  type CuaSubmissionSteerResult,
  type LineageRecord,
  type RevokedProjection,
} from "./cua-submission-types.js";

export class CuaSubmissionAuthority implements CuaSubmissionProducerPort {
  private readonly identity: Omit<
    CuaSubmissionRef,
    "submissionLineageId" | "authorizationRevision"
  >;
  private readonly maxLineages: number;
  private readonly maxActiveTurnsPerLineage: number;
  private readonly maxDeadProducerIncarnations: number;
  private readonly onRevocation?: (projection: RevokedProjection) => void;
  private readonly lineages = new Map<string, LineageRecord>();
  private readonly dedupKeys = new Map<string, string>();
  private readonly deadProducerIncarnations = new Set<string>();
  private producerRegistryExhausted = false;
  private disposed = false;

  constructor(options: CuaSubmissionAuthorityOptions) {
    for (const [field, value] of Object.entries({
      appIncarnation: options.appIncarnation,
      hostInstanceId: options.hostInstanceId,
      runtimeInstanceId: options.runtimeInstanceId,
      sessionId: options.sessionId,
      workspaceKey: options.workspaceKey,
    })) {
      if (!isNonEmpty(value)) throw new Error(`CuaSubmissionAuthority requires ${field}`);
    }
    this.identity = {
      appIncarnation: options.appIncarnation,
      hostInstanceId: options.hostInstanceId,
      runtimeInstanceId: options.runtimeInstanceId,
      sessionId: options.sessionId,
      workspaceKey: options.workspaceKey,
    };
    this.maxLineages = readCapacity(options.maxLineages, DEFAULT_MAX_LINEAGES, "maxLineages");
    this.maxActiveTurnsPerLineage = readCapacity(
      options.maxActiveTurnsPerLineage,
      DEFAULT_MAX_ACTIVE_TURNS_PER_LINEAGE,
      "maxActiveTurnsPerLineage",
    );
    this.maxDeadProducerIncarnations = readCapacity(
      options.maxDeadProducerIncarnations,
      DEFAULT_MAX_DEAD_PRODUCER_INCARNATIONS,
      "maxDeadProducerIncarnations",
    );
    this.onRevocation = options.onRevocation;
  }

  /**
   * 只由可信 Host/runtime admission 边界调用。source/queue id 不生成权限，只用于拒绝重送。
   */
  admitLive(request: CuaLiveAdmissionRequest): CuaSubmissionAdmissionResult {
    if (this.disposed) return { accepted: false, reason: "disposed" };
    if (!isSubmissionOrigin(request.origin)) return { accepted: false, reason: "invalid_input" };
    if (request.origin !== "desktop") return { accepted: false, reason: "ineligible_origin" };
    if (!isSubmissionInputKind(request.inputKind)) {
      return { accepted: false, reason: "invalid_input" };
    }
    if (request.inputKind !== "new-submission") {
      return { accepted: false, reason: "ineligible_input_kind" };
    }
    if (!isNonEmpty(request.sourceCommandId)) return { accepted: false, reason: "invalid_input" };
    if (request.queueItemId !== undefined && !isNonEmpty(request.queueItemId)) {
      return { accepted: false, reason: "invalid_input" };
    }

    const dedupKeys = submissionDedupKeys(request.sourceCommandId, request.queueItemId);
    const existing = this.findByDedupKeys(dedupKeys);
    if (existing) {
      return { accepted: false, reason: "duplicate", existingRef: copyRef(existing.ref) };
    }
    if (this.lineages.size >= this.maxLineages) return { accepted: false, reason: "capacity" };

    const submissionLineageId = this.createLineageId();
    const ref = copyRef({
      ...this.identity,
      submissionLineageId,
      authorizationRevision: 1,
    });
    this.lineages.set(submissionLineageId, {
      ref,
      state: "candidate",
      sourceCommandId: request.sourceCommandId,
      queueItemId: request.queueItemId,
      bindings: new Set(),
    });
    for (const key of dedupKeys) this.dedupKeys.set(key, submissionLineageId);
    return { accepted: true, ref: copyRef(ref) };
  }

  bindTurn(request: CuaSubmissionBindTurnRequest): CuaSubmissionBindTurnResult {
    if (this.disposed) return { ok: false, reason: "disposed" };
    if (
      !isNonEmpty(request.producerIncarnation) ||
      !isNonEmpty(request.runId) ||
      !isNonEmpty(request.turnId)
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    if (this.producerRegistryExhausted) {
      return { ok: false, reason: "producer_registry_exhausted" };
    }
    if (this.deadProducerIncarnations.has(request.producerIncarnation)) {
      return { ok: false, reason: "dead_producer" };
    }
    const found = this.findRecordForCleanup(request.ref);
    if (!found.ok) return { ok: false, reason: found.reason };
    const record = found.record;
    if (request.ref.authorizationRevision !== record.ref.authorizationRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    if (record.state === "revoked") return { ok: false, reason: "revoked" };
    if (record.producerIncarnation && record.producerIncarnation !== request.producerIncarnation) {
      return { ok: false, reason: "producer_mismatch" };
    }

    const bindingKey = turnBindingKey(request.runId, request.turnId);
    if (record.bindings.has(bindingKey)) {
      return { ok: true, ref: copyRef(record.ref), reusedBinding: true };
    }
    if (record.bindings.size >= this.maxActiveTurnsPerLineage) {
      return { ok: false, reason: "binding_capacity" };
    }
    record.producerIncarnation ??= request.producerIncarnation;
    record.bindings.add(bindingKey);
    return { ok: true, ref: copyRef(record.ref), reusedBinding: false };
  }

  /** 清理路径容忍撤销后 revision 前进，只要求身份匹配且请求 revision 不超前。 */
  endTurn(request: CuaSubmissionEndTurnRequest): CuaSubmissionEndTurnResult {
    if (this.disposed) return { ok: false, reason: "disposed" };
    if (!isNonEmpty(request.runId) || !isNonEmpty(request.turnId)) {
      return { ok: false, reason: "invalid_input" };
    }
    const found = this.findRecordForCleanup(request.ref);
    if (!found.ok) return found;
    const removed = found.record.bindings.delete(turnBindingKey(request.runId, request.turnId));
    return { ok: true, ref: copyRef(found.record.ref), removed };
  }

  steer(request: CuaSubmissionSteerRequest): CuaSubmissionSteerResult {
    if (this.disposed) return { ok: false, reason: "disposed" };
    if (!isSubmissionOrigin(request.origin)) return { ok: false, reason: "invalid_input" };
    const found = this.findRecordForCleanup(request.ref);
    if (!found.ok) return found;

    if (request.origin === "desktop") {
      return {
        ok: true,
        ref: copyRef(found.record.ref),
        lineageState: found.record.state,
      };
    }
    const revocation = this.revokeRecord(
      found.record,
      request.origin === "mobile" ? "mobile-steer" : "unknown-input",
    );
    return {
      ok: true,
      ref: copyRef(found.record.ref),
      lineageState: "revoked",
      revocation,
    };
  }

  producerLost(request: CuaSubmissionProducerLossRequest): CuaSubmissionRef[] {
    if (this.disposed || !isNonEmpty(request.producerIncarnation)) return [];
    if (!this.deadProducerIncarnations.has(request.producerIncarnation)) {
      if (this.deadProducerIncarnations.size >= this.maxDeadProducerIncarnations) {
        this.producerRegistryExhausted = true;
      } else {
        this.deadProducerIncarnations.add(request.producerIncarnation);
      }
    }
    const affected = [...this.lineages.values()].filter(
      (record) =>
        record.state === "candidate" && record.producerIncarnation === request.producerIncarnation,
    );
    const revoked: CuaSubmissionRef[] = [];
    for (const record of affected) {
      try {
        const result = this.revokeRecord(record, request.reason);
        if (result.status === "revoked") revoked.push(copyRef(result.ref));
      } catch {
        // 单个处置异常不能阻断其它 producer 关联 lineage 的撤销。
      }
    }
    return revoked;
  }

  /** 交给 producer 的窄面只有读取/撤销，不泄露 admit/bind 等可信 owner 方法。 */
  createProducerPort(): CuaSubmissionProducerPort {
    return Object.freeze({
      resolve: (request: CuaSubmissionResolveRequest) => this.resolve(request),
      revoke: (request: CuaSubmissionRevokeRequest) => this.revoke(request),
    });
  }

  async resolve(request: CuaSubmissionResolveRequest): Promise<CuaSubmissionProjection> {
    return this.projectNow(request);
  }

  /** runtime stop/shutdown 等同步边界读取同一 owner 事实，不建立授权。 */
  projectNow(request: CuaSubmissionResolveRequest): CuaSubmissionProjection {
    if (this.disposed) return unknownProjection();
    const record = this.lineages.get(request.ref.submissionLineageId);
    if (!record || !sameIdentity(record.ref, request.ref)) return unknownProjection();
    if (record.ref.authorizationRevision !== request.ref.authorizationRevision) {
      return unknownProjection();
    }
    return this.project(record);
  }

  async revoke(request: CuaSubmissionRevokeRequest): Promise<CuaSubmissionRevocationResult> {
    return this.revokeNow(request);
  }

  /** 先提交撤销事实再返回，供同步 stop 在 abort 前调用。 */
  revokeNow(request: CuaSubmissionRevokeRequest): CuaSubmissionRevocationResult {
    if (this.disposed || !isRevokeReason(request.reason)) return unknownRevocation();
    const found = this.findRecordForCleanup(request.ref);
    if (!found.ok) return unknownRevocation();
    return this.revokeRecord(found.record, request.reason);
  }

  dispose(): void {
    if (this.disposed) return;
    // 先封闭所有可信写入口，再通知 observer/撤销，避免回调重入建立新 binding。
    this.disposed = true;
    for (const record of this.lineages.values()) {
      if (record.state === "candidate") this.revokeRecord(record, "runtime-dispose");
    }
    this.lineages.clear();
    this.dedupKeys.clear();
    this.deadProducerIncarnations.clear();
    this.producerRegistryExhausted = false;
  }

  private revokeRecord(
    record: LineageRecord,
    reason: CuaSubmissionRevokeReason,
  ): CuaSubmissionRevocationResult {
    const idempotent = record.state === "revoked";
    if (!idempotent) {
      const nextRevision = record.ref.authorizationRevision + 1;
      record.ref = copyRef({
        ...record.ref,
        // 正常路径从 1 递增；达到上限时保持 revision，但状态仍 locked revoked。
        authorizationRevision: Number.isSafeInteger(nextRevision)
          ? nextRevision
          : record.ref.authorizationRevision,
      });
      record.state = "revoked";
      record.revocationReason = reason;
      this.notifyRevocation(record);
    }
    if (!record.revocationReason) return unknownRevocation();
    return {
      status: "revoked",
      ref: copyRef(record.ref),
      revocationReason: record.revocationReason,
      idempotent,
      projection: revokedProjection(record, record.revocationReason),
    };
  }

  private notifyRevocation(record: LineageRecord): void {
    if (!this.onRevocation || !record.revocationReason) return;
    const projection = revokedProjection(record, record.revocationReason);
    try {
      this.onRevocation(projection);
    } catch {
      // 撤销事实已经提交；观察者异常不得回滚或阻断后续 lineage 撤销。
    }
  }

  private project(record: LineageRecord): CuaSubmissionProjection {
    if (record.state === "candidate") {
      return candidateProjection(record.ref);
    }
    return record.revocationReason
      ? revokedProjection(record, record.revocationReason)
      : unknownProjection();
  }

  private findRecordForCleanup(
    ref: CuaSubmissionRef,
  ): { ok: true; record: LineageRecord } | { ok: false; reason: CleanupFailureReason } {
    if (!isValidRef(ref)) return { ok: false, reason: "invalid_input" };
    const record = this.lineages.get(ref.submissionLineageId);
    if (!record || !sameIdentity(record.ref, ref)) return { ok: false, reason: "unknown_lineage" };
    if (ref.authorizationRevision > record.ref.authorizationRevision) {
      return { ok: false, reason: "stale_revision" };
    }
    return { ok: true, record };
  }

  private findByDedupKeys(keys: readonly string[]): LineageRecord | undefined {
    for (const key of keys) {
      const lineageId = this.dedupKeys.get(key);
      if (!lineageId) continue;
      const record = this.lineages.get(lineageId);
      if (record) return record;
    }
    return undefined;
  }

  private createLineageId(): string {
    let lineageId = randomUUID();
    while (this.lineages.has(lineageId)) lineageId = randomUUID();
    return lineageId;
  }
}
