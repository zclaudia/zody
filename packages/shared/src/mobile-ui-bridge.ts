/**
 * 手机 Shell / Remote 原生桥契约（spec: specs/mobile-remote-ui-desktop-delivery.md 第 2、7、8 节；
 * M2-T1 交接要求见 docs/plans/mobile-ui-desktop-delivery/m2-android-dual-source.md）。
 *
 * 本文件只冻结 Android 注入到 WebView 的 JSON 线格式与严格运行时校验，供：
 * - Shell Web：读取/写入连接配置、读取 bridge 信息与诊断、调用 openRemote；
 * - Remote Web：从只读 session context 获取当前会话（M2-T2 接入）；
 * - Android：按同一份 schema 生成 JSON，不在原生侧另建字段来源。
 *
 * 唯一所有者（不得在页面侧另建第二条写入路径）：
 * - Gateway 地址、namespace、设备凭证、选中 backend、configRevision：Android 原生配置 store，
 *   由 `ZodyShellBridge` 读写；配置每次写入（含清除）必须递增 configRevision。
 * - `clientInstanceId`：由同一个原生配置 store 按 backendId 生成并持久化，作为桌面判定
 *   「同一部手机重连」的依据。它只经 `ZodyRemoteBridge.getSessionContext()` 只读提供给 Remote；
 *   Remote 页面不得通过通用 SecureStore 自行生成、读取或写入，Shell bridge 也不暴露该能力。
 * - sessionId / generation：Android `MobileShellController` 所有；Remote 的所有状态变更调用
 *   必须携带当前 sessionId。
 *
 * 线格式统一为 JSON 字符串：Android `@JavascriptInterface` 只暴露平铺方法，返回值是
 * `{ schemaVersion, ok: true, ... }` 或 `{ schemaVersion, ok: false, error: { code, message? } }`。
 * `code` 是稳定错误码，页面只能按 code 分支，不得解析 message。
 */
import { z } from "zod";
import {
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
  tryNormalizeRemoteAccessGatewayUrl,
} from "./remoteAccess.js";

/** bridge JSON 线格式版本；语义不兼容变化时递增。 */
export const MOBILE_UI_BRIDGE_SCHEMA_VERSION = 1;

/** 当前原生桥版本；additive capability 扩展保持 1，改变既有命令语义才递增。 */
export const MOBILE_UI_BRIDGE_VERSION = 1;

/** Shell 页面可见的原生对象名（Android `addJavascriptInterface`）。 */
export const MOBILE_UI_SHELL_BRIDGE_GLOBAL_KEY = "ZodyShellBridge";

/** Remote 页面可见的原生对象名。 */
export const MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY = "ZodyRemoteBridge";

/** Bridge v1 已知能力；未来可追加，未知能力必须被旧客户端忽略。 */
export const MOBILE_UI_BRIDGE_V1_CAPABILITIES = [
  "session-context",
  "file-save",
  "file-open",
  "notifications",
  "lifecycle",
] as const;

/** 稳定错误码；页面按 code 分支，message 仅用于诊断展示。 */
export const MOBILE_BRIDGE_ERROR_CODES = [
  "native-bridge-unavailable",
  "invalid-argument",
  "config-unavailable",
  "config-invalid",
  "config-revision-stale",
  "config-write-failed",
  "backend-not-found",
  "backend-remote-control-unsupported",
  "backend-ui-unsupported",
  "open-remote-failed",
  "session-context-invalid",
  "stale-session",
  "bridge-version-unsupported",
  "unsupported-capability",
] as const;

export type MobileBridgeErrorCode = (typeof MOBILE_BRIDGE_ERROR_CODES)[number];

const MAX_GATEWAY_URL_CHARS = 2048;
const MAX_NAMESPACE_CHARS = 128;
const MAX_CREDENTIAL_CHARS = 512;
const MAX_BACKEND_ID_CHARS = 256;
const MAX_SESSION_ID_CHARS = 256;
const MAX_CLIENT_INSTANCE_ID_CHARS = 256;
const MAX_APP_VERSION_CHARS = 64;
const MAX_ERROR_MESSAGE_CHARS = 512;
const MAX_CAPABILITY_CHARS = 64;
const MAX_CAPABILITIES = 32;

