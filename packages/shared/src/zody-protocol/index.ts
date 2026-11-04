import { requestVerificationReasons } from "../request-security-edition/verification-policy.js";
import { zodyProtocolTraceSchema } from "./trace.js";
// fork（bots移除）：Bot 反向回复（bot/channel/reply）的严格 schema 随第三方 IM bot channels 全量删除。
export { zodyProtocolTraceSchema, type ZodyProtocolTrace } from "./trace.js";
import {
  databaseMigrationFactsSchema,
  databaseStartupErrorCodeSchema,
  databaseStartupErrorDetailsSchema,
} from "../database-startup.js";
import {
  MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE,
  MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS,
  MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS,
  mcpAppsAppToolCallResultSchema,
  mcpAppsAppToolDescriptorSchema,
} from "../mcp-apps/appTools.js";
import { mcpAppsSamplingParamsSchema, mcpAppsSamplingResultSchema } from "../mcp-apps/sampling.js";
import { mcpAppInstanceSchema } from "../mcp-apps/instance.js";
export { conversationQuoteSchema, conversationQuotesSchema } from "../conversationSelection.js";
/* oxlint-disable eslint(max-lines) -- ZCode Protocol schema 需要单文件导出，方便 app 与 agent 共享同一份协议契约。 */
// ── 旧协议删除边界──────────────────────
// 剩余 ~257 个导出：旧 ZCode Protocol 方法契约、请求/响应/事件 schema、
// session/workspace state snapshot 投影等（承重类型已迁 zody-protocol-legacy-types.ts）。
// 已连根删除的死词（词表+schema+两侧实现）：session/steer、session/rewind、
// session/rewindCascade、session/previewFileRewind、session/applyFileRewind、
// prompt/enhance 全簇（含 promptEnhanceResult 通知）、plugins/marketplace/list；
// session/fork 客户端链已删（op+schema 留存 = v4 forkSessionAtMessage 钩子消费）。
// 消费者：services 旧栈（zcodeProtocolClient/zcodeAgent/zodyAgentService/zcodeSession*）、
// CLI bootstrap 旧协议 server（zody-protocol/server-operations、plugins、session-mapper 等）、
// UI 旧投影（zcodeSessionProjection 等读路径）。
// 上述旧协议 client/server 组删除时，本文件整体删除。
// 注：外部零消费 schema 多为存活 schema 联合的内部依赖，随宿主文件一起处理，勿单删。
import { z } from "zod";
import { accountProviderUnavailableReasonSchema } from "../account-provider-state.js";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
// fork（bots移除）：定时任务 Bot 回推目标 schema 随第三方 IM bot channels 全量删除。
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { completeModelPropertiesDataSchema } from "../model-config.js";
import { modelExecutionSchema } from "../model-execution.js";
import { modelSelectionSchema } from "../model-selection.js";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import { errorAttributionSchema } from "../zody-protocol-v4/snapshot.js";
// 后台详情共享精简的只读响应 schema，不携带命令或计时元数据。
export * from "../background-bash-output.js";
export * from "../process-diagnostic.js";
export { attachmentSourceKindSchema, type AttachmentSourceKind } from "../attachment-source.js";
import { PROTOCOL_V4_LIMITS } from "../zody-protocol-v4/core.js";

export const zodyTopicResourceReadParamsSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    taskId: z.string().min(1).max(256),
    inputId: z.string().min(1).max(256),
    authorizationId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256),
    resourceIndex: z.number().int().nonnegative(),
  })
  .strict();
export const zodyTopicResourceReadResultSchema = z
  .object({
    ref: z.string().min(1),
    fileName: z.string().min(1).max(1024),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
  })
  .strict();
export const zodyTopicResourceCancelParamsSchema = z
  .object({ requestId: z.string().min(1).max(256), taskId: z.string().min(1).max(256) })
  .strict();
export const zodyTopicResourceCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type ZodyTopicResourceReadParams = z.infer<typeof zodyTopicResourceReadParamsSchema>;
export type ZodyTopicResourceReadResult = z.infer<typeof zodyTopicResourceReadResultSchema>;
export { activeWorkSummarySchema, type ActiveWorkSummary } from "../zody-protocol-v4/snapshot.js";
// browser-use 命令/结果契约单一来源：agent 构造、协议校验和 main executor 共用同一 schema。
import {
  browserBackendListResultSchema,
  browserSessionContextKindSchema,
} from "../browser-use/backend.js";
import { browserClientModeSchema, browserCommandSchema } from "../browser-use/commands.js";
import { browserCommandResultSchema } from "../browser-use/result.js";
// fork（F4.6）：OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS 随官方 MCP 鉴权链删除。
import { integratedTerminalShellSelectionSchema } from "../validationAppSettings.js";
import {
  zodySyntheticUserMessageSourceSchema as legacyZcodeSyntheticUserMessageSourceSchema,
  zodyDeliveryKindSchema,
  zodyInteractionRequestOriginSchema,
  zodyMessagePartSchema,
  zodyMessageVisibilitySchema,
  zodyMessageWithPartsSchema,
  zodyPermissionDecisionSchema,
  zodyPermissionResponseSchema,
  zodyPermissionUpdateSchema,
  zodySessionApiRetryStatusSchema,
  zodySessionContextUsageSchema,
  zodySessionGoalSchema,
  zodySessionGoalVerificationSchema,
  zodySessionGoalVerificationTimelineSchema,
  zodySessionInfoSchema,
  zodySessionKindSchema,
  zodySessionModeSchema,
  zodySessionRuntimeStateSchema,
  zodySessionStatusSchema,
  zodyToolStateSchema,
  zodyWorkspaceRefSchema,
} from "../zody-protocol-legacy-types.js";
import { zodyTaskModeSchema } from "../zody-task-mode-schema.js";

export * from "../localTtft.js";
export {
  hookExecutionProjectionSchema,
  hookInvocationRowSchema,
  type HookExecutionProjection,
  type HookInvocationRow,
} from "../zody-protocol-v4/rows.js";

export const ZODY_PROTOCOL_NAME = "Zody Protocol" as const;
export const ZODY_PROTOCOL_VERSION = 1 as const;
// V4 wire 与 legacy 主协议并存；禁止为了 V4 physical framing 改写 legacy 版本。
export const ZODY_PROTOCOL_V4_WIRE_VERSION = 3 as const;
export const zodyRuntimeCapabilitiesSchema = z.object({
  independentPlanState: z.boolean().optional(),
});
export const zodyProtocolErrorCodes = {
  sessionUnavailable: -32004,
} as const;

const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();
const protocolInstantSchema = z.union([timestampMsSchema, nonEmptyString, z.date()]);

// Tool result display 不受模型文本 budget 约束；Node REPL 图片必须在 Agent/App 协议边界
// 做严格限长，避免截图把 continuous 或 replayable 消息扩成无界载荷。
export const zodyNodeReplImageToolResultDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

// 同理：CreateWorkflow 的类型检查诊断也是 display 通道，必须在协议边界限长，
// 避免大量诊断把 continuous/replayable 消息扩成无界载荷。
// causalityGraph 在工具输出边界已限长，这里镜像同一组上界（与 v4 rows 保持一致）。
// 图的词汇表刻意很小：step 卡片 + actor 车道 + 一种箭头（runs after，`back` 只标回边）+
// 返回物标记。分析器的 kind / certainty / exact / region 不进载荷。
// 名字只在运行时成形（`` agent(`研究员${i + 1}`) ``）时静态能拿到的形状：第一个洞之前的
// 字面量（head）与最后一个洞之后的字面量（tail）。至少一个在场，两者都已 trim 且含实义字符。
// Bug 修复：这两个字段随 0a8b059f40 落进 contracts 与 v4 镜像，v3 这份漏改——.strict()
// 之下带插值名的工作流会让整个 display 验证失败、图整块消失，所以这里必须与 v4 逐字段对齐。
const zodyWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// 一条边 = runs after；step 边与阶段边同形，`back` 只标循环回边。
const zodyWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const zodyCreateWorkflowCausalityGraphDisplaySchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            // `hole`：开着的留白自己的站点（docs/dynamic-workflow/presentation.md「Holes on the timeline」）；镜像 v4。
            kind: z.enum(["ask", "world-read", "hole"]),
            label: z.string().min(1).max(128),
            // 内联 `agent()` receiver 让 label 落到兜底串时，那个名字的静态形状。
            labelPattern: zodyWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // 展开自的站点 id，只出现在 may-set 车道展开的拷贝上（实时叠加的关联键）；
            // 加字段是 additive 的，不带它的旧载荷照常通过 .strict()。
            source: z.string().min(1).max(64).optional(),
            // 作者用 `phase("…")` 标记划入的阶段。
            // 与图的 phases / phaseEdges / exits 同进同退：全在场或全缺席。
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
            // 这个站点是某次补全写进来的：值是那个留白的站点 id；镜像 v4。
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // `name` 缺席而 agent() 首参是带洞的模板串时的静态形状；与 name 互斥。
            namePattern: zodyWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // 参与者与交接；镜像 v4。
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    handoffs: z
      .array(
        zodyWorkflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // 阶段词汇表：作者施加的分组结构，主画面以它为节点。与 phaseEdges / exits / Step.phase
    // 全有或全无——零标记脚本全缺席，UI 据此退回 step/车道视图。零成员阶段也在表里。
    // `unphased` 无 name，显示名由 UI 本地化。
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // 进入本阶段时还在跑的其他阶段（它们的 strand 尚未 join），阶段表序，不含自己，
            // 为空时缺席。是节点事实而不是边——控制没有从那里转移过来，所以不进 phaseEdges。
            // 时间轴据此把相邻阶段折成一条分叉的「带」，侧栏迷你轨道画成双线段。
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
            // 这个阶段是某次补全写进来的：值是那个留白的站点 id；镜像 v4。
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(zodyWorkflowEdgeSchema).max(128).optional(),
    // 阶段流（docs/dynamic-workflow/presentation.md「Streams」）：两端互为 alongside 的 data 边，
    // 只有 {from, to}——不是 runs after，不进 phaseEdges、不带 back。与词汇表同进同退。
    phaseStreams: z
      .array(z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict())
      .max(128)
      .optional(),
    // 还开着的留白，源码序（docs/dynamic-workflow/authoring.md「Holes」）；镜像 v4。
    holes: z
      .array(
        z
          .object({
            siteId: z.string().min(1).max(64),
            name: z.string().min(1).max(128),
            type: z.string().min(1).max(128),
            phase: z.string().min(1).max(64).optional(),
            tail: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    // 控制流可在其后正常完成的阶段（阶段视图的「阶段 → 返回物」箭头）；组内可为空数组。
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export const zodyCreateWorkflowToolResultDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: zodyCreateWorkflowCausalityGraphDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    // FillWorkflowHole 行补的是哪处留白（docs/dynamic-workflow/presentation.md「The fill row」）；镜像 v4。
    // 修复原因：dwf-recursive 只给 contracts 与 v4 加了留白字段，v3 的 .strict() 拒掉整条 tool.updated，
    // 桌面端 v3 订阅于是把含留白的 CreateWorkflow / FillWorkflowHole 结果当无效事件丢掉。
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        draftPath: z.string().min(1).max(1_024).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const zodyToolResultObjectSchema = jsonObjectSchema.superRefine((result, context) => {
  const display = result.display;
  if (typeof display !== "object" || display === null || Array.isArray(display)) {
    return;
  }
  const kind = (display as Record<string, unknown>).kind;
  const schemaByKind: Record<string, z.ZodTypeAny> = {
    node_repl_images: zodyNodeReplImageToolResultDisplaySchema,
    create_workflow: zodyCreateWorkflowToolResultDisplaySchema,
    bash_output: bashOutputDisplaySchema,
  };
  const schema = typeof kind === "string" ? schemaByKind[kind] : undefined;
  if (!schema) return;
  const parsed = schema.safeParse(display);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ["display", ...issue.path] });
  }
});

export const zodyProtocolRequestIdSchema = z.union([z.string(), z.number().int()]);
export type ZodyProtocolRequestId = z.infer<typeof zodyProtocolRequestIdSchema>;

// 远程历史附件仅通过现有连接的私有反向频道传输，单块保持在 RPC 帧预算内。
export const TOPIC_RESOURCE_RELAY_CHUNK_BYTES = 384 * 1024;
export const TOPIC_RESOURCE_RELAY_CHANNEL = "host-topic-resource";
export const zodyTopicResourceRelayRequestSchema = zodyTopicResourceReadParamsSchema
  .extend({
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().min(1).max(4096),
    remoteSessionId: z.string().min(1).max(256),
    trace: zodyProtocolTraceSchema.optional(),
  })
  .strict();
export type ZodyTopicResourceRelayRequest = z.infer<typeof zodyTopicResourceRelayRequestSchema>;
export const zodyTopicResourceRelayKeySchema = zodyTopicResourceCancelParamsSchema;
export const zodyTopicResourceRelayChunkRequestSchema = zodyTopicResourceRelayKeySchema
  .extend({
    index: z.number().int().nonnegative(),
  })
  .strict();
export const zodyTopicResourceRelayMetadataSchema = z
  .object({
    fileName: z.string().min(1).max(1024),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z
      .number()
      .int()
      .min(0)
      .max(Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / TOPIC_RESOURCE_RELAY_CHUNK_BYTES)),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const zodyTopicResourceRelayChunkSchema = z
  .object({
    dataBase64: z.string().max((TOPIC_RESOURCE_RELAY_CHUNK_BYTES / 3) * 4),
  })
  .strict();

export const zodyProtocolRequestSchema = z
  .object({
    id: zodyProtocolRequestIdSchema,
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zodyProtocolTraceSchema.optional(),
  })
  .strict();
export type ZodyProtocolRequest = z.infer<typeof zodyProtocolRequestSchema>;

export const zodyProtocolNotificationSchema = z
  .object({
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zodyProtocolTraceSchema.optional(),
  })
  .strict();
export type ZodyProtocolNotification = z.infer<typeof zodyProtocolNotificationSchema>;

export const zodyProtocolResponseSchema = z
  .object({
    id: zodyProtocolRequestIdSchema,
    result: z.unknown(),
  })
  .strict();
export type ZodyProtocolResponse = z.infer<typeof zodyProtocolResponseSchema>;

export const zodyProtocolErrorSchema = z
  .object({
    id: zodyProtocolRequestIdSchema,
    error: z
      .object({
        code: z.number().int(),
        message: nonEmptyString,
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type ZodyProtocolError = z.infer<typeof zodyProtocolErrorSchema>;

export const zodyProtocolMessageSchema = z.union([
  zodyProtocolRequestSchema,
  zodyProtocolNotificationSchema,
  zodyProtocolResponseSchema,
  zodyProtocolErrorSchema,
]);
export type ZodyProtocolMessage = z.infer<typeof zodyProtocolMessageSchema>;

export const zodyProtocolNotifications = {
  storageStartup: "startup/storageState",
  providerRuntimeHeadersCancelled: "interaction/providerRuntimeHeadersCancelled",
  mcpTelemetry: "process/mcpTelemetry",
  mcpResourceSamples: "process/mcpResourceSamples",
  toolExecResource: "process/toolExecResource",
  pluginOperationProgress: "plugins/operationProgress",
  processResourceSample: "process/resourceSample",
  processNetworkRequests: "process/networkRequests",
} as const;

/** 启动控制面独立于 task stream；数据库身份不可携带路径/凭据。 */
export const zodyStorageStartupStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    databaseId: z.string().min(1).max(128),
    databaseKind: z.enum(["session", "tasks-index"]),
    phase: z.enum(["checking", "waiting_for_lock", "migrating", "committing", "ready", "failed"]),
    // 包含锁内、版本 SQL 之前的可选 lastAppliedMigrationId；旧通知仍可解析。
    migration: databaseMigrationFactsSchema.optional(),
    elapsedMs: z.number().nonnegative().finite(),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    errorCode: databaseStartupErrorCodeSchema.optional(),
    ...databaseStartupErrorDetailsSchema.shape,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.phase === "failed" && !state.errorCode)
      context.addIssue({ code: "custom", message: "failed requires errorCode" });
  });
export type ZodyStorageStartupState = z.infer<typeof zodyStorageStartupStateSchema>;

const zodyMcpTelemetryPlatformSchema = z.enum([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
]);
const zodyMcpTelemetryArchSchema = z.enum([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);
const zodyMcpTelemetryBaseSchema = z
  .object({
    arch: zodyMcpTelemetryArchSchema,
    occurredAt: z.number().int().nonnegative(),
    platform: zodyMcpTelemetryPlatformSchema,
  })
  .strict();
const zodyMcpProcessTelemetryBaseShape = {
  mcpId: z
    .string()
    .regex(
      /^(?:builtin:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+(?::(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+)*|(?:plugin|custom):[a-f0-9]{12})$/,
    ),
  mcpInstanceId: nonEmptyString,
  mcpIsolation: z.enum(["session", "workspace"]),
  mcpSource: z.enum(["builtin", "plugin", "custom"]),
} as const;

export const zodyMcpTelemetryEventSchema = z.discriminatedUnion("kind", [
  zodyMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_start"),
      ...zodyMcpProcessTelemetryBaseShape,
    })
    .strict(),
  zodyMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_crash"),
      ...zodyMcpProcessTelemetryBaseShape,
      affectedSessionCount: z.number().int().nonnegative().max(10_000),
      exitCode: z.number().int().nullable(),
      signal: nonEmptyString.nullable(),
      uptimeMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  zodyMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("session_startup"),
      configuredCount: z.number().int().nonnegative().max(10_000),
      connectedCount: z.number().int().nonnegative().max(10_000),
      failedCount: z.number().int().nonnegative().max(10_000),
      processCount: z.number().int().nonnegative().max(10_000),
      sessionId: nonEmptyString,
    })
    .strict(),
  zodyMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("memory"),
      ...zodyMcpProcessTelemetryBaseShape,
      memoryKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
      memoryScope: z.enum(["process_tree", "direct_process"]),
      orphanSuspected: z.boolean(),
      ownerSessionCount: z.number().int().nonnegative().max(10_000),
      unownedSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
export type ZodyMcpTelemetryEvent = z.infer<typeof zodyMcpTelemetryEventSchema>;

/** MCP 每五分钟只探测一次，周期由生产者与设备总量过期判据共用。 */
export const ZODY_MCP_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60_000;

export const zodyMcpResourceSampleSchema = z
  .object({
    mcpId: zodyMcpProcessTelemetryBaseShape.mcpId,
    instanceToken: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    sampledAt: z.number().int().nonnegative(),
    intervalMs: z.number().finite().positive(),
    processCount: z.number().int().positive().max(100_000),
    rssKbTotal: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rssKbMaxProcess: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cpuTimeMsDelta: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    uptimeMinutes: z.number().int().nonnegative(),
    platform: zodyMcpTelemetryPlatformSchema,
    arch: zodyMcpTelemetryArchSchema,
    logicalCpuCount: z.number().int().positive().max(4_096),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576),
  })
  .strict();
export type ZodyMcpResourceSample = z.infer<typeof zodyMcpResourceSampleSchema>;
// 通知输入有界；main 另按每个上报窗口的 32 个 MCP 分组执行事件额度。
export const zodyMcpResourceSamplesSchema = z.array(zodyMcpResourceSampleSchema).max(1_024);

export const BASH_RESOURCE_SAMPLE_INTERVAL_MS = 15_000;
export const BASH_RESOURCE_MAX_SAMPLES = 20;

/** Bash 子进程的有界完成事实；禁止命令、路径与会话标识进入遥测旁路。 */
export const zodyToolExecResourceSchema = z
  .object({
    // 同一完成事实可能经多个 Host 转发；随机标识仅供 main 去重，旧 CLI 缺字段仍兼容。
    completionToken: z.string().uuid().optional(),
    platform: zodyMcpTelemetryPlatformSchema,
    toolName: z.literal("bash"),
    durationMs: z.number().finite().min(BASH_RESOURCE_SAMPLE_INTERVAL_MS),
    exitKind: z.enum(["completed", "timeout", "killed", "error"]),
    treeRssKbPeak: z.number().finite().nonnegative().optional(),
    treeCpuTimeMs: z.number().finite().nonnegative().optional(),
    sampleCount: z.number().int().nonnegative().max(BASH_RESOURCE_MAX_SAMPLES),
    cliRssKb: z.number().finite().nonnegative(),
    systemFreeMemoryKb: z.number().finite().nonnegative(),
  })
  .strict();
export type ZodyToolExecResource = z.infer<typeof zodyToolExecResourceSchema>;

export const zodyProcessResourceSampleSchema = z
  .object({
    platform: z.enum([
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "netbsd",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
    ]),
    arch: z.enum([
      "arm",
      "arm64",
      "ia32",
      "loong64",
      "mips",
      "mipsel",
      "ppc",
      "ppc64",
      "riscv64",
      "s390",
      "s390x",
      "x64",
    ]),
    logicalCpuCount: z.number().int().positive().max(4_096),
    intervalMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1_000),
    cpuCores: z.number().finite().nonnegative().max(4_096),
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /**
     * 以下四项为遥测新增字段，全部可选：旧 CLI 发来的样本仍能通过校验，因此
     * **不递增协议握手版本号**（握手版本是兼容性开关，不是字段版本）。
     */
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    uptimeMinutes: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 365 * 24 * 60)
      .optional(),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576).optional(),
    /**
     * CLI 进程启动时随机生成的实例标识，仅供 app 侧 main 统计「同时存活几个 CLI 进程」
     * 与「最大单进程 RSS」。不进 ARMS 属性、不含 pid。收紧字符集是隐私红线的机械保障：
     * 路径、workspace 标识这类内容不可能通过校验。
     */
    instanceToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
  })
  .strict();
