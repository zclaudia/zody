import { isWebRemoteControlThemeSeed, type WebRemoteControlThemeSeed } from "@zcode/shared";

/**
 * 手机端 gateway 连接配置（T3.4 的过渡注入点）。
 *
 * 产品规则（方案「产品规则 · 手机」）要求首次使用在设置页填写 gateway 地址、namespace 和 `zgd_`
 * 设备凭证，并保存到 Android 原生安全存储。该设置页属于 T4.2，本任务只提供 transport 需要的
 * 配置对象，并允许浏览器开发模式（`pnpm dev:mobile-remote`）通过 URL 参数注入：
 *
 *   ?gateway=https://gateway.example&namespace=zcode&credential=zgd_…&backend=<backendId>
 *   &client_id=<stable-id>&app_version=…&theme=…
 *
 * `clientInstanceId` 按 `backendId` 持久化在 localStorage，仅用于浏览器开发模式；T4.2/T6.2 会把
 * 配置与凭证迁移到原生安全存储，届时删除这里的 URL 与 localStorage 路径。凭证只来自用户输入，
 * 不写入日志。
 */

/** 方案「Gateway 使用约定」：namespace 默认 `zcode`，设置页可修改。 */
export const WEB_REMOTE_CONTROL_GATEWAY_DEFAULT_NAMESPACE = "zcode";

export interface WebRemoteControlGatewayBootstrapConfig {
  gatewayUrl: string;
  namespace: string;
  credential: string;
  backendId: string;
  clientInstanceId: string;
  clientName?: string;
  appVersion?: string;
  theme?: WebRemoteControlThemeSeed;
}

function readParam(params: URLSearchParams, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function createClientInstanceId(backendId: string): string {
  const storageKey = `zcode-mobile-remote-client-id:${backendId}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      return existing;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    globalThis.localStorage?.setItem(storageKey, nextId);
    return nextId;
  } catch {
    // 隐私模式/无 localStorage 时仍允许当前页面连接；刷新后会生成新的 clientInstanceId。
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  }
}

export function resolveWebRemoteControlGatewayBootstrapConfig(
  params: URLSearchParams,
): WebRemoteControlGatewayBootstrapConfig | null {
  const gatewayUrl = readParam(params, "gateway", "gateway_url");
  const credential = readParam(params, "credential", "zgd");
  const backendId = readParam(params, "backend", "backend_id");
  if (!gatewayUrl || !credential || !backendId) {
    return null;
  }
  const theme = readParam(params, "theme");
  const appVersion = readParam(params, "app_version");
  const clientName = readParam(params, "name");
  const explicitClientInstanceId = readParam(params, "client_id");
  return {
    gatewayUrl,
    namespace: readParam(params, "namespace") ?? WEB_REMOTE_CONTROL_GATEWAY_DEFAULT_NAMESPACE,
    credential,
    backendId,
    clientInstanceId: explicitClientInstanceId ?? createClientInstanceId(backendId),
    ...(clientName ? { clientName } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(isWebRemoteControlThemeSeed(theme) ? { theme } : {}),
  };
}
