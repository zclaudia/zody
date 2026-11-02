import type { Duplex } from "node:stream";
import type { CuaSubmissionRef, CuaSubmissionTurnScope } from "@zcode/contracts";

/** 与 R11 native authority 入口相同的帧上限，避免新接口悄悄放宽 wire 合同。 */
export const CUA_NATIVE_AUTHORITY_MAX_FRAME_BYTES = 16 * 1024;
export const CUA_NATIVE_AUTHORITY_MAX_PENDING_BYTES = 64 * 1024;
export const CUA_NATIVE_AUTHORITY_MAX_FIELD_BYTES = 4 * 1024;
export const CUA_NATIVE_AUTHORITY_CLOSE_FLUSH_TIMEOUT_MS = 250;
export const CUA_NATIVE_AUTHORITY_DEFAULT_MAX_PENDING_REQUESTS = 32;
export const CUA_NATIVE_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type CuaNativeAuthorityMethod = "bootstrap" | "check" | "captureResult" | "revoke" | "close";

export interface CuaNativeCaptureTarget {
  readonly pid: number;
  readonly windowId: number;
}

export interface CuaNativeCapturePngFacts {
  readonly path: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** native 只在同一 live scope 内回传一次；图字节仍由 CLI 从私有 captureRoot 读取核验。 */
export interface CuaNativeCaptureResultPayload {
  readonly ref: CuaSubmissionRef;
  readonly traceId: string;
  readonly producerIncarnation: string;
  readonly runId: string;
  readonly turnId: string;
  readonly target: CuaNativeCaptureTarget;
  readonly png: CuaNativeCapturePngFacts;
  readonly resourcesReleased: true;
  readonly machineLeaseReleased: true;
}

export interface CuaNativeAuthorityImageToolResult {
  readonly content: Array<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

export interface CuaNativeAuthorityCaptureOptions {
  /** native 私有 0700 目录；PNG 只允许是该目录直属普通文件。 */
  readonly root: string;
  /** 调用方显式给出的本次截图目标；bootstrap 必须回送同一 target。 */
  readonly target: CuaNativeCaptureTarget;
  /** 文件已核验且 scope 仍 live 时调用；返回值必须包含真实 image/png 内容块。 */
  accept(
    payload: CuaNativeCaptureResultPayload,
    png: Uint8Array,
  ): Promise<CuaNativeAuthorityImageToolResult>;
  /** 仅供本次 composition 结束等待；失败原因来自协议，不新增 authority 队列或信任来源。 */
  onRejected?(reason: string): void;
  /** authority 已写出 accepted 且 scope 仍 live；此前返回值不得当成已交付工具结果。 */
  onAccepted?(): void;
}

export interface CuaNativeAuthoritySessionOptions {
  /**
   * 唯一 runtime turn scope。身份只能从这里捕获，adapter 不接受调用方另行传入
   * host/session/ref/run/turn，也不 new authority。
   */
  readonly scope: CuaSubmissionTurnScope;
  /**
   * 可信 launcher 已经建立的私有双工流（真实 product 接线时来自固定签名 Helper）。
   * 显式注入不是认证：本接口不验证 OS peer，也不防同进程伪造 scope/stream；调用方负责
   * 已经完成可信启动/OS peer 校验，只把该流交给本 adapter。
   */
  readonly stream: Duplex;
  /** 与本次 launcher bootstrap material 相同的 producer incarnation。 */
  readonly producerIncarnation: string;
  /** 只有真实 app 的显式 capture composition 才提供；普通 authority 会话保持缺席。 */
  readonly capture?: CuaNativeAuthorityCaptureOptions;
  readonly maxFrameBytes?: number;
  readonly maxPendingBytes?: number;
  readonly maxPendingRequests?: number;
  readonly closeTimeoutMs?: number;
  /** 撤销 / 清理等待上限；超时不伪造 owner 事实。 */
  readonly requestTimeoutMs?: number;
}

export type CuaNativeAuthorityCloseReason =
  | "remote-close"
  | "scope-closed"
  | "owner-revoked"
  | "eof"
  | "protocol-error"
  | "transport-error"
  | "adapter-close";

export type CuaNativeAuthorityRevokeOutcome = "revoked" | "unknown" | "not-requested";

export interface CuaNativeAuthorityCloseResult {
  readonly reason: CuaNativeAuthorityCloseReason;
  readonly ownerRevoked: boolean;
  readonly revocationForwarded: boolean;
  readonly authorityRevoke: CuaNativeAuthorityRevokeOutcome;
  /** 只有实际观察到流 close 才为 true；deadline 未确认时保持 false。 */
  readonly transportClosed: boolean;
  /** close deadline 到达但真实 close 尚未确认，资源清理仍在等待。 */
  readonly cleanupPending: boolean;
  readonly nativeFence: "unknown";
  readonly machineLease: "unavailable";
  readonly stopComplete: false;
}

export interface CuaNativeAuthorityDiagnostics {
  readonly traceId: string;
  readonly state: "starting" | "bound" | "invalidated" | "closed";
  readonly invalidated: boolean;
  readonly ownerRevoked: boolean;
  readonly lastFailure: string | null;
  readonly executable: false;
  readonly candidateIsGrant: false;
  readonly nativeHelper: "unavailable";
  readonly nativeFence: "unknown";
  readonly machineLease: "unavailable";
  readonly stopComplete: false;
}

export interface CuaNativeAuthoritySession {
  readonly scope: CuaSubmissionTurnScope;
  readonly diagnostics: CuaNativeAuthorityDiagnostics;
  /** 等一次有界清理完成；不会遗留 pending Promise。 */
  waitForClose(): Promise<CuaNativeAuthorityCloseResult>;
  /**
   * adapter 侧正常关闭：只关闭 consumer 并释放本次 binding（scope.close），
   * 不撤销仍有效的 lineage。
   */
  close(): void;
}

export interface CuaNativeAuthorityRequestFrame {
  readonly requestId: string;
  readonly method: CuaNativeAuthorityMethod;
  readonly payload: Record<string, unknown>;
}

export type CuaNativeAuthorityParseResult =
  | { readonly ok: true; readonly frame: CuaNativeAuthorityRequestFrame }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly requestId?: string;
      readonly method?: string;
    };

const METHODS = new Set<CuaNativeAuthorityMethod>([
  "bootstrap",
  "check",
  "captureResult",
  "revoke",
  "close",
]);
const REF_STRING_FIELDS = [
  "submissionLineageId",
  "appIncarnation",
  "hostInstanceId",
  "runtimeInstanceId",
  "sessionId",
  "workspaceKey",
] as const;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= CUA_NATIVE_AUTHORITY_MAX_FIELD_BYTES
  );
}

