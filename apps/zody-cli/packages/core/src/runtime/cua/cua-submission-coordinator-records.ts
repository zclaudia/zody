import type { CuaSubmissionRef } from "@zody/contracts";
import type { CuaSubmissionCoordinator } from "./cua-submission-coordinator.js";

/** 未消费 live ticket 的 owner 归属；owner 对象身份不可序列化。 */
export interface CuaTicketRecord {
  readonly owner: CuaSubmissionCoordinator;
  readonly sourceCommandId: string;
  readonly queueItemId?: string;
}

/** coordinator 只持当前 ref 与输入关联，不复制 authority 授权状态。 */
export interface CuaCurrentSubmission {
  ref: CuaSubmissionRef;
  sourceCommandId: string;
  queueItemId?: string;
}
