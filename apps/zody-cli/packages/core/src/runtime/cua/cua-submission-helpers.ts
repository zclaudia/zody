import type {
  CuaSubmissionOrigin,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionRevocationResult,
  CuaSubmissionRevokeReason,
} from "@zody/contracts";
import type {
  LineageRecord,
  RevokedProjection,
  UnknownProjection,
} from "./cua-submission-types.js";

export function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSubmissionOrigin(value: unknown): value is CuaSubmissionOrigin {
  return value === "desktop" || value === "mobile" || value === "unknown";
}

export function isSubmissionInputKind(value: unknown): boolean {
  return (
    value === "new-submission" ||
    value === "steer" ||
    value === "continuation" ||
    value === "retry" ||
    value === "replay" ||
    value === "recovery"
  );
}

export function isRevokeReason(value: unknown): value is CuaSubmissionRevokeReason {
  return (
    value === "user-stop" ||
    value === "mobile-steer" ||
    value === "unknown-input" ||
    value === "producer-lost" ||
    value === "control-lost" ||
    value === "runtime-dispose"
  );
}

export function isValidRef(ref: CuaSubmissionRef): boolean {
  return (
    isNonEmpty(ref.submissionLineageId) &&
    Number.isSafeInteger(ref.authorizationRevision) &&
    ref.authorizationRevision > 0 &&
    isNonEmpty(ref.appIncarnation) &&
    isNonEmpty(ref.hostInstanceId) &&
    isNonEmpty(ref.runtimeInstanceId) &&
    isNonEmpty(ref.sessionId) &&
    isNonEmpty(ref.workspaceKey)
  );
}

export function sameIdentity(left: CuaSubmissionRef, right: CuaSubmissionRef): boolean {
  return (
    left.submissionLineageId === right.submissionLineageId &&
    left.appIncarnation === right.appIncarnation &&
    left.hostInstanceId === right.hostInstanceId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.sessionId === right.sessionId &&
    left.workspaceKey === right.workspaceKey
  );
}

/** producerPort 只接受本 scope 捕获的完整 ref；revision 也是身份的一部分。 */
export function sameFullRef(left: CuaSubmissionRef, right: CuaSubmissionRef): boolean {
  return sameIdentity(left, right) && left.authorizationRevision === right.authorizationRevision;
}

export function submissionDedupKeys(sourceCommandId: string, queueItemId?: string): string[] {
  const keys = [`command:${sourceCommandId}`];
  if (queueItemId !== undefined) keys.push(`queue:${queueItemId}`);
  return keys;
}

export function turnBindingKey(runId: string, turnId: string): string {
  return `${runId.length}:${runId}:${turnId.length}:${turnId}`;
}

export function readCapacity(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`CuaSubmissionAuthority requires positive safe integer ${name}`);
  }
  return resolved;
}

export function unknownProjection(): UnknownProjection {
  return Object.freeze({
    status: "unknown",
    nativeFence: "unknown",
    mobileDelivery: "unknown",
  });
}

export function unknownRevocation(): CuaSubmissionRevocationResult {
  return { status: "unknown", projection: unknownProjection() };
}

export function candidateProjection(ref: CuaSubmissionRef): CuaSubmissionProjection {
  return Object.freeze({
    status: "candidate",
    ref: copyRef(ref),
    nativeFence: "unknown",
    mobileDelivery: "unknown",
  });
}

export function revokedProjection(
  record: LineageRecord,
  revocationReason: CuaSubmissionRevokeReason,
): RevokedProjection {
  return Object.freeze({
    status: "revoked",
    ref: copyRef(record.ref),
    revocationReason,
    nativeFence: "unknown",
    mobileDelivery: "unknown",
  });
}

export function copyRef(ref: CuaSubmissionRef): CuaSubmissionRef {
  return Object.freeze({ ...ref });
}