export type ZodyProcessResourceSample = z.infer<typeof zodyProcessResourceSampleSchema>;

export const zodyProcessChildProcessesParamsSchema = z.object({}).strict();
export const zodyProcessChildProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    serverName: nonEmptyString,
    mcpSource: z.enum(["builtin", "plugin", "custom"]),
    /** 官方/第三方插件的插件名（`plugin:<name>:<key>` 的 name，或官方 host MCP 对应插件）；custom 无 */
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export const zodyProcessChildProcessesResultSchema = z
  .object({
    processes: z.array(zodyProcessChildProcessSchema).max(10_000),
  })
  .strict();
export type ZodyProcessChildProcess = z.infer<typeof zodyProcessChildProcessSchema>;
export type ZodyProcessChildProcessesResult = z.infer<
  typeof zodyProcessChildProcessesResultSchema
>;

export type ZodyDeliveryKind = z.infer<typeof zodyDeliveryKindSchema>;
// TurnStarted 与持久 message 必须共用同一来源词表；否则 live event 能通过而 cold
// message 在 app/agent 边界被拒绝，造成 continuous/replayable 语义分叉。
// 持久消息与输入沿用同一 source schema；agent_listing_delta 只作 provider context，不触发新 turn。
const zodyTurnInputSourceSchema = legacyZcodeSyntheticUserMessageSourceSchema;
export const zodySessionPersistenceSchema = z.enum(["immediate", "deferred"]);
export type ZodySessionPersistence = z.infer<typeof zodySessionPersistenceSchema>;
export type ZodyWorkspaceRef = z.infer<typeof zodyWorkspaceRefSchema>;
export const zodyPermissionOptionSchema = z
  .object({
    optionId: nonEmptyString,
    kind: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    response: zodyPermissionResponseSchema,
  })
  .strict();

const zodyProtocolMcpEntrySchema = z
  .object({
    name: nonEmptyString,
    value: z.string(),
  })
  .strict();

const zodyProtocolMcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: nonEmptyString,
      clientSecret: nonEmptyString,
      clientName: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: nonEmptyString.optional(),
      clientSecret: nonEmptyString.optional(),
      clientName: nonEmptyString.optional(),
      redirectPath: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