const appVersionSchema = z.string().trim().min(1).max(MAX_APP_VERSION_CHARS);
const backendIdSchema = z.string().trim().min(1).max(MAX_BACKEND_ID_CHARS);
/** 空串表示「尚未选择电脑」，与现有配置 store 的读取语义一致。 */
const optionalBackendIdSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  backendIdSchema.optional(),
);
const configRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

const gatewayUrlSchema = z.string().trim().min(1).max(MAX_GATEWAY_URL_CHARS);
const namespaceSchema = z.string().max(MAX_NAMESPACE_CHARS);
const credentialSchema = z.string().trim().min(1).max(MAX_CREDENTIAL_CHARS);

/** 设备凭证前缀；gateway 签发后由设置页输入。 */
export const MOBILE_UI_BRIDGE_CREDENTIAL_PREFIX = "zgd_";

function credentialSchemaWithPrefix() {
  return credentialSchema.refine(
    (value) => value.startsWith(MOBILE_UI_BRIDGE_CREDENTIAL_PREFIX),
    { message: `credential must start with ${MOBILE_UI_BRIDGE_CREDENTIAL_PREFIX}` },
  );
}

/** 持久化的连接配置；configRevision 由原生 store 维护，页面只读后原样回传。 */
export const mobileShellConfigSchema = z.strictObject({
  schemaVersion: z.literal(MOBILE_UI_BRIDGE_SCHEMA_VERSION),
  gatewayUrl: gatewayUrlSchema,
  namespace: namespaceSchema,
  credential: credentialSchemaWithPrefix(),
  backendId: optionalBackendIdSchema,
  configRevision: configRevisionSchema,
});

export type MobileShellConfig = z.infer<typeof mobileShellConfigSchema>;

/** 设置页提交的配置草稿；不带 configRevision，由原生写入时递增。 */
export const mobileShellConfigWriteSchema = z.strictObject({
  gatewayUrl: gatewayUrlSchema,
  namespace: namespaceSchema,
  credential: credentialSchemaWithPrefix(),
  backendId: optionalBackendIdSchema,
});

export type MobileShellConfigWrite = z.infer<typeof mobileShellConfigWriteSchema>;

/** Shell bridge 构建/调试能力；`allowsInsecureGatewayTransport` 仅 Debug APK 为 true。 */
export const mobileShellBridgeInfoSchema = z.strictObject({
  schemaVersion: z.literal(MOBILE_UI_BRIDGE_SCHEMA_VERSION),
  bridgeVersion: z.number().int().positive(),
  appVersion: appVersionSchema,
  allowsInsecureGatewayTransport: z.boolean(),
});

export type MobileShellBridgeInfo = z.infer<typeof mobileShellBridgeInfoSchema>;

/** Shell 连接诊断；不包含凭证、URL 原文或业务状态。 */
export const mobileShellDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(MOBILE_UI_BRIDGE_SCHEMA_VERSION),
  configRevision: configRevisionSchema,
  selectedBackendId: backendIdSchema.optional(),
  lastErrorCode: z.enum(MOBILE_BRIDGE_ERROR_CODES).optional(),
});

export type MobileShellDiagnostics = z.infer<typeof mobileShellDiagnosticsSchema>;

/**
 * Bridge 能力声明（spec 第 7 节）。
 * capabilities 只约束结构（非空、去重、有界），未知能力保留给 additive 扩展。
 */
export const mobileBridgeCapabilitySchema = z
  .string()
  .min(1)
  .max(MAX_CAPABILITY_CHARS)
  .regex(/^[a-z][a-z0-9-]*$/u, {
    message: "bridge capability must be lowercase kebab-case",
  });

export const mobileBridgeCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(MOBILE_UI_BRIDGE_SCHEMA_VERSION),
  bridgeVersion: z.number().int().positive(),
  appVersion: appVersionSchema,
  capabilities: z
    .array(mobileBridgeCapabilitySchema)
    .max(MAX_CAPABILITIES)
    .refine((values) => new Set(values).size === values.length, {
      message: "capabilities must not contain duplicates",
    }),
});

export type MobileBridgeCapabilities = z.infer<typeof mobileBridgeCapabilitiesSchema>;

/**
 * Remote 只读会话上下文（`ZodyRemoteBridge.getSessionContext()`）。
 * `clientInstanceId` 由原生配置 store 按 backendId 生成并持久化，Remote 不得再写。
 */
