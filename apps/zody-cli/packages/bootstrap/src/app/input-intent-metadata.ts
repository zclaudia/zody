import type { TurnInputIntentMetadata } from "@zody/contracts";
import type { AttachmentRef } from "@zody/shared/zody-protocol-v4";

/**
 * canonical input intent 的提交身份与 admission 事实。
 *
 * V4 从 CommandInbox admission 取值；普通 CLI 没有 command bucket，由 input facade 在提交
 * 边界生成。两种来源都经 `composeInputIntentMetadata` 组装，防止出现第二份缺省口径。
 */
export interface InputIntentIdentity {
  sourceCommandId: string;
  /** 缺省 cli：旧发送端没有可信 clientId。 */
  clientId?: string;
  kind: TurnInputIntentMetadata["kind"];
}

export interface InputIntentAdmission {
  admissionSeq: number;
  admittedAt: number;
  queueItemId: string;
}

export interface InputIntentMetadataOptions {
  text: string;
  inputOrigin?: TurnInputIntentMetadata["inputOrigin"];
  conversationQuotes?: TurnInputIntentMetadata["conversationQuotes"];
  requestedDelivery: TurnInputIntentMetadata["requestedDelivery"];
  admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
  fallbackReasonCode?: string;
  attachmentRefs?: readonly AttachmentRef[];
  modelSelection?: NonNullable<TurnInputIntentMetadata["modelSelection"]>;
  mode?: TurnInputIntentMetadata["mode"];
  planEnabled?: boolean;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  source?: TurnInputIntentMetadata["source"];
}

/**
 * V4 `inputIntentMetadata` 的纯组装部分：身份与 admission 由调用方提供，字段缺省规则
 * （clientId、admittedDelivery）只在这里维护一份。
 */
export function composeInputIntentMetadata(
  identity: InputIntentIdentity,
  admission: InputIntentAdmission,
  options: InputIntentMetadataOptions,
): TurnInputIntentMetadata {
  return {
    ...(options.inputOrigin ? { inputOrigin: options.inputOrigin } : {}),
    ...(options.conversationQuotes ? { conversationQuotes: options.conversationQuotes } : {}),
    sourceCommandId: identity.sourceCommandId,
    queueItemId: admission.queueItemId,
    clientId: identity.clientId || "cli",
    kind: identity.kind,
    text: options.text,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: options.requestedDelivery,
    admittedDelivery:
      options.admittedDelivery ??
      (options.requestedDelivery === "guide"
        ? "guide"
        : options.requestedDelivery === "queue"
          ? "queue"
          : "startNow"),
    ...(options.fallbackReasonCode ? { fallbackReasonCode: options.fallbackReasonCode } : {}),
    ...(options.attachmentRefs ? { attachmentRefs: [...options.attachmentRefs] } : {}),
    ...(options.sharedContextRefs ? { sharedContextRefs: [...options.sharedContextRefs] } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}
