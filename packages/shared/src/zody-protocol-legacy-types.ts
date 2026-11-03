/* oxlint-disable eslint(max-lines) -- re-home 产物：旧协议消息/会话承重类型集中迁移，保持单文件契约面。 */
// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载旧 ZCode Protocol 中仍被存活栈（validation/background-task-notifications/
// v4 投影等）消费的承重类型与 schema：ZCodeSessionInfo / ZCodeMessageWithParts /
// ZCodePermissionResponse / ZCodeInteractionRequestOrigin 及其依赖闭包。
// 旧协议死亡（zcode-protocol/index.ts 删除）后，这是该协议面的唯一幸存面。

import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();
export const zodyDeliveryKindSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export const zodyMessageVisibilitySchema = z.enum(["user-visible", "model-only"]);
export const zodySyntheticUserMessageSourceSchema = z.enum([
  "agent_listing_delta",
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  "plugin_reference",
  "bot_topic_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  // child 回复会作为 model-only synthetic user message 持久化；
  // app/agent 共用的承重消息 schema 必须与 CLI contracts 使用同一来源词表。
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动工作流的启动轮 source；与 contracts 的
  // SYNTHETIC_USER_MESSAGE_SOURCES 保持同一词表，否则 v3 mapper 收窄该 source 会 tsc 失败。
  "workflow_launch",
  "shared_context",
]);
export const zodyWorkspaceRefSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
  })
  .strict();
export const zodyPermissionDecisionSchema = z.enum(["allow", "deny", "escalate", "modify"]);
export const zodyPermissionRuleBehaviorSchema = z.enum(["allow", "deny", "ask"]);
/** Backward-compatible wire/storage key interpreted only for trusted official CUA tools. */
export const OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME = "zcode:permission-capability:official_cua";
/**
 * workflow 运行确认窗第三选项「Refine」（拒绝并附修改意见）的稳定 optionId。
 * CLI 侧 v4 投影合成选项、broker 应答映射与 GUI 特判共用同一常量；
 * 该选项只在 v4 链路投放。
 */
export const WORKFLOW_REFINE_PERMISSION_OPTION_ID = "workflowRefine";
export const zodyPermissionRuleValueSchema = z
  .object({
    toolName: nonEmptyString,
    ruleContent: z.string().optional(),
  })
  .strict();
export const zodyPermissionUpdateSchema = z
  .object({
    type: z.literal("addRules"),
    behavior: zodyPermissionRuleBehaviorSchema,
    rules: z.array(zodyPermissionRuleValueSchema).min(1),
  })
  .strict();
export const zodyPermissionResponseSchema = z
  .object({
    decision: zodyPermissionDecisionSchema,
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(zodyPermissionUpdateSchema).optional(),
  })
  .strict();
export type ZodyPermissionResponse = z.infer<typeof zodyPermissionResponseSchema>;
export const zodySessionModeSchema = z.enum(["plan", "build", "edit", "yolo", "guarded", "auto"]);
export const zodySessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "paused",
  "completed",
  "error",
]);
export const zodySessionKindSchema = z.enum([
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
]);
export const zodySessionGoalSchema = z
  .object({
    sessionId: nonEmptyString,
    targetId: nonEmptyString,
    objective: nonEmptyString,
    // 旧版持久化 session target 不包含 summaryTitle。
    // 协议读取历史 snapshot 时补 null，避免老会话恢复失败。
    summaryTitle: z.string().min(1).nullable().default(null),
    status: z.enum(["active", "paused", "budget_limited", "complete"]),
    tokenBudget: z.number().int().positive().nullable(),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    activeInputId: nonEmptyString.nullable().optional(),
    activeRunStartedAtMs: timestampMsSchema.nullable().optional(),
    activeRunLastSeenAtMs: timestampMsSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
  })
  .strict();
export const zodySessionGoalVerificationSchema = z
  .object({
    nextAction: z.string().nullable().optional(),
    passed: z.boolean(),
    reason: z.string(),
  })
  .strict();
export const zodySessionGoalVerificationTimelineSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("synthetic"),
    type: z.literal("goal_verification"),
    display: z.literal("separator"),
    targetId: nonEmptyString,
    verificationId: nonEmptyString,
    status: z.enum(["started", "completed", "failed_closed", "cancelled"]),
    verification: zodySessionGoalVerificationSchema.optional(),
    goalIteration: z.number().int().positive().optional(),
    anchorAssistantMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema,
  })
  .strict();
export const zodySessionInfoSchema = z
  .object({
    sessionId: nonEmptyString,
    workspace: zodyWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    sessionKind: zodySessionKindSchema,
    title: z.string(),
    titleSource: z.enum(["default", "first_input", "generated", "custom"]).optional(),
    mode: zodySessionModeSchema,
    status: zodySessionStatusSchema,
    model: modelSelectionSchema.optional(),
    target: zodySessionGoalSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
    archivedAt: timestampMsSchema.optional(),
  })
  .strict();
