import type {
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionTurnInvalidationReason,
} from "@zody/contracts";
import type {
  ControlOnlyDiagnosticLauncher,
  ControlOnlyLauncherInvalidatedEvent,
} from "./control-only-launcher.js";
import {
  CuaSubmissionControlError,
  createCuaSubmissionControlLostError as controlLostError,
  createCuaSubmissionControlResolutionError,
  normalizeCuaSubmissionControlOptions,
  resolveCuaSubmissionControlCandidate,
  type CuaSubmissionControlDiagnostics,
  type CuaSubmissionControlFailure,
  type CuaSubmissionControlResolution,
  type CuaSubmissionControlSession,
  type CuaSubmissionControlSessionOptions,
  type CuaSubmissionControlStopResult,
  type NormalizedCuaSubmissionControlOptions,
} from "./cua-submission-control-contract.js";
import {
  forwardControlRevocation,
} from "./cua-submission-control-forward.js";
import { CuaSubmissionInboundController } from "./cua-submission-control-inbound.js";
import {
  CuaSubmissionAuthorityLossRevocation,
  CuaSubmissionCleanupFailure,
  CuaSubmissionInboundCleanupRetention,
  startCuaSubmissionControlLauncher,
} from "./cua-submission-control-lifecycle.js";
import { CuaSubmissionRevocationController } from "./cua-submission-control-revocation.js";
import {
  stopCuaSubmissionControlSession,
  type CuaSubmissionControlStopHost,
} from "./cua-submission-control-stop.js";

export * from "./cua-submission-control-contract.js";

type RevokedProjection = Extract<CuaSubmissionProjection, { status: "revoked" }>;
type Phase = CuaSubmissionControlDiagnostics["control"];

class CuaSubmissionControlSessionImpl implements CuaSubmissionControlSession {
  readonly traceId: string;
  readonly onOwnerRevocation = (projection: RevokedProjection): void => {
    this.#revocation.handleOwnerProjection(projection);
  };
  readonly onScopeInvalidated = (reason: CuaSubmissionTurnInvalidationReason): void => {
    this.#revocation.handleScope(reason);
  };

  readonly #options: NormalizedCuaSubmissionControlOptions;
  readonly #originalRef: CuaSubmissionRef;
  #authoritativeRef: CuaSubmissionRef;
  #launcher: ControlOnlyDiagnosticLauncher | null = null;
  #phase: Phase = "created";
  #invalidated = false;
  #ownerRevoked = false;
  #scopeInvalidated = false;
  #stopping = false;
  #inboundInFlight = false;
  #inboundAuthorityRevoke = false;
  #invalidationEpoch = 0;
  #lastFailure: CuaSubmissionControlFailure | null = null;
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<CuaSubmissionControlStopResult> | null = null;
  #cleanupPromise: Promise<void> | null = null;
  readonly #cleanupFailure = new CuaSubmissionCleanupFailure();
  readonly #inboundRetention: CuaSubmissionInboundCleanupRetention;
  readonly #lossRevocation: CuaSubmissionAuthorityLossRevocation;
  readonly #revocation: CuaSubmissionRevocationController;
  readonly #inbound: CuaSubmissionInboundController;
  readonly #stopHost: CuaSubmissionControlStopHost;

