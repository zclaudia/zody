import type { CuaLiveSubmissionTicket } from "@zody/core";
import type { CommandEnvelope } from "@zody/shared/zody-protocol-v4";
import { queueItemIdForSubmission } from "../../app/session-input-id.js";
import type { V4SessionRecordView } from "./types.js";

/**
 * 只有真实 CommandInbox execute 路径、且可信来源为 desktop 的新提交才登记 live ticket。
 * ticket 不进入 envelope/intent/transcript；失败由调用方 cancel，queue 成功保留到提升消费。
 */
export function registerCuaLiveSubmission(
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  inputOrigin: "desktop" | "mobile" | undefined,
): CuaLiveSubmissionTicket | undefined {
  if (inputOrigin !== "desktop") return undefined;
  if (envelope.type !== "sendText" && envelope.type !== "createSession") return undefined;
  const registrar = record.app.runtime.getCuaSubmissionRegistrar?.();
  if (!registrar) return undefined;
  const result = registrar.register({
    origin: "desktop",
    inputKind: "new-submission",
    sourceCommandId: envelope.commandId,
    queueItemId: queueItemIdForSubmission(envelope.commandId),
  });
  return result.accepted ? result.ticket : undefined;
}

export function cancelCuaLiveSubmission(
  record: V4SessionRecordView,
  ticket: CuaLiveSubmissionTicket | undefined,
): void {
  if (!ticket) return;
  record.app.runtime.getCuaSubmissionRegistrar?.()?.cancel(ticket);
}