export type ZodySessionInfo = z.infer<typeof zodySessionInfoSchema>;
export const zodyInteractionRequestOriginSchema = z
  .object({
    kind: z.literal("subagent"),
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    childSessionId: nonEmptyString,
    childTurnId: nonEmptyString.optional(),
    description: z.string().optional(),
    parentSessionId: nonEmptyString,
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
  })
  .strict();
export type ZodyInteractionRequestOrigin = z.infer<typeof zodyInteractionRequestOriginSchema>;
const messageTimeSchema = z
  .object({
    created: timestampMsSchema,
    completed: timestampMsSchema.optional(),
  })
  .strict();
export const zodyTokenUsageSchema = z
  .object({
    total: z.number().int().nonnegative().optional(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cache: z
      .object({
        read: z.number().int().nonnegative(),
        write: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const zodyMessageSemanticsSchema = z
  .object({
    origin: z.enum(["real_user", "agent_runtime", "system", "migration", "import"]),
    kind: z.enum([
      "user_prompt",
      "slash_command",
      "system_reminder",
      "background_notification",
      "subagent_notification",
      "todo_reminder",
      "rewind_notice",
      "fork_notice",
      "timeline_event",
      "compact_summary",
      "shared_context",
      "assistant_response",
    ]),
    source: z.string().optional(),
    commandName: z.string().optional(),
    uiVisibility: z.enum(["visible", "hidden", "debug"]),
    providerVisibility: z.enum(["visible", "hidden"]),
    transcriptVisibility: z.enum(["visible", "hidden"]),
  })
  .strict();
export const zodyUserMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("user"),
    time: messageTimeSchema,
    agent: nonEmptyString,
    // 旧消息或未绑定会话的合成消息可能没有请求来源；不借默认模型补写。
    model: modelSelectionSchema.optional(),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    synthetic: z.boolean().optional(),
    source: zodySyntheticUserMessageSourceSchema.optional(),
    visibility: zodyMessageVisibilitySchema.optional(),
    semantics: zodyMessageSemanticsSchema.optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();
export const zodyAssistantMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("assistant"),
    time: messageTimeSchema,
    parentMessageId: nonEmptyString,
    agent: nonEmptyString,
    model: modelSelectionSchema.optional(),
    path: z
      .object({
        cwd: nonEmptyString,
        root: nonEmptyString,
      })
      .strict(),
    cost: z.number().nonnegative(),
    tokens: zodyTokenUsageSchema,
    finish: z.string().optional(),
    error: jsonObjectSchema.optional(),
    semantics: zodyMessageSemanticsSchema.optional(),
    structured: z.unknown().optional(),
  })
  .strict();
export const zodyMessageInfoSchema = z.discriminatedUnion("role", [
  zodyUserMessageInfoSchema,
  zodyAssistantMessageInfoSchema,
]);
export type ZodyMessageInfo = z.infer<typeof zodyMessageInfoSchema>;
const partBaseSchema = z.object({
  partId: nonEmptyString,
  sessionId: nonEmptyString,
  messageId: nonEmptyString,
});
export const zodyToolStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      input: jsonObjectSchema,
      raw: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("running"),
      input: jsonObjectSchema,
      title: z.string().optional(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      input: jsonObjectSchema,
      output: z.string(),
      title: z.string(),
      metadata: jsonObjectSchema,
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      input: jsonObjectSchema,
      error: z.string(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
]);
const zodyTimelineModelSelectionSchema = modelSelectionSchema.extend({
  label: z.string().optional(),
});
const zodyTimelinePartTimeSchema = z
  .object({
    start: timestampMsSchema.optional(),
    end: timestampMsSchema.optional(),
  })
  .strict();
export const zodyTimelinePartSchema = partBaseSchema
  .extend({
    type: z.literal("timeline"),
    timelineType: z.enum([
      "context_compaction",
      "goal_verification",
      "session_fork",
      "model_change",
    ]),
    display: z.enum(["separator", "worklog"]),
    status: z.string().optional(),
    anchorMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    time: zodyTimelinePartTimeSchema.optional(),
    operationId: z.string().optional(),
    trigger: z.enum(["manual", "auto", "partial", "reactive", "session_memory"]).optional(),
    phase: z.enum(["standalone_turn", "pre_request", "mid_turn", "reactive"]).optional(),
    compactReason: z.string().optional(),
    boundaryId: z.string().optional(),
    summaryMessageId: nonEmptyString.optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    attempt: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    targetId: z.string().optional(),
    verificationId: z.string().optional(),
    goalIteration: z.number().int().nonnegative().optional(),
    verification: z
      .object({
        passed: z.boolean(),
        reason: z.string(),
        nextAction: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: z.string().optional(),
    restoredFileCount: z.number().int().nonnegative().optional(),
    fromModel: zodyTimelineModelSelectionSchema.optional(),
    toModel: zodyTimelineModelSelectionSchema
      .extend({
        label: nonEmptyString,
      })
      .optional(),
  })
  .strict();
export const zodyMessagePartSchema = z.discriminatedUnion("type", [
  partBaseSchema
    .extend({
      type: z.literal("text"),
      text: z.string(),
      synthetic: z.boolean().optional(),
      ignored: z.boolean().optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("reasoning"),
      text: z.string(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("file"),
      mime: nonEmptyString,
      filename: z.string().optional(),
      url: nonEmptyString,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("tool"),
      callId: nonEmptyString,
      tool: nonEmptyString,
      state: zodyToolStateSchema,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({ type: z.literal("step-start"), snapshot: z.string().optional() })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("step-finish"),
      reason: z.string(),
      snapshot: z.string().optional(),
      cost: z.number().nonnegative(),
      tokens: zodyTokenUsageSchema,
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("snapshot"), snapshot: z.string() }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("patch"),
      hash: nonEmptyString,
      files: z.array(z.string()),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("compaction"),
      auto: z.boolean(),
      reason: z.string().optional(),
      summaryMessageId: nonEmptyString.optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  zodyTimelinePartSchema,
  partBaseSchema
    .extend({
      type: z.literal("subagent"),
      prompt: z.string(),
      description: z.string(),
      agent: nonEmptyString,
      model: modelSelectionSchema.optional(),
      command: z.string().optional(),
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("agent"), name: nonEmptyString }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("retry"),
      attempt: z.number().int().nonnegative(),
      error: jsonObjectSchema,
    })
    .strict(),
]);
export type ZodyMessagePart = z.infer<typeof zodyMessagePartSchema>;
export const zodyMessageWithPartsSchema = z
  .object({
    info: zodyMessageInfoSchema,
    parts: z.array(zodyMessagePartSchema),
  })
  .strict();
export type ZodyMessageWithParts = z.infer<typeof zodyMessageWithPartsSchema>;
export const zodySessionApiRetryStatusSchema = z
  .object({
    kind: z.literal("api_retry"),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    retryDelayMs: z.number().int().nonnegative(),
    errorStatus: z.number().int().nonnegative().nullable(),
    error: z.string(),
  })
  .strict();
export const zodySessionContextCacheUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    latestHitRate: z.number().nonnegative().nullable().optional(),
    hitRateRequestCount: z.number().int().nonnegative().optional(),
    totalInputTokens: z.number().int().nonnegative().optional(),
    totalCacheReadTokens: z.number().int().nonnegative().optional(),
    totalCacheWriteTokens: z.number().int().nonnegative().optional(),
    hitRate: z.number().nonnegative().nullable(),
  })
  .strict();
export const zodyContextUsageBreakdownSourceSchema = z.enum([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);
export const zodyContextUsageBreakdownItemSchema = z
  .object({
    source: zodyContextUsageBreakdownSourceSchema,
    chars: z.number().int().nonnegative(),
  })
  .strict();
export type ZodyContextUsageBreakdownItem = z.infer<typeof zodyContextUsageBreakdownItemSchema>;
export const zodyContextUsageBreakdownSchema = z.array(zodyContextUsageBreakdownItemSchema);
export const zodySessionContextUsageSchema = z
  .object({
    used: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: nonEmptyString,
      })
      .strict()
      .nullable()
      .optional(),
    cache: zodySessionContextCacheUsageSchema.optional(),
    breakdown: zodyContextUsageBreakdownSchema.optional(),
  })
  .strict();
export const zodySessionRuntimeStateSchema = z
  .object({
    eventSeq: z.number().int().nonnegative(),
    stateRevision: z.number().int().nonnegative(),
    deliveryKind: zodyDeliveryKindSchema.optional(),
    activeTurnId: nonEmptyString.optional(),
    activeTurnKind: z.enum(["regular", "compact", "rewind"]).optional(),
    pendingRequestIds: z.array(nonEmptyString),
    apiRetry: zodySessionApiRetryStatusSchema.nullable().optional(),
    contextUsage: zodySessionContextUsageSchema.optional(),
    goalVerifications: z.array(zodySessionGoalVerificationSchema).optional(),
    goalVerificationTimeline: z.array(zodySessionGoalVerificationTimelineSchema).optional(),
  })
  .strict();
export type ZodySessionRuntimeState = z.infer<typeof zodySessionRuntimeStateSchema>;
export type ZodySessionActiveTurnKind = NonNullable<ZodySessionRuntimeState["activeTurnKind"]>;
export function textFromZodyMessageParts(parts: readonly ZodyMessagePart[]): string {
  return parts
    .filter((part): part is Extract<ZodyMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}