export const mobileSessionContextSchema = z.strictObject({
  schemaVersion: z.literal(MOBILE_UI_BRIDGE_SCHEMA_VERSION),
  sessionId: z.string().trim().min(1).max(MAX_SESSION_ID_CHARS),
  gatewayUrl: gatewayUrlSchema,
  namespace: z.string().trim().min(1).max(MAX_NAMESPACE_CHARS),
  backendId: backendIdSchema,
  credential: credentialSchemaWithPrefix(),
  clientInstanceId: z.string().trim().min(1).max(MAX_CLIENT_INSTANCE_ID_CHARS),
  appVersion: appVersionSchema,
  bridgeCapabilities: mobileBridgeCapabilitiesSchema,
});

export type MobileSessionContext = z.infer<typeof mobileSessionContextSchema>;

/** 稳定失败 envelope；所有 bridge 方法都可能返回它。 */
export const mobileBridgeFailureSchema = z.strictObject({
  schemaVersion: z.literal(MOBILE_UI_BRIDGE_SCHEMA_VERSION),
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum(MOBILE_BRIDGE_ERROR_CODES),
    message: z.string().max(MAX_ERROR_MESSAGE_CHARS).optional(),
  }),
});

export type MobileBridgeFailure = z.infer<typeof mobileBridgeFailureSchema>;

const mobileBridgeSuccessSchema = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({
    schemaVersion: z.literal(MOBILE_UI_BRIDGE_SCHEMA_VERSION),
    ok: z.literal(true),
    ...shape,
  });

export const mobileShellConfigReadResultSchema = z.discriminatedUnion("ok", [
  mobileBridgeSuccessSchema({ config: mobileShellConfigSchema.nullable() }),
  mobileBridgeFailureSchema,
]);

export const mobileShellConfigSaveResultSchema = z.discriminatedUnion("ok", [
  mobileBridgeSuccessSchema({ config: mobileShellConfigSchema }),
  mobileBridgeFailureSchema,
]);

export const mobileShellOperationResultSchema = z.discriminatedUnion("ok", [
  mobileBridgeSuccessSchema({}),
  mobileBridgeFailureSchema,
]);

export const mobileShellBridgeInfoResultSchema = z.discriminatedUnion("ok", [
  mobileBridgeSuccessSchema({ info: mobileShellBridgeInfoSchema }),
  mobileBridgeFailureSchema,
]);

export const mobileShellDiagnosticsResultSchema = z.discriminatedUnion("ok", [
  mobileBridgeSuccessSchema({ diagnostics: mobileShellDiagnosticsSchema }),
  mobileBridgeFailureSchema,
]);

export const mobileSessionContextReadResultSchema = z.discriminatedUnion("ok", [
  mobileBridgeSuccessSchema({ context: mobileSessionContextSchema }),
  mobileBridgeFailureSchema,
]);

export type MobileShellConfigReadResult = z.infer<typeof mobileShellConfigReadResultSchema>;
export type MobileShellConfigSaveResult = z.infer<typeof mobileShellConfigSaveResultSchema>;
export type MobileShellOperationResult = z.infer<typeof mobileShellOperationResultSchema>;
export type MobileShellBridgeInfoResult = z.infer<typeof mobileShellBridgeInfoResultSchema>;
export type MobileShellDiagnosticsResult = z.infer<typeof mobileShellDiagnosticsResultSchema>;
export type MobileSessionContextReadResult = z.infer<typeof mobileSessionContextReadResultSchema>;

export interface MobileShellConfigValidationOptions {
  /** 本地开发允许 http；release 构建要求 https。 */
  allowInsecureTransport: boolean;
}

function normalizeShellConfig(
  config: z.infer<typeof mobileShellConfigWriteSchema>,
  options: MobileShellConfigValidationOptions,
) {
  const endpoint = tryNormalizeRemoteAccessGatewayUrl(config.gatewayUrl, options);
  if (!endpoint) {
    return undefined;
  }
  return {
    gatewayUrl: endpoint.baseUrl,
    namespace: config.namespace.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE,
    credential: config.credential.trim(),
    ...(config.backendId ? { backendId: config.backendId } : {}),
  };
}

/** 严格解析持久配置；非法/明文 release 配置返回 undefined，由调用方 fail closed。 */
export function parseMobileShellConfig(
  input: unknown,
  options: MobileShellConfigValidationOptions,
): MobileShellConfig | undefined {
  const parsed = mobileShellConfigSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const normalized = normalizeShellConfig(parsed.data, options);
  return normalized
    ? { ...normalized, schemaVersion: MOBILE_UI_BRIDGE_SCHEMA_VERSION, configRevision: parsed.data.configRevision }
    : undefined;
}

