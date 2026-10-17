/* eslint-disable max-lines -- 帧 schema、心跳常量、版本协商与 appProtocol 清单按 spec 必须同文件。 */
/**
 * 手机远控 channel 帧协议（zclaudia-gateway 数据面）。
 *
 * gateway 只做帧级中继：保序、区分 text/binary、不解析帧内容，所以桌面和手机之间的全部
 * channel 契约都在这里：帧 schema、心跳与超时常量、`protocolVersion`/`appProtocol` 协商、
 * 以及「类型与字段的引入版本」清单。
 *
 * 分层边界：channel 层只校验帧信封。`data` 帧里的 payload 是 `WebRemoteControlAppPayload`，
 * 它的校验 owner 仍是 `validation.ts` 的 `parseWebRemoteControlAppPayload`，接收方必须先用
 * 那个函数校验后再使用。这样 rpc-frame 这类高频帧不会在 channel 层被 base64 校验二次解析。
 *
 * 演进规则（spec「版本兼容」）：新增 `zcode_type` 或在已有类型上新增可选字段时，都要在
 * `WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES` 登记引入版本，并把
 * `WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION` 加 1。发送方只在协商版本达到引入版本时才写该
 * 类型或字段；接收方发现超出协商版本的已登记类型或字段时丢弃该帧，并回
 * `protocol_error{code:"unsupported-version"}`——只做诊断，不改变连接状态和页面。
 */
import { z } from "zod";
import type { WebRemoteControlAppPayload } from "./web-remote-control.js";
import { WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS } from "./web-remote-control-rpc-transport.js";

/** Channel kind 固定值；桌面只接受这个 kind，其余由 backend SDK 自动回 `channel_reject`。 */
export const WEB_REMOTE_CONTROL_CHANNEL_KIND = "zcode-remote";

/**
 * backend 在 `peer_hello.backend.capabilities` 里自报的能力位。
 * 手机在 channel_open 之前查 registry：电脑在线但没有这个能力位时直接进入 `backend-unsupported`。
 */
export const WEB_REMOTE_CONTROL_BACKEND_CAPABILITY = "zcode-remote-control";

/** channel 帧格式版本：只有帧格式不兼容变化时才递增，不相等就直接 `close{incompatible-version}`。 */
export const WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION = 1;

/** 应用层 payload 协议区间；`max` 是本仓库当前实现的版本。 */
export const WEB_REMOTE_CONTROL_APP_PROTOCOL_MIN_VERSION = 1;
/** v2：最近项目 / 打开项目 / 打开窗口 payload，以及 bootstrap-response 的新字段。 */
export const WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION = 2;

/** gateway 不在数据 socket 上发 ping，心跳由应用层每 15 秒发一次；45 秒没有入站帧即判定 channel 已死。 */
export const WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_INTERVAL_MS = 15_000;
export const WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS = 45_000;

/** 桌面等待 `hello` 的上限；超时直接关闭 channel。 */
export const WEB_REMOTE_CONTROL_CHANNEL_HELLO_TIMEOUT_MS = 10_000;

/** `close{superseded}` 的确认上限：收到 `close_ack` 或等满 2 秒后关闭旧 channel 数据连接。 */
export const WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS = 2_000;

/** 单帧物理上限沿用 (c) 层常量（1 MiB），超限帧由接收方丢弃并报告 raw fault。 */
export const WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES =
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes;

/** `clientInstanceId` 是不透明标识，做长度上限只是为了不接受无界字符串。 */
export const WEB_REMOTE_CONTROL_CHANNEL_CLIENT_INSTANCE_ID_MAX_CHARS = 256;

const WEB_REMOTE_CONTROL_CHANNEL_CLIENT_NAME_MAX_CHARS = 128;
const WEB_REMOTE_CONTROL_CHANNEL_APP_VERSION_MAX_CHARS = 64;
const WEB_REMOTE_CONTROL_CHANNEL_PING_ID_MAX_CHARS = 64;
const WEB_REMOTE_CONTROL_CHANNEL_OFFENDING_TYPE_MAX_CHARS = 128;

