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
  return requestAxConfirmation.call(this, input, "read");
}

export async function requestCuaNativeControlConfirmation(
  this: AgentRuntimeInternal,
  input: CuaNativeCaptureConfirmationInput,
): Promise<CuaNativeCaptureConfirmationResult> {
  return requestAxConfirmation.call(this, input, "control");
}

async function requestAxConfirmation(
  this: AgentRuntimeInternal,
  input: CuaNativeCaptureConfirmationInput,
  kind: "read" | "control",
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
        reason: `${kind === "read" ? "Read window content" : "Control window with AXPress or text value (120 second idle limit)"}: ${input.target.ownerName} — "${input.target.windowName}" (pid ${input.target.pid}, window ${input.target.windowId})`,
        requestId: `cua-${kind}-confirm-${input.generation}`,
        requestedAt: new Date(),
        riskLevel: "high",
        ruleId: `cua-${kind}-confirm`,
        sessionId: input.sessionId as PermissionBrokerRequest["sessionId"],
        toolCallId: input.runId as PermissionBrokerRequest["toolCallId"],
        toolName: `cua_ax_${kind}_confirm`,
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

export function matchesCuaContext(
  this: AgentRuntimeInternal,
  input: { workspaceIdentity?: string; remoteSessionId?: string },
): boolean {
  return (
    (this.config.workspaceIdentity?.toString().trim() || undefined) ===
      (input.workspaceIdentity?.trim() || undefined) &&
    (this.config.remoteSessionId?.trim() || undefined) ===
      (input.remoteSessionId?.trim() || undefined)
  );
}
