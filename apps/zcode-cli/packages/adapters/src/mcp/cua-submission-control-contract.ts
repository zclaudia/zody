import type {
  CuaSubmissionProducerPort,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionTurnInvalidationReason,
} from "@zcode/contracts";
import type {
  ControlChannelAckResult,
  ControlChannelRequestResult,
} from "@zcode/zcode-cua/control-channel";
import {
  normalizeControlOnlyOptions,
  type ControlOnlyBeforeSpawn,
  type ControlOnlyLaunchCommand,
  type ControlOnlyLauncherCloseReason,
  type NormalizedControlOnlyOptions,
} from "./control-only-contract.js";

const MAX_IDENTIFIER_BYTES = 256;
const MAX_PATH_BYTES = 4096;
const UNKNOWN_STOP_FACTS = Object.freeze({
  nativeFenced: false,
  pending: true,
  ownedInputsReleased: false,
  leaseReleased: false,
});

export type CuaSubmissionControlFailure =
  | "control_start_failed"
  | "control_lost"
  | "owner_revoked"
  | "control_forward_failed"
  | "authority_revoke_failed"
  | "unsupported_native_ack"
  | "control_ack_rejected"
  | "ref_unknown"
  | "ref_revoked"
  | "ref_mismatch";

export type CuaSubmissionControlErrorCode =
  | "invalid_options"
  | "control_start_failed"
  | "control_lost"
  | "ref_unknown"
  | "ref_revoked"
  | "ref_mismatch"
  | "unsupported_native_ack"
  | "closed";

export class CuaSubmissionControlError extends Error {
  readonly code: CuaSubmissionControlErrorCode;
  readonly traceId: string | null;

  constructor(
    code: CuaSubmissionControlErrorCode,
    message: string,
    options?: { cause?: unknown; traceId?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = "CuaSubmissionControlError";
    this.code = code;
    this.traceId = options?.traceId ?? null;
  }
}

export interface CuaSubmissionControlSessionOptions {
  readonly ref: CuaSubmissionRef;
  readonly producerPort: CuaSubmissionProducerPort;
  readonly launch: ControlOnlyLaunchCommand;
  /** Caller-owned trace; this adapter never mints a replacement. */
  readonly traceId: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 受信 composition/launcher 配置；只在本次真实 spawn 前调用。 */
  readonly beforeSpawn?: ControlOnlyBeforeSpawn;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export interface NormalizedCuaSubmissionControlOptions {
  readonly ref: CuaSubmissionRef;
  readonly producerPort: CuaSubmissionProducerPort;
  readonly traceId: string;
  readonly launcher: NormalizedControlOnlyOptions;
}

export interface CuaSubmissionControlDiagnostics {
  readonly traceId: string;
  readonly control: "created" | "starting" | "active" | "invalidated" | "stopped" | "closed";
  readonly invalidated: boolean;
  readonly ownerRevoked: boolean;
  readonly lastFailure: CuaSubmissionControlFailure | null;
  readonly executable: false;
  readonly candidateIsGrant: false;
  readonly nativeHelper: "unavailable";
  readonly nativeFence: "unknown";
  readonly machineLease: "unavailable";
  readonly stopComplete: false;
}

export interface CuaSubmissionControlStopResult {
  readonly authorityRevoked: boolean;
  readonly controlForwarded: boolean;
  readonly nativeFence: "unknown";
  readonly machineLease: "unavailable";
  readonly stopComplete: false;
}

export function createCuaSubmissionControlStopResult(
  authorityRevoked: boolean,
  controlForwarded: boolean,
): CuaSubmissionControlStopResult {
  return Object.freeze({
    authorityRevoked,
    controlForwarded,
    nativeFence: "unknown",
    machineLease: "unavailable",
    stopComplete: false,
  });
}

export interface CuaSubmissionControlSession {
  readonly traceId: string;
  /** Install this before `start()` in the existing runtime onRevocation callback. */
  readonly onOwnerRevocation: (
    projection: Extract<CuaSubmissionProjection, { status: "revoked" }>,
  ) => void;
  /**
   * 由 runtime turn scope 驱动的失效。owner-revoked 表示 owner 已撤销（不要另造
   * control-lost）；scope-closed 是正常 turn 结束，只关闭 consumer 与 binding。
   */
  readonly onScopeInvalidated: (
    reason: CuaSubmissionTurnInvalidationReason,
  ) => void;
  start(): Promise<void>;
  stop(): Promise<CuaSubmissionControlStopResult>;
  cleanup(): Promise<void>;
  diagnostics(): CuaSubmissionControlDiagnostics;
}

export interface CuaSubmissionControlInvalidation {
  readonly reason: ControlOnlyLauncherCloseReason;
  readonly message: string;
  readonly cause: Error | null;
}

function invalidOptions(message: string): never {
  throw new CuaSubmissionControlError("invalid_options", message);
}

function readBoundedString(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    value.includes("\0")
  ) {
    invalidOptions(`${name} must be a bounded non-empty string`);
  }
  return value;
}

export function copyCompleteCuaSubmissionRef(value: unknown): CuaSubmissionRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidOptions("ref must be a complete CuaSubmissionRef");
  }
  const ref = value as Partial<CuaSubmissionRef>;
  if (
    typeof ref.authorizationRevision !== "number" ||
    !Number.isSafeInteger(ref.authorizationRevision) ||
    ref.authorizationRevision <= 0
  ) {
    invalidOptions("ref.authorizationRevision must be a positive safe integer");
  }
  return Object.freeze({
    submissionLineageId: readBoundedString(
      ref.submissionLineageId,
      "ref.submissionLineageId",
      MAX_IDENTIFIER_BYTES,
    ),
    authorizationRevision: ref.authorizationRevision,
    appIncarnation: readBoundedString(
      ref.appIncarnation,
      "ref.appIncarnation",
      MAX_IDENTIFIER_BYTES,
    ),
    hostInstanceId: readBoundedString(
      ref.hostInstanceId,
      "ref.hostInstanceId",
      MAX_IDENTIFIER_BYTES,
    ),
    runtimeInstanceId: readBoundedString(
      ref.runtimeInstanceId,
      "ref.runtimeInstanceId",
      MAX_IDENTIFIER_BYTES,
    ),
    sessionId: readBoundedString(ref.sessionId, "ref.sessionId", MAX_IDENTIFIER_BYTES),
    workspaceKey: readBoundedString(ref.workspaceKey, "ref.workspaceKey", MAX_PATH_BYTES),
  });
}

