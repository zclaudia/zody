import { z } from "zod";

const CUA_NATIVE_AUDIT_PREFIX = "[cua-native] ";
const CUA_NATIVE_AUDIT_MAX_LINE_CHARS = 4_096;
const NODE_IDENTIFIER = "io.github.zclaudia.zody.cua-helper.node";

const pidSchema = z.number().int().min(1).max(2_147_483_647);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cdhash40Schema = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

// 中文原因：app-confirm-failed 是 App 内确认轮次新增的唯一 reason——CLI 对
// confirm 帧返回 ok:false 或帧处理失败时 Helper fail-closed 拒绝本次截图；
// 与 owner/EOF 失效分账。allowed 必须为 false，天然满足下方一致性校验。
const confirmationReasonSchema = z.enum([
  "user-approved",
  "user-canceled",
  "owner-invalidated",
  "authority-eof",
  "confirmation-stale",
  "shutdown",
  "relay-liveness-error",
  "relay-eof",
  "signal",
  "supervisor-destroyed",
  "app-confirm-failed",
]);

const captureReasonSchema = z.enum([
  "connection-failed",
  "entry-clean-exit",
  "entry-fatal",
  "entry-stopped",
  "session-stopping",
  "confirmation-unavailable",
  "confirmation-denied",
  "user-canceled",
  "confirmation-invalidated",
  "confirmation-canceled",
  "peer-auth-failed",
  "peer-pid-mismatch",
  "node-loaded-code-mismatch",
  "authority-transport-failed",
  "bootstrap-failed",
  "binding-invalid",
  "window-target-invalid",
  "machine-lease-unavailable",
  "capture-file-name-unavailable",
  "capture-file-verify-failed",
  "capture-canceled",
  "capture-result-not-accepted",
  "capture-result-transport-failed",
  "machine-lease-release-unconfirmed",
  "final-owner-check-failed",
  "post-confirm-check-failed",
  "authority-buffer-not-empty",
  "authority-fd-mode-failed",
  "machine-lease-not-held",
  "capture-context-incomplete",
  "tcc-not-authorized",
  "visual-start-denied",
  "visual-take-png-failed",
  "visual-png-invalid",
  "visual-wait-failed",
  "visual-resources-not-released",
  "visual-destroy-pending",
  "visual-staticlib-missing",
  "capture-facts-missing",
  "authority-revoke-failed",
  "authority-revoke-not-confirmed",
  "capture-create-failed",
  "capture-write-failed",
  "capture-fsync-failed",
  "capture-failed",
  "visual-failed",
  "tcc-failed",
  "capture-context-failed",
  "peer-rejected",
  "control-failed",
  "transport-closed",
  "authority-failed",
  "unexpected-control-frame",
]);

const confirmationPresentedSchema = z
  .object({ generation: positiveIntegerSchema })
  .strict()
  .transform((value) => ({ generation: value.generation }));

const confirmationResolvedSchema = z
  .object({
    generation: positiveIntegerSchema,
    allowed: z.boolean(),
    reason: confirmationReasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allowed !== (value.reason === "user-approved")) {
      context.addIssue({ code: "custom", message: "confirmation result is inconsistent" });
    }
  })
  .transform((value) => ({
    generation: value.generation,
    allowed: value.allowed,
    reason: value.reason,
  }));

const cellSpawnedSchema = z
  .object({ pid: pidSchema, suspended: z.boolean() })
  .strict()
  .transform((value) => ({ pid: value.pid, suspended: value.suspended }));

const cellLoadedCodeSchema = z
  .object({
    pid: pidSchema,
    verified: z.boolean(),
    identifier: z.union([z.literal(NODE_IDENTIFIER), z.literal("")]),
    cdhash: z.union([cdhash40Schema, z.literal("")]),
    entitlementsEmpty: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.verified &&
      (value.identifier !== NODE_IDENTIFIER || value.cdhash === "" || !value.entitlementsEmpty)
    ) {
      context.addIssue({ code: "custom", message: "verified cell identity is incomplete" });
    }
  })
  .transform((value) => ({
    pid: value.pid,
    verified: value.verified,
    identifier: value.identifier,
    cdhash: value.cdhash,
    entitlementsEmpty: value.entitlementsEmpty,
  }));

const cellResumedSchema = z
  .object({ pid: pidSchema })
  .strict()
  .transform((value) => ({ pid: value.pid }));

const cellSourceSentSchema = z
  .object({ pid: pidSchema, bytes: nonNegativeIntegerSchema })
  .strict()
  .transform((value) => ({ pid: value.pid, bytes: value.bytes }));

const cellPeerVerifiedSchema = z
  .object({
    pid: pidSchema,
    identifier: z.literal(NODE_IDENTIFIER),
    cdhash: cdhash40Schema,
    entitlementsEmpty: z.literal(true),
  })
  .strict()
  .transform((value) => ({
    pid: value.pid,
    identifier: value.identifier,
    cdhash: value.cdhash,
    entitlementsEmpty: value.entitlementsEmpty,
  }));

const cellReapedSchema = z
  .object({
    pid: pidSchema,
    confirmed: z.boolean(),
    exitCode: z.union([z.number().int().min(0).max(255), z.null()]),
    signal: z.union([z.number().int().min(1).max(128), z.null()]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.exitCode !== null && value.signal !== null) {
      context.addIssue({ code: "custom", message: "reaped status cannot contain both fields" });
    }
  })
  .transform((value) => ({
    pid: value.pid,
    confirmed: value.confirmed,
    exitCode: value.exitCode,
    signal: value.signal,
  }));

