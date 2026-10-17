import { z } from "zod";
import type { WebRemoteControlStatus } from "./web-remote-control.js";

/**
 * App 级远程访问（手机远控改走 zclaudia-gateway，方案见 specs/mobile-remote-control-via-gateway.md）。
 *
 * 这里只存非敏感配置：开关、gateway 地址与 namespace。backend 凭证（`zgb_`）存在桌面 Main
 * 的凭据服务里，不进 settings 文件、不进日志，renderer 只能读到「是否已配置」。
 */

/** namespace 默认值；设备凭证的 discovery 接口不返回 namespace，手机设置页可编辑。 */
export const DEFAULT_REMOTE_ACCESS_NAMESPACE = "zcode";

/** 归一化后的 gateway 端点，桌面 Main 与手机页面都从这里取地址。 */
export interface RemoteAccessGatewayEndpoint {
  /** 交给 SDK 的 HTTP(S) 基地址，已去掉尾部斜杠。 */
  baseUrl: string;
  /** 由 baseUrl 推导的 WebSocket 基地址：https→wss、http→ws。 */
  wsBaseUrl: string;
}

export interface RemoteAccessGatewayUrlOptions {
  /**
   * 是否允许非加密传输。默认 false：release 构建要求 https（方案「地址归一化」）。
   * 只有本地开发运行形态（`IPlatformService.isLocalDevelopmentRuntime`）才传 true。
   */
  allowInsecureTransport?: boolean;
}

function isSecureGatewayBaseUrl(baseUrl: string): boolean {
  return baseUrl.startsWith("https://");
}

/**
 * 解析 gateway 地址：去尾部斜杠、统一成 http(s) 形式并推导 ws/wss 基地址。
 * 不接受空值、相对地址、非 http(s)/ws(s) 协议、带凭据的地址以及查询串/片段
 * （后几项写进设置或日志都没有意义，只会掩盖配置错误）。
 */
function parseRemoteAccessGatewayEndpoint(value: string): RemoteAccessGatewayEndpoint | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  // 允许直接粘贴 gateway 的 ws 地址（文档里的控制连接形式），统一归一成 http(s)。
  const protocol =
    parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? "https:"
      : parsed.protocol === "http:" || parsed.protocol === "ws:"
        ? "http:"
        : undefined;
  if (!protocol) {
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return undefined;
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  return {
    baseUrl: `${protocol}//${parsed.host}${path}`,
    wsBaseUrl: `${protocol === "https:" ? "wss:" : "ws:"}//${parsed.host}${path}`,
  };
}

/** 同 `normalizeRemoteAccessGatewayUrl`，但用 undefined 表示地址不可用，供读取/校验分支复用。 */
export function tryNormalizeRemoteAccessGatewayUrl(
  value: string,
  options?: RemoteAccessGatewayUrlOptions,
): RemoteAccessGatewayEndpoint | undefined {
  const endpoint = parseRemoteAccessGatewayEndpoint(value);
  if (!endpoint) {
    return undefined;
  }
  if (!options?.allowInsecureTransport && !isSecureGatewayBaseUrl(endpoint.baseUrl)) {
    return undefined;
  }
  return endpoint;
}

/**
 * 归一化 gateway 地址，失败时抛错（设置页表单校验与 Main 建连前校验用）。
 * 传输要求由调用方按运行形态传入：release 构建不允许 http。
 */
export function normalizeRemoteAccessGatewayUrl(
  value: string,
  options?: RemoteAccessGatewayUrlOptions,
): RemoteAccessGatewayEndpoint {
  const endpoint = parseRemoteAccessGatewayEndpoint(value);
  if (!endpoint) {
    throw new Error(
      "Remote access gateway URL must be an absolute http(s) address without credentials, query or fragment",
    );
  }
  if (!options?.allowInsecureTransport && !isSecureGatewayBaseUrl(endpoint.baseUrl)) {
    throw new Error("Remote access gateway URL must use https outside local development");
  }
  return endpoint;
}

/** 地址字段的归一化主体：空串是「未配置」；非空则必须是合法 gateway 地址。 */
const remoteAccessGatewayUrlBaseSchema = z.string().transform((value, context) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const endpoint = parseRemoteAccessGatewayEndpoint(trimmed);
  if (!endpoint) {
    context.addIssue({
      code: "custom",
      message: "Remote access gateway URL must be an absolute http(s) address",
    });
    return z.NEVER;
  }
  return endpoint.baseUrl;
});