export const zodyProtocolMcpServerSchema = z.union([
  z
    .object({
      name: nonEmptyString,
      command: nonEmptyString,
      args: z.array(z.string()),
      env: z.array(zodyProtocolMcpEntrySchema),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      type: z.enum(["http", "sse"]),
      url: nonEmptyString,
      headers: z.array(zodyProtocolMcpEntrySchema),
      oauth: zodyProtocolMcpOAuthSchema.optional(),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ZodyProtocolMcpServer = z.infer<typeof zodyProtocolMcpServerSchema>;

export const zodyMcpServerStatusKindSchema = z.enum([
  "connecting",
  "connected",
  "disabled",
  "disconnected",
  "failed",
  "untrusted",
]);
export const MCP_SERVER_FAILURE_KINDS = [
  "config_invalid",
  "runtime_unavailable",
  "process_start_failed",
  "network_unreachable",
  "connection_timeout",
  "protocol_negotiation_failed",
  "tool_list_failed",
  "unexpected_disconnect",
  "oauth_authorization_failed",
  // fork（F4.6）：official_origin_untrusted 只由已删除的官方 MCP 可信 origin 校验产生。
  "not_authenticated",
  "coding_plan_required",
  "server_not_found",
  "server_unavailable",
  "rate_limited",
  "server_internal_error",
  "protocol_error",
  "status_unavailable",
  "connection_failed",
] as const;
export const mcpServerFailureKindSchema = z.enum(MCP_SERVER_FAILURE_KINDS);
export type McpServerFailureKind = z.infer<typeof mcpServerFailureKindSchema>;
export const zodyMcpServerStatusSnapshotSchema = z
  .object({
    status: zodyMcpServerStatusKindSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    toolCount: z.number().int().nonnegative(),
    updatedAt: nonEmptyString,
    error: z.string().optional(),
    failureKind: mcpServerFailureKindSchema.optional(),
    serverRequestId: nonEmptyString.optional(),
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    authorization: z
      .object({
        type: z.literal("oauth_authorization_code"),
        authorizationUrl: nonEmptyString,
        startedAt: nonEmptyString,
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZodyMcpServerStatusSnapshot = z.infer<typeof zodyMcpServerStatusSnapshotSchema>;

export const zodyMcpListModeSchema = z.enum(["connect", "status"]);
export type ZodyMcpListMode = z.infer<typeof zodyMcpListModeSchema>;

export const zodyMcpListParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    mcpServers: z.array(zodyProtocolMcpServerSchema).optional(),
    mode: zodyMcpListModeSchema.default("connect"),
  })
  .strict();
export const zodyMcpListResultSchema = z
  .object({
    statuses: z.record(z.string(), zodyMcpServerStatusSnapshotSchema),
  })
  .strict();
export type ZodyMcpListResult = z.infer<typeof zodyMcpListResultSchema>;

// 插件 UI：UI 发起的 MCP 资源读取与工具调用，
// 按 pluginId 限定 server 归属，agent 侧 fail closed。
export const zodyMcpUiOpenInstanceParamsSchema = z
  .object({
    accountContext: z.string().max(256).optional(),
    workspace: zodyWorkspaceRefSchema,
    sessionId: nonEmptyString,
    pluginId: nonEmptyString,
    serverName: nonEmptyString,
    scopeId: nonEmptyString.max(4096),
    resourceUri: nonEmptyString.max(2048),
    ownerWebContentsId: z.number().int().positive(),
  })
  .strict();
export const zodyMcpUiOpenInstanceResultSchema = mcpAppInstanceSchema;
export type ZodyMcpUiOpenInstanceParams = z.infer<typeof zodyMcpUiOpenInstanceParamsSchema>;
const zodyMcpUiPluginScopeShape = {
  instance: mcpAppInstanceSchema,

  workspace: zodyWorkspaceRefSchema,
  sessionId: nonEmptyString,
  pluginId: nonEmptyString,
  serverName: nonEmptyString,
};
export const zodyMcpUiCloseInstanceParamsSchema = z
  .object({ ...zodyMcpUiPluginScopeShape, onlyIfIdle: z.boolean().optional() })
  .strict();
export const zodyMcpUiCloseInstanceResultSchema = z.object({ closed: z.boolean() }).strict();
export const zodyMcpReadResourceParamsSchema = z
  .object({ ...zodyMcpUiPluginScopeShape, uri: nonEmptyString.max(2048) })
  .strict();
export type ZodyMcpReadResourceParams = z.infer<typeof zodyMcpReadResourceParamsSchema>;
export const zodyMcpResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const zodyMcpReadResourceResultSchema = z
  .object({ contents: z.array(zodyMcpResourceContentSchema) })
  .strict();
export type ZodyMcpReadResourceResult = z.infer<typeof zodyMcpReadResourceResultSchema>;

/**
 * 插件页面发起的 `resources/read` 代理。
 * 与 `mcp/readResource`（宿主取 ui:// HTML）参数同形，但结果去掉 `_meta`、受 8 MiB 与 mimeType 白名单约束。
 */
export const zodyMcpUiReadResourceParamsSchema = zodyMcpReadResourceParamsSchema;
export type ZodyMcpUiReadResourceParams = z.infer<typeof zodyMcpUiReadResourceParamsSchema>;
export const zodyMcpUiResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
  })
  .strict();
export const zodyMcpUiReadResourceResultSchema = z
  .object({ contents: z.array(zodyMcpUiResourceContentSchema) })
  .strict();
export type ZodyMcpUiReadResourceResult = z.infer<typeof zodyMcpUiReadResourceResultSchema>;

export const zodyMcpUiSamplingParamsSchema = z
  .object({
    ...zodyMcpUiPluginScopeShape,
    operationId: nonEmptyString.max(128),
    request: mcpAppsSamplingParamsSchema,
  })
  .strict();
export const zodyMcpUiCancelSamplingParamsSchema = z
  .object({ ...zodyMcpUiPluginScopeShape, operationId: nonEmptyString.max(128) })
  .strict();
export const zodyMcpUiSamplingResultSchema = mcpAppsSamplingResultSchema;
export type ZodyMcpUiSamplingParams = z.infer<typeof zodyMcpUiSamplingParamsSchema>;
export type ZodyMcpUiCancelSamplingParams = z.infer<typeof zodyMcpUiCancelSamplingParamsSchema>;

export const zodyMcpUiCallToolParamsSchema = z
  .object({
    ...zodyMcpUiPluginScopeShape,
    toolName: nonEmptyString,
    arguments: z.record(z.string(), z.unknown()).optional(),
    /** 宿主生成的调用 id，配合 `mcp/uiCancelCall` 取消进行中的调用。 */
    callId: nonEmptyString.max(128),
  })
  .strict();
export type ZodyMcpUiCallToolParams = z.infer<typeof zodyMcpUiCallToolParamsSchema>;
/** 取消页面发起的工具调用（卡片卸载、会话切换）；agent 侧 abort 到 MCP client。 */
export const zodyMcpUiCancelCallParamsSchema = z
  .object({ ...zodyMcpUiPluginScopeShape, callId: nonEmptyString.max(128) })
  .strict();
export type ZodyMcpUiCancelCallParams = z.infer<typeof zodyMcpUiCancelCallParamsSchema>;
export const zodyMcpUiCancelCallResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type ZodyMcpUiCancelCallResult = z.infer<typeof zodyMcpUiCancelCallResultSchema>;
/** 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe 代理。 */
export const zodyMcpUiListResourcesParamsSchema = z
  .object({ ...zodyMcpUiPluginScopeShape, cursor: nonEmptyString.max(2048).optional() })
  .strict();
export type ZodyMcpUiListResourcesParams = z.infer<typeof zodyMcpUiListResourcesParamsSchema>;
const zodyMcpUiResourceDescriptorSchema = z
  .object({
    uri: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    // MCP Resource 的标准字段；规范把资源级 csp / prefersBorder 放在这里，宿主读 HTML 项缺 _meta 时回退用。
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const zodyMcpUiListResourcesResultSchema = z
  .object({
    resources: z.array(zodyMcpUiResourceDescriptorSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
export type ZodyMcpUiListResourcesResult = z.infer<typeof zodyMcpUiListResourcesResultSchema>;
export const zodyMcpUiListResourceTemplatesResultSchema = z
  .object({
    resourceTemplates: z.array(
      z
        .object({
          uriTemplate: z.string(),
          name: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        })
        .strict(),
    ),
    nextCursor: z.string().optional(),
  })
  .strict();
export type ZodyMcpUiListResourceTemplatesResult = z.infer<
  typeof zodyMcpUiListResourceTemplatesResultSchema
>;
/** 订阅者身份 = 会话 + 沙箱作用域 + 实例代际（initId）；dispose 只退订本代际，新实例不受影响。 */
export const zodyMcpUiResourceSubscriptionParamsSchema = z
  .object({
    ...zodyMcpUiPluginScopeShape,
    scopeId: nonEmptyString.max(256),
    generation: z.number().int().nonnegative(),
    uri: nonEmptyString.max(2048),
  })
  .strict();
export type ZodyMcpUiResourceSubscriptionParams = z.infer<
  typeof zodyMcpUiResourceSubscriptionParamsSchema
>;
export const zodyMcpUiResourceSubscriptionResultSchema = z.object({}).strict();
/**
 * App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际（与资源订阅同一三元组）。
 * 登记按实例整体替换；调用认领 / 回传按 callId 幂等。
 */
const zodyMcpUiAppToolInstanceShape = {
  ...zodyMcpUiPluginScopeShape,
  scopeId: nonEmptyString.max(256),
  generation: z.number().int().nonnegative(),
};
export const zodyMcpUiRegisterAppToolsParamsSchema = z
  .object({
    ...zodyMcpUiAppToolInstanceShape,
    tools: z.array(mcpAppsAppToolDescriptorSchema).max(MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE),
  })
  .strict();
export type ZodyMcpUiRegisterAppToolsParams = z.infer<
  typeof zodyMcpUiRegisterAppToolsParamsSchema
>;
export const zodyMcpUiRegisterAppToolsResultSchema = z
  .object({ tools: z.array(z.object({ name: z.string(), modelName: z.string() }).strict()) })
  .strict();
export type ZodyMcpUiRegisterAppToolsResult = z.infer<
  typeof zodyMcpUiRegisterAppToolsResultSchema
>;
export const zodyMcpUiUnregisterAppToolsParamsSchema = z
  .object(zodyMcpUiAppToolInstanceShape)
  .strict();
export type ZodyMcpUiUnregisterAppToolsParams = z.infer<
  typeof zodyMcpUiUnregisterAppToolsParamsSchema
>;
export const zodyMcpUiUnregisterAppToolsResultSchema = z
  .object({ removed: z.number().int().nonnegative() })
  .strict();
export type ZodyMcpUiUnregisterAppToolsResult = z.infer<
  typeof zodyMcpUiUnregisterAppToolsResultSchema
>;
export const zodyMcpUiClaimAppToolCallParamsSchema = z
  .object({
    ...zodyMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
  })
  .strict();
export type ZodyMcpUiClaimAppToolCallParams = z.infer<
  typeof zodyMcpUiClaimAppToolCallParamsSchema
>;
export const zodyMcpUiAppToolAcceptedResultSchema = z.object({ accepted: z.boolean() }).strict();
export type ZodyMcpUiAppToolAcceptedResult = z.infer<typeof zodyMcpUiAppToolAcceptedResultSchema>;
export const zodyMcpUiResolveAppToolCallParamsSchema = z
  .object({
    ...zodyMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
    result: mcpAppsAppToolCallResultSchema.optional(),
    error: z
      .object({ message: z.string().max(MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.result === undefined) !== (value.error === undefined), {
    message: "exactly one of result or error is required",
  });
export type ZodyMcpUiResolveAppToolCallParams = z.infer<
  typeof zodyMcpUiResolveAppToolCallParamsSchema
>;
export const zodyMcpUiCallToolResultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ZodyMcpUiCallToolResult = z.infer<typeof zodyMcpUiCallToolResultSchema>;

export const zodySessionImportMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: timestampMsSchema.optional(),
  })
  .strict();
export type ZodySessionImportMessage = z.infer<typeof zodySessionImportMessageSchema>;

export const zodySessionImportHistorySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("claudeCode"),
      title: z.string().optional(),
      createdAt: timestampMsSchema.optional(),
      updatedAt: timestampMsSchema.optional(),
      messages: z.array(zodySessionImportMessageSchema).min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("sharedContext"),
      title: z.string().trim().min(1),
      createdAt: timestampMsSchema.optional(),
      markdown: z.string().min(1),
      provenance: z
        .object({
          shareId: z.string().trim().min(1),
          contextId: z.string().trim().min(1).optional(),
          shareUrl: z.string().url().optional(),
          status: z.enum(["pending", "reserved", "attached", "discarded"]).optional(),
          projectionSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          artifactSetSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          formatterVersion: z.literal(1),
          markdownSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          installedArtifacts: z.array(
            z
              .object({
                artifactId: z.string().trim().min(1),
                workspaceRelativePath: z.string().trim().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
]);
export type ZodySessionImportHistory = z.infer<typeof zodySessionImportHistorySchema>;

export const zodyThoughtLevelOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
  })
  .strict();
export const zodyModelReasoningOptionsSchema = z
  .object({
    levels: z.array(zodyThoughtLevelOptionSchema),
    defaultLevel: nonEmptyString.optional(),
  })
  .strict();
export type ZodyModelReasoningOptions = z.infer<typeof zodyModelReasoningOptionsSchema>;

export const zodyModelFormatPropertiesSchema = completeModelPropertiesDataSchema.pick({
  inputFormat: true,
  outputFormat: true,
});
export type ZodyModelFormatProperties = z.infer<typeof zodyModelFormatPropertiesSchema>;

export const zodyModelOptionSchema = z
  .object({
    ref: modelSelectionSchema,
    label: nonEmptyString,
    providerLabel: nonEmptyString.optional(),
    description: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: zodyModelReasoningOptionsSchema.optional(),
    properties: zodyModelFormatPropertiesSchema,
    disabledReason: z.string().optional(),
  })
  .strict();
export type ZodyModelOption = z.infer<typeof zodyModelOptionSchema>;

// fork（F4.11）：zcodeAccountAccessSchema / ZCodeAccountAccess 与
// zcodeProviderAccountAccessSchema / ZCodeProviderAccountAccess 随官方账号 Provider 删除。
// 旧持久化 settings/provisioning 中的 providerFamily* 字段仍由 validationAppSettings 宽松解析，
// 但协议层不再承载账号 Access 或 accountAccess 请求字段。

export type ZodySessionMode = z.infer<typeof zodySessionModeSchema>;
export type ZodySessionKind = z.infer<typeof zodySessionKindSchema>;
export type ZodySessionGoal = z.infer<typeof zodySessionGoalSchema>;

export const zodySessionTodoItemSchema = z
  .object({
    content: nonEmptyString,
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
  })
  .strict();
export const zodySessionGoalStatsSchema = z
  .object({
    timeUsedSeconds: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    iterationCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZodySessionGoalStats = z.infer<typeof zodySessionGoalStatsSchema>;
export type ZodySessionGoalVerification = z.infer<typeof zodySessionGoalVerificationSchema>;
export type ZodySessionGoalVerificationTimeline = z.infer<
  typeof zodySessionGoalVerificationTimelineSchema
>;

export const zodySessionTodoGroupSchema = z
  .object({
    id: nonEmptyString,
    source: z.enum(["goal_iteration", "session"]),
    goalIteration: z.number().int().positive().optional(),
    targetId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema.optional(),
    todos: z.array(zodySessionTodoItemSchema),
  })
  .strict();
export type ZodySessionTodoGroup = z.infer<typeof zodySessionTodoGroupSchema>;

export const zodySessionSettingsStateSchema = z
  .object({
    model: z
      .object({
        // 未绑定是合法恢复状态；不能为满足协议而伪造模型或阻断历史读取。
        current: modelSelectionSchema.optional(),
        available: z.array(zodyModelOptionSchema),
        lastUsed: modelSelectionSchema.optional(),
      })
      .strict(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: nonEmptyString.optional(),
        defaultLevel: nonEmptyString.optional(),
        available: z.array(zodyThoughtLevelOptionSchema),
      })
      .strict(),
    mode: z
      .object({
        current: zodySessionModeSchema,
      })
      .strict(),
    permission: z
      .object({
        mode: zodySessionModeSchema.optional(),
        rulesRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZodySessionSettingsState = z.infer<typeof zodySessionSettingsStateSchema>;
export const zodyPendingPermissionSchema = z
  .object({
    requestId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown().optional(),
    origin: zodyInteractionRequestOriginSchema.optional(),
    options: z.array(zodyPermissionOptionSchema).min(1),
    requestedAt: timestampMsSchema,
  })
  .strict();
export type ZodyPendingPermission = z.infer<typeof zodyPendingPermissionSchema>;

export const zodyActiveToolCallSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    status: z.enum(["pending", "running", "completed", "failed", "denied"]),
    startedAt: timestampMsSchema.optional(),
  })
  .strict();
export type ZodyActiveToolCall = z.infer<typeof zodyActiveToolCallSchema>;

export const zodySessionProjectionSchema = z
  .object({
    sessionId: nonEmptyString,
    status: zodySessionStatusSchema,
    mode: zodySessionModeSchema,
    turnCount: z.number().int().nonnegative(),
    totalTokenCount: z.number().int().nonnegative(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    currentTurnId: nonEmptyString.optional(),
    pendingPermissions: z.array(zodyPendingPermissionSchema),
    activeToolCalls: z.array(zodyActiveToolCallSchema),
    backgroundJobs: z.array(jsonObjectSchema),
    target: zodySessionGoalSchema.nullable().optional(),
    lastError: z
      .object({
        type: nonEmptyString,
        code: nonEmptyString.optional(),
        message: nonEmptyString,
        detail: z.string().optional(),
        attribution: errorAttributionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZodySessionProjection = z.infer<typeof zodySessionProjectionSchema>;
export type ZodyToolState = z.infer<typeof zodyToolStateSchema>;
export const zodySlashCommandSchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    inputHint: z.string().optional(),
    source: z.enum(["builtin", "custom"]).optional(),
  })
  .strict();
export type ZodySessionApiRetryStatus = z.infer<typeof zodySessionApiRetryStatusSchema>;
export type ZodySessionContextUsage = z.infer<typeof zodySessionContextUsageSchema>;
export const zodyModelStreamingKindSchema = z.enum([
  "start",
  "finish",
  "error",
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
]);
export const zodyModelStreamingEventPayloadSchema = z
  .object({
    assistantMessageId: z.string().optional(),
    delta: z.string().optional(),
    done: z.boolean().optional(),
    input: z.unknown().optional(),
    kind: zodyModelStreamingKindSchema,
    partId: z.string().optional(),
    providerExecuted: z.boolean().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
export const zodySessionStateSnapshotSchema = z
  .object({
    protocol: z
      .object({
        name: z.literal(ZODY_PROTOCOL_NAME),
        version: z.literal(ZODY_PROTOCOL_VERSION),
      })
      .strict(),
    session: zodySessionInfoSchema,
    settings: zodySessionSettingsStateSchema,
    projection: zodySessionProjectionSchema,
    runtime: zodySessionRuntimeStateSchema,
    messages: z.array(zodyMessageWithPartsSchema),
    goalStats: zodySessionGoalStatsSchema.optional(),
    todos: z.array(zodySessionTodoItemSchema).optional(),
    todoGroups: z.array(zodySessionTodoGroupSchema).optional(),
    slashCommands: z.array(zodySlashCommandSchema).optional(),
  })
  .strict();
export type ZodySessionStateSnapshot = z.infer<typeof zodySessionStateSnapshotSchema>;

export const zodyEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    seq: z.number().int().nonnegative(),
    traceId: nonEmptyString.optional(),
    timestamp: timestampMsSchema,
    deliveryKind: zodyDeliveryKindSchema.optional(),
  })
  .strict();

const zodyComputerUseOperationEventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    sequenceNumber: z.number().int().nonnegative(),
    sessionId: nonEmptyString,
    timestamp: timestampMsSchema,
  })
  .strict();

const zodyComputerUseTurnStartedEventSchema = zodyComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-started"),
  turnId: nonEmptyString,
});
const zodyComputerUseTurnCompletedEventSchema = zodyComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-completed"),
  turnId: nonEmptyString,
});
const zodyComputerUseTurnFailedEventSchema = zodyComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-failed"),
  turnId: nonEmptyString,
});
const zodyComputerUseToolScheduledEventSchema = zodyComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-scheduled"),
  turnId: nonEmptyString,
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  // 这个 cell 是否在用 Computer Use。只表达布尔事实，不再携带动作名——旧的
  // operationAction 靠从模型源码里抽取动作名得到，SDK 面一变就整体失配（见
  // bootstrap/src/zody-protocol/computer-use-operation-event.ts 的 usesComputerUse）。
  // 只挂在 scheduled 上：ToolCallStartedPayload 没有 input，start 时已拿不到模型源码。
  computerUse: z.literal(true).optional(),
});
const zodyComputerUseToolStartedEventSchema = zodyComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-started"),
  turnId: nonEmptyString.optional(),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString.optional(),
});
const zodyComputerUseSessionClosedEventSchema = zodyComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("session-closed"),
});

export const zodyComputerUseOperationEventSchema = z.discriminatedUnion("kind", [
  zodyComputerUseTurnStartedEventSchema,
  zodyComputerUseTurnCompletedEventSchema,
  zodyComputerUseTurnFailedEventSchema,
  zodyComputerUseToolScheduledEventSchema,
  zodyComputerUseToolStartedEventSchema,
  zodyComputerUseSessionClosedEventSchema,
]);
export type ZodyComputerUseOperationEvent = z.infer<typeof zodyComputerUseOperationEventSchema>;

export const zodySessionEventTypeSchema = z.enum([
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
]);
export type ZodySessionEventType = z.infer<typeof zodySessionEventTypeSchema>;

export const zodyProtocolErrorDetailSchema = z
  .object({
    type: nonEmptyString,
    message: nonEmptyString,
    stack: z.string().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
    underlyingErrorMessage: z.string().optional(),
    underlyingErrorDetail: z.string().optional(),
    attribution: errorAttributionSchema.optional(),
    retryable: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .strict();
export const zodySessionCreatedEventPayloadSchema = z
  .object({
    mode: zodySessionModeSchema,
    contextWindow: z.number().int().nonnegative(),
  })
  .strict();
export const zodySessionResumedEventPayloadSchema = z
  .object({
    directory: nonEmptyString,
    interruptedToolCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    partCount: z.number().int().nonnegative(),
    recoveredCompactTimelineCount: z.number().int().nonnegative().optional(),
    recoveredSteerInputCount: z.number().int().nonnegative().optional(),
    resumedTodoCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export const zodySessionTitleUpdatedEventPayloadSchema = z
  .object({
    messageID: nonEmptyString.optional(),
    previousTitle: z.string(),
    source: z.enum(["default", "first_input", "generated", "custom"]),
    title: z.string(),
  })
  .strict();
export const zodyTurnStartedEventPayloadSchema = z
  .object({
    // CLI 的高精度执行时间可含小数；漏声明会使 strict 校验丢弃整条开始事件，Bot 因此无法清空上一轮回复。
    executionStartedAt: z.number().nonnegative().optional(),
    turnNumber: z.number().int().nonnegative(),
    input: z.string(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    inputSource: zodyTurnInputSourceSchema.optional(),
    inputVisibility: zodyMessageVisibilitySchema.optional(),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    targetId: nonEmptyString.optional(),
    messageId: nonEmptyString.optional(),
    foregroundExecutionId: nonEmptyString.optional(),
    intent: jsonObjectSchema.optional(),
    originMeta: jsonObjectSchema.optional(),
    // runtime 会透传后台唤醒来源，strict schema 必须同步声明以免丢弃整条事件。
    backgroundSource: z.enum(["bash", "subagent"]).optional(),
    attachments: z.array(jsonObjectSchema).optional(),
  })
  .strict();
const zodyTurnSteerSourceSchema = z.enum(["plan_approval_feedback", "workflow_refine_feedback"]);
const zodyTurnSteerCommandKindSchema = z.enum(["sendText", "sendGoalCommand", "compact"]);
const zodyTurnSteerDeliverySchema = z.enum(["queue", "guide"]);

export const zodyTurnSteerQueuedEventPayloadSchema = z
  .object({
    pendingInputId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    input: z.string(),
    inputPreview: z.string(),
    inputSize: z.number().int().nonnegative(),
    commandKind: zodyTurnSteerCommandKindSchema.optional(),
    source: zodyTurnSteerSourceSchema.optional(),
    toolDisallowlist: z.array(nonEmptyString).optional(),
    delivery: zodyTurnSteerDeliverySchema.optional(),
    targetTurnId: nonEmptyString,
    queueLength: z.number().int().nonnegative(),
    intent: jsonObjectSchema.optional(),
  })
  .strict();
export const zodyTurnSteerDrainedEventPayloadSchema = z
  .object({
    pendingInputIds: z.array(nonEmptyString),
    queryIds: z.array(nonEmptyString).optional(),
    targetTurnId: nonEmptyString,
    injectedMessageIds: z.array(nonEmptyString),
    drainedInputs: z
      .array(
        z
          .object({
            pendingInputId: nonEmptyString,
            messageId: nonEmptyString,
            text: z.string(),
            delivery: zodyTurnSteerDeliverySchema.optional(),
            intent: jsonObjectSchema.optional(),
            toolDisallowlist: z.array(nonEmptyString).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const zodyTurnCompletedEventPayloadSchema = z
  .object({
    response: z.string(),
    tokenCount: z.number().int().nonnegative(),
    usage: z.unknown().optional(),
    toolCallCount: z.number().int().nonnegative(),
    historyRoundCount: z.number().int().nonnegative().optional(),
    duration: z.number().nonnegative(),
    // runtime turn.completed 会附带 cacheStats，协议 schema 之前漏掉该字段。
    // strict 校验失败会让桌面端丢掉终态事件，表现为消息已完成但 UI 一直没有回复。
    cacheStats: z
      .object({
        totalMessages: z.number().int().nonnegative(),
        cachedMessages: z.number().int().nonnegative(),
        lastCacheHit: z.boolean(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    inputId: nonEmptyString.optional(),
    resultType: z.enum([
      "success",
      // "cancelled": 用户主动中断属于正常结束，复用 turn.completed 上报，避免被映射成 turn.failed。
      "cancelled",
      "error_max_turns",
      "error_max_budget",
      "error_during_execution",
      "error_max_tool_calls",
    ]),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
export const zodyTurnFailedEventPayloadSchema = z
  .object({
    error: zodyProtocolErrorDetailSchema,
    turnPhase: z.string(),
    inputId: nonEmptyString.optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
export const zodyMessageUpsertedEventPayloadSchema = z
  .object({
    content: z.string(),
    attachments: z.array(z.unknown()).optional(),
    toolCalls: z.array(z.unknown()).optional(),
    type: z.string().optional(),
    compactBoundary: z.unknown().optional(),
  })
  .strict();
export const zodyMessageRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
export const zodyMessagePartDeltaEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    field: z.enum(["text", "reasoning", "input", "output"]).optional(),
    delta: z.string(),
  })
  .strict();
export const zodyMessagePartUpsertedEventPayloadSchema = z
  .object({
    part: zodyMessagePartSchema,
  })
  .strict();
export const zodyMessagePartRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
const zodyToolCallBasePayloadSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: z.string().optional(),
    parentToolCallId: nonEmptyString.optional(),
    source: z.enum(["subagent"]).optional(),
    agentId: nonEmptyString.optional(),
    agentType: nonEmptyString.optional(),
    // subagent mirror 会携带后台归因；strict schema 漏字段会让 session/event 整条被丢弃。
    background: z.boolean().optional(),
    childSessionId: nonEmptyString.optional(),
    childToolCallId: nonEmptyString.optional(),
    description: z.string().optional(),
  })
  .strict();

export const zodyToolUpdatedEventPayloadSchema = z.discriminatedUnion("kind", [
  zodyToolCallBasePayloadSchema
    .extend({
      kind: z.literal("scheduled"),
      // 修复：CLI 调度事件已携带所属消息 ID；漏声明会让严格校验丢弃整条事件。
      assistantMessageId: nonEmptyString.optional(),
      toolName: nonEmptyString,
      input: z.unknown().optional(),
      inputByteLength: z.number().int().nonnegative().optional(),
      inputOmitted: z.boolean().optional(),
      inputRef: z.literal("model_stream").optional(),
      dependencies: z.array(nonEmptyString).optional(),
      parallelGroupIndex: z.number().int().nonnegative().optional(),
      canRunParallel: z.boolean().optional(),
      schedule: jsonObjectSchema.optional(),
    })
    .strict(),
  zodyToolCallBasePayloadSchema
    .extend({
      kind: z.literal("started"),
      startedAt: protocolInstantSchema,
    })
    .strict(),
  zodyToolCallBasePayloadSchema
    .extend({
      kind: z.literal("progress"),
      elapsedMs: z.number().nonnegative().optional(),
      pid: z.number().int().optional(),
      stdoutBytes: z.number().int().nonnegative().optional(),
      stderrBytes: z.number().int().nonnegative().optional(),
      outputBytes: z.number().int().nonnegative().optional(),
      outputPreview: executionOutputPreviewSchema.optional(),
      stdoutTail: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .strict(),
  zodyToolCallBasePayloadSchema
    .extend({
      kind: z.literal("result"),
      result: zodyToolResultObjectSchema,
      duration: z.number().nonnegative(),
    })
    .strict(),
  zodyToolCallBasePayloadSchema
    .extend({
      kind: z.literal("error"),
      error: zodyProtocolErrorDetailSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      toolCallIds: z.array(nonEmptyString),
      successCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
    })
    .strict(),
  zodyToolCallBasePayloadSchema
    .extend({
      kind: z.literal("raw"),
      payload: jsonObjectSchema,
    })
    .strict(),
]);
export const zodyPermissionRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    reason: z.string(),
    input: z.unknown(),
    suggestedPermissionUpdates: z.array(zodyPermissionUpdateSchema).optional(),
    approvalMode: z.literal("user-once").optional(),
    origin: zodyInteractionRequestOriginSchema.optional(),
    options: z.array(zodyPermissionOptionSchema).min(1),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
export const zodyPermissionResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    decision: zodyPermissionDecisionSchema.optional(),
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    inputSummary: z.unknown().optional(),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
export const zodyUserInputRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    prompt: z.string(),
    inputType: z.enum(["text", "choice", "confirm"]).optional(),
    choices: z.array(z.string()).optional(),
  })
  .strict();
export const zodyUserInputResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    value: z.unknown().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();
export const zodySessionClosedEventPayloadSchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict();

function zodySessionEventEnvelopeFor<T extends ZodySessionEventType>(
  type: T,
  payload: z.ZodTypeAny,
) {
  return zodyEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: payload.optional(),
  });
}

export const zodySessionEventSchema = z.discriminatedUnion("type", [
  zodySessionEventEnvelopeFor("session.created", zodySessionCreatedEventPayloadSchema),
  zodySessionEventEnvelopeFor("session.resumed", zodySessionResumedEventPayloadSchema),
  zodySessionEventEnvelopeFor("session.updated", jsonObjectSchema),
  zodySessionEventEnvelopeFor("session.titleUpdated", zodySessionTitleUpdatedEventPayloadSchema),
  zodySessionEventEnvelopeFor("session.closed", zodySessionClosedEventPayloadSchema),
  zodySessionEventEnvelopeFor("turn.started", zodyTurnStartedEventPayloadSchema),
  zodySessionEventEnvelopeFor("turn.steerQueued", zodyTurnSteerQueuedEventPayloadSchema),
  zodySessionEventEnvelopeFor("turn.steerDrained", zodyTurnSteerDrainedEventPayloadSchema),
  zodySessionEventEnvelopeFor("turn.completed", zodyTurnCompletedEventPayloadSchema),
  zodySessionEventEnvelopeFor("turn.failed", zodyTurnFailedEventPayloadSchema),
  zodySessionEventEnvelopeFor("message.upserted", zodyMessageUpsertedEventPayloadSchema),
  zodySessionEventEnvelopeFor("message.removed", zodyMessageRemovedEventPayloadSchema),
  zodySessionEventEnvelopeFor("part.started", zodyMessagePartUpsertedEventPayloadSchema),
  zodySessionEventEnvelopeFor("part.delta", zodyMessagePartDeltaEventPayloadSchema),
  zodySessionEventEnvelopeFor("part.upserted", zodyMessagePartUpsertedEventPayloadSchema),
  zodySessionEventEnvelopeFor("part.removed", zodyMessagePartRemovedEventPayloadSchema),
  zodySessionEventEnvelopeFor("model.streaming", zodyModelStreamingEventPayloadSchema),
  zodySessionEventEnvelopeFor("tool.updated", zodyToolUpdatedEventPayloadSchema),
  zodySessionEventEnvelopeFor("permission.requested", zodyPermissionRequestedEventPayloadSchema),
  zodySessionEventEnvelopeFor("permission.resolved", zodyPermissionResolvedEventPayloadSchema),
  zodySessionEventEnvelopeFor("userInput.requested", zodyUserInputRequestedEventPayloadSchema),
  zodySessionEventEnvelopeFor("userInput.resolved", zodyUserInputResolvedEventPayloadSchema),
  zodySessionEventEnvelopeFor("checkpoint.created", jsonObjectSchema),
  zodySessionEventEnvelopeFor("rewind.triggered", jsonObjectSchema),
  zodySessionEventEnvelopeFor("streamRecovery.updated", jsonObjectSchema),
]);
export type ZodySessionEvent = z.infer<typeof zodySessionEventSchema>;

export const zodySessionEventsResultSchema = z
  .object({
    events: z.array(zodySessionEventSchema),
  })
  .strict();
export const zodySessionMessagesResultSchema = z
  .object({
    messages: z.array(zodyMessageWithPartsSchema),
  })
  .strict();
export const zodyStateUpdatedNotificationSchema = z
  .object({
    type: z.literal("state.updated"),
    scope: z.enum(["server", "workspace", "session"]),
    workspace: zodyWorkspaceRefSchema.optional(),
    sessionId: nonEmptyString.optional(),
    revision: z.number().int().nonnegative(),
    reason: z.string().optional(),
    patch: z.unknown(),
  })
  .strict();
export type ZodyStateUpdatedNotification = z.infer<typeof zodyStateUpdatedNotificationSchema>;

export const zodySessionSubscribeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zodyDeliveryKindSchema,
    afterSeq: z.number().int().nonnegative().optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export type ZodySessionSubscribeParams = z.infer<typeof zodySessionSubscribeParamsSchema>;

export const zodySessionSubscribeResultSchema = z
  .object({
    sessionId: nonEmptyString,
    eventSeq: z.number().int().nonnegative(),
    events: z.array(zodySessionEventSchema),
    snapshot: zodySessionStateSnapshotSchema.optional(),
  })
  .strict();
export const zodySessionListResultSchema = z
  .object({
    sessions: z.array(zodySessionInfoSchema),
  })
  .strict();

const zodySessionSubagentBaseSchema = z
  .object({
    childSessionId: nonEmptyString,
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    subagentType: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const zodySessionRunningSubagentSchema = zodySessionSubagentBaseSchema.extend({
  status: z.enum(["running", "waiting", "blocked"]),
});
export type ZodySessionRunningSubagent = z.infer<typeof zodySessionRunningSubagentSchema>;

export const zodySessionEndedSubagentSchema = zodySessionSubagentBaseSchema.extend({
  status: z.enum(["success", "failed", "cancelled", "lost"]),
});
export type ZodySessionEndedSubagent = z.infer<typeof zodySessionEndedSubagentSchema>;

export const zodySessionSubagentsResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    childSessionIds: z.array(nonEmptyString),
    running: z.array(zodySessionRunningSubagentSchema),
    ended: z
      .object({
        total: z.number().int().nonnegative(),
        items: z.array(zodySessionEndedSubagentSchema),
        nextCursor: nonEmptyString.optional(),
      })
      .strict(),
  })
  .strict();
export type ZodySessionSubagentsResult = z.infer<typeof zodySessionSubagentsResultSchema>;
/** 服务端 feature key 的取值域在协议里的 zod 形态（packages/shared/src/dynamic-workflow-feature.ts）。 */
export const zodyDynamicWorkflowModeSchema = z.enum(DYNAMIC_WORKFLOW_MODES);

export const zodySessionCreateParamsSchema = z
  .object({
    sessionId: nonEmptyString.optional(),
    workspace: zodyWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    mode: zodySessionModeSchema.optional(),
    model: modelSelectionSchema.optional(),
    persistence: zodySessionPersistenceSchema.optional(),
    thoughtLevel: nonEmptyString.optional(),
    titleGenerationEnabled: z.boolean().optional(),
    mcpServers: z.array(zodyProtocolMcpServerSchema).optional(),
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    importedHistory: zodySessionImportHistorySchema.optional(),
    // host 只按本地服务装配/远程/端形态决定是否注册工具，不读取灰度；
    // 缺省不下发 = 不注册；灰度与套餐准入在实际创建的 Host handler 校验。
    // fork（F4.3）：offPeakToolEnabled 随闲时任务全链路删除。
    // 动态工作流灰度：与原 offPeakToolEnabled 同一
    // 模式——host 裁决后下发，缺省不下发 = 不注册工作流工具簇（fail-closed）。
    dynamicWorkflowEnabled: z.boolean().optional(),
    // 灰度 mode 随布尔同行下发（launch.md「On demand: activation」）：`onDemand` 让 CLI 把十个
    // 工具推迟到会话首次 `/workflow` 才注册；缺席 = 按布尔行事（alwaysOn），供旧 Host 配对。
    dynamicWorkflowMode: zodyDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZodySessionCreateParams = z.infer<typeof zodySessionCreateParamsSchema>;

export const zodySessionResumeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    workspace: zodyWorkspaceRefSchema.optional(),
    // 旧 session 尚无 runtime/model_selection entry 时，由同 task 的索引元数据提供迁移 hint。
    thoughtLevel: nonEmptyString.optional(),
    mcpServers: z.array(zodyProtocolMcpServerSchema).optional(),
    // 冷恢复重建 runtime 时必须沿用 create 的工具面约束（否则会绕过 allow/deny，尤其 CUA 会话）。
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    // 与 create 同语义；resume 不带会导致冷恢复丢工作流工具簇。
    // fork（F4.3）：offPeakToolEnabled 随闲时任务全链路删除。
    dynamicWorkflowEnabled: z.boolean().optional(),
    dynamicWorkflowMode: zodyDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZodySessionResumeParams = z.infer<typeof zodySessionResumeParamsSchema>;

export const zodySessionListParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema.optional(),
    // 显式身份查询包含隐藏会话；普通列表仍只返回主任务，避免索引修复激活 runtime。
    sessionIds: z.array(nonEmptyString).min(1).max(64).optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZodySessionListParams = z.infer<typeof zodySessionListParamsSchema>;

export const zodySessionSubagentsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    endedCursor: nonEmptyString.optional(),
    endedLimit: z.number().int().positive().max(100).default(20),
  })
  .strict();
export type ZodySessionSubagentsParams = z.infer<typeof zodySessionSubagentsParamsSchema>;

export const zodyUsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export const zodyUsageStatsResultSchema = appUsageSnapshotSchema;
export const zodyTaskTokenUsageParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
export const zodyTaskTokenUsageResultSchema = z
  .object({
    sessionId: nonEmptyString,
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type ZodyTaskTokenUsageResult = z.infer<typeof zodyTaskTokenUsageResultSchema>;

export const zodySessionReadParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zodyDeliveryKindSchema.optional(),
    messageLimit: z.number().int().positive().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    // "index"：仅 task index resync 使用，返回剥离 tool/reasoning/data URL 大载荷的同结构 snapshot，
    // 结果禁止回写 UI 状态；缺省等同 "full"。
    contentProfile: z.enum(["full", "index"]).optional(),
  })
  .strict();
export type ZodySessionReadParams = z.infer<typeof zodySessionReadParamsSchema>;

export const zodySessionMessagesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterMessageId: nonEmptyString.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZodySessionMessagesParams = z.infer<typeof zodySessionMessagesParamsSchema>;

export const zodySessionEventsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZodySessionEventsParams = z.infer<typeof zodySessionEventsParamsSchema>;

export const zodySessionRuntimePreferencesScopeSchema = z.enum([
  "runtime-materialization",
  "user-execution",
]);
export type ZodySessionRuntimePreferencesScope = z.infer<
  typeof zodySessionRuntimePreferencesScopeSchema
>;

// subagents/readRuntimeConfig 返回 Host 已解析的完整快照或显式内置回退，不再传 Markdown。
export {
  subagentRuntimeConfigSchema,
  type SubagentRuntimeConfig,
} from "../subagent-runtime-config.js";
export const zodySubagentsReadRuntimeConfigParamsSchema = z
  .object({ sessionId: nonEmptyString })
  .strict();

export const ZODY_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS = 15_000;

export const zodySessionRequestRuntimePreferencesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    scope: zodySessionRuntimePreferencesScopeSchema,
  })
  .strict();
export type ZodySessionRequestRuntimePreferencesParams = z.infer<
  typeof zodySessionRequestRuntimePreferencesParamsSchema
>;

export const DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY = "preflight-v1" as const;

// 3.12.2：legacy 仅为旧协议接收兼容；Runtime 一律归一为上面的共享默认策略。
export const zodyModelContextBudgetStrategySchema = z.enum(["legacy", "preflight-v1"]);
export type ZodyModelContextBudgetStrategy = z.infer<typeof zodyModelContextBudgetStrategySchema>;

export const zodySessionRuntimePreferencesResultSchema = z
  .object({
    nativeSearchEnhancementsEnabled: z.boolean(),
    subagentRuntimeConfigEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().default(false),
    askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
    integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
    // 兼容旧 Host：缺少字段时在协议解析边界使用当前默认策略。
    modelContextBudgetStrategy: zodyModelContextBudgetStrategySchema.default(
      DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    ),
  })
  .strict();
export type ZodySessionRuntimePreferencesResult = z.infer<
  typeof zodySessionRuntimePreferencesResultSchema
>;

/**
 * App 在提交 prompt 前只读采集的 IAB 可见状态。该字段只用于 provider-visible
 * ambient context，不进入用户可见 transcript；内容有界，禁止携带页面正文或凭据。
 */
export const zodyBrowserAmbientContextSchema = z
  .object({
    tabCount: z.number().int().positive().max(100),
    currentUrl: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
export type ZodyBrowserAmbientContext = z.infer<typeof zodyBrowserAmbientContextSchema>;

export const zodySessionSendParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    modelExecution: modelExecutionSchema.optional(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    content: z.string(),
    attachments: z.array(jsonObjectSchema).optional(),
    browserAmbientContext: zodyBrowserAmbientContextSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedProviderRevision: nonEmptyString.optional(),
    automationId: nonEmptyString.optional(),
    // fork（F4.3）：offPeakTaskId/offPeakRunType（闲时派发归因）随闲时任务全链路删除。
    // fork（bots移除）：定时任务 Bot 回推目标字段随第三方 IM bot channels 全量删除。
    toolDenylist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.modelExecution && !payload.modelSelection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelExecution requires modelSelection",
        path: ["modelExecution"],
      });
    }
  });
export const zodySessionSendResultSchema = z
  .object({
    sessionId: nonEmptyString,
    accepted: z.literal(true),
    stateRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ZodySessionSendResult = z.infer<typeof zodySessionSendResultSchema>;

export const zodySessionHistoryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("turn"),
      turnIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      messageId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      checkpointId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("latestCheckpoint"),
    })
    .strict(),
]);
export type ZodySessionHistoryTarget = z.infer<typeof zodySessionHistoryTargetSchema>;

export const zodySessionForkParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    target: zodySessionHistoryTargetSchema.default({
      kind: "latestCheckpoint",
    }),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZodySessionForkParams = z.infer<typeof zodySessionForkParamsSchema>;

export const zodySessionForkResultSchema = z
  .object({
    forkedSessionId: nonEmptyString,
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: nonEmptyString.optional(),
    response: z.string(),
    snapshot: zodySessionStateSnapshotSchema,
  })
  .strict();
export type ZodySessionForkResult = z.infer<typeof zodySessionForkResultSchema>;

export const zodySessionCompactParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    instructions: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZodySessionCompactParams = z.infer<typeof zodySessionCompactParamsSchema>;

export const zodySessionCompactResultSchema = z
  .object({
    response: z.string(),
    snapshot: zodySessionStateSnapshotSchema,
    compact: z
      .object({
        state: z.enum(["accepted", "already_running"]),
        inputId: nonEmptyString.optional(),
        operationId: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZodySessionCompactResult = z.infer<typeof zodySessionCompactResultSchema>;

export const zodySessionGoalActionSchema = z.enum([
  "show",
  "set",
  "replace",
  "pause",
  "resume",
  "clear",
]);
export type ZodySessionGoalAction = z.infer<typeof zodySessionGoalActionSchema>;

export const zodySessionGoalParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    action: zodySessionGoalActionSchema,
    objective: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZodySessionGoalParams = z.infer<typeof zodySessionGoalParamsSchema>;

export const zodySessionGoalResultSchema = z
  .object({
    response: z.string(),
    snapshot: zodySessionStateSnapshotSchema,
    startedTurn: z.boolean().optional(),
  })
  .strict();
export type ZodySessionGoalResult = z.infer<typeof zodySessionGoalResultSchema>;

export const zodySessionStopParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
const zodyBackgroundTaskInfoStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "lost",
]);

export const zodyBackgroundTaskInfoSchema = z
  .object({
    taskId: nonEmptyString,
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    taskKind: z.enum(["bash", "subagent"]).optional(),
    blocked: z.boolean().optional(),
    blockedReason: z.string().optional(),
    cancellable: z.boolean().optional(),
    cancelRequestedAt: protocolInstantSchema.optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    status: zodyBackgroundTaskInfoStatusSchema,
    pid: z.number().int().positive().optional(),
    startedAt: protocolInstantSchema.optional(),
    completedAt: protocolInstantSchema.optional(),
    outputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
    outputTail: z.string().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    stderrTail: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stdoutTail: z.string().optional(),
    terminalId: nonEmptyString.optional(),
  })
  .strict();
export const zodySessionCancelBackgroundTaskParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
  })
  .strict();
export type ZodySessionCancelBackgroundTaskParams = z.infer<
  typeof zodySessionCancelBackgroundTaskParamsSchema
>;

export const zodySessionCancelBackgroundTaskResultSchema = z
  .object({
    cancelled: z.boolean(),
    reason: z.string().optional(),
    snapshot: zodyBackgroundTaskInfoSchema.optional(),
    status: zodyBackgroundTaskInfoStatusSchema,
    taskId: nonEmptyString,
  })
  .strict();
export type ZodySessionCancelBackgroundTaskResult = z.infer<
  typeof zodySessionCancelBackgroundTaskResultSchema
>;

export const zodySessionSetModelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    model: modelSelectionSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZodySessionSetModelParams = z.infer<typeof zodySessionSetModelParamsSchema>;

export const zodySessionSetThoughtLevelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    thoughtLevel: nonEmptyString.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZodySessionSetThoughtLevelParams = z.infer<
  typeof zodySessionSetThoughtLevelParamsSchema
>;

export const zodySessionSetModeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    mode: zodySessionModeSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZodySessionSetModeParams = z.infer<typeof zodySessionSetModeParamsSchema>;

export const zodySessionCloseParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    expectedPersistence: zodySessionPersistenceSchema.optional(),
  })
  .strict();
export type ZodySessionCloseParams = z.infer<typeof zodySessionCloseParamsSchema>;
export const zodySessionCloseResultSchema = z
  .object({
    closed: z.boolean().optional(),
  })
  .strict();
export type ZodySessionCloseResult = z.infer<typeof zodySessionCloseResultSchema>;
export const zodyWorkspaceReadPresentationParamsSchema = z
  .object({ workspace: zodyWorkspaceRefSchema })
  .strict();
export const zodyWorkspacePresentationSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    mode: zodySessionModeSchema,
    slashCommands: z.array(zodySlashCommandSchema),
  })
  .strict();
export type ZodyWorkspacePresentation = z.infer<typeof zodyWorkspacePresentationSchema>;
const workspaceHookSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const zodyWorkspaceHookTrustGrantParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    bundleDigest: workspaceHookSha256DigestSchema,
    hookDeclarationDigest: workspaceHookSha256DigestSchema,
  })
  .strict();
export type ZodyWorkspaceHookTrustGrantParams = z.infer<
  typeof zodyWorkspaceHookTrustGrantParamsSchema
>;
export const zodyWorkspaceHookTrustGrantReasonCodeSchema = z.enum([
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_config_unreadable",
]);
export type ZodyWorkspaceHookTrustGrantReasonCode = z.infer<
  typeof zodyWorkspaceHookTrustGrantReasonCodeSchema
>;
export const zodyWorkspaceHookTrustGrantResultSchema = z
  .object({
    accepted: z.boolean(),
    reasonCode: zodyWorkspaceHookTrustGrantReasonCodeSchema.optional(),
  })
  .strict();
export type ZodyWorkspaceHookTrustGrantResult = z.infer<
  typeof zodyWorkspaceHookTrustGrantResultSchema
>;
const zodyWorkspaceModelToolCallSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    input: z.unknown(),
  })
  .strict();
const zodyWorkspaceModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(zodyWorkspaceModelToolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
      isError: z.boolean().optional(),
    })
    .strict(),
]);
const zodyWorkspaceModelToolSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const zodyWorkspaceGenerateTextParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    selection: modelSelectionSchema,
    prompt: nonEmptyString.optional(),
    messages: z.array(zodyWorkspaceModelMessageSchema).min(1).optional(),
    tools: z.array(zodyWorkspaceModelToolSchema).optional(),
    querySource: nonEmptyString,
    maxOutputTokens: z.number().int().positive().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict()
  .refine((value) => value.prompt !== undefined || value.messages !== undefined, {
    message: "prompt 或 messages 至少需要提供一个",
  });
export const zodyWorkspaceGenerateTextResultSchema = z
  .object({
    text: z.string(),
    selection: modelSelectionSchema,
    toolCalls: z.array(zodyWorkspaceModelToolCallSchema).optional(),
    // 可选以兼容仍在运行的旧 app-server；新 CLI 始终返回结构化结束原因。
    finishReason: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheWriteTokens: z.number().nonnegative().optional(),
        reasoningTokens: z.number().nonnegative().optional(),
        serverToolUse: z
          .object({
            webSearchRequests: z.number().nonnegative().optional(),
            webFetchRequests: z.number().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZodyWorkspaceGenerateTextParams = z.infer<
  typeof zodyWorkspaceGenerateTextParamsSchema
>;
export type ZodyWorkspaceModelMessage = z.infer<typeof zodyWorkspaceModelMessageSchema>;
export type ZodyWorkspaceModelTool = z.infer<typeof zodyWorkspaceModelToolSchema>;
export type ZodyWorkspaceGenerateTextResult = z.infer<
  typeof zodyWorkspaceGenerateTextResultSchema
>;
export const zodyWorkspaceCancelGenerateTextParamsSchema = z
  .object({ operationId: nonEmptyString })
  .strict();
export const zodyWorkspaceCancelGenerateTextResultSchema = z
  .object({ operationId: nonEmptyString, cancelled: z.boolean() })
  .strict();

export const zodyProviderTestModelConnectivityParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    selection: modelSelectionSchema,
  })
  .strict();
export const zodyProviderTestModelConnectivityResultSchema = z
  .object({ success: z.literal(true) })
  .strict();
export type ZodyProviderTestModelConnectivityParams = z.infer<
  typeof zodyProviderTestModelConnectivityParamsSchema
>;
export type ZodyProviderTestModelConnectivityResult = z.infer<
  typeof zodyProviderTestModelConnectivityResultSchema
>;

export const zodyProviderUpdateAccountConfigParamsSchema = z
  .object({
    revision: nonEmptyString,
    basedOnZodyBuiltinRevision: nonEmptyString,
    // Provider Config 的字段校验由 @zody/provider 负责；协议层只约束可传输信封。
    providers: z.record(z.string(), z.unknown()),
    // 账号状态与 Overlay 必须一起传递，否则 Worker 会丢失非当前套餐的执行门禁。
    states: z.record(
      z.string(),
      z
        .object({
          availability: z.enum(["available", "pending", "unavailable", "unknown"]),
          entitled: z.boolean(),
          unavailableReason: accountProviderUnavailableReasonSchema.optional(),
          current: z.boolean().optional(),
          connectionKey: z.string().optional(),
          effectiveAt: z.number().finite().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const zodyProviderUpdateAccountConfigResultSchema = z
  .object({
    // 收到账号结果不代表配套 Built-in 已到达；应用版本只能读取 Registry 快照。
    receivedRevision: nonEmptyString,
    providerCount: z.number().int().nonnegative(),
    status: z.enum(["received", "unchanged"]),
  })
  .strict();
export type ZodyProviderUpdateAccountConfigResult = z.infer<
  typeof zodyProviderUpdateAccountConfigResultSchema
>;
export const zodyInteractionPreferencesSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
  })
  .strict();
export type ZodyInteractionPreferences = z.infer<typeof zodyInteractionPreferencesSchema>;

export const zodyWorkspaceUpdateInteractionPreferencesParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    preferences: zodyInteractionPreferencesSchema,
  })
  .strict();
export type ZodyWorkspaceUpdateInteractionPreferencesParams = z.infer<
  typeof zodyWorkspaceUpdateInteractionPreferencesParamsSchema
>;

export const zodyWorkspaceUpdateInteractionPreferencesResultSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    snoozedInteractionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZodyWorkspaceUpdateInteractionPreferencesResult = z.infer<
  typeof zodyWorkspaceUpdateInteractionPreferencesResultSchema
>;

export const zodyModelIoPreferencesSchema = z
  .object({
    fullRetentionEnabled: z.boolean(),
  })
  .strict();
export type ZodyModelIoPreferences = z.infer<typeof zodyModelIoPreferencesSchema>;

export const zodyWorkspaceUpdateModelIoPreferencesParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    preferences: zodyModelIoPreferencesSchema,
  })
  .strict();
export type ZodyWorkspaceUpdateModelIoPreferencesParams = z.infer<
  typeof zodyWorkspaceUpdateModelIoPreferencesParamsSchema
>;

export const zodyWorkspaceUpdateModelIoPreferencesResultSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    fullRetentionEnabled: z.boolean(),
    updatedSessionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZodyWorkspaceUpdateModelIoPreferencesResult = z.infer<
  typeof zodyWorkspaceUpdateModelIoPreferencesResultSchema
>;

// fork（F4.3）：zcodeWorkspaceUpdateOffPeakToolPolicy{Params,Result}Schema（闲时工具策略
// workspace 更新 RPC）随闲时任务全链路删除。

// 动态工作流灰度门禁：workspace 级事实，
// 与 Off-Peak 同一套 host→CLI 同步模式；旧 CLI method-not-found → host 降级忽略。
export const zodyWorkspaceUpdateDynamicWorkflowPolicyParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    enabled: z.boolean(),
    // launch.md「On demand: activation」：mode 与布尔同行；缺席时 CLI 按布尔行事（alwaysOn）。
    mode: zodyDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZodyWorkspaceUpdateDynamicWorkflowPolicyParams = z.infer<
  typeof zodyWorkspaceUpdateDynamicWorkflowPolicyParamsSchema
>;

export const zodyWorkspaceUpdateDynamicWorkflowPolicyResultSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZodyWorkspaceUpdateDynamicWorkflowPolicyResult = z.infer<
  typeof zodyWorkspaceUpdateDynamicWorkflowPolicyResultSchema
>;

export const zodyPermissionRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown(),
    origin: zodyInteractionRequestOriginSchema.optional(),
    options: z.array(zodyPermissionOptionSchema).min(1),
  })
  .strict();
