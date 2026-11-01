/* oxlint-disable eslint(max-lines) -- 扩展传输是单一严格契约；拆分会把交叉引用的 schema、联合与解析器分散到多个文件。 */
import { z } from "zod";

/**
 * Chrome 扩展 ↔ Desktop Main 的传输契约。
 *
 * 该文件是独立叶模块：扩展包只从 `@zcode/shared/browser-extension-transport`
 * 导入，不经过 shared barrel；这里只依赖 zod，不引入 Node/Electron/DOM 类型。
 *
 * 约束（见 docs/browser-use/2026-10-31-chrome-extension-debugger-backend-design.md）：
 * - 所有消息使用 `type` 判别联合并 `.strict()` 校验，未知字段一律拒绝。
 * - 传输层只使用 `nativeTabId` / `targetId`，禁止 CDP `sessionId` 字段。
 * - 消息不携带 session/workspace/turn/本地路径；这些由 Host 持有。
 */

export const EXTENSION_BRIDGE_PROTOCOL_VERSION = 1;

/** Desktop 与扩展共享的默认 loopback 端口；两端允许一致地覆盖。 */
export const EXTENSION_BRIDGE_DEFAULT_PORT = 39731;

/** manifest 固定 `key` 推导出的扩展 ID；Main 用它校验 hello 与 Origin。 */
export const EXTENSION_BRIDGE_EXTENSION_ID = "mgbbfehgciopncanakmloajgfomoeepp";

/** 单帧 JSON 上限；超出后扩展与 Main 都必须失败并释放缓冲。 */
export const EXTENSION_BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** 截图 / DOM snapshot 等单次结果上限，低于整帧上限。 */
export const EXTENSION_BRIDGE_MAX_RESULT_BYTES = 4 * 1024 * 1024;

/** ECDH 共享密钥派生为 HMAC key 时使用的 HKDF info，两端必须一致。 */
export const EXTENSION_BRIDGE_HKDF_INFO = "zody-extension-bridge-v1";

/** 双向 resume challenge 的 HMAC 域分隔前缀。 */
export const EXTENSION_BRIDGE_CLIENT_PROOF_PREFIX = "client";
export const EXTENSION_BRIDGE_SERVER_PROOF_PREFIX = "server";

/** Main 监听的 loopback 地址字面量；不使用 `localhost`，避免解析到 `::1`。 */
export const EXTENSION_BRIDGE_HOST = "127.0.0.1";

const identifierSchema = z.string().trim().min(1).max(200);
const base64Schema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .regex(/^[A-Za-z0-9+/=_-]+$/, "base64 编码不合法");

/** 扩展首次安装生成的随机 Profile 实例 ID；不是操作系统 Profile 路径。 */
export const extensionProfileInstanceIdSchema = z.string().trim().min(16).max(128);
export type ExtensionProfileInstanceId = z.infer<typeof extensionProfileInstanceIdSchema>;

/** 每次成功 WebSocket 握手生成的随机连接 ID。 */
export const extensionConnectionIdSchema = z.string().trim().min(16).max(128);
export type ExtensionConnectionId = z.infer<typeof extensionConnectionIdSchema>;

/** 请求关联 ID；Host 生成，同一连接内必须唯一。 */
export const extensionRequestIdSchema = z.string().trim().min(1).max(200);
export type ExtensionRequestId = z.infer<typeof extensionRequestIdSchema>;

/** 每次成功 attach 返回的新 attachment ID。 */
export const extensionAttachmentIdSchema = z.string().trim().min(1).max(200);
export type ExtensionAttachmentId = z.infer<typeof extensionAttachmentIdSchema>;

/** Chrome 内部数字 tabId；只在单个 Profile 内有效。 */
export const extensionNativeTabIdSchema = z.number().int().nonnegative();
export type ExtensionNativeTabId = z.infer<typeof extensionNativeTabIdSchema>;

/** chrome.debugger 子 target；不是 CDP sessionId。 */
export const extensionTargetIdSchema = z.string().trim().min(1).max(512);
export type ExtensionTargetId = z.infer<typeof extensionTargetIdSchema>;

/**
 * Host 侧 tab/attachment 绑定。任一项不匹配都必须拒绝命令。
 * 注意这里没有 CDP `sessionId`：Host 内部映射由 Host 持有。
 */
export const extensionTargetRefSchema = z
  .object({
    browserId: identifierSchema,
    browserGeneration: z.number().int().nonnegative(),
    connectionId: extensionConnectionIdSchema,
    nativeTabId: extensionNativeTabIdSchema,
    attachmentId: extensionAttachmentIdSchema,
  })
  .strict();
