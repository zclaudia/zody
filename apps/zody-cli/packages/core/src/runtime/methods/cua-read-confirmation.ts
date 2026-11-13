import type { PermissionBrokerRequest } from "@zody/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  CuaNativeCaptureConfirmationInput,
  CuaNativeCaptureConfirmationResult,
} from "./cua-submission.js";

/** 读取确认独立于截图规则；等待前后都核验同一 foreground 与 turn。 */
export async function requestCuaNativeReadConfirmation(
  this: AgentRuntimeInternal,
  input: CuaNativeCaptureConfirmationInput,
): Promise<CuaNativeCaptureConfirmationResult> {
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation <= 0 ||
    !Number.isSafeInteger(input.target.pid) ||
    input.target.pid <= 0 ||
    !Number.isSafeInteger(input.target.windowId) ||
    input.target.windowId <= 0 ||
    typeof input.target.ownerName !== "string" ||
    Buffer.byteLength(input.target.ownerName, "utf8") > 128 ||
    typeof input.target.windowName !== "string" ||
    Buffer.byteLength(input.target.windowName, "utf8") > 128
  ) {
    return { allowed: false, failureReason: "confirmation-invalid" };
  }
  const initial = this.cuaSubmissionCoordinator?.currentProjection();
  const turn = this.activeTurn;
  const foreground = this.activeForegroundExecution;
  const live = () => {
    const projection = this.cuaSubmissionCoordinator?.currentProjection();
    return Boolean(
      turn &&
      turn.kind === "regular" &&
      this.activeTurn === turn &&
      turn.turnId === input.turnId &&
      turn.traceContext.traceId === input.traceId &&
      String(this.sessionId) === input.sessionId &&
      this.activeForegroundExecution === foreground &&
      foreground &&
      foreground.foregroundExecutionId === input.runId &&
      !foreground.controller.signal.aborted &&
      !input.signal?.aborted &&
      projection?.status === "candidate" &&
      projection.ref.workspaceKey === input.workspaceKey &&
      initial?.status === "candidate" &&
      this.cuaSubmissionCoordinator?.isCurrentCandidateRef(initial.ref),
    );
  };
  if (!live()) return { allowed: false, failureReason: "confirmation-invalid" };
  try {
    let claimed = false;
    const result = await this.permissionBroker.requestPermission(
      {
        input: { target: input.target },
        mode: this.config.mode ?? "build",
        reason: `Read window content: ${input.target.ownerName} — "${input.target.windowName}" (pid ${input.target.pid}, window ${input.target.windowId})`,
        requestId: `cua-read-confirm-${input.generation}`,
        requestedAt: new Date(),
        riskLevel: "high",
        ruleId: "cua-read-confirm",
        sessionId: input.sessionId as PermissionBrokerRequest["sessionId"],
        toolCallId: input.runId as PermissionBrokerRequest["toolCallId"],
        toolName: "cua_ax_read_confirm",
        traceId: input.traceId,
        turnId: input.turnId,
        approvalMode: "user-once",
        optionsPolicy: "no-always-allow",
      },
      {
        ...(input.signal ? { signal: input.signal } : {}),
        claimResponse: () => {
          if (claimed) return false;
          claimed = true;
          return true;
        },
      },
    );
    if (!live()) return { allowed: false, failureReason: "confirmation-invalid" };
    return { allowed: result.decision === "allow" };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { allowed: false, failureReason: "confirmation-unavailable" };
  }
}