export type ZodyPermissionRequestParams = z.infer<typeof zodyPermissionRequestParamsSchema>;

/** Agent 请求 app 枚举当前 workspace/session 可达且已完成握手的 browser backend。 */
export const zodyBrowserListParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type ZodyBrowserListParams = z.infer<typeof zodyBrowserListParamsSchema>;

export const zodyBrowserListResultSchema = browserBackendListResultSchema;
export type ZodyBrowserListResult = z.infer<typeof zodyBrowserListResultSchema>;

/**
 * 用户显式配置的默认 backend（具体 browserId）。选择仍由 CLI 的 defaultBrowserId 规则执行；
 * Host 只提供设置事实，不能通过 descriptor metadata 伪造 preferred。
 */
export const zodyBrowserDefaultResultSchema = z
  .object({
    defaultBrowserId: nonEmptyString.optional(),
  })
  .strict();
export type ZodyBrowserDefaultResult = z.infer<typeof zodyBrowserDefaultResultSchema>;

/** Agent 把一条 browser-use 命令发送给 app 执行。 */
export const zodyBrowserExecuteParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    browserId: nonEmptyString.optional(),
    browserGeneration: z.number().int().nonnegative().optional(),
    workspaceKey: nonEmptyString.optional(),
    workspacePath: nonEmptyString.optional(),
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema.optional(),
    sessionContext: browserSessionContextKindSchema.optional(),
    command: browserCommandSchema,
  })
  .strict();
export type ZodyBrowserExecuteParams = z.infer<typeof zodyBrowserExecuteParamsSchema>;

// browser command result 是 app/agent 的同源协议结果；其中 duplicate_request_id 用于在真正维护
// pending/running 生命周期的边界拒绝 correlation key 冲突，不能依赖上游 UUID 概率保证。
export const zodyBrowserExecuteResultSchema = browserCommandResultSchema;
export type ZodyBrowserExecuteResult = z.infer<typeof zodyBrowserExecuteResultSchema>;

export const zodyUserInputOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();
export const zodyUserInputQuestionSchema = z
  .object({
    question: nonEmptyString,
    header: nonEmptyString,
    options: z.array(zodyUserInputOptionSchema).min(1),
    multiSelect: z.boolean().optional(),
  })
  .strict();
export type ZodyUserInputQuestion = z.infer<typeof zodyUserInputQuestionSchema>;

export const zodyUserInputRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    prompt: z.string().optional(),
    questions: z.array(zodyUserInputQuestionSchema).min(1).optional(),
    input: z.unknown().optional(),
    origin: zodyInteractionRequestOriginSchema.optional(),
    schema: z.unknown().optional(),
  })
  .strict();
export type ZodyUserInputRequestParams = z.infer<typeof zodyUserInputRequestParamsSchema>;

export const zodyUserInputResponseSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: jsonObjectSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ZodyUserInputResponse = z.infer<typeof zodyUserInputResponseSchema>;

export const zodyProviderRuntimeHeadersRequestReasonSchema = z.enum(requestVerificationReasons);
export const zodyProviderRuntimeHeadersRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspace: zodyWorkspaceRefSchema,
    modelSelection: modelSelectionSchema,
    providerId: nonEmptyString,
    // fork（F4.11）：accountAccess（zhipu-account 访问类别）随官方账号链路删除；
    // 普通 BYOK/自定义 provider 不需要账号 Access 刷新。
    expectedAccountScope: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    rejectedProjectTokenFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reason: zodyProviderRuntimeHeadersRequestReasonSchema,
  })
  .strict();
export type ZodyProviderRuntimeHeadersRequestParams = z.infer<
  typeof zodyProviderRuntimeHeadersRequestParamsSchema
>;

/** 请求取消只作用于同 workspace/session 的这一轮凭据刷新。 */
export const zodyProviderRuntimeHeadersCancelledSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    workspace: zodyWorkspaceRefSchema,
  })
  .strict();
export type ZodyProviderRuntimeHeadersCancelled = z.infer<
  typeof zodyProviderRuntimeHeadersCancelledSchema
>;

export const zodyProviderRuntimeHeadersResponseSchema = z.discriminatedUnion("headersApplied", [
  z
    .object({
      headersApplied: z.literal(true),
      // 合并重接：成功必须携带当前请求的鉴权材料，不依赖旧 Registry 已被写入。
      requestAuth: z
        .object({
          apiKey: nonEmptyString.optional(),
          apiKeyId: z.string().trim().min(1).optional(),
          accountScope: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          headers: z.record(nonEmptyString, nonEmptyString).optional(),
        })
        .strict(),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      headersApplied: z.literal(false),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
]);
export type ZodyProviderRuntimeHeadersResponse = z.infer<
  typeof zodyProviderRuntimeHeadersResponseSchema
>;

// fork（F4.6）：官方 Server MCP 鉴权的
// interaction/requestOfficialMcpAuthHeaders 请求/响应 schema 随鉴权链删除。

// ── Plugin management (list + enable/disable) ──
// 镜像 @zody/contracts 的 PluginMetadata, 仅保留 UI 需要的可序列化字段。
export const zodyPluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type ZodyPluginOptionValue = z.infer<typeof zodyPluginOptionValueSchema>;
export const zodyPluginScopeSchema = z.enum(["user", "workspace"]);
export type ZodyPluginScope = z.infer<typeof zodyPluginScopeSchema>;
export const zodyPluginHookDetailSchema = z
  .object({
    event: nonEmptyString,
    matcher: z.string().optional(),
    type: z.enum(["command", "process"]),
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string()]).optional(),
    timeout: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    statusMessage: z.string().optional(),
    sourcePath: z.string(),
    runnable: z.boolean(),
  })
  .strict();
export const zodyPluginUserConfigOptionSchema = z
  .object({
    default: zodyPluginOptionValueSchema.optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    title: z.string().optional(),
    type: z.enum(["string", "number", "boolean", "directory", "file"]).optional(),
  })
  .strict();
export type ZodyPluginUserConfigOption = z.infer<typeof zodyPluginUserConfigOptionSchema>;

// 组件类型与详情弹窗/市场详情共用的分组顺序保持一致：agent / command / skill / hook / mcp。
// 注意：这三个 schema 必须定义在 zodyPluginInfoSchema 之前，因为后者（.strict()）的 components 字段引用了它们。
export const zodyPluginComponentKindSchema = z.enum(["agent", "command", "skill", "hook", "mcp"]);
export type ZodyPluginComponentKind = z.infer<typeof zodyPluginComponentKindSchema>;

export const zodyPluginComponentItemSchema = z
  .object({
    name: nonEmptyString,
    // 描述来自组件 frontmatter（SKILL.md / command / agent）或 manifest；缺失时省略，不伪造。
    description: z.string().optional(),
  })
  .strict();
export const zodyPluginComponentGroupSchema = z
  .object({
    kind: zodyPluginComponentKindSchema,
    items: z.array(zodyPluginComponentItemSchema),
  })
  .strict();
export type ZodyPluginComponentGroup = z.infer<typeof zodyPluginComponentGroupSchema>;