export type ExtensionTargetRef = z.infer<typeof extensionTargetRefSchema>;

/**
 * 扩展创建/接管的 tab 归属。Host 是 logical tab owner，但扩展必须真实记录该事实，
 * 才能在断连/重载清理时决定关闭 agent tab 还是只 detach user tab。
 */
export const extensionTabClassSchema = z.enum(["agent", "user"]);
export type ExtensionTabClass = z.infer<typeof extensionTabClassSchema>;

/** attach 请求只携带建立 attachment 所需的字段；attachmentId 由扩展成功 attach 后返回。 */
export const extensionAttachTargetSchema = z
  .object({
    browserId: identifierSchema,
    browserGeneration: z.number().int().nonnegative(),
    connectionId: extensionConnectionIdSchema,
    nativeTabId: extensionNativeTabIdSchema,
    targetId: extensionTargetIdSchema.optional(),
    tabClass: extensionTabClassSchema,
  })
  .strict();
export type ExtensionAttachTarget = z.infer<typeof extensionAttachTargetSchema>;

export const extensionBridgeFatalErrorCodeSchema = z.enum([
  "protocol_version_mismatch",
  "invalid_message",
  "frame_too_large",
  "origin_mismatch",
  "pairing_unavailable",
  "pairing_failed",
  "pairing_expired",
  "pairing_attempts_exceeded",
  "resume_failed",
  "unauthorized",
  "duplicate_request_id",
  "result_too_large",
  "replaced",
  "internal_error",
]);
export type ExtensionBridgeFatalErrorCode = z.infer<typeof extensionBridgeFatalErrorCodeSchema>;

/** 传输层命令失败使用 BrowserCommand 领域的稳定错误码，不包装成 fatalError。 */
export const extensionCommandFailureCodeSchema = z.enum([
  "authorization_required",
  "permission_denied",
  "target_unavailable",
  "invalid_message",
  "internal_error",
]);
export type ExtensionCommandFailureCode = z.infer<typeof extensionCommandFailureCodeSchema>;

export const extensionBridgeFailureSchema = z
  .object({
    code: extensionCommandFailureCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ExtensionBridgeFailure = z.infer<typeof extensionBridgeFailureSchema>;

/** CDP 错误保留 method/code/message，由 Host 归一化为 BrowserCommandResult。 */
export const extensionCdpErrorSchema = z
  .object({
    method: z.string().trim().min(1).max(200).optional(),
    code: z.number().int().optional(),
    message: z.string().max(2_000),
  })
  .strict();
export type ExtensionCdpError = z.infer<typeof extensionCdpErrorSchema>;

const cdpParamsSchema = z.record(z.string(), z.unknown());

// ── Extension → Main / Host ──────────────────────────────────────────────

/**
 * hello 不携带配对码和共享密钥；`clientPublicKey` 是扩展的 P-256 ECDH 公钥
 * （raw uncompressed，65 字节的 base64）。共享密钥由双方 ECDH + HKDF 得到。
 */
export const extensionHelloMessageSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.number().int().positive(),
    extensionId: z.string().trim().min(1).max(128),
    extensionVersion: z.string().trim().min(1).max(64),
    profileInstanceId: extensionProfileInstanceIdSchema,
    clientPublicKey: base64Schema,
  })
  .strict();
export type ExtensionHelloMessage = z.infer<typeof extensionHelloMessageSchema>;

/** 一次性配对证明：HMAC(pairingCode, nonce)，不回传配对码原文。 */
export const extensionPairingProofMessageSchema = z
  .object({
    type: z.literal("pairing.proof"),
    pairingSessionId: identifierSchema,
    nonce: base64Schema,
    proof: base64Schema,
  })
  .strict();
export type ExtensionPairingProofMessage = z.infer<typeof extensionPairingProofMessageSchema>;

/** 重连证明：HMAC(sharedKey, "client" | nonce | connectionId)。 */
export const extensionResumeProofMessageSchema = z
  .object({
    type: z.literal("resume.proof"),
    connectionId: extensionConnectionIdSchema,
    proof: base64Schema,
  })
  .strict();
export type ExtensionResumeProofMessage = z.infer<typeof extensionResumeProofMessageSchema>;

