import type { KeyObject } from "node:crypto";
import type { Duplex } from "node:stream";

import type {
  ControlAckBody,
  ControlAckEvaluation,
  ControlAckFacts,
  ControlBinding,
  ControlOperation,
  ControlPhase,
  ControlRequestBody,
  ControlTrustStore,
  VerifiedControlEnvelope,
} from "./control-protocol.js";

export declare const CONTROL_CHANNEL_LIMITS: Readonly<{
  minFrameBytes: number;
  maxFrameBytes: number;
  defaultFrameBytes: number;
  minOutboundBytes: number;
  maxOutboundBytes: number;
  defaultOutboundBytes: number;
  minPendingRequests: number;
  maxPendingRequests: number;
  defaultPendingRequests: number;
  minIncomingRequests: number;
  maxIncomingRequests: number;
  defaultIncomingRequests: number;
  minAckCache: number;
  maxAckCache: number;
  defaultAckCache: number;
  minRequestTimeoutMs: number;
  maxRequestTimeoutMs: number;
  defaultRequestTimeoutMs: number;
  maxFramesPerChunk: number;
}>;

export type ControlChannelRole = "controller" | "producer";

export type ControlChannelCloseCode =
  | "local_close"
  | "disposed"
  | "peer_eof"
  | "transport_closed"
  | "transport_error"
  | "protocol_error"
  | "frame_too_large"
  | "outbound_overflow"
  | "incoming_overflow"
  | "handler_error"
  | "request_timeout"
  | "request_aborted";

export interface ControlChannelRequest {
  readonly body: ControlRequestBody;
  readonly keyId: string;
  readonly digest: string;
  readonly signal: AbortSignal;
}

export interface ControlChannelAckResult {
  readonly phase: ControlPhase;
  readonly facts: ControlAckFacts;
}

export interface ControlChannelRequestInput {
  readonly operation: ControlOperation;
  readonly submissionLineageId: string;
  readonly authorizationRevision: number;
  readonly signal?: AbortSignal;
}

export interface ControlChannelRequestResult {
  readonly messageId: string;
  readonly sequence: number;
  readonly ack: VerifiedControlEnvelope<ControlAckBody>;
  readonly evaluation: ControlAckEvaluation;
}

export interface ControlChannelClosedEvent {
  readonly code: ControlChannelCloseCode;
  readonly message: string;
  readonly cause: Error | null;
  readonly pendingRequests: number;
}

export interface CreateControlChannelOptions {
  readonly duplex: Duplex;
  readonly role: ControlChannelRole;
  readonly binding: ControlBinding;
  /** Local signing keyId, supplied by trusted startup code. */
  readonly keyId: string;
  /** In-memory Ed25519 private key. There is no default or discovery path. */
  readonly privateKey: KeyObject | string | Buffer;
  /** Peer keyId -> Ed25519 public key. Private key material is rejected. */
  readonly trustedKeys: ControlTrustStore;
  readonly onRequest: (
    request: ControlChannelRequest,
  ) => ControlChannelAckResult | Promise<ControlChannelAckResult>;
  readonly onClosed?: (event: ControlChannelClosedEvent) => void | Promise<void>;
  readonly replayWindowSize?: number;
  readonly maxPendingRequests?: number;
  readonly maxIncomingRequests?: number;
  readonly maxAckCache?: number;
  readonly maxFrameBytes?: number;
  readonly maxOutboundBytes?: number;
  /** Bounded failure deadline. Expiry closes the channel; it is never a success. */
  readonly requestTimeoutMs?: number;
}

export interface ControlChannel {
  readonly role: ControlChannelRole;
  /** Frozen normalized copy; later caller mutations do not affect the channel. */
  readonly binding: ControlBinding;
  readonly closed: boolean;
  readonly closeCode: ControlChannelCloseCode | null;
  request(input: ControlChannelRequestInput): Promise<ControlChannelRequestResult>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export declare class ControlChannelError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown });
}

export declare class ControlChannelClosedError extends ControlChannelError {
  readonly closeCode: ControlChannelCloseCode;
  constructor(closeCode: ControlChannelCloseCode, message: string, options?: { cause?: unknown });
}

export declare function createControlChannel(options: CreateControlChannelOptions): ControlChannel;