export const zodyPluginInfoSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    source: nonEmptyString,
    marketplace: nonEmptyString,
    // manifest（plugin.json）的作者/主页回退字段；商店 listing 缺失时详情页信息区用它兜底。
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    skillCount: z.number().int().nonnegative().optional(),
    skillRootCount: z.number().int().nonnegative(),
    commandRootCount: z.number().int().nonnegative(),
    // 权威组件清单（名称 + 可选描述），由 CLI 对插件根目录枚举得出，与启用态无关。
    // 详情 UI 直接展示，取代旧的「数量取协议、名称靠 UI 侧 join」脆弱方案。optional 兼容旧 payload。
    components: z.array(zodyPluginComponentGroupSchema).optional(),
    declaredMcpServerNames: z.array(z.string()).optional(),
    hostMcpServerNames: z.array(z.string()).optional(),
    mcpServerNames: z.array(z.string()),
    hookDetails: z.array(zodyPluginHookDetailSchema).optional(),
    rootPath: z.string(),
    userConfig: z.record(z.string(), zodyPluginUserConfigOptionSchema).optional(),
    configuredOptions: z.record(z.string(), zodyPluginOptionValueSchema).optional(),
    // 缺省表示 package 可用；missing 用于保留已声明但目标 Host 尚未物化的配置行。
    packageStatus: z.literal("missing").optional(),
    rootSource: zodyPluginScopeSchema.optional(),
    enabledSource: zodyPluginScopeSchema.optional(),
    optionSources: z.record(z.string(), zodyPluginScopeSchema).optional(),
  })
  .strict();
export type ZodyPluginInfo = z.infer<typeof zodyPluginInfoSchema>;

export const zodyPluginDiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(["warning", "error"]).optional(),
    pluginId: z.string().optional(),
  })
  .strict();
export type ZodyPluginDiagnostic = z.infer<typeof zodyPluginDiagnosticSchema>;

export const zodyPluginsListParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    configScope: zodyPluginScopeSchema.optional(),
  })
  .strict();
export const zodyPluginsListResultSchema = z
  .object({
    plugins: z.array(zodyPluginInfoSchema),
    diagnostics: z.array(zodyPluginDiagnosticSchema),
  })
  .strict();
export type ZodyPluginsListResult = z.infer<typeof zodyPluginsListResultSchema>;

// ── 插件 UI 面板入口──
// 工作区级只读投影：已启用插件清单 `ui.surfaces[]` 的合法条目；插件启停后 host 重新拉取。
export const zodyPluginUiSurfaceSchema = z
  .object({
    pluginId: nonEmptyString,
    pluginName: nonEmptyString,
    id: nonEmptyString.max(128),
    title: z.union([nonEmptyString, z.record(z.string(), z.string())]),
    icon: z.string().optional(),
    // 运行时 namespaced server 名（plugin:<name>:<server>），可直接用于 mcp/uiReadResource。
    server: nonEmptyString,
    resourceUri: nonEmptyString.max(2048),
    availability: z.literal("session"),
  })
  .strict();
export type ZodyPluginUiSurface = z.infer<typeof zodyPluginUiSurfaceSchema>;
export const zodyPluginsListUiSurfacesParamsSchema = z
  .object({ workspace: zodyWorkspaceRefSchema })
  .strict();
export type ZodyPluginsListUiSurfacesParams = z.infer<
  typeof zodyPluginsListUiSurfacesParamsSchema
>;
export const zodyPluginsListUiSurfacesResultSchema = z
  .object({ surfaces: z.array(zodyPluginUiSurfaceSchema) })
  .strict();
export type ZodyPluginsListUiSurfacesResult = z.infer<
  typeof zodyPluginsListUiSurfacesResultSchema
>;

// ── Plugin 对话引用 catalog（docs/plugin-reference-mention.md）──
// Session-scoped 只读投影：带 sessionId → 该 Session 创建时冻结的身份 catalog；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。身份与能力字段保持
// identifiers-only，不携带 rootPath/配置等；可选 icon/displayName(I18n)/description(I18n)
// 仅供 UI 展示与 Picker 搜索，不参与身份、权限或 runtime reminder。
export const zodyPluginReferenceCatalogEntrySchema = z
  .object({
    // 仅 referenceCatalogWithCategory 返回；旧入口保持原结构。
    category: nonEmptyString.optional(),
    pluginId: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    icon: z.string().optional(),
    // 商店 listing 的 display-only 本地化显示名投影（沿 icon 先例）：让 Picker 能按
    // 中文显示名搜索/展示；locale 解析复用 shared 的 plugin-display-name helper。
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    // 仅供 Picker 展示，不进入能力身份或 model-only reminder。
    description: z.string().optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    // 非空 = 与其他 enabled Plugin 共享 manifest name 的 V1 fail closed 冲突：
    // Picker 禁选并展示原因，runtime 解析按 ambiguous 跳过。
    conflictingPluginIds: z.array(nonEmptyString),
    skillQualifiedNames: z.array(nonEmptyString),
    mcpServerNames: z.array(nonEmptyString),
    // 旧 Host 不投影该字段时按空数组兼容；只有新 Agent 会把它用于 reminder live 交集。
    subagentNames: z.array(nonEmptyString).default([]),
  })
  .strict();
export type ZodyPluginReferenceCatalogEntry = z.infer<
  typeof zodyPluginReferenceCatalogEntrySchema
>;

export const zodyPluginsReferenceCatalogParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    // 已有 Session 的 Picker 必须带 sessionId 才能拿到 session-owned catalog；
    // session 不存在时按协议错误 fail closed，禁止静默回退 workspace authority。
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZodyPluginsReferenceCatalogParams = z.infer<
  typeof zodyPluginsReferenceCatalogParamsSchema
>;
export const zodyPluginsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    plugins: z.array(zodyPluginReferenceCatalogEntrySchema),
  })
  .strict();
export type ZodyPluginsReferenceCatalogResult = z.infer<
  typeof zodyPluginsReferenceCatalogResultSchema
>;

// ── Skill 对话引用 catalog──
// 新草稿读取 workspace 当前目录；已有 Session 读取 AgentRuntime 首次 context
// 初始化时冻结的发现结果。该协议只承载 Composer 的只读引用投影，不替代 Settings
// 的 Skill 管理接口，也不持久化 runtime 快照。
export const zodySkillReferenceCatalogEntrySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string(),
    path: nonEmptyString,
    scope: z.enum(["workspace", "user", "plugin"]),
    enabled: z.literal(true),
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export type ZodySkillReferenceCatalogEntry = z.infer<typeof zodySkillReferenceCatalogEntrySchema>;

export const zodySkillsReferenceCatalogParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    // 带 sessionId 时必须命中该进程内的 resident Session；未知 Session fail closed，
    // 禁止回退到 workspace 当前目录而把新 Skill 泄漏进旧对话。
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZodySkillsReferenceCatalogParams = z.infer<
  typeof zodySkillsReferenceCatalogParamsSchema
>;
export const zodySkillsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    skills: z.array(zodySkillReferenceCatalogEntrySchema),
  })
  .strict();
export type ZodySkillsReferenceCatalogResult = z.infer<
  typeof zodySkillsReferenceCatalogResultSchema
>;

// ── 已保存工作流的 GUI 中枢──
// workspace 级、无会话的五个方法，照 skills/referenceCatalog 的先例：每次调用现扫
// `<cwd>/.zody/workflows/`（挂载时快照会漏掉手改的文件）。形状与 @zody/contracts 的
// saved-workflow.ts 逐字对齐——依赖方向是 contracts → shared，所以这里结构化地再声明一遍，
// 而不是 import；两边的 strict 形状由 bootstrap 侧的协议测试互相钉住。
export const zodySavedWorkflowArgTypeSchema = z.enum(["string", "number", "boolean", "json"]);
export type ZodySavedWorkflowArgType = z.infer<typeof zodySavedWorkflowArgTypeSchema>;
export const zodySavedWorkflowArgDeclarationSchema = z
  .object({
    type: zodySavedWorkflowArgTypeSchema,
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();
export type ZodySavedWorkflowArgDeclaration = z.infer<
  typeof zodySavedWorkflowArgDeclarationSchema
>;
export const zodySavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  zodySavedWorkflowArgDeclarationSchema,
);
export type ZodySavedWorkflowArgsDeclaration = z.infer<
  typeof zodySavedWorkflowArgsDeclarationSchema
>;
export const zodySavedWorkflowMetaSchema = z
  .object({
    description: nonEmptyString,
    whenToUse: nonEmptyString.optional(),
    args: zodySavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();
export type ZodySavedWorkflowMeta = z.infer<typeof zodySavedWorkflowMetaSchema>;
// 作用域两档：项目档落 `<cwd>/.zody/workflows/`、全局档落 agent 机器的 `~/.zody/workflows/`。作用域由文件所在目录推得，frontmatter 不存 scope。
export const zodySavedWorkflowScopeSchema = z.enum(["project", "global"]);
export type ZodySavedWorkflowScope = z.infer<typeof zodySavedWorkflowScopeSchema>;
export const zodySavedWorkflowEntrySchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    whenToUse: z.string().optional(),
    args: zodySavedWorkflowArgsDeclarationSchema.optional(),
    scope: zodySavedWorkflowScopeSchema,
    path: nonEmptyString,
  })
  .strict();
export type ZodySavedWorkflowEntry = z.infer<typeof zodySavedWorkflowEntrySchema>;
export const zodySavedWorkflowInvalidEntrySchema = z
  .object({ path: nonEmptyString, reason: nonEmptyString })
  .strict();
export type ZodySavedWorkflowInvalidEntry = z.infer<typeof zodySavedWorkflowInvalidEntrySchema>;
/** 名字非法 / 未找到 / frontmatter 坏 / 读错——与 core store 的 resolve 失败四态逐字对应。 */
export const zodySavedWorkflowFailureReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "parse_error",
  "read_error",
]);
export type ZodySavedWorkflowFailureReason = z.infer<typeof zodySavedWorkflowFailureReasonSchema>;
const zodySavedWorkflowFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: zodySavedWorkflowFailureReasonSchema,
    detail: z.string().optional(),
  })
  .strict();

export const zodyWorkflowsListParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    // 缺省即 `project`（本项目档）。给 `global` 时改扫本机 `~/.zody/workflows/`；此时 `workspace`
    // 仍必填，但只是**载体运行时**——协议处理器对全局档不读它的路径。
    scope: zodySavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZodyWorkflowsListParams = z.infer<typeof zodyWorkflowsListParamsSchema>;
export const zodyWorkflowsListResultSchema = z
  .object({
    workflows: z.array(zodySavedWorkflowEntrySchema),
    invalid: z.array(zodySavedWorkflowInvalidEntrySchema),
    // 扫过的目录（本地绝对路径），即使目录还不存在也回：GUI 的文件监听靠它 watch。
    dir: nonEmptyString,
  })
  .strict();
export type ZodyWorkflowsListResult = z.infer<typeof zodyWorkflowsListResultSchema>;

export const zodyWorkflowsGetParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    name: nonEmptyString,
    // 缺省 `project`；`global` 时只查本机全局根。`workspace` 语义同 list（全局档只当载体）。
    scope: zodySavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZodyWorkflowsGetParams = z.infer<typeof zodyWorkflowsGetParamsSchema>;
export const zodyWorkflowsGetResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      path: nonEmptyString,
      scope: zodySavedWorkflowScopeSchema,
      meta: zodySavedWorkflowMetaSchema,
      /** 脚本本体（frontmatter 之后逐字节），即被类型检查与执行的那一份。 */
      script: z.string(),
    })
    .strict(),
  zodySavedWorkflowFailureSchema,
]);
export type ZodyWorkflowsGetResult = z.infer<typeof zodyWorkflowsGetResultSchema>;

export const zodyWorkflowsUpdateMetaParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    name: nonEmptyString,
    meta: zodySavedWorkflowMetaSchema,
    // 缺省 `project`；`global` 时只写本机全局根那一份。`workspace` 语义同 list。
    scope: zodySavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZodyWorkflowsUpdateMetaParams = z.infer<typeof zodyWorkflowsUpdateMetaParamsSchema>;
export const zodyWorkflowsUpdateMetaResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zodySavedWorkflowFailureSchema,
]);
export type ZodyWorkflowsUpdateMetaResult = z.infer<typeof zodyWorkflowsUpdateMetaResultSchema>;

export const zodyWorkflowsDeleteParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    name: nonEmptyString,
    // 缺省 `project`；`global` 时按 scope 选根删除（不再写死 roots[0]）。`workspace` 语义同 list。
    scope: zodySavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZodyWorkflowsDeleteParams = z.infer<typeof zodyWorkflowsDeleteParamsSchema>;
export const zodyWorkflowsDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zodySavedWorkflowFailureSchema,
  z.object({ ok: z.literal(false), reason: z.literal("read_only_source") }).strict(),
]);
export type ZodyWorkflowsDeleteResult = z.infer<typeof zodyWorkflowsDeleteResultSchema>;

export const ZODY_WORKFLOWS_RUNS_MAX_LIMIT = 50;
export const zodyWorkflowsRunsParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    /** 只要这个名字的 run（`dwf_run.name` 字面等值）；缺省即本项目全部 run。 */
    name: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(ZODY_WORKFLOWS_RUNS_MAX_LIMIT),
    // 缺省 `project`：只查 `dwf_run.cwd === workspacePath` 的 run。`global` 时**不**按 cwd 过滤，
    // 跨所有项目取该名字的运行历史（全局工作流在任何项目里跑，历史因此跨 cwd）；结果行带 `cwd`
    // 供 GUI 标项目。`workspace` 语义同 list（全局档只当载体）。
    scope: zodySavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZodyWorkflowsRunsParams = z.infer<typeof zodyWorkflowsRunsParamsSchema>;
