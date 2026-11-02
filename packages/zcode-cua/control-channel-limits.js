import { CONTROL_LIMITS } from "./control-protocol.js";

export const CONTROL_CHANNEL_LIMITS = Object.freeze({
  minFrameBytes: 256,
  maxFrameBytes: 1024 * 1024,
  defaultFrameBytes: CONTROL_LIMITS.maxCanonicalBytes + 8192,
  minOutboundBytes: 256,
  maxOutboundBytes: 4 * 1024 * 1024,
  defaultOutboundBytes: 256 * 1024,
  minPendingRequests: 1,
  maxPendingRequests: 1024,
  defaultPendingRequests: 32,
  minIncomingRequests: 1,
  maxIncomingRequests: 1024,
  defaultIncomingRequests: 32,
  minAckCache: 1,
  maxAckCache: CONTROL_LIMITS.maxReplayRecords,
  defaultAckCache: 64,
  minRequestTimeoutMs: 1,
  maxRequestTimeoutMs: 300_000,
  defaultRequestTimeoutMs: 30_000,
  maxFramesPerChunk: 64,
});
