import { ZCODE_VERSION, type ZodyEnv } from "@zody/shared";

declare const __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: readonly string[] | undefined;

const TEST_REMOTE_CDN_RELEASE_ROOT = "http://intranet.example.invalid:12345/ssh-remote-assets";

export interface ResolveRemoteCdnOptions {
  env?: ZodyEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

/**
 * 解析 remote runtime 制品的 CDN 根列表。
 *
 * 修复原因：上游在未注入构建期 CDN 根时回落到上游自有的国内/海外 CDN 默认地址，
 * Zody 无权访问这些地址，且发布制品并不在其上；远程部署实际走 local-only 资源
 * （见 desktopRuntimeEnv.resolveRemoteAssetDirs）。因此未配置时返回空列表，
 * 只有构建期显式注入 `CDN_DOMAIN`/`OSS_PATH_PREFIX` 或调用方覆盖基址时才使用 CDN。
 */
export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const overrideBaseUrl = options.overrideBaseUrl?.trim();
  if (overrideBaseUrl) {
    return [normalizeBaseUrl(overrideBaseUrl)];
  }

  const version = options.version ?? ZCODE_VERSION;

  if (options.env === "test") {
    return [`${TEST_REMOTE_CDN_RELEASE_ROOT}/${version}`];
  }

  const configuredReleaseRoots =
    typeof __ZCODE_REMOTE_CDN_RELEASE_ROOTS__ === "undefined"
      ? []
      : __ZCODE_REMOTE_CDN_RELEASE_ROOTS__;
  // 构建期按 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 注入有序列表，切换时只改 CI 变量。
  return configuredReleaseRoots.map((releaseRoot) => `${normalizeBaseUrl(releaseRoot)}/${version}`);
}

export function resolvePrimaryRemoteCdnBaseUrl(
  options: ResolveRemoteCdnOptions = {},
): string | undefined {
  return resolveRemoteCdnBaseUrls(options)[0];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
