import type {
  CuaSubmissionProducerPort,
  CuaSubmissionRef,
  CuaSubmissionRevocationResult,
} from "@zody/contracts";
import type {
  ControlChannelAckResult,
  ControlChannelRequest,
} from "@zody/zody-cua/control-channel";
import {
  startControlOnlyDiagnosticLauncher,
  type ControlOnlyDiagnosticLauncher,
  type ControlOnlyLauncherInvalidatedEvent,
} from "./control-only-launcher.js";
import {
  CuaSubmissionControlError,
  adoptCuaSubmissionRevocationRef,
  type NormalizedCuaSubmissionControlOptions,
} from "./cua-submission-control-contract.js";

export async function startCuaSubmissionControlLauncher(
  options: NormalizedCuaSubmissionControlOptions,
  callbacks: {
    onInvalidated: (event: ControlOnlyLauncherInvalidatedEvent) => void;
    onRequest: (
      request: ControlChannelRequest,
    ) => ControlChannelAckResult | Promise<ControlChannelAckResult>;
    traceId: string;
  },
): Promise<ControlOnlyDiagnosticLauncher> {
  try {
    return await startControlOnlyDiagnosticLauncher({
      appIncarnation: options.ref.appIncarnation,
      ...(options.launcher.beforeSpawn === undefined
        ? {}
        : { beforeSpawn: options.launcher.beforeSpawn }),
      closeTimeoutMs: options.launcher.closeTimeoutMs,
      env: options.launcher.env,
      launch: options.launcher.launch,
      onInvalidated: callbacks.onInvalidated,
      onRequest: callbacks.onRequest,
      requestTimeoutMs: options.launcher.requestTimeoutMs,
      startupTimeoutMs: options.launcher.startupTimeoutMs,
    });
  } catch (error) {
    throw new CuaSubmissionControlError("control_start_failed", "control binding startup failed", {
      cause: error,
      traceId: callbacks.traceId,
    });
  }
}

export class CuaSubmissionInboundCleanupRetention {
  readonly #timeoutMs: number;
  readonly #cleanup: () => void;
  #timer: NodeJS.Timeout | null = null;

  constructor(timeoutMs: number, cleanup: () => void) {
    this.#timeoutMs = timeoutMs;
    this.#cleanup = cleanup;
  }

  schedule(): void {
    if (this.#timer) return;
    const timer = setTimeout(() => {
      this.#timer = null;
      // 这里只是资源保留上限，不证明 ACK 已送达，也不代表 native drain 完成。
      this.#cleanup();
    }, this.#timeoutMs);
    timer.unref?.();
    this.#timer = timer;
  }

  clear(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export class CuaSubmissionAuthorityLossRevocation {
  readonly #port: CuaSubmissionProducerPort;
  readonly #originalRef: CuaSubmissionRef;
  readonly #currentRef: () => CuaSubmissionRef;
  readonly #onAdopted: (ref: CuaSubmissionRef) => void;
  readonly #onMismatch: () => void;
  readonly #onFailure: () => void;
  #promise: Promise<void> | null = null;

  constructor(options: {
    port: CuaSubmissionProducerPort;
    originalRef: CuaSubmissionRef;
    currentRef: () => CuaSubmissionRef;
    onAdopted: (ref: CuaSubmissionRef) => void;
    onMismatch: () => void;
    onFailure: () => void;
  }) {
    this.#port = options.port;
    this.#originalRef = options.originalRef;
    this.#currentRef = options.currentRef;
    this.#onAdopted = options.onAdopted;
    this.#onMismatch = options.onMismatch;
    this.#onFailure = options.onFailure;
  }

  get promise(): Promise<void> | null {
    return this.#promise;
  }

  request(): void {
    if (this.#promise) return;
    let pending: Promise<CuaSubmissionRevocationResult>;
    try {
      pending = this.#port.revoke({ ref: this.#originalRef, reason: "control-lost" });
    } catch {
      this.#promise = Promise.resolve().then(this.#onFailure);
      return;
    }
    this.#promise = pending.then((result) => {
      const next =
        result.status === "revoked"
          ? adoptCuaSubmissionRevocationRef(this.#currentRef(), result.ref)
          : null;
      if (!next) {
        this.#onMismatch();
        return;
      }
      this.#onAdopted(next);
    }, this.#onFailure);
  }
}

export class CuaSubmissionCleanupFailure {
  #error: Error | null = null;

  record(message: string): void {
    this.#error ??= new Error(message);
  }

  throwIfAny(): void {
    if (this.#error) throw this.#error;
  }
}