export function sameCompleteCuaSubmissionRef(
  left: CuaSubmissionRef,
  right: CuaSubmissionRef,
): boolean {
  return (
    left.submissionLineageId === right.submissionLineageId &&
    left.authorizationRevision === right.authorizationRevision &&
    left.appIncarnation === right.appIncarnation &&
    left.hostInstanceId === right.hostInstanceId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.sessionId === right.sessionId &&
    left.workspaceKey === right.workspaceKey
  );
}

export function sameCuaSubmissionIdentity(
  left: CuaSubmissionRef,
  right: CuaSubmissionRef,
): boolean {
  return (
    left.submissionLineageId === right.submissionLineageId &&
    left.appIncarnation === right.appIncarnation &&
    left.hostInstanceId === right.hostInstanceId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.sessionId === right.sessionId &&
    left.workspaceKey === right.workspaceKey
  );
}

export function adoptCuaSubmissionRevocationRef(
  current: CuaSubmissionRef,
  candidate: unknown,
): CuaSubmissionRef | null {
  let next: CuaSubmissionRef;
  try {
    next = copyCompleteCuaSubmissionRef(candidate);
  } catch {
    return null;
  }
  if (!sameCuaSubmissionIdentity(current, next)) return null;
  if (next.authorizationRevision < current.authorizationRevision) return null;
  return next;
}

export type CuaSubmissionControlResolution =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "control_lost"
        | "ref_unknown"
        | "ref_revoked"
        | "ref_mismatch"
        | "resolve_failed";
      readonly message: string;
    };

