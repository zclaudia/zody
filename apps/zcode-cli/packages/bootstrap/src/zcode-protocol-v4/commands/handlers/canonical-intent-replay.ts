// edit/retry 的 canonical intent 重发原语：rewind 截断之后，把 projection resolver 解析出的
// canonical user intent（含附件引用、模型 Selection、goal 命令语义）重新发起为一轮。
// 从 fork-edit-retry.ts 抽出：editUserQuery 与 retryTurn 共用，forkAssistant 不经过这里
// （fork 只做 conversation-only copy，不 rewind、不重发）。
import type { CommandEnvelope, CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { resolveSessionFallbackModelSelection } from "../input-admission.js";
import { inputIntentMetadataFromCanonical } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { applyGoalCommand } from "./goal-compact.js";
// fork（F4.2）：加速重发材料（highspeed card/execution 的 applies/retain 链）随加速卡删除；
// 存量 rewind 重放仍可能带加速 providerId Selection，用本地字面量判定回落会话模型（兼容读取）。
/** fork（F4.2）：判定已删除的加速卡隐藏 Provider id（存量数据兼容判定）。 */
function isRemovedHighspeedProviderId(providerId: string | undefined): boolean {
  return (
    providerId === "account:zai-highspeed-card" || providerId === "account:bigmodel-highspeed-card"
  );
}
import type { ConversationEditTarget } from "../../product-projection.js";

const EDIT_QUEUE_FALLBACK_REASON = "edit.admissionRace";

export function stableAttachmentRefs(editTarget: ConversationEditTarget) {
  return editTarget.intent.attachments?.flatMap((attachment) =>
    attachment.ref ? [{ ...attachment, ref: attachment.ref }] : [],
  );
}

export async function startCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  options?: { requireQueue?: boolean },
): Promise<void> {
  const intent = inputIntentMetadataFromCanonical(
    envelope,
    {
      kind: editTarget.intent.kind,
      conversationQuotes:
        envelope.type === "editUserQuery"
          ? ((envelope.payload as CommandPayloadMap["editUserQuery"]).conversationQuotes ??
            editTarget.intent.conversationQuotes)
          : editTarget.intent.conversationQuotes,
      text: editTarget.intent.text,
      sourceCommandId: editTarget.intent.sourceCommandId,
      clientId: editTarget.intent.clientId,
      queueItemId: editTarget.intent.queueItemId,
      requestedDelivery: editTarget.intent.requestedDelivery,
      admittedDelivery: editTarget.intent.admittedDelivery,
      fallbackReasonCode: editTarget.intent.fallbackReasonCode,
      modelSelection: editTarget.intent.modelSelection,
      mode: editTarget.intent.mode,
      planEnabled: editTarget.intent.planEnabled,
      attachmentRefs,
      provenance: editTarget.intent.provenance,
    },
    text,
  );
  const requireQueue = options?.requireQueue === true;
  // fork（F4.2）：原「本次重发带加速材料时改写 intent / 入队时暂存凭据」分支随加速卡删除。
  // 存量 rewind 重放仍可能沿用被 rewind 那轮持久化的 account:*-highspeed-card Selection：
  // 加速 Selection 只有与同一轮 requestAuth 成对才有效，单独保留会让 Core 以
  // ModelRequestAuthMissing 失败。与队列提升共用同一 resolver 退回会话常驻 Selection，
  // 只改本轮 intent、不改 session 模型。
  if (isRemovedHighspeedProviderId(intent.modelSelection?.providerId)) {
    intent.modelSelection = resolveSessionFallbackModelSelection(record);
  }
  if (requireQueue) {
    intent.requestedDelivery = "queue";
    intent.admittedDelivery = "queue";
    intent.fallbackReasonCode = EDIT_QUEUE_FALLBACK_REASON;
  }
  if (editTarget.intent.kind === "sendGoalCommand") {
    await applyGoalCommand(host, record, {
      inputId: envelope.commandId,
      objective: text,
      intent,
    });
    return;
  }
  try {
    const started = await startPromptTurn(host, record, {
      content: text,
      inputId: envelope.commandId,
      intent,
      ...(requireQueue ? { requireQueue: true } : {}),
      ...(attachments ? { attachments } : {}),
    });
    if (requireQueue && started.admission.kind !== "queued") {
      throw new Error("edited input was not admitted to the queue");
    }
  } catch (error) {
    throw error;
  }
}