export const WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPES = [
  "hello",
  "hello_ack",
  "data",
  "ping",
  "pong",
  "close",
  "close_ack",
  "protocol_error",
] as const;
export type WebRemoteControlChannelFrameType =
  (typeof WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPES)[number];

const WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPE_SET = new Set<string>(
  WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPES,
);

export const WEB_REMOTE_CONTROL_CHANNEL_CLOSE_REASONS = [
  "superseded",
  "incompatible-version",
  "desktop-stopping",
  "client-leaving",
] as const;
export type WebRemoteControlChannelCloseReason =
  (typeof WEB_REMOTE_CONTROL_CHANNEL_CLOSE_REASONS)[number];

/** 协商失败时指明哪一端需要升级。 */
export const WEB_REMOTE_CONTROL_APP_PROTOCOL_UPGRADE_TARGETS = ["mobile", "desktop"] as const;
export type WebRemoteControlAppProtocolUpgradeTarget =
  (typeof WEB_REMOTE_CONTROL_APP_PROTOCOL_UPGRADE_TARGETS)[number];

/** 目前只有 `unsupported-version`；它只用于诊断，不是 `WebRemoteControlFailureReason`。 */
export const WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_ERROR_CODES = ["unsupported-version"] as const;
export type WebRemoteControlChannelProtocolErrorCode =
  (typeof WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_ERROR_CODES)[number];

export type WebRemoteControlAppProtocolRange = { min: number; max: number };

export const WEB_REMOTE_CONTROL_APP_PROTOCOL_RANGE: WebRemoteControlAppProtocolRange = {
  min: WEB_REMOTE_CONTROL_APP_PROTOCOL_MIN_VERSION,
  max: WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION,
};

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// 身份与版本字符串来自对端自报，先 trim 再校验：否则「  x  」和「x」会在两端算出不同的
// clientInstanceId，让同一部手机被判成新设备。
function createPeerStringSchema(maxChars: number) {
  return z.string().trim().min(1).max(maxChars);
}

const clientInstanceIdSchema = createPeerStringSchema(
  WEB_REMOTE_CONTROL_CHANNEL_CLIENT_INSTANCE_ID_MAX_CHARS,
);
const clientNameSchema = createPeerStringSchema(WEB_REMOTE_CONTROL_CHANNEL_CLIENT_NAME_MAX_CHARS);
const appVersionSchema = createPeerStringSchema(WEB_REMOTE_CONTROL_CHANNEL_APP_VERSION_MAX_CHARS);

export const webRemoteControlChannelAppProtocolRangeSchema = z
  .object({
    min: positiveSafeIntegerSchema,
    max: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.min > value.max) {
      context.addIssue({
        code: "custom",
        path: ["max"],
        message: "appProtocol max must not be smaller than min",
      });
    }
  });

export const webRemoteControlChannelHelloFrameSchema = z
  .object({
    type: z.literal("hello"),
    // protocolVersion 只做形状校验：版本不相等时调用方要能回 close{incompatible-version}，
    // 用 literal 校验会把「版本不兼容」退化成无法区分的 malformed。
    protocolVersion: positiveSafeIntegerSchema,
    appProtocol: webRemoteControlChannelAppProtocolRangeSchema,
    clientInstanceId: clientInstanceIdSchema,
    clientName: clientNameSchema,
    appVersion: appVersionSchema,
  })
  .strict();

export const webRemoteControlChannelHelloAckFrameSchema = z
  .object({
    type: z.literal("hello_ack"),
    appProtocol: positiveSafeIntegerSchema,
    desktopAppVersion: appVersionSchema,
  })
  .strict();