/** 写入（patch）用：非法地址直接拒绝，合法地址落盘成归一化形式。 */
const remoteAccessGatewayUrlSettingSchema = remoteAccessGatewayUrlBaseSchema;

const remoteAccessNamespaceSettingSchema = z
  .string()
  .transform((value) => value.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE);

/**
 * 读取用：坏值按「未配置」处理。单个坏字段不能让整份 setting.json 被判定为损坏
 * （settings 读取失败会退回默认值，代价远高于丢一个地址），设置页表单自己保留草稿。
 */
const remoteAccessGatewayUrlStoredSchema = remoteAccessGatewayUrlBaseSchema.catch("");

/** 读取用：缺失或非字符串的 namespace 按默认值处理。 */
const remoteAccessNamespaceStoredSchema = remoteAccessNamespaceSettingSchema.catch(
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
);

/**
 * 读文件时使用的 schema：字段级容错，缺失或坏值都按默认值处理。
 * `.strict()` 不用于读取：旧版本或手写配置里的多余字段要能被丢弃，而不是让设置读不出来。
 */
export const remoteAccessSettingsSchema = z.object({
  /** 总开关；关闭时桌面不与 gateway 保持 backend 连接，手机侧看到这台电脑离线。 */
  enabled: z.boolean().catch(false),
  /** gateway 地址；空串表示未配置，开关打开也只进入 error(unconfigured)。 */
  gatewayUrl: remoteAccessGatewayUrlStoredSchema,
  /** gateway namespace；空值按默认值处理。 */
  namespace: remoteAccessNamespaceStoredSchema,
});

/**
 * 写入用的 schema：三个字段必须一次给全。
 * settings 更新是浅合并（`{...current, ...patch}`），允许局部对象会把没带的字段悄悄清空；
 * `.strict()` 同时保证凭证之类的字段不可能被写进 settings 文件。
 */
export const remoteAccessSettingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    gatewayUrl: remoteAccessGatewayUrlSettingSchema,
    namespace: remoteAccessNamespaceSettingSchema,
  })
  .strict();

/** 桌面设置里的远程访问配置；`gatewayUrl` 为空串表示尚未配置。 */
export type RemoteAccessSettings = z.infer<typeof remoteAccessSettingsSchema>;

/**
 * gateway backend 连接状态（T3.2 的 `RemoteGatewayBackend` 是唯一所有者）。
 *
 * 取值与方案「桌面侧状态」一致：`disabled | connecting | online | error(...)`。
 * 错误原因只保留 UI 需要区分的四种；其余 SDK 错误码（`HANDSHAKE_TIMEOUT`、`PROTOCOL_ERROR` 等）
 * 一律归入 `unreachable`，由 Main 的日志保留原始 `code`。
 */
export type RemoteAccessGatewayConnectionErrorReason =
  | "unconfigured"
  | "credential-invalid"
  | "replaced"
  | "unreachable";

export type RemoteAccessGatewayConnectionStatus =
  | { state: "disabled" }
  | { state: "connecting" }
  | { state: "online"; backendId?: string; epoch?: number }
  | { state: "error"; reason: RemoteAccessGatewayConnectionErrorReason };

/**
 * App 级远程访问状态（T2.3 起，T3.2 扩展 gateway 连接状态）。
 *
 * 远控 runtime 从「每个窗口一个」改为「全 App 一个」，所以状态查询和状态广播都不再携带
 * windowId。`status` 与旧窗口级 `WebRemoteControlStatus` 同构，方便现有 UI 过渡；
 * `gateway` 描述桌面到 gateway 的 backend 连接，与手机上看到的是否在线一致。
 */
export interface RemoteAccessStatus {
  /** `AppSettings.remoteAccess.enabled` 的当前值（Main 是唯一写入方）。 */
  enabled: boolean;
  /** App 级远控 runtime 状态；`idle` 表示当前没有运行中的远控会话。 */
  status: WebRemoteControlStatus;
  /** gateway backend 连接状态；关闭远程访问时为 `disabled`。 */
  gateway: RemoteAccessGatewayConnectionStatus;
}
