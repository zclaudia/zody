import type { CuaLiveSubmissionTicket } from "@zody/core";
import type { CommandEnvelope } from "@zody/shared/zody-protocol-v4";
import { queueItemIdForSubmission } from "../../app/session-input-id.js";
import type { V4SessionRecordView } from "./types.js";

/**
 * 只有真实 CommandInbox execute 路径的新提交才登记 live ticket；ticket 不进入
 * envelope/intent/transcript；失败由调用方 cancel，queue 成功保留到提升消费。
 *
 * mobile-origin 授权轮次（2026-11-10，specs/computer-use-macos-phase1.md）：desktop
 * 新提交无条件登记；mobile 新提交只有持久授权命中（项目 cua_screenshot_confirm
 * allow_always / 会话 full access，经 runtime.isCuaLiveSubmissionGrantActive 同一规则链
 * 查询）才登记 origin=mobile 的 ticket——ticket 存在性即授权事实的表达，coordinator 侧
 * 据此区分「带授权的 mobile 提交」与 mobile-steer。未授权 mobile 不登记（原状），
 * 截图在 createCuaSubmissionTurnScope 处可观测拒绝。函数因此为 async：授权查询读
 * sessionStore。
 */
export async function registerCuaLiveSubmission(
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  inputOrigin: "desktop" | "mobile" | undefined,
): Promise<CuaLiveSubmissionTicket | undefined> {
  if (envelope.type !== "sendText" && envelope.type !== "createSession") return undefined;
  // 来源短路必须在访问 record.app.runtime 之前：无可信 inputOrigin 的输入（含历史/
  // 测试 stub app）不登记，也不触碰可能缺省的 runtime。
  if (inputOrigin !== "desktop" && inputOrigin !== "mobile") return undefined;
  const runtime = record.app.runtime;
  const registrar = runtime.getCuaSubmissionRegistrar?.();
  if (!registrar) return undefined;
  let origin: "desktop" | "mobile";
  if (inputOrigin === "desktop") {
    origin = "desktop";
  } else if ((await runtime.isCuaLiveSubmissionGrantActive()) === true) {
    origin = "mobile";
  } else {
    return undefined;
  }
  const result = registrar.register({
    origin,
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