export const webRemoteControlChannelDataFrameSchema = z
  .object({
    type: z.literal("data"),
    // payload 的校验 owner 是应用层 schema，channel 层只保证信封严格。
    payload: z.unknown(),
    client_ts: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict();

export const webRemoteControlChannelPingFrameSchema = z
  .object({
    type: z.literal("ping"),
    id: z.string().min(1).max(WEB_REMOTE_CONTROL_CHANNEL_PING_ID_MAX_CHARS),
  })
  .strict();

export const webRemoteControlChannelPongFrameSchema = z
  .object({
    type: z.literal("pong"),
    id: z.string().min(1).max(WEB_REMOTE_CONTROL_CHANNEL_PING_ID_MAX_CHARS),
  })
  .strict();

export const webRemoteControlChannelCloseFrameSchema = z
  .object({
    type: z.literal("close"),
    reason: z.enum(WEB_REMOTE_CONTROL_CHANNEL_CLOSE_REASONS),
    upgrade: z.enum(WEB_REMOTE_CONTROL_APP_PROTOCOL_UPGRADE_TARGETS).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // `upgrade` 只属于 incompatible-version：缺了就不知道升级哪一端，多了说明对端实现有 bug。
    const upgradeRequired = value.reason === "incompatible-version";
    if (upgradeRequired === (value.upgrade !== undefined)) {
      return;
    }
    context.addIssue({
      code: "custom",
      path: ["upgrade"],
      message: upgradeRequired
        ? "upgrade is required for incompatible-version"
        : "upgrade is only allowed for incompatible-version",
    });
  });

export const webRemoteControlChannelCloseAckFrameSchema = z
  .object({ type: z.literal("close_ack") })
  .strict();

export const webRemoteControlChannelProtocolErrorFrameSchema = z
  .object({
    type: z.literal("protocol_error"),
    code: z.enum(WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_ERROR_CODES),
    offendingType: z
      .string()
      .min(1)
      .max(WEB_REMOTE_CONTROL_CHANNEL_OFFENDING_TYPE_MAX_CHARS)
      .optional(),
  })
  .strict();

export const webRemoteControlChannelFrameSchema = z.union([
  webRemoteControlChannelHelloFrameSchema,
  webRemoteControlChannelHelloAckFrameSchema,
  webRemoteControlChannelDataFrameSchema,
  webRemoteControlChannelPingFrameSchema,
  webRemoteControlChannelPongFrameSchema,
  webRemoteControlChannelCloseFrameSchema,
  webRemoteControlChannelCloseAckFrameSchema,
  webRemoteControlChannelProtocolErrorFrameSchema,
]);

export type WebRemoteControlChannelFrame = z.infer<typeof webRemoteControlChannelFrameSchema>;
/** 单帧类型，例如 `WebRemoteControlChannelFrameOf<"hello">`。 */
export type WebRemoteControlChannelFrameOf<T extends WebRemoteControlChannelFrameType> = Extract<
  WebRemoteControlChannelFrame,
  { type: T }
>;

export function isWebRemoteControlChannelFrameType(
  value: unknown,
): value is WebRemoteControlChannelFrameType {
  return typeof value === "string" && WEB_REMOTE_CONTROL_CHANNEL_FRAME_TYPE_SET.has(value);
}

/** 发送方构造 `data` 帧；payload 就是现有的 `WebRemoteControlAppPayload`。 */
export function createWebRemoteControlChannelDataFrame(
  payload: WebRemoteControlAppPayload,
  clientTs?: number,
): WebRemoteControlChannelFrameOf<"data"> {
  return { type: "data", payload, ...(clientTs === undefined ? {} : { client_ts: clientTs }) };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseWebRemoteControlChannelFrame(
  value: unknown,
): WebRemoteControlChannelFrame | null {
  const result = webRemoteControlChannelFrameSchema.safeParse(value);
  return result.success ? result.data : null;
}

export type WebRemoteControlChannelFrameDiscardReason = "malformed" | "oversize" | "unknown-type";

export type WebRemoteControlChannelFrameParseResult =
  | { kind: "accepted"; frame: WebRemoteControlChannelFrame; bytes: number }
  | {
      kind: "discarded";
      reason: WebRemoteControlChannelFrameDiscardReason;
      /** 超长帧在测量前就被挡下，这时不给字节数。 */
      bytes?: number;
      /** 只记录安全元数据：形如标识符的类型名，且长度有界。 */
      frameType?: string;
    };

/** 丢弃时只回安全元数据，绝不把帧内容（payload、路径）写进日志。 */
function readSafeFrameTypeLabel(value: string): string | undefined {
  return /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined;
}

/** 非法或缺失的配置值一律回落到协议常量，避免 0 或 NaN 让闸门失效。 */
function resolvePositiveFallback(configured: number | undefined, fallback: number): number {
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return fallback;
  }
  return Math.floor(configured);
}

export function parseWebRemoteControlChannelFrameJson(
  rawJson: string,
  options: { maxFrameBytes?: number } = {},
): WebRemoteControlChannelFrameParseResult {
  const maxFrameBytes = resolvePositiveFallback(
    options.maxFrameBytes,
    WEB_REMOTE_CONTROL_CHANNEL_MAX_FRAME_BYTES,
  );
  // UTF-8 字节数不会小于 UTF-16 code unit 数，先用便宜的长度闸挡掉明显超限的帧，避免为超长输入做测量。
  if (rawJson.length > maxFrameBytes) {
    return { kind: "discarded", reason: "oversize" };
  }
  const bytes = utf8Bytes(rawJson);
  if (bytes > maxFrameBytes) {
    return { kind: "discarded", reason: "oversize", bytes };
  }

  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return { kind: "discarded", reason: "malformed", bytes };
  }

  const rawFrameType =
    typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
  if (typeof rawFrameType !== "string") {
    return { kind: "discarded", reason: "malformed", bytes };
  }
  if (!isWebRemoteControlChannelFrameType(rawFrameType)) {
    const label = readSafeFrameTypeLabel(rawFrameType);
    return {
      kind: "discarded",
      reason: "unknown-type",
      bytes,
      ...(label === undefined ? {} : { frameType: label }),
    };
  }

  const frame = parseWebRemoteControlChannelFrame(value);
  if (!frame) {
    return { kind: "discarded", reason: "malformed", bytes, frameType: rawFrameType };
  }
  return { kind: "accepted", frame, bytes };
}

export function isWebRemoteControlChannelProtocolVersionSupported(
  protocolVersion: number,
): boolean {
  return protocolVersion === WEB_REMOTE_CONTROL_CHANNEL_PROTOCOL_VERSION;
}

export type WebRemoteControlAppProtocolNegotiationResult =
  | { ok: true; appProtocol: number }
  | { ok: false; upgrade: WebRemoteControlAppProtocolUpgradeTarget };

/**
 * 取两个区间的交集里最大的值；交集为空时按 spec 指明哪一端需要升级：
 * 手机 `max` 小于桌面 `min` 时升级手机，反之升级桌面。
 */
export function negotiateWebRemoteControlAppProtocol(
  desktop: WebRemoteControlAppProtocolRange,
  mobile: WebRemoteControlAppProtocolRange,
): WebRemoteControlAppProtocolNegotiationResult {
  const upper = Math.min(desktop.max, mobile.max);
  const lower = Math.max(desktop.min, mobile.min);
  if (upper >= lower) {
    return { ok: true, appProtocol: upper };
  }
  return { ok: false, upgrade: mobile.max < desktop.min ? "mobile" : "desktop" };
}

/** `lastInboundAtMs` 之后超过 45 秒没有任何入站帧就判定 channel 已死；时钟回拨不判死。 */
export function isWebRemoteControlChannelHeartbeatExpired(
  lastInboundAtMs: number,
  nowMs: number,
  timeoutMs: number = WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS,
): boolean {
  const timeout = resolvePositiveFallback(
    timeoutMs,
    WEB_REMOTE_CONTROL_CHANNEL_HEARTBEAT_TIMEOUT_MS,
  );
  if (!Number.isFinite(lastInboundAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return nowMs - lastInboundAtMs >= timeout;
}

/** 旧 channel 进入 closing 后，除 `close_ack` 外的入站帧一律丢弃（替换时序第 1 步）。 */
export function isWebRemoteControlChannelInboundFrameAllowedWhileClosing(
  frameType: WebRemoteControlChannelFrameType,
): boolean {
  return frameType === "close_ack";
}

/**
 * 替换时序第 4 步：收到旧手机的 `close_ack`，或等满 2 秒后关闭旧 channel 数据连接。
 * 旧版本对端会丢掉 `close_ack`，那时只能走超时分支。
 */
export function isWebRemoteControlChannelClosingFinished(options: {
  startedAtMs: number;
  closeAckAtMs?: number;
  nowMs: number;
  closeAckTimeoutMs?: number;
}): boolean {
  if (options.closeAckAtMs !== undefined) {
    return true;
  }
  const timeout = resolvePositiveFallback(
    options.closeAckTimeoutMs,
    WEB_REMOTE_CONTROL_CHANNEL_CLOSE_ACK_TIMEOUT_MS,
  );
  return options.nowMs - options.startedAtMs >= timeout;
}

export type WebRemoteControlAppPayloadType = WebRemoteControlAppPayload["zcode_type"];

export interface WebRemoteControlAppProtocolFeature {
  /** 引入该类型或字段的 appProtocol 版本。 */
  introducedIn: number;
  zcodeType: WebRemoteControlAppPayloadType;
  /**
   * 字段级条目才有；类型级条目省略。嵌套字段用点号表示（例如 `result.recentProjects`），
   * 顶层字段直接写字段名。
   */
  field?: string;
}

/**
 * 「类型和字段的引入版本」清单：类型级条目覆盖 `WebRemoteControlAppPayload` 的全部
 * `zcode_type`；字段级条目只在 appProtocol > 首个版本新增字段时登记，未登记的字段按所属类型的
 * 引入版本处理。单测保证清单与 `webRemoteControlAppPayloadSchema` 一致。
 */
export const WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES: readonly WebRemoteControlAppProtocolFeature[] =
  [
    { zcodeType: "telemetry-report", introducedIn: 1 },
    { zcodeType: "bootstrap-request", introducedIn: 1 },
    { zcodeType: "bootstrap-response", introducedIn: 1 },
    { zcodeType: "workspace-list-request", introducedIn: 1 },
    { zcodeType: "workspace-list-response", introducedIn: 1 },
    { zcodeType: "workspace-list-updated", introducedIn: 1 },
    // T2.4（appProtocol 2）：最近项目与打开请求。
    { zcodeType: "recent-projects-updated", introducedIn: 2 },
    { zcodeType: "workspace-open-request", introducedIn: 2 },
    { zcodeType: "workspace-open-response", introducedIn: 2 },
    { zcodeType: "desktop-window-open-request", introducedIn: 2 },
    { zcodeType: "desktop-window-open-response", introducedIn: 2 },
    // bootstrap-response 的新字段挂在 result 下；字段路径用点号表示嵌套。
    { zcodeType: "bootstrap-response", field: "result.desktopWindowState", introducedIn: 2 },
    { zcodeType: "bootstrap-response", field: "result.recentProjects", introducedIn: 2 },
    { zcodeType: "workspace-bridge-open", introducedIn: 1 },
    { zcodeType: "workspace-bridge-ready", introducedIn: 1 },
    { zcodeType: "workspace-bridge-error", introducedIn: 1 },
    { zcodeType: "workspace-reconnect-request", introducedIn: 1 },
    { zcodeType: "workspace-reconnect-response", introducedIn: 1 },
    { zcodeType: "mobile-view-state-update", introducedIn: 1 },
    { zcodeType: "platform-request", introducedIn: 1 },
    { zcodeType: "platform-response", introducedIn: 1 },
    { zcodeType: "rpc-frame", introducedIn: 1 },
    { zcodeType: "rpc-frame-ack", introducedIn: 1 },
    { zcodeType: "bridge-degraded", introducedIn: 1 },
    { zcodeType: "app-error", introducedIn: 1 },
    { zcodeType: "mobile-diagnostic", introducedIn: 1 },
  ];

/**
 * 类型或字段的引入版本。类型未登记时返回 null（由应用层 schema 丢弃，不属于版本闸门）；
 * 类型已登记而字段未登记，表示该字段随类型一起引入。发送方只在协商版本达到返回值时才写该字段。
 */
export function resolveWebRemoteControlAppProtocolVersion(
  zcodeType: string,
  field?: string,
  features: readonly WebRemoteControlAppProtocolFeature[] = WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES,
): number | null {
  const typeFeature = features.find(
    (entry) => entry.field === undefined && entry.zcodeType === zcodeType,
  );
  if (!typeFeature || field === undefined) {
    return typeFeature ? typeFeature.introducedIn : null;
  }
  const fieldFeature = features.find(
    (entry) => entry.zcodeType === zcodeType && entry.field === field,
  );
  return fieldFeature ? fieldFeature.introducedIn : typeFeature.introducedIn;
}

export type WebRemoteControlAppPayloadVersionGate =
  | { kind: "accepted" }
  | {
      kind: "unsupported-version";
      offendingType: string;
      offendingField?: string;
      /** 回给对端的诊断帧；按 spec 只记日志，不改变连接状态和页面。 */
      protocolError: WebRemoteControlChannelFrameOf<"protocol_error">;
    };

/** 按点号路径判断字段是否真的出现在 payload 里（用于 result.recentProjects 这类嵌套字段）。 */
function hasPayloadFieldPath(payload: unknown, fieldPath: string): boolean {
  let current: unknown = payload;
  for (const segment of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

/** 找出协商版本之外的已登记类型或字段；没有任何越界时返回 null。 */
function findUnsupportedAppProtocolFeature(
  payload: WebRemoteControlAppPayload,
  negotiatedAppProtocol: number,
  features: readonly WebRemoteControlAppProtocolFeature[],
): { zcodeType: string; field?: string } | null {
  const typeVersion = resolveWebRemoteControlAppProtocolVersion(
    payload.zcode_type,
    undefined,
    features,
  );
  if (typeVersion === null) {
    return null;
  }
  if (typeVersion > negotiatedAppProtocol) {
    return { zcodeType: payload.zcode_type };
  }
  for (const feature of features) {
    if (
      feature.field !== undefined &&
      feature.zcodeType === payload.zcode_type &&
      feature.introducedIn > negotiatedAppProtocol &&
      hasPayloadFieldPath(payload, feature.field)
    ) {
      return { zcodeType: payload.zcode_type, field: feature.field };
    }
  }
  return null;
}

export function gateWebRemoteControlAppPayloadVersion(
  payload: WebRemoteControlAppPayload,
  negotiatedAppProtocol: number,
  features: readonly WebRemoteControlAppProtocolFeature[] = WEB_REMOTE_CONTROL_APP_PROTOCOL_FEATURES,
): WebRemoteControlAppPayloadVersionGate {
  // 纯函数、不持有状态，所以只可能回诊断帧，不会改变连接状态或页面。
  const offending = findUnsupportedAppProtocolFeature(payload, negotiatedAppProtocol, features);
  if (!offending) {
    return { kind: "accepted" };
  }
  return {
    kind: "unsupported-version",
    offendingType: offending.zcodeType,
    ...(offending.field === undefined ? {} : { offendingField: offending.field }),
    protocolError: {
      type: "protocol_error",
      code: "unsupported-version",
      offendingType: offending.zcodeType,
    },
  };
}
