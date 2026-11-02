import type { CuaSubmissionOrigin } from "@zody/contracts";
import type { RevokedProjection } from "./cua-submission-types.js";

export const DEFAULT_MAX_PENDING_LIVE_SUBMISSIONS = 256;
export const DEFAULT_MAX_CONSUMED_ASSOCIATIONS = 256;

export interface CuaSubmissionRuntimeOptions {
  readonly appIncarnation: string;
  readonly hostInstanceId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly workspaceKey: string;
  readonly maxLineages?: number;
  readonly maxActiveTurnsPerLineage?: number;
  readonly maxPendingLiveSubmissions?: number;
  readonly onRevocation?: (projection: RevokedProjection) => void;
}

export interface CuaLiveSubmissionRegistrationRequest {
  readonly origin: CuaSubmissionOrigin;
  readonly inputKind: "new-submission";
  readonly sourceCommandId: string;
  readonly queueItemId?: string;
}

declare const CUA_LIVE_SUBMISSION_TICKET: unique symbol;

/** 不可序列化的 owner 对象身份；copy/JSON/transcript 都无法重新获得登记资格。 */
export interface CuaLiveSubmissionTicket {
  readonly [CUA_LIVE_SUBMISSION_TICKET]: "cua-live-submission";
}

export type CuaLiveSubmissionRegistrationResult =
  | { readonly accepted: true; readonly ticket: CuaLiveSubmissionTicket }
  | {
      readonly accepted: false;
      readonly reason:
        | "ineligible_origin"
        | "ineligible_input_kind"
        | "invalid_input"
        | "duplicate"
        | "consumed"
        | "capacity"
        | "disposed";
    };

export interface CuaLiveSubmissionRegistrar {
  register(input: CuaLiveSubmissionRegistrationRequest): CuaLiveSubmissionRegistrationResult;
  /** 仅用于可信调用方取消自己持有的未消费凭证；已消费/旧 owner 返回 false。 */
  cancel(ticket: CuaLiveSubmissionTicket): boolean;
}

export interface CuaSubmissionAdmissionObservation {
  readonly sourceCommandId?: string;
  readonly queueItemId?: string;
  readonly inputOrigin?: "desktop" | "mobile";
}

export function resolveCuaSubmissionOrigin(
  inputOrigin: "desktop" | "mobile" | undefined,
): CuaSubmissionOrigin {
  return inputOrigin === "desktop" || inputOrigin === "mobile" ? inputOrigin : "unknown";
}

export function cuaAssociationFromAdmission(
  intent:
    | { sourceCommandId?: string; queueItemId?: string; inputOrigin?: "desktop" | "mobile" }
    | undefined,
  inputId: string | undefined,
): CuaSubmissionAdmissionObservation {
  return {
    sourceCommandId: intent?.sourceCommandId ?? inputId,
    queueItemId: intent?.queueItemId,
    inputOrigin: intent?.inputOrigin,
  };
}

export function hasCompleteCuaSubmissionIdentity(options: CuaSubmissionRuntimeOptions): boolean {
  return [
    options.appIncarnation,
    options.hostInstanceId,
    options.runtimeInstanceId,
    options.sessionId,
    options.workspaceKey,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}

export function readPositiveCuaLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("CuaSubmissionCoordinator requires a positive safe integer pending limit");
  }
  return resolved;
}

export function cuaConsumedAssociationKey(
  sourceCommandId: string,
  queueItemId: string | undefined,
): string {
  return `command:${sourceCommandId}\u0000queue:${queueItemId ?? ""}`;
}

export function rememberBoundedCuaKey(target: Map<string, true>, key: string, limit: number): void {
  target.set(key, true);
  while (target.size > limit) {
    const oldest = target.keys().next().value;
    if (oldest === undefined) break;
    target.delete(oldest);
  }
}
