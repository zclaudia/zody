// MCP Port - Model Context Protocol adapter boundary

import type { McpServerFailureKind } from "@zody/shared";
import type {
  McpAppsMetaKeyDirection,
  McpAppsMetaKeyPair,
  McpAppsToolVisibility,
  McpToolUiDescriptor,
} from "@zody/shared/mcp-apps";
import type { JsonSchema } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";

export type McpServerTransportType = "stdio" | "http" | "sse";
export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";
export type McpServerIsolation = "session" | "workspace";

/** 公共 MCP 配置校验完成后由宿主附加的运行时来源。 */
export interface McpServerRuntimeSource {
  kind: "builtin" | "plugin";
}

export interface McpServerConfigBase {
  enabled?: boolean;
  isolation?: McpServerIsolation;
  protocolVersion?: McpProtocolVersion;
  /** 仅限宿主生成，公共配置 schema 会拒绝该字段。 */
  source?: McpServerRuntimeSource;
  timeoutMs?: number;
}

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

// fork（F4.6）：ZCodeOfficialMcpAuthConfig / McpOfficialProvenance 随官方 MCP
// 鉴权链删除，stdio/http 配置不再接受 auth/official 字段。

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export type McpServerStatusKind =
  | "connecting"
  | "connected"
  | "disabled"
  | "disconnected"
  | "failed"
  | "untrusted";

