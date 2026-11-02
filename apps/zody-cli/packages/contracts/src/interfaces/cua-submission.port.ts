import type { TraceId, TurnId } from "./shared.js";

/** 可信输入来源；缺省或无法证明时使用 unknown，不能由模型 metadata 推断。 */
export type CuaSubmissionOrigin = "desktop" | "mobile" | "unknown";

/** 只有 desktop + new-submission 可建立新的 CUA lineage candidate。 */
export type CuaSubmissionInputKind =
  | "new-submission"
  | "steer"
  | "continuation"
  | "retry"
  | "replay"
  | "recovery";

/**
 * lineage 的完整可信身份。resolve 必须逐字段匹配并匹配 authorizationRevision；
 * 仅凭 submissionLineageId 或客户端自报字段不能解析出资格。
 */
export interface CuaSubmissionRef {
  readonly submissionLineageId: string;
  readonly authorizationRevision: number;
  readonly appIncarnation: string;
  readonly hostInstanceId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly workspaceKey: string;
}

/** sourceCommandId/queueItemId 只作关联与去重证据，不直接授权。 */
export interface CuaLiveAdmissionRequest {
  origin: CuaSubmissionOrigin;
  inputKind: CuaSubmissionInputKind;
  sourceCommandId: string;
  queueItemId?: string;
}

export type CuaSubmissionAdmissionRejectionReason =
  | "ineligible_origin"
  | "ineligible_input_kind"
  | "invalid_input"
  | "duplicate"
  | "capacity"
  | "disposed";

export type CuaSubmissionAdmissionResult =
  | { accepted: true; ref: CuaSubmissionRef }
  | {
      accepted: false;
      reason: CuaSubmissionAdmissionRejectionReason;
      /** 重送命中既有 lineage 时给出当前 revision，仍不代表可获权。 */
      existingRef?: CuaSubmissionRef;
    };

export type CuaSubmissionRevokeReason =
  | "user-stop"
  | "mobile-steer"
  | "unknown-input"
  | "producer-lost"
  | "control-lost"
  | "runtime-dispose";

export interface CuaSubmissionResolveRequest {
  ref: CuaSubmissionRef;
}

export interface CuaSubmissionRevokeRequest {
  ref: CuaSubmissionRef;
  reason: CuaSubmissionRevokeReason;
}

/**
 * 纯 runtime 内存投影。nativeFence/mobileDelivery 当前没有真实来源，必须保持 unknown；
 * candidate 不是 grant，revoked 也不等于原生已 Fenced。
 */
export interface CuaSubmissionProjectionCommon {
  nativeFence: "unknown";
  mobileDelivery: "unknown";
}

export type CuaSubmissionProjection =
  | (CuaSubmissionProjectionCommon & { status: "candidate"; ref: CuaSubmissionRef })
  | (CuaSubmissionProjectionCommon & {
      status: "revoked";
      ref: CuaSubmissionRef;
      revocationReason: CuaSubmissionRevokeReason;
    })
  | (CuaSubmissionProjectionCommon & { status: "unknown" });

export type CuaSubmissionRevocationResult =
  | {
      status: "revoked";
      ref: CuaSubmissionRef;
      revocationReason: CuaSubmissionRevokeReason;
      idempotent: boolean;
      projection: Extract<CuaSubmissionProjection, { status: "revoked" }>;
    }
  | {
      status: "unknown";
      projection: Extract<CuaSubmissionProjection, { status: "unknown" }>;
    };

/**
 * producer 唯一的 runtime 权限面：只能读取投影或请求撤销，不能创建、绑定或恢复授权。
 */
export interface CuaSubmissionProducerPort {
  resolve(request: CuaSubmissionResolveRequest): Promise<CuaSubmissionProjection>;
  revoke(request: CuaSubmissionRevokeRequest): Promise<CuaSubmissionRevocationResult>;
}

/**
 * turn scope 失效原因只区分两类：
 * - owner-revoked：唯一 authority 已撤销/失去 producer/control，调用方不得再借该 scope 操作；
 * - scope-closed：正常 turn 结束或 consumer 主动 close，只释放本次 binding，不代表 lineage 被撤销。
 */
export type CuaSubmissionTurnInvalidationReason = "owner-revoked" | "scope-closed";

/**
 * 生产 runtime 在真实 regular turn 内签发的一次性内存 scope，不是执行许可。
 *
 * ref/traceId/runId/turnId 全部由 runtime 从当前 admission 事实捕获，调用方不能传入或覆盖；
 * runId 是本切片 wire runId（既有 RuntimeCommand.foregroundExecutionId），不是 workflow runId。
 * 同一 runtime turn 至多一个活动 scope；scope 关闭后不能重新签发来复活旧 turn。
 */
export interface CuaSubmissionTurnScope {
  readonly ref: CuaSubmissionRef;
  readonly traceId: TraceId;
  readonly runId: string;
  readonly turnId: TurnId;
  readonly producerPort: CuaSubmissionProducerPort;
  /**
   * 仅当真实 turn/execution 仍是原对象、owner 仍持原 revision candidate 时才绑定成功。
   * 同一 producer incarnation 幂等返回 true；关闭或失效后恒为 false。
   */
  bindProducer(producerIncarnation: string): boolean;
  /**
   * 订阅失效。终态订阅必须同步立即回调同一 reason；返回退订函数，重复退订幂等。
   */
  onInvalidated(listener: (reason: CuaSubmissionTurnInvalidationReason) => void): () => void;
  /** 幂等正常关闭：释放本 scope 的 binding，不撤销仍有效的 lineage。 */
  close(): void;
}
