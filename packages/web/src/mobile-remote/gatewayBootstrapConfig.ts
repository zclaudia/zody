import {
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
  isWebRemoteControlThemeSeed,
  type WebRemoteControlThemeSeed,
} from "@zcode/shared";
import type { MobileRemoteGatewayConfig } from "./mobileRemoteConfigStore.js";

/**
 * 手机端 gateway 连接配置的 URL 注入点（仅开发模式）。
 *
 * 产品路径是设置页 + `IPlatformService.secureStore`（`mobileRemoteConfigStore.ts`）；
 * 浏览器开发模式（`pnpm dev:mobile-remote`）仍允许用 URL 参数快速进入：
 *
 *   ?gateway=https://gateway.example&namespace=zcode&credential=zgd_…&backend=<backendId>
 *   &theme=…
 *
 * release 构建不允许把凭证放进地址栏：调用方只在 `import.meta.env.DEV` 时解析这些参数，
 * 正式入口只读安全存储。
 */

/** 方案「Gateway 使用约定」：namespace 默认 `zcode`，设置页可修改。 */
export const WEB_REMOTE_CONTROL_GATEWAY_DEFAULT_NAMESPACE = DEFAULT_REMOTE_ACCESS_NAMESPACE;

function readParam(params: URLSearchParams, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** 从 URL 参数读取开发模式配置；字段不全时返回 null。 */
export function resolveWebRemoteControlGatewayBootstrapConfig(
  params: URLSearchParams,
): MobileRemoteGatewayConfig | null {
  const gatewayUrl = readParam(params, "gateway", "gateway_url");
  const credential = readParam(params, "credential", "zgd");
  const backendId = readParam(params, "backend", "backend_id");
  if (!gatewayUrl || !credential || !backendId) {
    return null;
  }
  return {
    gatewayUrl,
    namespace: readParam(params, "namespace") ?? WEB_REMOTE_CONTROL_GATEWAY_DEFAULT_NAMESPACE,
    credential,
    backendId,
  };
}

/** 主题只影响首屏配色，开发模式允许用 URL 覆盖；正式入口沿用页面预热结果。 */
export function resolveWebRemoteControlThemeFromSearchParams(
  params: URLSearchParams,
): WebRemoteControlThemeSeed | undefined {
  const theme = readParam(params, "theme");
  return isWebRemoteControlThemeSeed(theme) ? theme : undefined;
}