export const extensionNativeTabSchema = z
  .object({
    nativeTabId: extensionNativeTabIdSchema,
    active: z.boolean(),
    url: z.string().max(16_384),
    title: z.string().max(16_384),
    windowId: z.number().int().nonnegative().optional(),
    /**
     * Chrome 报告该 tab 已被其他调试器（DevTools 或其他扩展）占用。
     * Host 用它把不可 claim 的页面从 openTabs 过滤掉；attach 失败仍需返回 target_unavailable。
     */
    debuggerAttached: z.boolean().optional(),
  })
  .strict();
export type ExtensionNativeTab = z.infer<typeof extensionNativeTabSchema>;

export const extensionTabsListResultMessageSchema = z
  .object({
    type: z.literal("tabs.list.result"),
    requestId: extensionRequestIdSchema,
    ok: z.boolean(),
    tabs: z.array(extensionNativeTabSchema).optional(),
    failure: extensionBridgeFailureSchema.optional(),
  })
  .strict();
export type ExtensionTabsListResultMessage = z.infer<typeof extensionTabsListResultMessageSchema>;

export const extensionTabsCreateResultMessageSchema = z
  .object({
    type: z.literal("tabs.create.result"),
    requestId: extensionRequestIdSchema,
    ok: z.boolean(),
    tab: extensionNativeTabSchema.optional(),
    failure: extensionBridgeFailureSchema.optional(),
  })
  .strict();
export type ExtensionTabsCreateResultMessage = z.infer<
  typeof extensionTabsCreateResultMessageSchema
>;

export const extensionTabsCloseResultMessageSchema = z
  .object({
    type: z.literal("tabs.close.result"),
    requestId: extensionRequestIdSchema,
    ok: z.boolean(),
    failure: extensionBridgeFailureSchema.optional(),
  })
  .strict();
export type ExtensionTabsCloseResultMessage = z.infer<typeof extensionTabsCloseResultMessageSchema>;

export const extensionAttachResultMessageSchema = z
  .object({
    type: z.literal("debugger.attach.result"),
    requestId: extensionRequestIdSchema,
    ok: z.boolean(),
    attachmentId: extensionAttachmentIdSchema.optional(),
    nativeTabId: extensionNativeTabIdSchema.optional(),
    targetId: extensionTargetIdSchema.optional(),
    url: z.string().max(16_384).optional(),
    title: z.string().max(16_384).optional(),
    failure: extensionBridgeFailureSchema.optional(),
  })
  .strict();
export type ExtensionAttachResultMessage = z.infer<typeof extensionAttachResultMessageSchema>;

export const extensionDetachResultMessageSchema = z
  .object({
    type: z.literal("debugger.detach.result"),
    requestId: extensionRequestIdSchema,
    ok: z.boolean(),
    failure: extensionBridgeFailureSchema.optional(),
  })
  .strict();
export type ExtensionDetachResultMessage = z.infer<typeof extensionDetachResultMessageSchema>;