/** 严格解析设置页草稿并归一化；失败返回 undefined。 */
export function parseMobileShellConfigWrite(
  input: unknown,
  options: MobileShellConfigValidationOptions,
): MobileShellConfigWrite | undefined {
  const parsed = mobileShellConfigWriteSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  return normalizeShellConfig(parsed.data, options);
}

/** 严格解析 session context；Remote 在启动业务 Channel 前必须调用并 fail closed。 */
export function parseMobileSessionContext(
  input: unknown,
  options: MobileShellConfigValidationOptions,
): MobileSessionContext | undefined {
  const parsed = mobileSessionContextSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const endpoint = tryNormalizeRemoteAccessGatewayUrl(parsed.data.gatewayUrl, options);
  if (!endpoint) {
    return undefined;
  }
  return {
    ...parsed.data,
    gatewayUrl: endpoint.baseUrl,
  };
}

/** 解析 Android 注入方法的 JSON 返回值；损坏 JSON 或 schema 不匹配都抛错。 */
export function parseMobileBridgeJson<T>(json: string, schema: z.ZodType<T>): T {
  if (typeof json !== "string") {
    throw new Error("Mobile bridge JSON must be a string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error("Invalid mobile bridge JSON: not a JSON document.", { cause: error });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid mobile bridge JSON: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Shell bridge 的 Android 注入面（`@JavascriptInterface` 平铺方法）。
 * 只负责配对配置，不含 Remote 文件、通知或业务能力。
 */
export interface MobileShellBridge {
  /** 返回 `MobileShellConfigReadResult` JSON。 */
  readConfig(): string;
  /** 入参 `MobileShellConfigWrite` JSON，返回 `MobileShellConfigSaveResult` JSON；写入递增 configRevision。 */
  saveConfig(inputJson: string): string;
  /** 清除配置并递增 configRevision，返回 `MobileShellOperationResult` JSON。 */
  clearConfig(): string;
  /** 校验 expectedConfigRevision 后导航到 Remote，返回 `MobileShellOperationResult` JSON。 */
  openRemote(backendId: string, expectedConfigRevision: number): string;
  /** 返回 `MobileShellBridgeInfoResult` JSON。 */
  getBridgeInfo(): string;
  /** 返回 `MobileShellDiagnosticsResult` JSON。 */
  getDiagnostics(): string;
}

/**
 * Remote bridge 的 Android 注入面。
 * 除只读 session context 外，所有会改变原生或远端状态的调用都带 sessionId。
 */
export interface MobileRemoteBridge {
  /** 返回 `MobileSessionContextReadResult` JSON。 */
  getSessionContext(): string;
  /** 当前 sessionId 不符时原生拒绝，不执行返回 Shell。 */
  returnShell(reason: string, sessionId: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function hasFunctions(value: Record<string, unknown>, methods: readonly string[]): boolean {
  return methods.every((method) => typeof value[method] === "function");
}

/** 从注入目标发现 Shell bridge；方法不全时按不可用处理，不尝试部分适配。 */
export function resolveMobileShellBridge(
  target: unknown = globalThis,
): MobileShellBridge | undefined {
  if (!isRecord(target)) {
    return undefined;
  }
  const bridge = target[MOBILE_UI_SHELL_BRIDGE_GLOBAL_KEY];
  if (!isRecord(bridge)) {
    return undefined;
  }
  return hasFunctions(bridge, [
    "readConfig",
    "saveConfig",
    "clearConfig",
    "openRemote",
    "getBridgeInfo",
    "getDiagnostics",
  ])
    ? (bridge as unknown as MobileShellBridge)
    : undefined;
}

/** 从注入目标发现 Remote bridge；方法不全时按不可用处理。 */
export function resolveMobileRemoteBridge(
  target: unknown = globalThis,
): MobileRemoteBridge | undefined {
  if (!isRecord(target)) {
    return undefined;
  }
  const bridge = target[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY];
  if (!isRecord(bridge)) {
    return undefined;
  }
  return hasFunctions(bridge, ["getSessionContext", "returnShell"])
    ? (bridge as unknown as MobileRemoteBridge)
    : undefined;
}
