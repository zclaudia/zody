import type { ControlChannelAckResult, ControlChannelRequest } from "./control-channel.js";

/**
 * Candidate, default-disabled producer control owner.
 *
 * Only inject `onRequest` into a `createControlChannel` producer endpoint that
 * already verified the request. This module does not authenticate transport,
 * create keys, call a Helper, or expose native receipt writes.
 */

export declare const PRODUCER_CONTROL_LIMITS: Readonly<{
  minLineages: number;
  defaultLineages: number;
  maxLineages: number;
}>;

export interface CreateProducerControlOwnerOptions {
  /** Bounded tombstone capacity. Old lineages are never evicted or reopened. */
  readonly maxLineages?: number;
}

export interface ProducerLineageDiagnostic {
  readonly submissionLineageId: string;
  /** Revision at which revocation evidence is held; sticky and never restored. */
  readonly authorizationRevision: number;
  /** Highest authenticated revision observed for ordering; may exceed revocation evidence. */
  readonly observedRevision: number;
  readonly authorizationRevoked: boolean;
  readonly admissionClosed: boolean;
  readonly stopPending: boolean;
  /** No Helper exists in this build; this is always unknown. */
  readonly nativeFence: "unknown";
}

export interface ProducerControlDiagnostics {
  readonly closed: boolean;
  readonly admissionClosed: boolean;
  /** There is no executable native admission path in this candidate slice. */
  readonly executableAdmission: false;
  readonly nativeHelper: "unavailable";
  readonly nativeFence: "unknown";
  /** A candidate is not a native grant. */
  readonly candidateIsGrant: false;
  readonly maxLineages: number;
  readonly lineageCount: number;
  readonly revokedLineageCount: number;
  readonly stopPendingLineageCount: number;
  readonly lineages: readonly ProducerLineageDiagnostic[];
}

export interface ProducerControlOwner {
  readonly closed: boolean;
  /** Narrow handler for `createControlChannel({ onRequest })`. */
  onRequest(request: ControlChannelRequest): ControlChannelAckResult;
  /** Latch global admission closed. Wire this to the endpoint `onClosed`. */
  close(): void;
  /** Idempotent alias for `close()`. */
  dispose(): void;
  /** Frozen read-only snapshot; it cannot write native facts. */
  diagnostics(): ProducerControlDiagnostics;
}

export declare class ProducerControlError extends Error {
  readonly code: "invalid_options" | "invalid_request";
  constructor(code: string, message: string, options?: { cause?: unknown });
}

export declare function createProducerControlOwner(
  options?: CreateProducerControlOwnerOptions,
): ProducerControlOwner;
