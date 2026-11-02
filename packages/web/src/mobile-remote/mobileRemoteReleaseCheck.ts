import {
  safeParseMobileUiReleaseManifest,
  type MobileSessionContext,
  type MobileUiReleaseManifest,
} from "@zcode/shared";

/**
 * Remote 启动期的发布清单校验（spec 第 4.2、9.1、10 节）。
 *
 * M2-T2 只做一次启动校验：release manifest 的 `supportedBridgeVersions` 不含当前
 * `ZodyRemoteBridge` 版本时，必须在创建业务 Channel 前停在页面上提示升级 APK。
 * 后续发布轮询、刷新 guard 和二次确认属于 M3，不在本模块内实现。
 *
 * 路径边界：
 * - 生产构建从 Remote 固定 origin 请求 `/mobile-ui/release`，由 Android `RemoteUiProxy`
 *   转为 Gateway `/api/proxy/<backendId>/mobile-ui/release` 并注入 Bearer；
 * - 开发构建没有原生代理，才直接向 Gateway 代理路径请求，凭证只放在 Authorization 头，
 *   不写 URL、日志或 Web Storage。
 */

export const MOBILE_REMOTE_RELEASE_ENDPOINT_PATH = "/mobile-ui/release";
export const MOBILE_REMOTE_RELEASE_REQUEST_TIMEOUT_MS = 10_000;

const GATEWAY_PROXY_PATH_PREFIX = "/api/proxy/";

export type MobileRemoteReleaseCheckResult =
  | { kind: "compatible"; manifest: MobileUiReleaseManifest }
  | {
      kind: "upgrade-required";
      bridgeVersion: number;
      supportedBridgeVersions: readonly number[];
    }
  | {
      kind: "unavailable";
      reason: "release-url-unavailable" | "network-error" | "http-error" | "invalid-manifest";
    };

export interface CheckMobileRemoteReleaseOptions {
  context: Pick<
    MobileSessionContext,
    "gatewayUrl" | "backendId" | "credential" | "bridgeCapabilities"
  >;
  isProduction?: boolean;
  /**
   * 生产构建的 Remote origin；缺省取 `globalThis.location.origin`。
   * 测试注入固定 origin，不访问真实 Gateway。
   */
  origin?: string;
  fetcher?: typeof fetch;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

/** 生产走固定 origin 的同源代理；开发模式直接走 Gateway 的 `/api/proxy`。 */
export function resolveMobileRemoteReleaseRequestUrl(
  options: Pick<CheckMobileRemoteReleaseOptions, "context" | "isProduction" | "origin">,
): string | undefined {
  const isProduction = options.isProduction ?? import.meta.env.PROD;
  if (isProduction) {
    const origin = trimTrailingSlashes(
      options.origin ?? globalThis.location?.origin ?? "",
    );
    return origin ? `${origin}${MOBILE_REMOTE_RELEASE_ENDPOINT_PATH}` : undefined;
  }
  return `${trimTrailingSlashes(options.context.gatewayUrl)}${GATEWAY_PROXY_PATH_PREFIX}${encodeURIComponent(options.context.backendId)}${MOBILE_REMOTE_RELEASE_ENDPOINT_PATH}`;
}

/**
 * 启动业务 Channel 前调用。网络/HTTP/schema 失败统一返回 `unavailable`，由调用方回到
 * Shell 或显示可重试错误；只有 manifest 明确不支持当前 bridgeVersion 时才要求升级 APK。
 */
export async function checkMobileRemoteRelease(
  options: CheckMobileRemoteReleaseOptions,
): Promise<MobileRemoteReleaseCheckResult> {
  const url = resolveMobileRemoteReleaseRequestUrl(options);
  if (!url) {
    return { kind: "unavailable", reason: "release-url-unavailable" };
  }
  const isProduction = options.isProduction ?? import.meta.env.PROD;
  const headers: Record<string, string> = { accept: "application/json" };
  if (!isProduction) {
    // 生产由原生代理注入 Bearer；开发模式直接请求 Gateway，凭证只出现在请求头。
    headers.authorization = `Bearer ${options.context.credential}`;
  }

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(MOBILE_REMOTE_RELEASE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable", reason: "network-error" };
  }
  if (!response.ok) {
    return { kind: "unavailable", reason: "http-error" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "unavailable", reason: "invalid-manifest" };
  }
  const parsed = safeParseMobileUiReleaseManifest(payload);
  if (!parsed.success) {
    return { kind: "unavailable", reason: "invalid-manifest" };
  }
  const bridgeVersion = options.context.bridgeCapabilities.bridgeVersion;
  if (!parsed.data.supportedBridgeVersions.includes(bridgeVersion)) {
    return {
      kind: "upgrade-required",
      bridgeVersion,
      supportedBridgeVersions: parsed.data.supportedBridgeVersions,
    };
  }
  return { kind: "compatible", manifest: parsed.data };
}
