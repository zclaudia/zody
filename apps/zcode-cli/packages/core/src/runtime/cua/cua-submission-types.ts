import type {
  CuaSubmissionOrigin,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionRevocationResult,
  CuaSubmissionRevokeReason,
} from "@zcode/contracts";

export const DEFAULT_MAX_LINEAGES = 256;
export const DEFAULT_MAX_ACTIVE_TURNS_PER_LINEAGE = 32;
export const DEFAULT_MAX_DEAD_PRODUCER_INCARNATIONS = 256;

export type RevokedProjection = Extract<CuaSubmissionProjection, { status: "revoked" }>;
export type UnknownProjection = Extract<CuaSubmissionProjection, { status: "unknown" }>;
export type CleanupFailureReason =
  | "unknown_lineage"
  | "stale_revision"
  | "invalid_input"
  | "disposed";

export interface CuaSubmissionAuthorityOptions {
  appIncarnation: string;
  hostInstanceId: string;
  runtimeInstanceId: string;
  sessionId: string;
  workspaceKey: string;
  maxLineages?: number;
  maxActiveTurnsPerLineage?: number;
  maxDeadProducerIncarnations?: number;
  onRevocation?: (projection: RevokedProjection) => void;
}

export interface CuaSubmissionBindTurnRequest {
  ref: CuaSubmissionRef;
  producerIncarnation: string;
  runId: string;
  turnId: string;
}

export type CuaSubmissionBindTurnResult =
  | { ok: true; ref: CuaSubmissionRef; reusedBinding: boolean }
  | {
      ok: false;
      reason:
        | "unknown_lineage"
        | "stale_revision"
        | "revoked"
        | "producer_mismatch"
        | "dead_producer"
        | "producer_registry_exhausted"
        | "binding_capacity"
        | "invalid_input"
        | "disposed";
    };

export interface CuaSubmissionEndTurnRequest {
  ref: CuaSubmissionRef;
  runId: string;
  turnId: string;
}

export type CuaSubmissionEndTurnResult =
  | { ok: true; ref: CuaSubmissionRef; removed: boolean }
  | { ok: false; reason: CleanupFailureReason };

export interface CuaSubmissionSteerRequest {
  ref: CuaSubmissionRef;
  origin: CuaSubmissionOrigin;
}

export type CuaSubmissionSteerResult =
  | {
      ok: true;
      ref: CuaSubmissionRef;
      lineageState: "candidate" | "revoked";
      revocation?: CuaSubmissionRevocationResult;
    }
  | { ok: false; reason: CleanupFailureReason };

export interface CuaSubmissionProducerLossRequest {
  producerIncarnation: string;
  reason: "producer-lost" | "control-lost";
}

export interface LineageRecord {
  ref: CuaSubmissionRef;
  state: "candidate" | "revoked";
  sourceCommandId: string;
  queueItemId?: string;
  producerIncarnation?: string;
  revocationReason?: CuaSubmissionRevokeReason;
  bindings: Set<string>;
}