// 三终态词汇：errored = 脚本之错，stopped = 被停下（可恢复）。
export const zodySavedWorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
]);
export type ZodySavedWorkflowRunStatus = z.infer<typeof zodySavedWorkflowRunStatusSchema>;
export const zodySavedWorkflowRunStopReasonSchema = z.enum([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);
export const zodySavedWorkflowRunSchema = z
  .object({
    runId: nonEmptyString,
    name: z.string().optional(),
    status: zodySavedWorkflowRunStatusSchema,
    // `status === "stopped"` 才在场。
    stopReason: zodySavedWorkflowRunStopReasonSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
    /** 发起它的会话与 CreateWorkflow 工具调用：有这两个才能从中枢打开实例详情。老行可缺。 */
    parentSessionId: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    // 实际运行的项目目录（`dwf_run.cwd`）。全局档的 `workflows/runs` 跨 cwd 查询，GUI 用它给
    // 每行标项目；项目档变体里它恒等于 workspacePath，GUI 可忽略。老行可缺。
    cwd: z.string().optional(),
    // 这次运行发布的**用户面产物**：中枢的运行历史行在
    // 状态词之后画一串 kind chips，详情页头部的「最近产物」条取最近一次 completed run 的这一份。
    // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值。
    // 只带 chip 画得下的字段（≤ 8 件，取最新版的元数据）；字节与条目经 v4 查询按需读。
    // optional，照上面 `cwd` 的先例：老 CLI 不发，少一个键是退化不是错误。
    artifacts: z
      .array(
        z
          .object({
            id: nonEmptyString,
            kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
            title: z.string().optional(),
            version: z.number(),
            contentType: z.string().optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type ZodySavedWorkflowRun = z.infer<typeof zodySavedWorkflowRunSchema>;
export const zodyWorkflowsRunsResultSchema = z
  .object({
    runs: z.array(zodySavedWorkflowRunSchema),
    /** 为真时才在场：还有更多 run 没进这一页（多取一条判定，不是 length === limit）。 */
    truncated: z.literal(true).optional(),
  })
  .strict();
export type ZodyWorkflowsRunsResult = z.infer<typeof zodyWorkflowsRunsResultSchema>;

// workflows/move：把本机全局根的同名文件搬到 `workspace` 项目根。**只此一向**：项目→全局不是搬文件而是模型的概括（「提升为
// 全局」在该项目开新会话、经 SaveWorkflow 另存），所以没有 `to` 参数。同机同用户，rename 优先、EXDEV
// 回落 copy+unlink；逐字节搬，不改内容（frontmatter 不存 scope）；`move` 不覆盖——目标已存在即拒绝
// （覆盖是 SaveWorkflow 经确认窗才有的动作，不变式 7）。`workspace` 既是载体运行时也是目标项目。
export const zodyWorkflowsMoveParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    name: nonEmptyString,
  })
  .strict();
export type ZodyWorkflowsMoveParams = z.infer<typeof zodyWorkflowsMoveParamsSchema>;
export const zodyWorkflowsMoveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      /** 源落点路径（全局根，搬走前）。 */
      from: nonEmptyString,
      /** 目标落点路径（项目根，搬到处）。 */
      to: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // target_exists：目标档已有同名（move 不覆盖）；not_found：源档没有这个名字；
      // read_error / write_error：搬运时的 I/O 失败；invalid_name：名字先验没过。
      reason: z.enum(["invalid_name", "not_found", "target_exists", "read_error", "write_error"]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type ZodyWorkflowsMoveResult = z.infer<typeof zodyWorkflowsMoveResultSchema>;

// ── 从一次 run 保存工作流（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
// run, and running it again」）──
// 完成卡的「直接保存」走这条：**不收脚本，只收 runId**——要写的那份正文是这次 run 实际执行的
// 脚本，agent 从 journal 记录（`scriptText`）里读。脚本不经 GUI 走一圈有两个后果值得写下来：
// 修订过的 run 存下的是**结算它的**那一份，而工具行入参被快照裁成预览的老对话也照样存得出
// 同样的字节。名字合法性、覆盖、遮蔽与类型检查全部复用 SaveWorkflow 的同一套实现（不变式 3）。
/** 另一档已有同名定义（遮蔽事实）；与 contracts 的 SavedWorkflowShadowing 逐字对齐。 */
export const zodySavedWorkflowShadowingSchema = z.enum(["hides_global", "hidden_by_project"]);
export type ZodySavedWorkflowShadowing = z.infer<typeof zodySavedWorkflowShadowingSchema>;

export const zodyWorkflowsSaveParamsSchema = z
  .object({
    // 两用：既是载体运行时，也是这次 run 的项目——journal 在它那里，项目根也在它那里。
    // 全局档同样带它（与 list/get 的「全局只当载体」不同）：脚本必须从这个 agent 的 journal 读。
    workspace: zodyWorkspaceRefSchema,
    runId: nonEmptyString,
    name: nonEmptyString,
    meta: zodySavedWorkflowMetaSchema,
    // 缺省 `project`。
    scope: zodySavedWorkflowScopeSchema.optional(),
    // 只有 GUI 已经把覆盖警告摆给用户看过时才为 true；缺省即「目标已存在就拒绝」——
    // 覆盖是用户的决定，不是一次保存的副作用（与 `workflows/move` 不覆盖同一条纪律）。
    overwrite: z.boolean().optional(),
  })
  .strict();
export type ZodyWorkflowsSaveParams = z.infer<typeof zodyWorkflowsSaveParamsSchema>;
export const zodyWorkflowsSaveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      scope: zodySavedWorkflowScopeSchema,
      path: nonEmptyString,
      /** 写的那一刻重新判定，不回抄入参里的 `overwrite`（与 SaveWorkflow 的 `overwritten` 同源）。 */
      overwritten: z.boolean(),
      shadowing: zodySavedWorkflowShadowingSchema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // run_not_found：journal 里没有这条 run；script_missing：老记录没存脚本原文；
      // target_exists：目标已存在而调用方没说覆盖；compile_failed：类型检查没过，一个字节都没写。
      reason: z.enum([
        "invalid_name",
        "run_not_found",
        "script_missing",
        "target_exists",
        "compile_failed",
        "write_error",
      ]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type ZodyWorkflowsSaveResult = z.infer<typeof zodyWorkflowsSaveResultSchema>;

// ── 一次 run 对应哪个已保存工作流 ──
// 完成卡的「已保存」芯片与「再次运行」都问这一个问题，而答案**推导得来、不记在卡上**：重开
// 会话、换一个窗口保存、在对话里保存，都走同一条判定。判定住在 agent 一侧，因为两份事实
// （run 的 journal 记录与磁盘上的定义）都在那里；返回解析好的 entry，用户后来删掉的那一份
// 因此会自动不再算数。
/** 转写自对话的候选：模型用 `SaveWorkflow` 存过、并在入参里认领了这次 run。 */
export const zodyWorkflowsForRunCandidateSchema = z
  .object({ name: nonEmptyString, scope: zodySavedWorkflowScopeSchema.optional() })
  .strict();
export type ZodyWorkflowsForRunCandidate = z.infer<typeof zodyWorkflowsForRunCandidateSchema>;
/** 候选上界：一次 run 在一段对话里被存过的次数远小于它。 */
export const ZODY_WORKFLOWS_FOR_RUN_MAX_CANDIDATES = 8;
export const zodyWorkflowsForRunParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    runId: nonEmptyString,
    candidates: z
      .array(zodyWorkflowsForRunCandidateSchema)
      .max(ZODY_WORKFLOWS_FOR_RUN_MAX_CANDIDATES)
      .optional(),
  })
  .strict();
export type ZodyWorkflowsForRunParams = z.infer<typeof zodyWorkflowsForRunParamsSchema>;
export const zodyWorkflowsForRunResultSchema = z
  .object({
    /** 命中的定义；缺席即这次 run 还没有对应的已保存工作流。 */
    entry: zodySavedWorkflowEntrySchema.optional(),
    /** 命中的是哪一条规则（诊断与测试用；UI 只看 entry 在不在）。 */
    match: z.enum(["candidate", "script", "name"]).optional(),
    /** 这次 run 跑时用的实参（journal 原样），供「再次运行」预填实参窗。 */
    runArgs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ZodyWorkflowsForRunResult = z.infer<typeof zodyWorkflowsForRunResultSchema>;

// 推荐 Prompt 的可信插件解析：UI 不拆解 stableId，也不从旧目录快照推断可安装性。
export const zodyPluginSuggestedReferenceStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing",
  "conflict",
  "unavailable",
]);
export type ZodyPluginSuggestedReferenceStatus = z.infer<
  typeof zodyPluginSuggestedReferenceStatusSchema
>;
export const zodyPluginOperationStateSchema = z.enum([
  "checking",
  "refreshing",
  "installing",
  "enabling",
  "cancelling",
  "cancelled",
  "complete",
  "failed",
]);
export type ZodyPluginOperationState = z.infer<typeof zodyPluginOperationStateSchema>;
export const zodyPluginOperationProgressNotificationSchema = z
  .object({
    operationId: nonEmptyString,
    state: z.literal("refreshing"),
  })
  .strict();
export type ZodyPluginOperationProgressNotification = z.infer<
  typeof zodyPluginOperationProgressNotificationSchema
>;
export const zodyPluginsResolveSuggestedReferenceParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    stableId: nonEmptyString,
    operationId: nonEmptyString,
    clientMode: zodyDeliveryKindSchema,
    deliveryKind: zodyDeliveryKindSchema,
  })
  .strict();
export type ZodyPluginsResolveSuggestedReferenceParams = z.infer<
  typeof zodyPluginsResolveSuggestedReferenceParamsSchema
>;
export const zodyPluginsSetEnabledParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginId: nonEmptyString,
    enabled: z.boolean(),
    operationId: nonEmptyString.optional(),
    scope: zodyPluginScopeSchema.optional(),
  })
  .strict();
export const zodyPluginsSetEnabledResultSchema = z
  .object({
    plugin: zodyPluginInfoSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZodyPluginsSetEnabledResult = z.infer<typeof zodyPluginsSetEnabledResultSchema>;

// 商店信息（Store Listing）：目录条目携带的展示性元数据（显示名/icon/分类/作者/链接/hero/
// 示例提示词），全部可选，UI 缺失时按降级矩阵处理（字母头像/隐藏区块/省略信息行）。
// i18n 采用 `<字段>I18n` map，locale 解析复用 shared 的 plugin-display-name helper。
export const zodyPluginStoreListingSchema = z
  .object({
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    privacyPolicy: z.string().optional(),
    termsOfService: z.string().optional(),
    heroImage: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    examplePromptsI18n: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * 需要付费套餐才好用的插件：市场目录条目声明 `requiresPaidPlan: true`，
     * UI 在标题右侧展示提示图标。描述的是「使用条件」而非「插件是收费商品」——
     * 不参与安装门禁与计费，命名也不绑定具体套餐商品名。
     */
    requiresPaidPlan: z.boolean().optional(),
  })
  .strict();
export type ZodyPluginStoreListing = z.infer<typeof zodyPluginStoreListingSchema>;

export const zodyPluginsResolveSuggestedReferenceResultSchema = z
  .object({
    stableId: nonEmptyString,
    status: zodyPluginSuggestedReferenceStatusSchema,
    marketplace: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    sourceTrust: z.literal("official").optional(),
    // 官方 Marketplace listing 的可选展示投影；不参与身份、安装或权限判断。
    icon: z.string().optional(),
    listing: zodyPluginStoreListingSchema.optional(),
    diagnostics: z.array(zodyPluginDiagnosticSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "ready" && value.status !== "disabled" && value.status !== "missing") {
      return;
    }
    if (!value.marketplace || !value.pluginName || value.sourceTrust !== "official") {
      context.addIssue({
        code: "custom",
        message: "actionable suggested Plugin results require trusted install identity",
      });
    }
  });
export type ZodyPluginsResolveSuggestedReferenceResult = z.infer<
  typeof zodyPluginsResolveSuggestedReferenceResultSchema
>;

export const zodyPluginMarketplaceSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    source: jsonObjectSchema,
    description: z.string().optional(),
    lastUpdated: z.string().optional(),
    pluginCount: z.number().int().nonnegative(),
    isOfficial: z.boolean().optional(),
    // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区）。
    featured: z.array(z.string()).optional(),
    refreshFailure: z
      .object({
        code: z.string(),
        failedAt: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZodyPluginMarketplaceSummary = z.infer<typeof zodyPluginMarketplaceSummarySchema>;

export const zodyAvailablePluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    installed: z.boolean(),
    componentTypes: z.array(z.string()).optional(),
    listing: zodyPluginStoreListingSchema.optional(),
  })
  .strict();
export type ZodyAvailablePluginSummary = z.infer<typeof zodyAvailablePluginSummarySchema>;

export const zodyInstalledPluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    scope: zodyPluginScopeSchema,
    installPath: z.string().optional(),
    installedAt: z.string().optional(),
    componentTypes: z.array(z.string()).optional(),
    hookDetails: z.array(zodyPluginHookDetailSchema).optional(),
    updateStatus: z.enum(["none", "update-available", "version-changed"]).optional(),
    latestVersion: z.string().optional(),
    listing: zodyPluginStoreListingSchema.optional(),
  })
  .strict();
export type ZodyInstalledPluginSummary = z.infer<typeof zodyInstalledPluginSummarySchema>;

export const zodyPluginsOverviewParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    configScope: zodyPluginScopeSchema.optional(),
  })
  .strict();
export const zodyPluginsOverviewResultSchema = z
  .object({
    marketplaces: z.array(zodyPluginMarketplaceSummarySchema),
    availablePlugins: z.array(zodyAvailablePluginSummarySchema),
    installedPlugins: z.array(zodyInstalledPluginSummarySchema),
    restorableBuiltins: z.array(zodyAvailablePluginSummarySchema),
    diagnostics: z.array(zodyPluginDiagnosticSchema),
    capability: z
      .object({
        supported: z.boolean(),
        reason: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type ZodyPluginsOverviewResult = z.infer<typeof zodyPluginsOverviewResultSchema>;

export const zodyPluginsMarketplaceAddParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    source: nonEmptyString,
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zodyPluginsMarketplaceRemoveParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    marketplace: nonEmptyString,
  })
  .strict();
export const zodyPluginsMarketplaceUpdateParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    marketplace: nonEmptyString.optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zodyPluginsMarketplaceMutationResultSchema = z
  .object({
    marketplace: zodyPluginMarketplaceSummarySchema.optional(),
    marketplaces: z.array(zodyPluginMarketplaceSummarySchema).optional(),
    diagnostics: z.array(zodyPluginDiagnosticSchema).optional(),
  })
  .strict();
export type ZodyPluginsMarketplaceMutationResult = z.infer<
  typeof zodyPluginsMarketplaceMutationResultSchema
>;

export const zodyPluginsInstallParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
    scope: zodyPluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zodyPluginsCancelOperationParamsSchema = z
  .object({
    operationId: nonEmptyString,
  })
  .strict();
export type ZodyPluginsCancelOperationParams = z.infer<
  typeof zodyPluginsCancelOperationParamsSchema
>;

export const zodyPluginsCancelOperationResultSchema = z
  .object({
    operationId: nonEmptyString,
    cancelled: z.boolean(),
  })
  .strict();
export type ZodyPluginsCancelOperationResult = z.infer<
  typeof zodyPluginsCancelOperationResultSchema
>;
export const zodyPluginsUninstallParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    removeCache: z.boolean().optional(),
  })
  .strict();
export const zodyPluginsInstallResultSchema = z
  .object({
    installedPlugins: z.array(zodyInstalledPluginSummarySchema),
    dependencyClosure: z.array(z.string()),
    diagnostics: z.array(zodyPluginDiagnosticSchema),
  })
  .strict();
export type ZodyPluginsInstallResult = z.infer<typeof zodyPluginsInstallResultSchema>;

export const zodyPluginsUninstallResultSchema = z
  .object({
    removedPlugin: zodyInstalledPluginSummarySchema.optional(),
    diagnostics: z.array(zodyPluginDiagnosticSchema),
  })
  .strict();
export type ZodyPluginsUninstallResult = z.infer<typeof zodyPluginsUninstallResultSchema>;

export const zodyPluginsUpdateParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
  })
  .strict();
export const zodyPluginsRestoreBuiltinParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginId: nonEmptyString,
  })
  .strict();
export const zodyPluginsRestoreBuiltinResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zodyPluginDiagnosticSchema),
  })
  .strict();
export type ZodyPluginsRestoreBuiltinResult = z.infer<
  typeof zodyPluginsRestoreBuiltinResultSchema
>;

export const zodyPluginsConfigureParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginId: nonEmptyString,
    options: jsonObjectSchema,
    clearOptionKeys: z.array(nonEmptyString).optional(),
    scope: zodyPluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export const zodyPluginsConfigureResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zodyPluginDiagnosticSchema),
  })
  .strict();
export type ZodyPluginsConfigureResult = z.infer<typeof zodyPluginsConfigureResultSchema>;

export const zodyPluginsResetConfigParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginId: nonEmptyString,
    scope: zodyPluginScopeSchema.optional(),
  })
  .strict();
export type ZodyPluginsResetConfigParams = z.infer<typeof zodyPluginsResetConfigParamsSchema>;

export const zodyPluginsValidateParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    source: nonEmptyString.optional(),
  })
  .strict();
export const zodyPluginsValidateResultSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: z.array(zodyPluginDiagnosticSchema),
    compatibility: z
      .object({
        runnable: z.array(z.string()),
        diagnosticOnly: z.array(z.string()),
        unsupported: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type ZodyPluginsValidateResult = z.infer<typeof zodyPluginsValidateResultSchema>;

// plugins/describe：按需枚举单个插件的组件「名称 + 描述」。
// 已安装插件读本地缓存目录；未安装候选按需解析/临时 clone 源后枚举再清理。
export const zodyPluginsDescribeParamsSchema = z
  .object({
    workspace: zodyWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
  })
  .strict();
export const zodyPluginsDescribeResultSchema = z
  .object({
    components: z.array(zodyPluginComponentGroupSchema),
    diagnostics: z.array(zodyPluginDiagnosticSchema).optional(),
    // 插件包内 plugin.json 的展示性回退字段；未安装候选详情页信息区在商店 listing 缺失时兜底。
    metadata: z
      .object({
        author: z.string().optional(),
        authorUrl: z.string().optional(),
        homepage: z.string().optional(),
        version: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZodyPluginsDescribeResult = z.infer<typeof zodyPluginsDescribeResultSchema>;

export const zodyAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
export type ZodyAutomationScheduleRuleProtocol = z.infer<typeof zodyAutomationScheduleRuleSchema>;

/** 会话侧长间隔周期 carrier 的 unit 枚举（与 scheduleRule.unit 同集）。 */
export const zodyAutomationIntervalUnitSchema = z.enum([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

export const zodyAutomationProtocolSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zodyTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: timestampMsSchema.optional(),
    lastRunAt: timestampMsSchema.optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    // 自定义重复规则；缺省时调度回退到解析 cronExpr。会话卡片必须读到本字段才能展示
    // cron 无法表达的真实间隔（如每50小时、每40天，兼容 cronExpr 只是 0 * * * *）。
    scheduleRule: zodyAutomationScheduleRuleSchema.optional(),
  })
  .strict();
export type ZodyAutomationProtocol = z.infer<typeof zodyAutomationProtocolSchema>;

export const zodyAutomationCreateParamsSchema = z
  .object({
    title: z.string().optional(),
    cronExpr: nonEmptyString,
    relativeDelayMinutes: z.number().int().positive().max(525_600).optional(),
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zodyTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    // fork（bots移除）：定时任务 Bot 回推目标字段随第三方 IM bot channels 全量删除。
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().optional(),
    // 会话侧自定义重复 carrier：每 N 分钟/小时/天/周/月/年均通过此字段归一化为权威 scheduleRule，
    // cronExpr 仅作合法兼容展示。
    intervalUnit: zodyAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  // intervalUnit 与 interval 必须配对提交（只传一个无法确定真实间隔）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // 周期 carrier 与一次性相对延迟语义冲突，禁止同传。
  .refine((input) => input.intervalUnit === undefined || input.relativeDelayMinutes === undefined, {
    message: "intervalUnit cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
export type ZodyAutomationCreateProtocolParams = z.infer<typeof zodyAutomationCreateParamsSchema>;

export const zodyAutomationCreateResultSchema = z
  .object({ automation: zodyAutomationProtocolSchema })
  .strict();
export type ZodyAutomationCreateProtocolResult = z.infer<typeof zodyAutomationCreateResultSchema>;

export const zodyAutomationUpdateParamsSchema = z
  .object({
    automationId: nonEmptyString,
    title: nonEmptyString.optional(),
    cronExpr: nonEmptyString.optional(),
    prompt: nonEmptyString.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    // 会话侧自定义重复 carrier（同 create 侧语义）。
    intervalUnit: zodyAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.cronExpr !== undefined ||
      input.prompt !== undefined ||
      input.recurring !== undefined ||
      input.maxRuns !== undefined ||
      input.intervalUnit !== undefined,
    { message: "automation update requires at least one field" },
  )
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "clearing maxRuns requires recurring=true",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit 与 interval 必须配对提交（同 create 侧语义）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
export type ZodyAutomationUpdateProtocolParams = z.infer<typeof zodyAutomationUpdateParamsSchema>;
export const zodyAutomationUpdateResultSchema = z
  .object({ automation: zodyAutomationProtocolSchema })
  .strict();
export type ZodyAutomationUpdateProtocolResult = z.infer<typeof zodyAutomationUpdateResultSchema>;

export const zodyAutomationListParamsSchema = z.object({}).strict();
export type ZodyAutomationListProtocolParams = z.infer<typeof zodyAutomationListParamsSchema>;
export const zodyAutomationListResultSchema = z
  .object({ automations: z.array(zodyAutomationProtocolSchema) })
  .strict();
export type ZodyAutomationListProtocolResult = z.infer<typeof zodyAutomationListResultSchema>;

export const zodyAutomationCheckTaskBindingParamsSchema = z
  .object({ targetTaskId: nonEmptyString })
  .strict();
export type ZodyAutomationCheckTaskBindingProtocolParams = z.infer<
  typeof zodyAutomationCheckTaskBindingParamsSchema
>;
export const zodyAutomationCheckTaskBindingResultSchema = z
  .object({ bound: z.boolean() })
  .strict();
export type ZodyAutomationCheckTaskBindingProtocolResult = z.infer<
  typeof zodyAutomationCheckTaskBindingResultSchema
>;

export const zodyAutomationDeleteParamsSchema = z
  .object({ automationId: nonEmptyString })
  .strict();
export type ZodyAutomationDeleteProtocolParams = z.infer<typeof zodyAutomationDeleteParamsSchema>;
export const zodyAutomationDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
export type ZodyAutomationDeleteProtocolResult = z.infer<typeof zodyAutomationDeleteResultSchema>;

// fork（F4.3）：Off-Peak 会话内创建协议段（permissionMode 词表、offPeak/create、
// offPeak/list、任务快照与失败分类）随闲时任务全链路删除。

export const zodyProtocolMethods = {
  runtimeCapabilities: "runtime/capabilities",
  /** 私有 stdio 启动初始化：只允许 Host 的 ProcessManager 在 spawn 后写入一次。 */
  runtimeIdentityInitialize: "startup/runtimeIdentity",
  computerUseOperationEvent: "computer-use/operation-event",
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionSubagents: "session/subagents",
  sessionRequestRuntimePreferences: "session/requestRuntimePreferences",
  subagentsReadRuntimeConfig: "subagents/readRuntimeConfig",
  sessionRead: "session/read",
  sessionMessages: "session/messages",
  sessionEvents: "session/events",
  sessionDebug: "session/debug",
  sessionSubscribe: "session/subscribe",
  // @deprecated（部分）：send 主路径已收敛 v4 sendText；仅剩 adapter 附件
  // 回退分支消费（v4 attachmentRef 上传/寄存命令面未建模），待附件命令面落地后移除。
  sessionSend: "session/send",
  // @deprecated：host 客户端方法已删（stop 已收敛 v4 stop 命令）。
  // wire case 留兼容（transport bypass 名单仍引用），随旧词整体删除时一并移除。
  sessionStop: "session/stop",
  // @deprecated：host 客户端方法已删（已收敛 v4 cancelBackgroundWork 命令）。
  // wire case 留兼容，随旧词整体删除时一并移除。
  sessionCancelBackgroundTask: "session/cancelBackgroundTask",
  // @deprecated：host 客户端方法已删（v4 forkAssistant 原生 handler 经
  // forkSessionAtMessage 钩子直调 server-operations.forkSession op）。wire case 与
  // fork params/result schema 保留＝op 存活面；fork record 归 v4 原生重写。
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionGoal: "session/goal",
  sessionClose: "session/close",
  // setModel 仍被 zodySessionService 的 desktop 旧链路消费；replayable
  // switchModelConfig 已直接由目标 Environment Registry 解析 Selection。
  sessionSetModel: "session/setModel",
  // replayable facade 的思考深度/模式已收敛 v4 switchModelConfig/
  // switchCollaborationMode；剩余消费 = zodySessionService（desktop 旧链路，随
  // 桌面 v4 UI 收口清零）与 setMode 的 auto 值残留（v4 值域刻意排除 auto）。
  sessionSetThoughtLevel: "session/setThoughtLevel",
  sessionSetMode: "session/setMode",
  workspaceReadPresentation: "workspace/readPresentation",
  workspaceHookTrustGrant: "workspace/hooks/trustGrant",
  // 进程级 Account Provider Config 与 workspace 运行目录分离。
  providerUpdateAccountConfig: "provider/updateAccountConfig",
  workspaceUpdateInteractionPreferences: "workspace/updateInteractionPreferences",
  workspaceUpdateModelIoPreferences: "workspace/updateModelIoPreferences",
  // Off-Peak 工具面门禁是 workspace 级事实（灰度 + 本地/远程），由 host 在 agent 就绪时同步；
  // CLI 对 legacy create/resume 与 v4 冷恢复统一读取。旧 CLI method-not-found → host 降级忽略。
  // fork（F4.3）：workspaceUpdateOffPeakToolPolicy 方法随闲时工具策略 RPC 删除。
  // 动态工作流灰度门禁：与原 Off-Peak 策略同一同步模式。
  workspaceUpdateDynamicWorkflowPolicy: "workspace/updateDynamicWorkflowPolicy",
  // LLM 执行面在 CLI，直连不可行；消费仅 services 内部
  // （commit message），待 v4 workspace 查询/命令面覆盖后移除。
  workspaceGenerateText: "workspace/generateText",
  workspaceCancelGenerateText: "workspace/cancelGenerateText",
  providerTestModelConnectivity: "provider/testModelConnectivity",
  mcpList: "mcp/list",
  mcpReadResource: "mcp/readResource",
  mcpUiOpenInstance: "mcp/uiOpenInstance",
  mcpUiCloseInstance: "mcp/uiCloseInstance",
  mcpUiValidateInstance: "mcp/uiValidateInstance",
  mcpUiSampling: "mcp/uiSampling",
  mcpUiCancelSampling: "mcp/uiCancelSampling",
  mcpUiCallTool: "mcp/uiCallTool",
  mcpUiCancelCall: "mcp/uiCancelCall",
  mcpUiReadResource: "mcp/uiReadResource",
  mcpUiListResources: "mcp/uiListResources",
  mcpUiListResourceTemplates: "mcp/uiListResourceTemplates",
  mcpUiSubscribeResource: "mcp/uiSubscribeResource",
  mcpUiUnsubscribeResource: "mcp/uiUnsubscribeResource",
  // App-Provided Tools：页面工具登记 / 注销，与模型调用的认领 / 回传（信箱投递走 v4 live 增量）。
  mcpUiRegisterAppTools: "mcp/uiRegisterAppTools",
  mcpUiUnregisterAppTools: "mcp/uiUnregisterAppTools",
  mcpUiClaimAppToolCall: "mcp/uiClaimAppToolCall",
  mcpUiResolveAppToolCall: "mcp/uiResolveAppToolCall",
  pluginsList: "plugins/list",
  pluginsReferenceCatalog: "plugins/referenceCatalog",
  pluginsListUiSurfaces: "plugins/listUiSurfaces",
  pluginsReferenceCatalogWithCategory: "plugins/referenceCatalogWithCategory",
  skillsReferenceCatalog: "skills/referenceCatalog",
  // 已保存工作流的 GUI 中枢：workspace 级、无会话。
  workflowsList: "workflows/list",
  workflowsGet: "workflows/get",
  workflowsUpdateMeta: "workflows/updateMeta",
  workflowsDelete: "workflows/delete",
  workflowsRuns: "workflows/runs",
  // 在项目档 / 全局档之间移动同名文件。
  workflowsMove: "workflows/move",
  // 完成卡的「直接保存」与「已保存」判定（docs/dynamic-workflow/transcript-and-notifications.md）：
  // 前者按 runId 从 journal 取脚本落盘，后者回答「这次 run 对应哪个已保存工作流」。
  workflowsSave: "workflows/save",
  workflowsForRun: "workflows/forRun",
  pluginsResolveSuggestedReference: "plugins/resolveSuggestedReference",
  pluginsSetEnabled: "plugins/setEnabled",
  pluginsOverview: "plugins/overview",
  pluginsMarketplaceAdd: "plugins/marketplace/add",
  pluginsMarketplaceRemove: "plugins/marketplace/remove",
  pluginsMarketplaceUpdate: "plugins/marketplace/update",
  pluginsInstall: "plugins/install",
  pluginsCancelOperation: "plugins/cancelOperation",
  pluginsUninstall: "plugins/uninstall",
  pluginsUpdate: "plugins/update",
  pluginsRestoreBuiltin: "plugins/restoreBuiltin",
  pluginsConfigure: "plugins/configure",
  pluginsResetConfig: "plugins/resetConfig",
  pluginsValidate: "plugins/validate",
  pluginsDescribe: "plugins/describe",
  automationCreate: "automation/create",
  // fork（bots移除）：bot/channel/reply 与 topic/resource/* 协议方法
  // 随第三方 IM bot channels 全量删除（specs/bot-channels-removal.md）。
  automationUpdate: "automation/update",
  automationCheckTaskBinding: "automation/checkTaskBinding",
  automationList: "automation/list",
  automationDelete: "automation/delete",
  // fork（F4.3）：offPeakCreate/offPeakList 方法族随闲时任务全链路删除。
  // @deprecated：host 消费已清零（zodyAgentService 改走 v4/usage/stats）。
  // 仅剩 CLI server 的 wire 兼容 case；随旧词整体删除时一并移除。
  usageStats: "usage/stats",
  // ZCode Protocol 对 agent 只暴露 session-first 方法；task 是 UI 投影概念，不能泄露进协议方法名。
  // @deprecated：host 已改走 v4/conversation/usage；后续与 usage/stats 一并移除。
  sessionUsage: "session/usage",
  // 资源管理器：CLI 回报其 MCP 子进程 pid 与插件归属（纯内存，无 I/O），采样在 Host 侧完成。
  processChildProcesses: "process/childProcesses",
  processNetworkCapture: "process/networkCapture",
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
  // fork（F4.6）：interaction/requestOfficialMcpAuthHeaders 随官方 MCP 鉴权链删除。
  // browser-use 反向请求由 agent 发起，host 转给 main 中的 CDP executor。
  interactionBrowserList: "interaction/browserList",
  interactionBrowserDefault: "interaction/browserDefault",
  interactionBrowserExecute: "interaction/browserExecute",
} as const;

export type ZodyProtocolMethod = (typeof zodyProtocolMethods)[keyof typeof zodyProtocolMethods];

export const zodyProtocolEmptyResultSchema = z.object({}).strict();

// 最新 V4 主链已不再依赖旧版全量方法表；这里仅保留仍被兼容测试和 browser broker
// 消费的最小契约集合，避免重新引入已移除的 legacy 方法。
export const zodyProtocolSessionMethodContracts = {
  [zodyProtocolMethods.mcpUiOpenInstance]: {
    params: zodyMcpUiOpenInstanceParamsSchema,
    result: zodyMcpUiOpenInstanceResultSchema,
  },
  [zodyProtocolMethods.mcpUiCloseInstance]: {
    params: zodyMcpUiCloseInstanceParamsSchema,
    result: zodyMcpUiCloseInstanceResultSchema,
  },
  [zodyProtocolMethods.mcpUiValidateInstance]: {
    params: zodyMcpUiCloseInstanceParamsSchema,
    result: zodyMcpUiResourceSubscriptionResultSchema,
  },
  [zodyProtocolMethods.workspaceHookTrustGrant]: {
    params: zodyWorkspaceHookTrustGrantParamsSchema,
    result: zodyWorkspaceHookTrustGrantResultSchema,
  },
  [zodyProtocolMethods.mcpList]: {
    params: zodyMcpListParamsSchema,
    result: zodyMcpListResultSchema,
  },
  [zodyProtocolMethods.mcpReadResource]: {
    params: zodyMcpReadResourceParamsSchema,
    result: zodyMcpReadResourceResultSchema,
  },
  [zodyProtocolMethods.mcpUiSampling]: {
    params: zodyMcpUiSamplingParamsSchema,
    result: zodyMcpUiSamplingResultSchema,
  },
  [zodyProtocolMethods.mcpUiCancelSampling]: {
    params: zodyMcpUiCancelSamplingParamsSchema,
    result: zodyMcpUiCancelCallResultSchema,
  },
  [zodyProtocolMethods.mcpUiCallTool]: {
    params: zodyMcpUiCallToolParamsSchema,
    result: zodyMcpUiCallToolResultSchema,
  },
  [zodyProtocolMethods.mcpUiCancelCall]: {
    params: zodyMcpUiCancelCallParamsSchema,
    result: zodyMcpUiCancelCallResultSchema,
  },
  [zodyProtocolMethods.mcpUiReadResource]: {
    params: zodyMcpUiReadResourceParamsSchema,
    result: zodyMcpUiReadResourceResultSchema,
  },
  [zodyProtocolMethods.mcpUiListResources]: {
    params: zodyMcpUiListResourcesParamsSchema,
    result: zodyMcpUiListResourcesResultSchema,
  },
  [zodyProtocolMethods.mcpUiListResourceTemplates]: {
    params: zodyMcpUiListResourcesParamsSchema,
    result: zodyMcpUiListResourceTemplatesResultSchema,
  },
  [zodyProtocolMethods.mcpUiSubscribeResource]: {
    params: zodyMcpUiResourceSubscriptionParamsSchema,
    result: zodyMcpUiResourceSubscriptionResultSchema,
  },
  [zodyProtocolMethods.mcpUiUnsubscribeResource]: {
    params: zodyMcpUiResourceSubscriptionParamsSchema,
    result: zodyMcpUiResourceSubscriptionResultSchema,
  },
  [zodyProtocolMethods.mcpUiRegisterAppTools]: {
    params: zodyMcpUiRegisterAppToolsParamsSchema,
    result: zodyMcpUiRegisterAppToolsResultSchema,
  },
  [zodyProtocolMethods.mcpUiUnregisterAppTools]: {
    params: zodyMcpUiUnregisterAppToolsParamsSchema,
    result: zodyMcpUiUnregisterAppToolsResultSchema,
  },
  [zodyProtocolMethods.mcpUiClaimAppToolCall]: {
    params: zodyMcpUiClaimAppToolCallParamsSchema,
    result: zodyMcpUiAppToolAcceptedResultSchema,
  },
  [zodyProtocolMethods.mcpUiResolveAppToolCall]: {
    params: zodyMcpUiResolveAppToolCallParamsSchema,
    result: zodyMcpUiAppToolAcceptedResultSchema,
  },
  [zodyProtocolMethods.interactionBrowserList]: {
    params: zodyBrowserListParamsSchema,
    result: zodyBrowserListResultSchema,
  },
  [zodyProtocolMethods.interactionBrowserDefault]: {
    params: zodyBrowserListParamsSchema,
    result: zodyBrowserDefaultResultSchema,
  },
  [zodyProtocolMethods.interactionBrowserExecute]: {
    params: zodyBrowserExecuteParamsSchema,
    result: zodyBrowserExecuteResultSchema,
  },
} as const satisfies Partial<
  Record<ZodyProtocolMethod, { params: z.ZodTypeAny; result: z.ZodTypeAny }>
>;

export type ZodyProtocolSessionMethodContract =
  (typeof zodyProtocolSessionMethodContracts)[keyof typeof zodyProtocolSessionMethodContracts];

/** 仅存储准备子进程的私有控制帧，原始路径不进入业务事件或遥测。 */
export const zodyStoragePreparationFrameSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("startup/storagePath"),
      params: z.object({ path: z.string().min(1).max(32768) }).strict(),
    })
    .strict(),
  z
    .object({ method: z.literal("startup/storagePrepared"), params: z.object({}).strict() })
    .strict(),
  z
    .object({ method: z.literal("startup/storageState"), params: zodyStorageStartupStateSchema })
    .strict(),
]);
export const zodyStoragePathReadySchema = z
  .object({ method: z.literal("startup/storagePathReady"), reuse: z.boolean().optional() })
  .strict();

/**
 * Host→Agent 私有启动身份。非秘密，但不属于业务命令/模型参数面；只经 stdio startup 握手
 * 一次性固定，缺席时 CLI 不构造 CUA candidate。
 */
export const zodyCuaLaunchIdentitySchema = z
  .object({
    hostInstanceId: nonEmptyString.max(256),
    runtimeInstanceId: nonEmptyString.max(256),
  })
  .strict();
export type ZodyCuaLaunchIdentity = z.infer<typeof zodyCuaLaunchIdentitySchema>;

export const zodyRuntimeIdentityInitializeParamsSchema = z
  .object({ identity: zodyCuaLaunchIdentitySchema })
  .strict();
export type ZodyRuntimeIdentityInitializeParams = z.infer<
  typeof zodyRuntimeIdentityInitializeParamsSchema
>;

export const zodyRuntimeIdentityInitializeResultSchema = z
  .object({ initialized: z.literal(true), reused: z.boolean() })
  .strict();
export type ZodyRuntimeIdentityInitializeResult = z.infer<
  typeof zodyRuntimeIdentityInitializeResultSchema
>;

// 桌面本地 TTFT 的严格事实合同；检查点不能替代实际内容帧。
export { localTtftFactsSchema } from "../localTtft.js";
// fork（bots移除）：botIdentity/botTopic/botGroupInputSource 等 re-export
// 随第三方 IM bot channels 全量删除（specs/bot-channels-removal.md）。