/** 严格读取完整 ref；6 个字符串字段与正安全整数 revision 缺一不可。 */
export function readCuaSubmissionRef(value: unknown): CuaSubmissionRef | undefined {
  if (!isObject(value)) return undefined;
  const ref: Record<string, unknown> = {};
  for (const field of REF_STRING_FIELDS) {
    if (!isBoundedString(value[field])) return undefined;
    ref[field] = value[field];
  }
  if (
    !Number.isSafeInteger(value.authorizationRevision) ||
    Number(value.authorizationRevision) <= 0
  ) {
    return undefined;
  }
  ref.authorizationRevision = value.authorizationRevision;
  return ref as unknown as CuaSubmissionRef;
}

export function sameCuaSubmissionRef(
  left: CuaSubmissionRef | undefined,
  right: CuaSubmissionRef | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    REF_STRING_FIELDS.every((field) => left[field] === right[field]) &&
    left.authorizationRevision === right.authorizationRevision
  );
}

/** 撤销会推进 authorizationRevision；同 lineage 身份用 identity 比较，回执另验 revision 不倒退。 */
export function sameCuaSubmissionIdentity(
  left: CuaSubmissionRef | undefined,
  right: CuaSubmissionRef | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    REF_STRING_FIELDS.every((field) => left[field] === right[field])
  );
}

export function parseCuaNativeAuthorityRequest(line: string): CuaNativeAuthorityParseResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isObject(value)) return { ok: false, reason: "invalid_frame" };
  const requestId = value.requestId;
  const method = value.method;
  if (!isBoundedString(requestId) || !isBoundedString(method) || !isObject(value.payload)) {
    return {
      ok: false,
      reason: "invalid_frame",
      ...(typeof requestId === "string" ? { requestId } : {}),
      ...(typeof method === "string" ? { method } : {}),
    };
  }
  if (!METHODS.has(method as CuaNativeAuthorityMethod)) {
    return { ok: false, reason: "unknown_method", requestId, method };
  }
  return {
    ok: true,
    frame: {
      requestId,
      method: method as CuaNativeAuthorityMethod,
      payload: value.payload,
    },
  };
}

export function cuaNativeAuthorityRevocationRequestId(ref: CuaSubmissionRef): string {
  return `revocation:${ref.submissionLineageId}:${ref.authorizationRevision}`;
}