export const extensionCdpResultMessageSchema = z
  .object({
    type: z.literal("cdp.result"),
    requestId: extensionRequestIdSchema,
    attachmentId: extensionAttachmentIdSchema,
    nativeTabId: extensionNativeTabIdSchema,
    targetId: extensionTargetIdSchema.optional(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: extensionCdpErrorSchema.optional(),
    failure: extensionBridgeFailureSchema.optional(),
  })
  .strict();
export type ExtensionCdpResultMessage = z.infer<typeof extensionCdpResultMessageSchema>;

export const extensionCdpEventMessageSchema = z
  .object({
    type: z.literal("cdp.event"),
    attachmentId: extensionAttachmentIdSchema,
    nativeTabId: extensionNativeTabIdSchema,
    targetId: extensionTargetIdSchema.optional(),
    method: z.string().trim().min(1).max(200),
    params: cdpParamsSchema,
  })
  .strict();
export type ExtensionCdpEventMessage = z.infer<typeof extensionCdpEventMessageSchema>;

export const extensionTargetUpdatedMessageSchema = z
  .object({
    type: z.literal("target.updated"),
    targetRef: extensionTargetRefSchema,
    url: z.string().max(16_384).optional(),
    title: z.string().max(16_384).optional(),
    active: z.boolean().optional(),
    windowId: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ExtensionTargetUpdatedMessage = z.infer<typeof extensionTargetUpdatedMessageSchema>;

export const extensionTargetDetachReasonSchema = z.enum([
  "user_cancel",
  "debugger_detached",
  "tab_closed",
  "socket_closed",
  "host_exit",
  "window_transfer",
  "unknown",
]);
export type ExtensionTargetDetachReason = z.infer<typeof extensionTargetDetachReasonSchema>;

export const extensionTargetDetachedMessageSchema = z
  .object({
    type: z.literal("target.detached"),
    targetRef: extensionTargetRefSchema,
    reason: extensionTargetDetachReasonSchema,
  })
  .strict();
export type ExtensionTargetDetachedMessage = z.infer<typeof extensionTargetDetachedMessageSchema>;

export const extensionTargetClosedMessageSchema = z
  .object({
    type: z.literal("target.closed"),
    targetRef: extensionTargetRefSchema,
  })
  .strict();
export type ExtensionTargetClosedMessage = z.infer<typeof extensionTargetClosedMessageSchema>;

// ── Main / Host → Extension ──────────────────────────────────────────────

/** 配对阶段由 Main 返回；pairingSessionId 会同时显示在 Popup 与发起窗口供用户核对。 */
export const extensionPairingRequiredMessageSchema = z
  .object({
    type: z.literal("pairing.required"),
    pairingSessionId: identifierSchema,
    nonce: base64Schema,
    serverPublicKey: base64Schema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ExtensionPairingRequiredMessage = z.infer<typeof extensionPairingRequiredMessageSchema>;

/** 已配对 Profile 的重连挑战；不包含共享密钥。 */
export const extensionResumeChallengeMessageSchema = z
  .object({
    type: z.literal("resume.challenge"),
    connectionId: extensionConnectionIdSchema,
    nonce: base64Schema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ExtensionResumeChallengeMessage = z.infer<typeof extensionResumeChallengeMessageSchema>;

/**
 * 握手成功。resume 时携带 serverProof = HMAC(sharedKey, "server" | nonce | connectionId)，
 * 扩展必须验证后才进入 connected；pairing 时没有 serverProof。
 */
export const extensionWelcomeMessageSchema = z
  .object({
    type: z.literal("welcome"),
    connectionId: extensionConnectionIdSchema,
    protocolVersion: z.number().int().positive(),
    browserId: identifierSchema,
    profileInstanceId: extensionProfileInstanceIdSchema,
    generation: z.number().int().nonnegative(),
    capabilitiesVersion: z.number().int().nonnegative(),
    serverProof: base64Schema.optional(),
  })
  .strict();
export type ExtensionWelcomeMessage = z.infer<typeof extensionWelcomeMessageSchema>;

export const extensionFatalErrorMessageSchema = z
  .object({
    type: z.literal("fatalError"),
    code: extensionBridgeFatalErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ExtensionFatalErrorMessage = z.infer<typeof extensionFatalErrorMessageSchema>;

export const extensionTabsListMessageSchema = z
  .object({
    type: z.literal("tabs.list"),
    requestId: extensionRequestIdSchema,
  })
  .strict();
export type ExtensionTabsListMessage = z.infer<typeof extensionTabsListMessageSchema>;

/**
 * Agent 新建标签页必须后台打开：`active` 只接受字面量 `false`，
 * 从协议层拒绝会把 Chrome 拉到前台的调用。
 */
export const extensionTabsCreateMessageSchema = z
  .object({
    type: z.literal("tabs.create"),
    requestId: extensionRequestIdSchema,
    active: z.literal(false),
    url: z.string().max(16_384).optional(),
  })
  .strict();
export type ExtensionTabsCreateMessage = z.infer<typeof extensionTabsCreateMessageSchema>;

/** 关闭原生 tab；已 attach 时必须先 detach，扩展侧保证幂等。 */
export const extensionTabsCloseMessageSchema = z
  .object({
    type: z.literal("tabs.close"),
    requestId: extensionRequestIdSchema,
    nativeTabId: extensionNativeTabIdSchema,
  })
  .strict();
export type ExtensionTabsCloseMessage = z.infer<typeof extensionTabsCloseMessageSchema>;

export const extensionAttachMessageSchema = z
  .object({
    type: z.literal("debugger.attach"),
    requestId: extensionRequestIdSchema,
    target: extensionAttachTargetSchema,
  })
  .strict();
export type ExtensionAttachMessage = z.infer<typeof extensionAttachMessageSchema>;

export const extensionDetachMessageSchema = z
  .object({
    type: z.literal("debugger.detach"),
    requestId: extensionRequestIdSchema,
    targetRef: extensionTargetRefSchema,
  })
  .strict();
export type ExtensionDetachMessage = z.infer<typeof extensionDetachMessageSchema>;

/**
 * CDP 请求。`targetRef` 必须与当前 attachment 完全匹配；
 * 子 frame 使用 `targetId`。此 schema 是 strict 的，携带 `sessionId` 会校验失败。
 */
export const extensionCdpRequestMessageSchema = z
  .object({
    type: z.literal("cdp.request"),
    requestId: extensionRequestIdSchema,
    targetRef: extensionTargetRefSchema,
    method: z.string().trim().min(1).max(200),
    params: cdpParamsSchema,
    targetId: extensionTargetIdSchema.optional(),
  })
  .strict();
export type ExtensionCdpRequestMessage = z.infer<typeof extensionCdpRequestMessageSchema>;

export const extensionRequestCancelMessageSchema = z
  .object({
    type: z.literal("request.cancel"),
    targetRequestId: extensionRequestIdSchema,
  })
  .strict();
export type ExtensionRequestCancelMessage = z.infer<typeof extensionRequestCancelMessageSchema>;

export const extensionSessionDetachAllMessageSchema = z
  .object({
    type: z.literal("session.detachAll"),
    reason: extensionTargetDetachReasonSchema,
  })
  .strict();
export type ExtensionSessionDetachAllMessage = z.infer<
  typeof extensionSessionDetachAllMessageSchema
>;

/**
 * Host → Extension：登记一个等待用户授权的已有 tab。
 *
 * 该消息只登记 pending claim，不 attach。Host 首次 claimTab 发出后立即返回
 * authorization_required，不等待用户操作；用户决定通过 claim.decision 回到 Host。
 */
export const extensionClaimRequestMessageSchema = z
  .object({
    type: z.literal("claim.request"),
    claimId: identifierSchema,
    nativeTabId: extensionNativeTabIdSchema,
    /** 仅用于 Popup 展示剩余时间；权威 TTL 仍由 Host 计时。 */
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ExtensionClaimRequestMessage = z.infer<typeof extensionClaimRequestMessageSchema>;

/** Host → Extension：撤销 pending claim（超时、取消、连接失效或晚到决定）。 */
export const extensionClaimCancelMessageSchema = z
  .object({
    type: z.literal("claim.cancel"),
    claimId: identifierSchema,
  })
  .strict();
export type ExtensionClaimCancelMessage = z.infer<typeof extensionClaimCancelMessageSchema>;

export const extensionClaimDecisionSchema = z.enum(["granted", "denied", "dismissed"]);
export type ExtensionClaimDecision = z.infer<typeof extensionClaimDecisionSchema>;

/**
 * Extension → Host：用户在 Popup 的决定。`dismissed` 表示 Popup 关闭且未作决定。
 * Host 只在 pending claim 仍有效且 claimId/nativeTabId 都匹配时接受 granted。
 */
export const extensionClaimDecisionMessageSchema = z
  .object({
    type: z.literal("claim.decision"),
    claimId: identifierSchema,
    nativeTabId: extensionNativeTabIdSchema,
    decision: extensionClaimDecisionSchema,
  })
  .strict();
export type ExtensionClaimDecisionMessage = z.infer<typeof extensionClaimDecisionMessageSchema>;

// ── 方向化联合 ──────────────────────────────────────────────────────────

const extensionToMainMessages = [
  extensionHelloMessageSchema,
  extensionPairingProofMessageSchema,
  extensionResumeProofMessageSchema,
  extensionTabsListResultMessageSchema,
  extensionTabsCreateResultMessageSchema,
  extensionTabsCloseResultMessageSchema,
  extensionAttachResultMessageSchema,
  extensionDetachResultMessageSchema,
  extensionCdpResultMessageSchema,
  extensionCdpEventMessageSchema,
  extensionTargetUpdatedMessageSchema,
  extensionTargetDetachedMessageSchema,
  extensionTargetClosedMessageSchema,
  extensionClaimDecisionMessageSchema,
] as const;

const mainToExtensionMessages = [
  extensionPairingRequiredMessageSchema,
  extensionResumeChallengeMessageSchema,
  extensionWelcomeMessageSchema,
  extensionFatalErrorMessageSchema,
  extensionTabsListMessageSchema,
  extensionTabsCreateMessageSchema,
  extensionTabsCloseMessageSchema,
  extensionAttachMessageSchema,
  extensionDetachMessageSchema,
  extensionCdpRequestMessageSchema,
  extensionRequestCancelMessageSchema,
  extensionSessionDetachAllMessageSchema,
  extensionClaimRequestMessageSchema,
  extensionClaimCancelMessageSchema,
] as const;

export const extensionBridgeClientMessageSchema = z.discriminatedUnion(
  "type",
  extensionToMainMessages,
);
export type ExtensionBridgeClientMessage = z.infer<typeof extensionBridgeClientMessageSchema>;

export const extensionBridgeServerMessageSchema = z.discriminatedUnion(
  "type",
  mainToExtensionMessages,
);
export type ExtensionBridgeServerMessage = z.infer<typeof extensionBridgeServerMessageSchema>;

export const extensionBridgeMessageSchema = z.union([
  extensionBridgeClientMessageSchema,
  extensionBridgeServerMessageSchema,
]);
export type ExtensionBridgeMessage = z.infer<typeof extensionBridgeMessageSchema>;

/** Host 发往扩展且等待终态结果的请求；用于 Host ↔ Main 传输消息的严格校验。 */
export const extensionBridgeRequestMessageSchema = z.discriminatedUnion("type", [
  extensionTabsListMessageSchema,
  extensionTabsCreateMessageSchema,
  extensionTabsCloseMessageSchema,
  extensionAttachMessageSchema,
  extensionDetachMessageSchema,
  extensionCdpRequestMessageSchema,
]);
export type ExtensionBridgeRequestMessage = z.infer<typeof extensionBridgeRequestMessageSchema>;

const extensionBridgeResultTypes = new Set<string>([
  "tabs.list.result",
  "tabs.create.result",
  "tabs.close.result",
  "debugger.attach.result",
  "debugger.detach.result",
  "cdp.result",
]);

/** 判断一条扩展消息是否为某个 requestId 的终态结果。 */
export function isExtensionBridgeResultMessage(
  message: ExtensionBridgeClientMessage,
): message is
  | ExtensionTabsListResultMessage
  | ExtensionAttachResultMessage
  | ExtensionDetachResultMessage
  | ExtensionCdpResultMessage {
  return extensionBridgeResultTypes.has(message.type);
}

// ── 解析与帧限制 ────────────────────────────────────────────────────────

export type ExtensionBridgeProtocolErrorCode =
  | "invalid_frame"
  | "frame_too_large"
  | "invalid_message";

export class ExtensionBridgeProtocolError extends Error {
  readonly code: ExtensionBridgeProtocolErrorCode;

  constructor(code: ExtensionBridgeProtocolErrorCode, message: string) {
    super(message);
    this.name = "ExtensionBridgeProtocolError";
    this.code = code;
  }
}

/** 返回 UTF-8 字节长度；扩展与 Main 使用同一口径校验 8 MiB 上限。 */
export function extensionBridgeMessageByteLength(raw: string): number {
  return new TextEncoder().encode(raw).byteLength;
}

function decodeFrame(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const byteLength = extensionBridgeMessageByteLength(raw);
  if (byteLength > EXTENSION_BRIDGE_MAX_FRAME_BYTES) {
    throw new ExtensionBridgeProtocolError(
      "frame_too_large",
      `frame exceeds ${EXTENSION_BRIDGE_MAX_FRAME_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ExtensionBridgeProtocolError("invalid_frame", "frame is not valid JSON");
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function parseWithSchema<T>(schema: z.ZodType<T>, raw: unknown, direction: string): T {
  const parsed = schema.safeParse(decodeFrame(raw));
  if (!parsed.success) {
    throw new ExtensionBridgeProtocolError(
      "invalid_message",
      `${direction} message rejected: ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** 校验扩展发往 Main/Host 的消息；server-only 消息会被拒绝。 */
export function parseExtensionBridgeClientMessage(raw: unknown): ExtensionBridgeClientMessage {
  return parseWithSchema(extensionBridgeClientMessageSchema, raw, "client");
}

/** 校验 Main/Host 发往扩展的消息；client-only 消息会被拒绝。 */
export function parseExtensionBridgeServerMessage(raw: unknown): ExtensionBridgeServerMessage {
  return parseWithSchema(extensionBridgeServerMessageSchema, raw, "server");
}

/** 序列化并检查整帧上限；超限直接失败，不排队。 */
export function serializeExtensionBridgeMessage(message: ExtensionBridgeMessage): string {
  const raw = JSON.stringify(message);
  if (extensionBridgeMessageByteLength(raw) > EXTENSION_BRIDGE_MAX_FRAME_BYTES) {
    throw new ExtensionBridgeProtocolError(
      "frame_too_large",
      `frame exceeds ${EXTENSION_BRIDGE_MAX_FRAME_BYTES} bytes`,
    );
  }
  return raw;
}
