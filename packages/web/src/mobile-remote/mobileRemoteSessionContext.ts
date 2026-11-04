import {
  MOBILE_UI_BRIDGE_VERSION,
  mobileSessionContextReadResultSchema,
  parseMobileBridgeJson,
  parseMobileSessionContext,
  resolveMobileRemoteBridge,
  type MobileBridgeErrorCode,
  type MobileRemoteBridge,
  type MobileSessionContext,
} from "@zcode/shared";

/**
 * Remote 页面的只读会话上下文入口（spec 第 7、8、9.1 节）。
 *
 * Remote 启动时唯一允许的数据来源是 `ZodyRemoteBridge.getSessionContext()`：
 * - Gateway、namespace、backendId、credential、clientInstanceId、sessionId 和 bridge
 *   capabilities 都由 Android 原生配置 store / MobileShellController 提供；
 * - 页面不再读取 SecureStore、URL 参数或 localStorage，也没有任何写回配置的路径；
 * - JSON 损坏、schema 不匹配、bridge 版本不兼容或缺少 `session-context` 能力时必须
 *   fail closed，不能带着部分字段继续启动业务 Channel。
 */

/**
 * Debug APK 的增量能力位：允许当前会话使用 HTTP Gateway。
 *
 * Release 构建始终要求 HTTPS；Android `ZodyRemoteBridge` 只在 Debug 构建声明该能力，
 * 页面不从 URL 或旧桥单独探测调试开关（spec 第 6.1 节「Debug 明文规则不变」）。
 */
export const MOBILE_REMOTE_INSECURE_GATEWAY_TRANSPORT_CAPABILITY =
  "insecure-gateway-transport";

const MOBILE_REMOTE_SESSION_CONTEXT_CAPABILITY = "session-context";

/** 稳定失败；调用方按 `code` 分支，不解析 message，也不把凭证写进错误。 */
export class MobileRemoteSessionContextError extends Error {
  readonly code: MobileBridgeErrorCode;

  constructor(code: MobileBridgeErrorCode, message?: string, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = "MobileRemoteSessionContextError";
    this.code = code;
  }
}

export interface MobileRemoteSession {
  bridge: MobileRemoteBridge;
  context: MobileSessionContext;
  /** 由 bridge capability 决定；Release 构建没有该能力时固定为 false。 */
  allowInsecureTransport: boolean;
}

export interface ReadMobileRemoteSessionContextOptions {
  /** 测试/集成注入；缺省从 `globalThis.ZodyRemoteBridge` 发现。 */
  bridge?: MobileRemoteBridge;
  /** 注入点；默认 `globalThis`。 */
  target?: unknown;
  /** 注入生产标志，缺省使用 `import.meta.env.PROD`。 */
  isProduction?: boolean;
  /** 测试显式覆盖；生产代码只由 capability 推导。 */
  allowInsecureTransport?: boolean;
}

/** Debug 能力位只能放宽到 HTTP；Release 构建始终 HTTPS。 */
export function resolveMobileRemoteAllowInsecureTransport(input: {
  capabilities: readonly string[];
  isProduction: boolean;
}): boolean {
  return (
    !input.isProduction ||
    input.capabilities.includes(MOBILE_REMOTE_INSECURE_GATEWAY_TRANSPORT_CAPABILITY)
  );
}

/**
 * 读取并严格校验当前会话。任何异常都转成稳定错误码，避免把原生 message 或凭证带进页面。
 */
export function readMobileRemoteSessionContext(
  options: ReadMobileRemoteSessionContextOptions = {},
): MobileRemoteSession {
  const bridge =
    options.bridge ?? resolveMobileRemoteBridge(options.target ?? globalThis);
  if (!bridge) {
    throw new MobileRemoteSessionContextError(
      "native-bridge-unavailable",
      "ZodyRemoteBridge is not available.",
    );
  }

  let json: string;
  try {
    json = bridge.getSessionContext();
  } catch (error) {
    throw new MobileRemoteSessionContextError(
      "session-context-invalid",
      "ZodyRemoteBridge.getSessionContext() failed.",
      { cause: error },
    );
  }

  let result;
  try {
    result = parseMobileBridgeJson(json, mobileSessionContextReadResultSchema);
  } catch (error) {
    throw new MobileRemoteSessionContextError(
      "session-context-invalid",
      "Invalid mobile session context JSON.",
      { cause: error },
    );
  }
  if (!result.ok) {
    throw new MobileRemoteSessionContextError(
      result.error.code,
      result.error.message ?? result.error.code,
    );
  }

  const isProduction = options.isProduction ?? import.meta.env.PROD;
  const allowInsecureTransport =
    options.allowInsecureTransport ??
    resolveMobileRemoteAllowInsecureTransport({
      capabilities: result.context.bridgeCapabilities.capabilities,
      isProduction,
    });
  const context = parseMobileSessionContext(result.context, {
    allowInsecureTransport,
  });
  if (!context) {
    throw new MobileRemoteSessionContextError(
      "session-context-invalid",
      "The mobile session context is not a valid Gateway configuration.",
    );
  }

  const { bridgeVersion, capabilities } = context.bridgeCapabilities;
  if (bridgeVersion !== MOBILE_UI_BRIDGE_VERSION) {
    throw new MobileRemoteSessionContextError(
      "bridge-version-unsupported",
      `Unsupported bridge version ${bridgeVersion}.`,
    );
  }
  if (!capabilities.includes(MOBILE_REMOTE_SESSION_CONTEXT_CAPABILITY)) {
    throw new MobileRemoteSessionContextError(
      "unsupported-capability",
      "The native bridge does not declare session-context.",
    );
  }

  return { bridge, context, allowInsecureTransport };
}

/** 通知等异步结果回到页面时只允许写回创建它的 backend。 */
export function isMobileRemoteSessionBackend(
  context: Pick<MobileSessionContext, "backendId">,
  backendId: string,
): boolean {
  return context.backendId === backendId;
}
