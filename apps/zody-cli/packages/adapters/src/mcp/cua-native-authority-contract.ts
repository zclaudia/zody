import type { Duplex } from "node:stream";
import type { CuaSubmissionRef, CuaSubmissionTurnScope } from "@zody/contracts";

/** 与 R11 native authority 入口相同的帧上限，避免新接口悄悄放宽 wire 合同。 */
export const CUA_NATIVE_AUTHORITY_MAX_FRAME_BYTES = 16 * 1024;
export const CUA_NATIVE_AUTHORITY_MAX_PENDING_BYTES = 64 * 1024;
export const CUA_NATIVE_AUTHORITY_MAX_FIELD_BYTES = 4 * 1024;
export const CUA_NATIVE_AUTHORITY_CLOSE_FLUSH_TIMEOUT_MS = 250;
export const CUA_NATIVE_AUTHORITY_DEFAULT_MAX_PENDING_REQUESTS = 32;
export const CUA_NATIVE_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type CuaNativeAuthorityMethod =
  | "bootstrap"
  | "check"
  | "captureResult"
  | "confirm"
  | "revoke"
  | "close";

export interface CuaNativeCaptureTarget {
  readonly pid: number;
  readonly windowId: number;
}

/** App 内确认弹窗的 target 展示事实；ownerName/windowName 上限 128 UTF-8 字节（spec 2026-10-31）。 */
export const CUA_NATIVE_AUTHORITY_CONFIRM_TARGET_MAX_STRING_BYTES = 128;

export interface CuaNativeConfirmTarget {
  readonly pid: number;
  readonly windowId: number;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly ownerName: string;
  readonly windowName: string;
}

/** confirm 帧携带的用户确认载荷；关联字段仍留在 wire payload 顶层由 handler 校验。 */
export interface CuaNativeConfirmRequestPayload {
  readonly generation: number;
  readonly target: CuaNativeConfirmTarget;
}

/**
 * App 内确认结果：用户允许/取消是 {allowed}；CLI 侧拒绝或失败必须保留固定 reason，
 * 由 protocol 原样写成 ok:false（Helper 一律 fail-closed），不能压平成 allowed:false。
 */
export type CuaNativeConfirmRequestOutcome =
  | { readonly allowed: boolean }
  | {
      readonly ok: false;
      readonly reason: "confirmation-invalid" | "confirmation-unavailable";
    };

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
  /**
   * App 内确认弹窗回调（替代 Helper 原生 NSAlert，spec 2026-10-31）：Helper 的 confirm
   * 帧经它发起一次用户交互。会话级交互入口，与 capture 的图像交付选项分开，不混进
   * accept/onRejected/onAccepted；只有真实 capture composition 提供。
   */
  readonly confirmRequest?: (
    payload: CuaNativeConfirmRequestPayload,
  ) => Promise<CuaNativeConfirmRequestOutcome>;
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
  "confirm",
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
const CONFIRM_PAYLOAD_KEYS = new Set([
  "ref",
  "traceId",
  "producerIncarnation",
  "runId",
  "turnId",
  "generation",
  "target",
]);
const CONFIRM_TARGET_KEYS = new Set([
  "pid",
  "windowId",
  "layer",
  "x",
  "y",
  "width",
  "height",
  "ownerName",
  "windowName",
]);

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

/**
 * 严格读取 confirm 帧的 target 展示事实：9 个字段缺一不可、不接受未知字段。
 * target 直接来自 native 的 CGRect：x/y/width/height 是 double，只要求有限 number
 * （安全整数约束会拒掉真实窗口）；pid/windowId/layer 仍是整数。ownerName/windowName
 * 可以是空串（无标题窗口），只限制 string 类型与 ≤128 UTF-8 字节。
 */
export function readCuaNativeConfirmTarget(value: unknown): CuaNativeConfirmTarget | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, CONFIRM_TARGET_KEYS)) return undefined;
  if (!isPositiveSafeInteger(value.pid) || !isPositiveSafeInteger(value.windowId)) return undefined;
  // layer 允许 0 与负值（窗口层级），但必须是安全整数。
  if (!isSafeInteger(value.layer)) return undefined;
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return undefined;
  if (!isPositiveFiniteNumber(value.width) || !isPositiveFiniteNumber(value.height)) {
    return undefined;
  }
  if (!isBoundedTargetString(value.ownerName) || !isBoundedTargetString(value.windowName)) {
    return undefined;
  }
  return Object.freeze({
    pid: value.pid,
    windowId: value.windowId,
    layer: value.layer,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    ownerName: value.ownerName,
    windowName: value.windowName,
  });
}

/**
 * 严格读取 confirm 帧 payload：顶层只允许关联字段 + generation + target，
 * generation 必须是正安全整数；关联字段本身与 scope 的匹配由 protocol handler 校验。
 */
export function readCuaNativeConfirmRequestPayload(
  value: unknown,
): CuaNativeConfirmRequestPayload | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, CONFIRM_PAYLOAD_KEYS)) return undefined;
  if (!isPositiveSafeInteger(value.generation)) return undefined;
  const target = readCuaNativeConfirmTarget(value.target);
  if (!target) return undefined;
  return Object.freeze({ generation: value.generation, target });
}

function isBoundedTargetString(value: unknown): value is string {
  // 空串合法（无标题窗口）；只约束类型与 UTF-8 字节上限。
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= CUA_NATIVE_AUTHORITY_CONFIRM_TARGET_MAX_STRING_BYTES
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
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
