import type {
  CuaSubmissionProducerPort,
  CuaSubmissionRef,
} from "@zcode/contracts";
import type { ControlOnlyDiagnosticLauncher } from "./control-only-launcher.js";
import {
  adoptCuaSubmissionRevocationRef,
  createCuaSubmissionControlStopResult,
  type CuaSubmissionControlFailure,
  type CuaSubmissionControlStopResult,
} from "./cua-submission-control-contract.js";
import { forwardControlStopSequence } from "./cua-submission-control-forward.js";

export interface CuaSubmissionControlStopHost {
  readonly producerPort: CuaSubmissionProducerPort;
  readonly originalRef: CuaSubmissionRef;
  launcher(): ControlOnlyDiagnosticLauncher | null;
  setStopping(value: boolean): void;
  clearInboundRetention(): void;
  nextInvalidationEpoch(): number;
  invalidationEpoch(): number;
  currentRef(): CuaSubmissionRef;
  adoptRef(ref: CuaSubmissionRef): void;
  markOwnerRevoked(): void;
  isInvalidated(): boolean;
  isCleanupPending(): boolean;
  phase(): "created" | "starting" | "active" | "invalidated" | "stopped" | "closed";
  markInvalidated(): void;
  markStoppedIfOpen(): void;
  setLastFailure(failure: CuaSubmissionControlFailure): void;
  recordCleanupFailure(message: string): void;
  scheduleCleanup(): void;
}

/** 用户 stop：先撤销唯一 owner，再按原 binding 转发 revoke/stop；native 事实保持 unknown。 */
export async function stopCuaSubmissionControlSession(
  host: CuaSubmissionControlStopHost,
): Promise<CuaSubmissionControlStopResult> {
  host.setStopping(true);
  host.clearInboundRetention();
  // stop 是外部终止：立即推进 generation，使在途反向 ACK 与后续 forward 都失效。
  const stopEpoch = host.nextInvalidationEpoch();
  try {
    let authorityRevoked = false;
    try {
      const result = await host.producerPort.revoke({
        ref: host.originalRef,
        reason: "user-stop",
      });
      if (result.status === "revoked") {
        const next = adoptCuaSubmissionRevocationRef(host.currentRef(), result.ref);
        if (next) {
          host.adoptRef(next);
          host.markOwnerRevoked();
          authorityRevoked = true;
        } else {
          host.setLastFailure("authority_revoke_failed");
          host.recordCleanupFailure("authority revoke returned a mismatched ref");
        }
      } else {
        host.setLastFailure("authority_revoke_failed");
        host.recordCleanupFailure("authority revoke did not return revoked");
      }
    } catch {
      host.setLastFailure("authority_revoke_failed");
      host.recordCleanupFailure("authority revoke failed");
    }

    let controlForwarded = false;
    const canForward = (): boolean =>
      authorityRevoked &&
      !host.isInvalidated() &&
      !host.isCleanupPending() &&
      host.phase() !== "closed" &&
      host.invalidationEpoch() === stopEpoch;
    if (canForward()) {
      controlForwarded = await forwardControlStopSequence({
        launcher: host.launcher(),
        ref: host.currentRef(),
        onFailure: host.setLastFailure,
        stillCurrent: canForward,
      });
    }

    host.markInvalidated();
    host.markStoppedIfOpen();
    if (host.invalidationEpoch() !== stopEpoch) controlForwarded = false;
    host.scheduleCleanup();
    return createCuaSubmissionControlStopResult(authorityRevoked, controlForwarded);
  } finally {
    host.setStopping(false);
  }
}
