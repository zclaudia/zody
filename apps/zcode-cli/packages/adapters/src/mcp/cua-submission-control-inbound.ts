import type {
  CuaSubmissionProducerPort,
  CuaSubmissionRef,
  CuaSubmissionRevocationResult,
} from "@zcode/contracts";
import type {
  ControlChannelAckResult,
  ControlChannelRequest,
} from "@zcode/zcode-cua/control-channel";
import {
  adoptCuaSubmissionRevocationRef,
  rejectedProducerAck,
  revokedProducerAck,
  type CuaSubmissionControlResolution,
  type CuaSubmissionControlFailure,
} from "./cua-submission-control-contract.js";

export interface InboundRevocationOptions {
  readonly request: ControlChannelRequest;
  readonly eligible: boolean;
  readonly authoritativeRef: CuaSubmissionRef;
  readonly resolve: () => Promise<{
    readonly ok: boolean;
    readonly code?: CuaSubmissionControlFailure;
  }>;
  readonly stillEligible: () => boolean;
  /** 同步准入唯一在途撤销；返回 false 时不得进入 resolve/revoke。 */
  readonly beginInbound: () => boolean;
  readonly endInbound: () => void;
  readonly revoke: (ref: CuaSubmissionRef) => Promise<CuaSubmissionRevocationResult>;
  readonly onAuthorityRejected: (failure: CuaSubmissionControlFailure) => void;
  readonly onRevoked: (ref: CuaSubmissionRef) => boolean;
  readonly invalidated: () => boolean;
  readonly invalidationEpoch: () => number;
}

export async function handleBoundInboundRevocation(
  options: InboundRevocationOptions,
): Promise<ControlChannelAckResult> {
  const operation = options.request.body.payload.operation;
  if (!options.eligible || operation !== "revoke_submission") {
    return rejectedProducerAck(operation);
  }
  if (
    options.request.body.submissionLineageId !== options.authoritativeRef.submissionLineageId ||
    options.request.body.authorizationRevision !== options.authoritativeRef.authorizationRevision
  ) {
    return rejectedProducerAck(operation);
  }
  if (!options.beginInbound()) return rejectedProducerAck(operation);
  try {
    const resolution = await options.resolve();
    if (!resolution.ok) {
      options.onAuthorityRejected(resolution.code ?? "control_lost");
      return rejectedProducerAck(operation);
    }
    if (!options.stillEligible()) return rejectedProducerAck(operation);
    const epoch = options.invalidationEpoch();
    let result: CuaSubmissionRevocationResult;
    try {
      result = await options.revoke(options.authoritativeRef);
    } catch {
      options.onAuthorityRejected("authority_revoke_failed");
      return rejectedProducerAck(operation);
    }
    if (result.status !== "revoked") {
      options.onAuthorityRejected("authority_revoke_failed");
      return rejectedProducerAck(operation);
    }
    if (!options.onRevoked(result.ref)) {
      options.onAuthorityRejected("authority_revoke_failed");
      return rejectedProducerAck(operation);
    }
    if (options.invalidationEpoch() !== epoch) {
      // 控制链路在 authority 调用期间失效时保留真实撤销事实，但不能把迟到 ACK 当作有效控制完成。
      return rejectedProducerAck(operation);
    }
    return revokedProducerAck(options.invalidated());
  } finally {
    options.endInbound();
  }
}

export interface SessionInboundBinding {
  readonly authoritativeRef: () => CuaSubmissionRef;
  readonly eligible: () => boolean;
  readonly resolve: () => Promise<CuaSubmissionControlResolution>;
  readonly beginInbound: () => boolean;
  readonly endInbound: () => void;
  readonly revoke: (ref: CuaSubmissionRef) => Promise<CuaSubmissionRevocationResult>;
  readonly onAuthorityRejected: (failure: CuaSubmissionControlFailure) => void;
  readonly adoptRevokedRef: (ref: CuaSubmissionRef) => boolean;
  readonly invalidated: () => boolean;
  readonly invalidationEpoch: () => number;
  readonly onSettledInvalidated: () => void;
}

export async function handleSessionInboundRevocation(
  request: ControlChannelRequest,
  binding: SessionInboundBinding,
): Promise<ControlChannelAckResult> {
  try {
    return await handleBoundInboundRevocation({
      request,
      eligible: binding.eligible(),
      authoritativeRef: binding.authoritativeRef(),
      resolve: async () => {
        const resolution = await binding.resolve();
        if (resolution.ok) return { ok: true };
        return {
          ok: false,
          code: resolution.code === "resolve_failed" ? "ref_unknown" : resolution.code,
        };
      },
      stillEligible: binding.eligible,
      beginInbound: binding.beginInbound,
      endInbound: binding.endInbound,
      revoke: binding.revoke,
      onAuthorityRejected: binding.onAuthorityRejected,
      onRevoked: binding.adoptRevokedRef,
      invalidated: binding.invalidated,
      invalidationEpoch: binding.invalidationEpoch,
    });
  } finally {
    // ACK 仍只能尽力写入已失效 transport；保留期有上限，且不构成送达或 native drain 证据。
    if (binding.invalidated()) binding.onSettledInvalidated();
  }
}

export interface CuaSubmissionInboundHost {
  readonly producerPort: CuaSubmissionProducerPort;
  currentRef(): CuaSubmissionRef;
  adoptRef(ref: CuaSubmissionRef): void;
  eligible(): boolean;
  resolve(): Promise<CuaSubmissionControlResolution>;
  beginInbound(): boolean;
  endInbound(): void;
  setInboundAuthorityRevoke(value: boolean): void;
  markAuthorityRejected(failure: CuaSubmissionControlFailure): void;
  markOwnerRevokedAndInvalidated(): void;
  invalidated(): boolean;
  invalidationEpoch(): number;
  scheduleInboundRetention(): void;
}

export class CuaSubmissionInboundController {
  readonly #host: CuaSubmissionInboundHost;

  constructor(host: CuaSubmissionInboundHost) {
    this.#host = host;
  }

  handle(request: ControlChannelRequest): Promise<ControlChannelAckResult> {
    const host = this.#host;
    return handleSessionInboundRevocation(request, {
      authoritativeRef: () => host.currentRef(),
      eligible: () => host.eligible(),
      resolve: () => host.resolve(),
      beginInbound: () => host.beginInbound(),
      endInbound: () => host.endInbound(),
      revoke: (ref) => this.#revoke(ref),
      onAuthorityRejected: (failure) => host.markAuthorityRejected(failure),
      adoptRevokedRef: (ref) => {
        const next = adoptCuaSubmissionRevocationRef(host.currentRef(), ref);
        if (!next) {
          host.markAuthorityRejected("authority_revoke_failed");
          return false;
        }
        host.adoptRef(next);
        host.markOwnerRevokedAndInvalidated();
        return true;
      },
      invalidated: () => host.invalidated(),
      invalidationEpoch: () => host.invalidationEpoch(),
      onSettledInvalidated: () => host.scheduleInboundRetention(),
    });
  }

  #revoke(ref: CuaSubmissionRef): Promise<CuaSubmissionRevocationResult> {
    const host = this.#host;
    host.setInboundAuthorityRevoke(true);
    try {
      return host.producerPort.revoke({ ref, reason: "control-lost" });
    } finally {
      // 仅覆盖 port.revoke 同步阶段的 owner 回调；异步 owner 通知仍按外部终止处理。
      host.setInboundAuthorityRevoke(false);
    }
  }
}