  constructor(options: NormalizedCuaSubmissionControlOptions) {
    this.#options = options;
    this.#originalRef = options.ref;
    this.#authoritativeRef = options.ref;
    this.traceId = options.traceId;
    this.#inboundRetention = new CuaSubmissionInboundCleanupRetention(
      options.launcher.requestTimeoutMs,
      () => this.scheduleCleanup(),
    );
    this.#lossRevocation = new CuaSubmissionAuthorityLossRevocation({
      port: options.producerPort,
      originalRef: options.ref,
      currentRef: () => this.#authoritativeRef,
      onAdopted: (ref) => {
        this.#authoritativeRef = ref;
        this.#ownerRevoked = true;
      },
      onMismatch: () => {
        this.#lastFailure = "authority_revoke_failed";
        this.#cleanupFailure.record("authority revoke returned a mismatched ref");
      },
      onFailure: () => {
        this.#lastFailure = "authority_revoke_failed";
        this.#cleanupFailure.record("authority revoke failed");
      },
    });
    this.#revocation = new CuaSubmissionRevocationController({
      producerPort: options.producerPort,
      originalRef: () => this.#originalRef,
      currentRef: () => this.#authoritativeRef,
      adoptRef: (ref) => {
        this.#authoritativeRef = ref;
      },
      isClosed: () => this.#phase === "closed",
      isStarting: () => this.#phase === "starting",
      isStopping: () => this.#stopping,
      isInboundAuthorityRevoke: () => this.#inboundAuthorityRevoke,
      isInvalidated: () => this.#invalidated,
      latchOwnerRevoked: () => {
        this.#ownerRevoked = true;
      },
      latchScopeOwnerRevoked: () => {
        this.#scopeInvalidated = true;
        this.#ownerRevoked = true;
        this.#lastFailure = "owner_revoked";
      },
      latchScopeClosed: () => this.latchScopeClosed(),
      beginExternalOwnerInvalidation: () => this.beginExternalOwnerInvalidation(),
      forwardOwnerRevocation: () => this.forwardOwnerRevocation(),
      scheduleCleanup: () => this.scheduleCleanup(),
      setLastFailure: (failure) => {
        this.#lastFailure = failure;
      },
      recordCleanupFailure: (message) => this.#cleanupFailure.record(message),
    });
    this.#inbound = new CuaSubmissionInboundController({
      producerPort: options.producerPort,
      currentRef: () => this.#authoritativeRef,
      adoptRef: (ref) => {
        this.#authoritativeRef = ref;
      },
      eligible: () =>
        this.#phase === "active" && !this.#invalidated && !this.#ownerRevoked && !this.#stopping,
      resolve: () => this.resolveCandidate(),
      beginInbound: () => {
        if (this.#inboundInFlight) return false;
        this.#inboundInFlight = true;
        return true;
      },
      endInbound: () => {
        this.#inboundInFlight = false;
      },
      setInboundAuthorityRevoke: (value) => {
        this.#inboundAuthorityRevoke = value;
      },
      markAuthorityRejected: (failure) => {
        this.#invalidated = true;
        if (this.#phase !== "closed") this.#phase = "invalidated";
        this.#lastFailure = failure;
        if (failure === "authority_revoke_failed") {
          this.#cleanupFailure.record("authority revoke failed during inbound request");
        }
      },
      markOwnerRevokedAndInvalidated: () => {
        this.#ownerRevoked = true;
        this.#invalidated = true;
        if (this.#phase !== "closed") this.#phase = "invalidated";
        this.#lastFailure = "control_lost";
      },
      invalidated: () => this.#invalidated,
      invalidationEpoch: () => this.#invalidationEpoch,
      scheduleInboundRetention: () => this.#inboundRetention.schedule(),
    });
    this.#stopHost = {
      producerPort: options.producerPort,
      originalRef: options.ref,
      launcher: () => this.#launcher,
      setStopping: (value) => {
        this.#stopping = value;
      },
      clearInboundRetention: () => this.#inboundRetention.clear(),
      nextInvalidationEpoch: () => ++this.#invalidationEpoch,
      invalidationEpoch: () => this.#invalidationEpoch,
      currentRef: () => this.#authoritativeRef,
      adoptRef: (ref) => {
        this.#authoritativeRef = ref;
      },
      markOwnerRevoked: () => {
        this.#ownerRevoked = true;
      },
      isInvalidated: () => this.#invalidated,
      isCleanupPending: () => this.#cleanupPromise !== null,
      phase: () => this.#phase,
      markInvalidated: () => {
        this.#invalidated = true;
      },
      markStoppedIfOpen: () => {
        if (this.#phase !== "closed" && !this.#cleanupPromise) this.#phase = "stopped";
      },
      setLastFailure: (failure) => {
        this.#lastFailure = failure;
      },
      recordCleanupFailure: (message) => this.#cleanupFailure.record(message),
      scheduleCleanup: () => this.scheduleCleanup(),
    };
  }

  start(): Promise<void> {
    this.#startPromise ??= this.startInternal();
    return this.#startPromise;
  }

  stop(): Promise<CuaSubmissionControlStopResult> {
    this.#stopPromise ??= this.stopInternal();
    return this.#stopPromise;
  }

  cleanup(): Promise<void> {
    this.invalidateForCleanup();
    return this.ensureCleanup();
  }

  diagnostics(): CuaSubmissionControlDiagnostics {
    return Object.freeze({
      traceId: this.traceId,
      control: this.#phase,
      invalidated: this.#invalidated,
      ownerRevoked: this.#ownerRevoked,
      lastFailure: this.#lastFailure,
      executable: false,
      candidateIsGrant: false,
      nativeHelper: "unavailable",
      nativeFence: "unknown",
      machineLease: "unavailable",
      stopComplete: false,
    });
  }

  private async startInternal(): Promise<void> {
    if (this.#invalidated || this.#phase !== "created") {
      throw controlLostError("control binding was already invalidated or used", this.traceId);
    }
    this.#phase = "starting";
    try {
      const preflight = await this.resolveCandidate();
      if (!preflight.ok) {
        throw createCuaSubmissionControlResolutionError(preflight, this.traceId);
      }
      this.assertStartOpen();
      const launcher = await startCuaSubmissionControlLauncher(this.#options, {
        onInvalidated: (event) => this.handleLauncherInvalidation(event),
        onRequest: (request) => this.#inbound.handle(request),
        traceId: this.traceId,
      });
      this.#launcher = launcher;
      if (this.#invalidated || this.#ownerRevoked || launcher.closed || this.#cleanupPromise) {
        await this.closeLauncher();
        throw controlLostError("control binding invalidated during startup", this.traceId);
      }
      const postflight = await this.resolveCandidate();
      if (!postflight.ok) {
        this.#invalidated = true;
        this.#phase = "invalidated";
        this.#lastFailure = postflight.code === "resolve_failed" ? "ref_unknown" : postflight.code;
        if (postflight.code === "resolve_failed") {
          // 启动后复核抛错时 authority 事实不确定，必须用最初完整 ref 请求唯一 owner 撤销。
          this.#lossRevocation.request();
        }
        await this.closeLauncher();
        throw createCuaSubmissionControlResolutionError(postflight, this.traceId);
      }
      this.#phase = "active";
    } catch (error) {
      if (!this.#invalidated && !this.#ownerRevoked) {
        this.#invalidated = true;
        this.#phase = "invalidated";
        this.#lastFailure ??=
          error instanceof CuaSubmissionControlError && error.code.startsWith("ref_")
            ? (error.code as CuaSubmissionControlFailure)
            : "control_start_failed";
      }
      throw error;
    }
  }

  private async stopInternal(): Promise<CuaSubmissionControlStopResult> {
    return await stopCuaSubmissionControlSession(this.#stopHost);
  }

  private async resolveCandidate(): Promise<CuaSubmissionControlResolution> {
    return await resolveCuaSubmissionControlCandidate(
      this.#options.producerPort,
      this.#authoritativeRef,
      () => this.#invalidated || this.#ownerRevoked,
    );
  }

  private latchScopeClosed(): void {
    this.#scopeInvalidated = true;
    this.#invalidationEpoch += 1;
    this.#inboundRetention.clear();
    this.#lastFailure = null;
    if (!this.#invalidated) {
      this.#invalidated = true;
      if (this.#phase !== "stopped") {
        this.#phase = this.#phase === "starting" ? "starting" : "invalidated";
      }
    }
  }

  private beginExternalOwnerInvalidation(): void {
    this.#invalidated = true;
    this.#invalidationEpoch += 1;
    this.#inboundRetention.clear();
    this.#phase = this.#phase === "starting" ? "starting" : "invalidated";
    this.#lastFailure = "owner_revoked";
  }

  private async forwardOwnerRevocation(): Promise<void> {
    await forwardControlRevocation({
      launcher: this.#launcher,
      ref: this.#authoritativeRef,
      onFailure: (failure) => {
        this.#lastFailure = failure;
      },
    });
    this.scheduleCleanup();
  }

  private handleLauncherInvalidation(_event: ControlOnlyLauncherInvalidatedEvent): void {
    if (this.#phase === "closed") return;
    this.#invalidationEpoch += 1;
    this.#inboundRetention.clear();
    if (!this.#invalidated) {
      this.#invalidated = true;
      this.#phase = this.#phase === "starting" ? "starting" : "invalidated";
      this.#lastFailure = this.#ownerRevoked ? "owner_revoked" : "control_lost";
    }
    // scope 驱动的失效（owner 已撤销或正常 turn 结束）不再制造 control-lost；
    // 只有真正的控制链路失效才用最初完整 ref 请求唯一 authority 撤销。
    if (!this.#scopeInvalidated) this.#lossRevocation.request();
    // binding 已提前 invalidated 时，launcher 的后续失效仍必须并入同一真实 cleanup。
    if (this.#phase !== "starting") this.scheduleCleanup();
  }

  private invalidateForCleanup(): void {
    this.#inboundRetention.clear();
    if (this.#phase === "closed") return;
    this.#invalidationEpoch += 1;
    if (!this.#invalidated) {
      this.#invalidated = true;
      if (this.#phase !== "stopped") {
        this.#phase = this.#phase === "starting" ? "starting" : "invalidated";
      }
      this.#lastFailure = this.#ownerRevoked ? "owner_revoked" : "control_lost";
    }
    // stop/owner 已确认 authority 撤销、或 scope 已正常关闭时，cleanup 不制造第二个撤销。
    if (!this.#ownerRevoked && !this.#scopeInvalidated) this.#lossRevocation.request();
  }

  private ensureCleanup(): Promise<void> {
    this.#cleanupPromise ??= (async () => {
      if (this.#lossRevocation.promise) await this.#lossRevocation.promise;
      if (this.#startPromise) await this.#startPromise.catch(() => undefined);
      await this.closeLauncher();
      // closeLauncher 的首次失效回调可能此时才发起 authority revoke，必须一并等待其真实结果。
      if (this.#lossRevocation.promise) await this.#lossRevocation.promise;
      this.#cleanupFailure.throwIfAny();
    })().finally(() => {
      this.#phase = "closed";
    });
    return this.#cleanupPromise;
  }

  private async closeLauncher(): Promise<void> {
    const launcher = this.#launcher;
    if (!launcher) return;
    try {
      await launcher.close();
    } catch (error) {
      this.#cleanupFailure.record(
        error instanceof Error ? error.message : "control binding cleanup failed",
      );
    }
  }

  private scheduleCleanup(): void {
    void this.cleanup().catch(() => undefined);
  }

  private assertStartOpen(): void {
    if (this.#invalidated || this.#ownerRevoked || this.#stopping || this.#cleanupPromise) {
      throw controlLostError("control binding invalidated before startup", this.traceId);
    }
  }
}

export function createCuaSubmissionControlSession(
  options: CuaSubmissionControlSessionOptions,
): CuaSubmissionControlSession {
  return new CuaSubmissionControlSessionImpl(normalizeCuaSubmissionControlOptions(options));
}