export interface McpServerStatus {
  status: McpServerStatusKind;
  transport: McpServerTransportType;
  toolCount: number;
  updatedAt: string;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  protocolEra?: "legacy" | "modern";
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * CLI 私有 MCP wire 键的双命名空间定义（规则见 `specs/zody-rename-plugin-wire.md` §1.3）。
 *
 * 旧字面值是 manifest 的 explicit-retention 条目，**只登记、不改写、不删除**；新规范值统一走
 * `zody/*` / `zody.cua/*` / `com.zody/*`。CLI contracts 是 zod v3、shared 是 zod v4，不能复用
 * shared 的 schema 与解析实现；这里按 R50 的同一规则手写常量镜像与同语义解析器
 * （`readZodyMcpMetaEntry`），由 `contracts/tests/tool-result-metadata.test.ts` 与
 * `core/tests/mcp-ui-display.test.ts` 双侧 fixture 锁定，不反向 import shared 实现函数。
 */
export const ZODY_MCP_ERROR_PRESENTATION_META_KEY = "zcode/errorPresentation";
export const ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL = "zody/errorPresentation";
export const ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY = "message-only";
/** MCP content 中来自模型显式 tab.screenshot() 的 image block 索引。 */
export const ZODY_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY =
  "zcode/browserScreenshotContentIndices";
export const ZODY_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY_CANONICAL =
  "zody/browserScreenshotContentIndices";
/**
 * 本次 node_repl cell 操作的目标应用身份，供工具卡显示 App 图标。
 *
 * **只能由 node-repl-host 写入**：宿主的 CUA bridge 从 broker 响应里读 producer 的
 * `zcode.cua/app-associations-v1`（canonical `zody.cua/app-associations-v1` 同属 producer 键），
 * 投影成这里的最小形态。producer 那个键本身经 `nodeRepl.setResponseMeta` /
 * `nodeRepl.emitStructuredResult` 也能到达 `_meta`，而这两个 API 挂在模型可见的 sandbox
 * globals 上，因此不可信、必须在宿主侧丢弃（同
 * `ZODY_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY` 的处置）。
 */
export const ZODY_MCP_NODE_REPL_CUA_APP_META_KEY = "zcode/nodeReplCuaApp";
export const ZODY_MCP_NODE_REPL_CUA_APP_META_KEY_CANONICAL = "zody/nodeReplCuaApp";
/** node-repl 请求上下文键：由可信宿主从真实调用上下文生成，插件/模型传入的同名键不是权限来源。 */
export const ZODY_MCP_REQUEST_CONTEXT_META_KEY = "com.zcode/request-context";
export const ZODY_MCP_REQUEST_CONTEXT_META_KEY_CANONICAL = "com.zody/request-context";

const zodyMcpMetaKeyPair = (
  canonical: string,
  legacy: string,
  direction: McpAppsMetaKeyDirection,
  failClosed: boolean,
): McpAppsMetaKeyPair => ({ canonical, legacy, direction, failClosed });

/**
 * CLI 侧 `_meta` 键对注册表（R50 `MCP_APPS_META_KEY_COMPAT` 的同语义镜像）。
 * `failClosed` 只对“冲突即不得授予身份/权限”的键为 true；其余键冲突时只丢弃该字段，
 * 整条工具结果照常保留（spec §2.3）。
 */
export const ZODY_MCP_META_KEY_COMPAT = {
  requestContext: zodyMcpMetaKeyPair(
    ZODY_MCP_REQUEST_CONTEXT_META_KEY_CANONICAL,
    ZODY_MCP_REQUEST_CONTEXT_META_KEY,
    "bidirectional",
    true,
  ),
  errorPresentation: zodyMcpMetaKeyPair(
    ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL,
    ZODY_MCP_ERROR_PRESENTATION_META_KEY,
    "inbound",
    false,
  ),
  browserScreenshotContentIndices: zodyMcpMetaKeyPair(
    ZODY_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY_CANONICAL,
    ZODY_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
    "bidirectional",
    false,
  ),
  nodeReplCuaApp: zodyMcpMetaKeyPair(
    ZODY_MCP_NODE_REPL_CUA_APP_META_KEY_CANONICAL,
    ZODY_MCP_NODE_REPL_CUA_APP_META_KEY,
    "bidirectional",
    false,
  ),
} as const satisfies Record<string, McpAppsMetaKeyPair>;

/** 双键读取结果：`conflict` 由调用边界拒绝应用该字段；纯函数不 throw。 */
export type ZodyMcpMetaEntryRead<T> =
  | { status: "absent" }
  | { status: "accepted"; value: T; source: "canonical" | "legacy" | "both" }
  | {
      status: "conflict";
      canonicalKey: string;
      legacyKey: string;
      canonical: unknown;
      legacy: unknown;
    };

/**
 * 双键读取（R50 spec §2 的同语义 CLI 镜像）：单键按原 schema 校验，非法视作未声明；
 * 双键各自归一化后相等才接受，任一不可用或不等即 `conflict`。不做“新键优先”，也不 throw。
 */
export function readZodyMcpMetaEntry<T>(
  meta: unknown,
  pair: McpAppsMetaKeyPair,
  parse: (value: unknown) => T | null,
): ZodyMcpMetaEntryRead<T> {
  const root = asMetaRecord(meta);
  if (!root) return { status: "absent" };
  const hasCanonical = hasOwnMetaKey(root, pair.canonical);
  const hasLegacy = hasOwnMetaKey(root, pair.legacy);
  if (!hasCanonical && !hasLegacy) return { status: "absent" };
  const canonical = hasCanonical ? parse(root[pair.canonical]) : null;
  const legacy = hasLegacy ? parse(root[pair.legacy]) : null;
  if (hasCanonical && hasLegacy) {
    if (canonical === null || legacy === null || !jsonEquals(canonical, legacy)) {
      return {
        status: "conflict",
        canonicalKey: pair.canonical,
        legacyKey: pair.legacy,
        canonical: root[pair.canonical],
        legacy: root[pair.legacy],
      };
    }
    return { status: "accepted", value: canonical, source: "both" };
  }
  if (hasCanonical) {
    return canonical === null
      ? { status: "absent" }
      : { status: "accepted", value: canonical, source: "canonical" };
  }
  return legacy === null
    ? { status: "absent" }
    : { status: "accepted", value: legacy, source: "legacy" };
}

/**
 * 出站双表示：同一份冻结快照同时写入 canonical 与 legacy 两个键，且两键引用同一对象
 * （spec §4：禁止两次独立序列化产生内容分叉）。
 */
export function buildZodyMcpDualMetaEntry(
  pair: McpAppsMetaKeyPair,
  value: unknown,
): Record<string, unknown> {
  return { [pair.canonical]: value, [pair.legacy]: value };
}

function asMetaRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// contracts 的 tsconfig 未显式抬高 target/lib，用 hasOwnProperty.call 而不是 Object.hasOwn。
function hasOwnMetaKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** 归一化值比较：按键排序的 JSON 文本，对象字面量顺序不影响等值判定。 */
function jsonEquals(left: unknown, right: unknown): boolean {
  return normalizedJson(left) === normalizedJson(right);
}

function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${normalizedJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
// fork（F4.6）：ZCODE_MCP_SERVER_REQUEST_ID_META_KEY 只由官方 MCP 响应头写入，随链删除。

export interface McpToolDescriptor {
  serverName: string;
  toolName: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  /**
   * 工具对谁开放（`_meta.ui.visibility`，缺省 `["model", "app"]`），与是否带 UI 资源无关。
   * 不含 "model" 的工具不进 provider contracts；不含 "app" 的工具拒绝 `mcp/uiCallTool`。
   * 由 adapter 归一化写入；缺省（旧 descriptor）时以 `ui.visibility` 兜底，再缺省视为两者都可见。
   */
  visibility?: McpAppsToolVisibility[];
  /**
   * 工具 `_meta` 归一化后的插件 UI 呈现描述。
   * 只有声明了合法 `ui://` resourceUri 的工具才有；其中的 visibility 与上面的字段同源。
   */
  ui?: McpToolUiDescriptor;
}

/** 可见性判定的唯一实现：descriptor.visibility → ui.visibility → 两者都可见。 */
export function resolveMcpToolVisibility(
  descriptor: Pick<McpToolDescriptor, "visibility" | "ui">,
): McpAppsToolVisibility[] {
  return descriptor.visibility ?? descriptor.ui?.visibility ?? ["model", "app"];
}

export type McpContentBlock = Record<string, unknown>;

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceRequest {
  serverName: string;
  uri: string;
  trace?: TraceContext;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

/** `resources/list` / `resources/templates/list`（分页游标原样透传）。 */
export interface McpListResourcesRequest {
  serverName: string;
  cursor?: string;
  trace?: TraceContext;
}
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface McpListResourcesResult {
  resources: McpResourceDescriptor[];
  nextCursor?: string;
}
export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface McpListResourceTemplatesResult {
  resourceTemplates: McpResourceTemplateDescriptor[];
  nextCursor?: string;
}
/**
 * 资源订阅。`subscriberKey` 由调用方给出（bootstrap 用 sessionId|scopeId|generation），
 * 登记表在连接层按 (serverName, uri) 计数：0→1 才真调 SDK subscribe，1→0 才 unsubscribe；断连重连后按登记表重放。
 */
export interface McpResourceSubscriptionRequest {
  serverName: string;
  uri: string;
  subscriberKey: string;
  trace?: TraceContext;
}
/** server 没有声明 `capabilities.resources.subscribe` 时抛出（协议层映射为 -32001 not_supported）。 */
export class McpResourceSubscribeUnsupportedError extends Error {
  readonly code = "not_supported" as const;
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} does not support resource subscriptions`);
    this.name = "McpResourceSubscribeUnsupportedError";
  }
}

/** server → client 通知，adapter 转成宿主可消费的形状；订阅类通知带当前登记的 subscriberKey。 */
export type McpServerNotification =
  | { kind: "resourceUpdated"; serverName: string; uri: string; subscribers: string[] }
  | { kind: "resourceListChanged"; serverName: string; subscribers: string[] }
  | { kind: "toolListChanged"; serverName: string }
  | { kind: "loggingMessage"; serverName: string; level: string; logger?: string; data: unknown };
export interface McpNotificationPort {
  onNotification(notification: McpServerNotification): void;
}

export interface McpConnectionSnapshot {
  statuses: Record<string, McpServerStatus>;
  tools: McpToolDescriptor[];
}

export interface McpConnectOptions {
  /**
   * authorization_code OAuth callback 的等待上限。
   * 普通 MCP timeoutMs 只约束协议请求，session 启动需要单独限制 OAuth 授权等待。
   */
  oauthAuthorizationTimeoutMs?: number;
  /**
   * 复用既有连接前先校验其存活性（见 McpPort.pingServer），已死则重连。
   * 设置页刷新这类"用户明确要求重新探测"的调用必须置位；session 启动不需要，
   * 复用池中刚建立的连接即可。
   */
  revalidate?: boolean;
  signal?: AbortSignal;
  trace?: TraceContext;
  workingDirectory?: string;
  /** 身份隔离使用 workspaceIdentity；本地缺省时才 fallback 到 workingDirectory。 */
  workspaceIdentity?: string;
}

export interface McpCallToolRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  trace?: TraceContext;
  /** 调用来源；宿主 MCP 可据此限制不能安全继承到 subagent 的能力。 */
  runtimeScope?: "main" | "subagent";
  /** 请求上下文仅用于 shared-host 隔离，不改变 MCP tool 参数。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: string;
  deliveryKind?: string;
  turnId?: string;
}

/** MCP `notifications/progress`（A8）：progress 单调递增，total 可缺省；adapter 原样转发，不做节流。 */
export interface McpToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallToolOptions {
  /** 页面写操作固定此连接；禁止恢复或重新授权后自动重放。 */
  appConnection?: { identity: string; generation: number };
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 收到服务端进度通知时回调；SDK 侧同时以 resetTimeoutOnProgress 让每次进度重置超时。 */
  onProgress?: (progress: McpToolCallProgress) => void;
}

/** 工具级 `_meta.timeoutMs` 的允许区间：低于下限视为非法丢弃，高于上限截到上限。 */
export const MCP_TOOL_META_TIMEOUT_MIN_MS = 1_000;
export const MCP_TOOL_META_TIMEOUT_MAX_MS = 30 * 60 * 1_000;

// fork（F4.6）：OfficialMcpAuthFailureReason / OfficialMcpAuthHeadersPort /
// OfficialMcpTrustedOriginRegistry 随官方 MCP 鉴权链删除。

/** MCP elicitation（server → client `elicitation/create`）交给宿主提问的端口。 */
export interface McpElicitationTrace {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  traceId?: string;
}
export interface McpElicitationRequest {
  serverName: string;
  message: string;
  requestedSchema: unknown;
  /** 发起 elicitation 时该 server 正在执行的工具调用；没有则无法归属会话，端口应拒绝。 */
  trace?: McpElicitationTrace;
}
export interface McpElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export interface McpElicitationPort {
  requestElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult>;
}

export interface McpPort {
  /** 可信配置派生的稳定来源与现有连接代际。断线时不签发新页面凭证。 */
  onAppConnectionInvalidated?(serverName: string, listener: () => void): () => void;
  appConnectionSnapshot?(serverName: string): { identity: string; generation: number } | null;
  /**
   * 等待本会话已租用的 server 的既有连接任务，再返回连接快照。
   * 只读既有租约：未租用、已释放或连接失败时返回 null，不新建连接、不重新 initialize。
   * 首开屏障使用（见 `docs/plugin-ui-connection-readiness.md`）。
   */
  waitForAppConnection?(
    serverName: string,
  ): Promise<{ identity: string; generation: number } | null>;

  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  /**
   * 主动探测连接是否仍然存活，返回 false 表示 transport 已断。
   * HTTP/SSE MCP 被停掉时不会派发 onclose，status() 会长期停在 connected；
   * 只有显式 ping 才能把这种"无声死亡"暴露出来。实现可选：未实现时调用方按存活处理。
   */
  pingServer?(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  status(): Promise<Record<string, McpServerStatus>>;
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * 自端口创建以来收到 `notifications/tools/list_changed` 的累计次数。
   * runtime 在回合开始前比较该值，变了才重新 listTools 并重注册；未实现表示端口不会主动变化。
   */
  toolListRevision?(): number;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  /**
   * 读取 MCP 资源（插件 UI 的 `ui://` HTML）。与 pingServer 同样可选：mock port 不必实现，
   * 调用方缺失时按"不支持资源"处理。实现必须与 callTool 共用同一连接与重连路径。
   */
  readResource?(
    request: McpReadResourceRequest,
    options?: McpCallToolOptions,
  ): Promise<McpReadResourceResult>;
  /** 资源列表与订阅；缺省表示该端口不支持（协议层回 -32001）。 */
  listResources?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourcesResult>;
  listResourceTemplates?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourceTemplatesResult>;
  subscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  unsubscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  /** 删除 subscriberKey 以 prefix 开头的全部登记（会话关闭）；返回真正向 server 退订的 uri 数。 */
  unsubscribeResourcesBySubscriber?(subscriberKeyPrefix: string): Promise<number>;
  close(): Promise<void>;
}