const machineLeaseReleasedSchema = z
  .object({ confirmed: z.boolean() })
  .strict()
  .transform((value) => ({ confirmed: value.confirmed }));

const captureDeliveredSchema = z
  .object({
    sha256: sha256Schema,
    width: z.number().int().min(1).max(0xffff_ffff),
    height: z.number().int().min(1).max(0xffff_ffff),
    bytes: nonNegativeIntegerSchema,
    resourcesReleased: z.literal(true),
    machineLeaseReleased: z.literal(true),
  })
  .strict()
  .transform((value) => ({
    sha256: value.sha256,
    width: value.width,
    height: value.height,
    bytes: value.bytes,
    resourcesReleased: true,
    machineLeaseReleased: true,
  }));

const captureRejectedSchema = z
  .object({ reason: captureReasonSchema })
  .strict()
  .transform((value) => ({ reason: value.reason }));

const visualCompletionHeldSchema = z
  .object({
    captureErrorPresent: z.boolean(),
    hasImage: z.boolean(),
    requestId: positiveIntegerSchema,
  })
  .strict()
  .transform((value) => ({
    captureErrorPresent: value.captureErrorPresent,
    hasImage: value.hasImage,
    requestId: value.requestId,
  }));

const visualSubmitReturnSchema = z
  .object({ requestId: positiveIntegerSchema, targetMatches: z.boolean() })
  .strict()
  .transform((value) => ({ requestId: value.requestId, targetMatches: value.targetMatches }));

const visualStopGateReleaseSchema = z
  .object({
    completionConsumed: z.literal(false),
    gateResult: z.literal("stopped"),
    heldCompletionDiscarded: z.literal(true),
    requestId: positiveIntegerSchema,
  })
  .strict()
  .transform((value) => ({
    completionConsumed: false,
    gateResult: "stopped" as const,
    heldCompletionDiscarded: true,
    requestId: value.requestId,
  }));

const visualStopGateTimeoutSchema = z
  .object({
    gateResult: z.literal("deadline-timeout"),
    heldCompletionDiscarded: z.literal(true),
    requestId: positiveIntegerSchema,
    timeoutMs: z.literal(30_000),
  })
  .strict()
  .transform((value) => ({
    gateResult: "deadline-timeout" as const,
    heldCompletionDiscarded: true,
    requestId: value.requestId,
    timeoutMs: 30_000,
  }));

const visualStopGateErrorSchema = z
  .object({
    gateResult: z.enum(["missing-operation", "invalid-result"]),
    heldCompletionDiscarded: z.literal(true),
    requestId: positiveIntegerSchema,
  })
  .strict()
  .transform((value) => ({
    gateResult: value.gateResult,
    heldCompletionDiscarded: true,
    requestId: value.requestId,
  }));

const markerSchemas = {
  "confirmation-presented": confirmationPresentedSchema,
  "confirmation-resolved": confirmationResolvedSchema,
  "cell-spawned": cellSpawnedSchema,
  "cell-loaded-code": cellLoadedCodeSchema,
  "cell-resumed": cellResumedSchema,
  "cell-source-sent": cellSourceSentSchema,
  "cell-peer-verified": cellPeerVerifiedSchema,
  "cell-reaped": cellReapedSchema,
  "machine-lease-released": machineLeaseReleasedSchema,
  "capture-delivered": captureDeliveredSchema,
  "capture-rejected": captureRejectedSchema,
  "visual-completion-held": visualCompletionHeldSchema,
  "visual-submit-return": visualSubmitReturnSchema,
  "visual-stop-gate-release": visualStopGateReleaseSchema,
  "visual-stop-gate-timeout": visualStopGateTimeoutSchema,
  "visual-stop-gate-error": visualStopGateErrorSchema,
} as const;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * 只接受 native source 中实际存在的固定审计行。
 *
 * 根因：raw stderr 在正式包只走 debug，运行中的 cell 验证和 visual gate 事实无法进入
 * 既有 Host 日志。这里不转发原 JSON，而是严格校验后重建规范行，避免任意 CLI 文本、
 * 额外 secret 字段或超长内容借诊断通道进入生产日志。
 */
export function parseCuaNativeAuditLine(line: string): string | undefined {
  if (
    line.length === 0 ||
    line.length > CUA_NATIVE_AUDIT_MAX_LINE_CHARS ||
    containsControlCharacter(line) ||
    !line.startsWith(CUA_NATIVE_AUDIT_PREFIX)
  ) {
    return undefined;
  }

  const body = line.slice(CUA_NATIVE_AUDIT_PREFIX.length);
  if (body === "machine-lease-acquired") {
    return line;
  }

  const separator = body.indexOf(" ");
  if (separator <= 0) return undefined;
  const marker = body.slice(0, separator) as keyof typeof markerSchemas;
  const payloadText = body.slice(separator + 1);
  if (
    !Object.hasOwn(markerSchemas, marker) ||
    !payloadText.startsWith("{") ||
    !payloadText.endsWith("}")
  ) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return undefined;
  }

  const parsed = markerSchemas[marker].safeParse(payload);
  if (!parsed.success) return undefined;
  return `${CUA_NATIVE_AUDIT_PREFIX}${marker} ${JSON.stringify(parsed.data)}`;
}