export async function resolveCuaSubmissionControlCandidate(
  producerPort: CuaSubmissionProducerPort,
  ref: CuaSubmissionRef,
  invalidated: () => boolean,
): Promise<CuaSubmissionControlResolution> {
  let projection: CuaSubmissionProjection;
  try {
    projection = await producerPort.resolve({ ref });
  } catch {
    return { ok: false, code: "resolve_failed", message: "authority resolve failed" };
  }
  if (invalidated()) {
    return { ok: false, code: "control_lost", message: "control binding invalidated" };
  }
  if (projection.status === "unknown") {
    return { ok: false, code: "ref_unknown", message: "authority does not know the full ref" };
  }
  if (!sameCuaSubmissionIdentity(projection.ref, ref)) {
    return { ok: false, code: "ref_mismatch", message: "authority returned a different ref" };
  }
  if (projection.status === "revoked") {
    return { ok: false, code: "ref_revoked", message: "authority ref is revoked" };
  }
  if (!sameCompleteCuaSubmissionRef(projection.ref, ref)) {
    return { ok: false, code: "ref_mismatch", message: "authority candidate revision changed" };
  }
  return { ok: true };
}

export function createCuaSubmissionControlResolutionError(
  resolution: Exclude<CuaSubmissionControlResolution, { ok: true }>,
  traceId: string,
): CuaSubmissionControlError {
  if (resolution.code === "control_lost") {
    return new CuaSubmissionControlError("control_lost", resolution.message, { traceId });
  }
  const code = resolution.code === "resolve_failed" ? "ref_unknown" : resolution.code;
  return new CuaSubmissionControlError(code, resolution.message, { traceId });
}

export function createCuaSubmissionControlLostError(
  message: string,
  traceId: string,
): CuaSubmissionControlError {
  return new CuaSubmissionControlError("control_lost", message, { traceId });
}

export function normalizeCuaSubmissionControlOptions(
  options: CuaSubmissionControlSessionOptions,
): NormalizedCuaSubmissionControlOptions {
  if (options === null || typeof options !== "object") invalidOptions("options are required");
  const ref = copyCompleteCuaSubmissionRef(options.ref);
  const producerPort = options.producerPort;
  if (
    producerPort === null ||
    typeof producerPort !== "object" ||
    typeof producerPort.resolve !== "function" ||
    typeof producerPort.revoke !== "function"
  ) {
    invalidOptions("producerPort must provide resolve and revoke");
  }
  const traceId = readBoundedString(options.traceId, "traceId", MAX_IDENTIFIER_BYTES);
  const launcher = normalizeControlOnlyOptions({
    appIncarnation: ref.appIncarnation,
    launch: options.launch,
    ...(options.beforeSpawn === undefined ? {} : { beforeSpawn: options.beforeSpawn }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
  });
  return Object.freeze({ launcher, producerPort, ref, traceId });
}

export function unsupportedNativeAckReason(result: ControlChannelRequestResult): string | null {
  const phase = result.ack.body.phase;
  if (phase === "fenced" || phase === "drained") {
    return `control-only ACK claimed unsupported phase ${phase}`;
  }
  const stop = result.ack.body.facts.stop;
  if (stop !== null) {
    if (stop.nativeFenced !== false) return "control-only ACK claimed nativeFenced";
    if (stop.pending !== true) return "control-only ACK claimed stop no longer pending";
    if (stop.ownedInputsReleased !== false) return "control-only ACK claimed ownedInputsReleased";
    if (stop.leaseReleased !== false) return "control-only ACK claimed leaseReleased";
  }
  return null;
}

export function isRejectedControlAck(result: ControlChannelRequestResult): boolean {
  return ["rejected", "unknown", "retained_fault"].includes(result.ack.body.phase);
}

export function rejectedProducerAck(
  operation: "revoke_submission" | "stop",
): ControlChannelAckResult {
  return {
    phase: "rejected",
    facts: {
      projection: { admissionClosed: false, projectionApplied: false },
      revoked: { authorizationRevoked: false },
      stop: operation === "stop" ? { ...UNKNOWN_STOP_FACTS } : null,
    },
  };
}

export function revokedProducerAck(bindingInvalidated: boolean): ControlChannelAckResult {
  if (!bindingInvalidated) return rejectedProducerAck("revoke_submission");
  return {
    phase: "revoked",
    facts: {
      projection: { admissionClosed: true, projectionApplied: true },
      revoked: { authorizationRevoked: true },
      stop: null,
    },
  };
}
