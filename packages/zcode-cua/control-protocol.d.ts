import type { KeyObject } from "node:crypto";

/**
 * Candidate, default-disabled CUA control protocol contract.
 *
 * These types are compile-time help only. Runtime validation in
 * control-protocol.js is authoritative and fails closed.
 */

export declare const CONTROL_PROTOCOL: "zody.cua.control";
export declare const CONTROL_PROTOCOL_VERSION: 1;
export declare const CONTROL_DIGEST_DOMAIN: "zody.cua.control.v1/digest";
export declare const CONTROL_SIGNATURE_DOMAIN: "zody.cua.control.v1/signature";

export declare const CONTROL_LIMITS: Readonly<{
  maxCanonicalBytes: number;
  maxCanonicalNodes: number;
  maxDepth: number;
  maxStringBytes: number;
  maxIdentifierBytes: number;
  maxObjectKeys: number;
  maxArrayLength: number;
  maxReplayRecords: number;
  minReplayWindow: number;
  maxReplayWindow: number;
  defaultReplayWindow: number;
}>;

export interface ControlBinding {
  channelId: string;
  /** Opaque non-empty runtime authority string; never parsed as a counter. */
  controllerIncarnation: string;
  /** Opaque non-empty runtime authority string; never parsed as a counter. */
  producerIncarnation: string;
  /** Opaque non-empty runtime authority string; never parsed as a counter. */
  appIncarnation: string;
}

export type ControlDirection = "controller_to_producer" | "producer_to_controller";
export type ControlOperation = "revoke_submission" | "stop";
export type ControlPhase =
  | "admission_closed"
  | "projection_applied"
  | "revoked"
  | "stop_pending"
  | "fenced"
  | "drained"
  | "unknown"
  | "rejected"
  | "retained_fault";

export interface ControlRequestPayload {
  operation: ControlOperation;
}

export interface ControlRequestBody {
  keyId: string;
  kind: "request";
  direction: ControlDirection;
  binding: ControlBinding;
  messageId: string;
  sequence: number;
  submissionLineageId: string;
  authorizationRevision: number;
  payload: ControlRequestPayload;
  payloadDigest: string;
}

export interface ControlStopFacts {
  nativeFenced: boolean;
  pending: boolean;
  ownedInputsReleased: boolean;
  leaseReleased: boolean;
}

export interface ControlAckFacts {
  projection: {
    admissionClosed: boolean;
    projectionApplied: boolean;
  };
  revoked: {
    authorizationRevoked: boolean;
  };
  stop: ControlStopFacts | null;
}

export interface ControlAckBody {
  keyId: string;
  kind: "ack";
  direction: ControlDirection;
  binding: ControlBinding;
  messageId: string;
  sequence: number;
  replyToMessageId: string;
  replyToSequence: number;
  replyToPayloadDigest: string;
  submissionLineageId: string;
  authorizationRevision: number;
  phase: ControlPhase;
  facts: ControlAckFacts;
}

export type ControlBody = ControlRequestBody | ControlAckBody;

export interface ControlEnvelope<T extends ControlBody = ControlBody> {
  protocol: "zody.cua.control";
  version: 1;
  body: T;
  signature: string;
}

export type ControlPublicKey = KeyObject | string | Buffer;
/** Each value must resolve to an Ed25519 public key. */
export type ControlTrustStore = Readonly<Record<string, ControlPublicKey>>;

export interface VerifyControlEnvelopeOptions {
  trustedKeys: ControlTrustStore;
  expectedKind: "request" | "ack";
  expectedDirection: ControlDirection;
  expectedBinding: ControlBinding;
}

export interface VerifiedControlEnvelope<T extends ControlBody = ControlBody> {
  readonly body: T;
  readonly keyId: string;
  /** Digest of the complete canonical signed body, not the request payload. */
  readonly digest: string;
}

export interface CreateControlRequestInput {
  keyId: string;
  direction: ControlDirection;
  binding: ControlBinding;
  messageId: string;
  sequence: number;
  submissionLineageId: string;
  authorizationRevision: number;
  operation: ControlOperation;
}

export declare class ControlProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export declare function canonicalizeControlJson(value: unknown): string;
export declare function digestControlPayload(value: unknown): string;

export declare function createControlRequest(
  input: CreateControlRequestInput,
  privateKey: KeyObject | string | Buffer,
): ControlEnvelope<ControlRequestBody>;

export declare function signControlBody<T extends ControlBody>(
  body: T,
  privateKey: KeyObject | string | Buffer,
): ControlEnvelope<T>;

export declare function verifyControlEnvelope(
  envelope: unknown,
  options: VerifyControlEnvelopeOptions & { expectedKind: "request" },
): VerifiedControlEnvelope<ControlRequestBody>;
export declare function verifyControlEnvelope(
  envelope: unknown,
  options: VerifyControlEnvelopeOptions & { expectedKind: "ack" },
): VerifiedControlEnvelope<ControlAckBody>;

export type ControlReplayDecision = "exact" | "duplicate" | "conflict" | "stale";

export interface ControlReplayRecord {
  sequence: number;
  messageId: string;
  /** Digest of the complete canonical signed body. */
  bodyDigest: string;
}

export interface ControlReplayWindowState {
  windowSize: number;
  binding: ControlBinding;
  direction: ControlDirection;
  lastSequence: number;
  records: readonly ControlReplayRecord[];
}

export interface CreateControlReplayWindowInput {
  windowSize: number;
  binding: ControlBinding;
  direction: ControlDirection;
}

export interface ControlReplayEntry {
  sequence: number;
  messageId: string;
  /** Digest from VerifiedControlEnvelope.digest for the complete signed body. */
  bodyDigest: string;
  binding: ControlBinding;
  direction: ControlDirection;
}

export interface ControlReplayResult {
  decision: ControlReplayDecision;
  state: ControlReplayWindowState;
}

export declare function createControlReplayWindow(
  input: CreateControlReplayWindowInput,
): ControlReplayWindowState;

export declare function admitControlSequence(
  state: ControlReplayWindowState,
  entry: ControlReplayEntry,
): ControlReplayResult;

export interface ControlRevocationInput {
  submissionLineageId: string;
  authorizationRevision: number;
}

export interface ControlRevocationState extends ControlRevocationInput {
  revoked: boolean;
}

export type ControlRevocationReason = "revoked" | "already_revoked" | "stale_revision";

export interface ControlRevocationResult {
  applied: boolean;
  reason: ControlRevocationReason;
  state: ControlRevocationState;
}

export declare function createControlRevocation(
  input: ControlRevocationInput,
): ControlRevocationState;

export declare function applyControlRevocation(
  state: ControlRevocationState,
  input: ControlRevocationInput,
): ControlRevocationResult;

export interface ControlAckEvaluation {
  operation: ControlOperation;
  projection: {
    admissionClosed: boolean;
    projectionApplied: boolean;
    complete: boolean;
  };
  revoked: {
    authorizationRevoked: boolean;
    complete: boolean;
  };
  stop: null | {
    nativeFenced: boolean;
    pending: boolean;
    ownedInputsReleased: boolean;
    leaseReleased: boolean;
    complete: boolean;
    reasons: readonly string[];
  };
}

/** Call only with bodies returned by verifyControlEnvelope after binding matching. */
export declare function evaluateControlAck(
  requestBody: ControlRequestBody,
  ackBody: ControlAckBody,
): ControlAckEvaluation;
