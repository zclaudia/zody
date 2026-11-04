import { createHash } from "node:crypto";
import { join } from "node:path";

export function resolveZodyBuiltinClientPlatform(): string {
  const target = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${target}-${arch}`;
}

export interface ZodyBuiltinCachePathOptions {
  readonly environmentConfigRoot: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly zodyEndpointOrigin: string;
}

export interface ZodyBuiltinCachePaths {
  readonly activeFilePath: string;
  readonly controlFilePath: string;
}

/** 按平台与 App 版本隔离 Active/LKG；路径本身就是兼容范围。 */
export function resolveZodyBuiltinCachePaths(
  options: ZodyBuiltinCachePathOptions,
): ZodyBuiltinCachePaths {
  const platform = normalizeSegment(options.platform, "platform");
  const appVersion = normalizeSegment(options.appVersion, "appVersion");
  const endpointKey = createZodyBuiltinEndpointKey(options.zodyEndpointOrigin);
  const directory = join(
    options.environmentConfigRoot,
    "runtime",
    "provider",
    platform,
    appVersion,
    endpointKey,
  );
  return {
    activeFilePath: join(directory, "zody-builtin.json"),
    controlFilePath: join(directory, "zcode-builtin-refresh.json"),
  };
}

/**
 * fork（F3.1）：端点未配置时的稳定缓存目录名。
 * 不再为「未配置」伪造官方 origin；该目录只读取随包/本地缓存，远端刷新在调用方关闭。
 */
const ZCODE_BUILTIN_UNCONFIGURED_ENDPOINT_KEY = "endpoint-unconfigured";

/** 将 ZCode 控制面 Origin 规范化后映射为安全、稳定且碰撞风险可忽略的缓存路径段。 */
export function createZodyBuiltinEndpointKey(zodyEndpointOrigin: string): string {
  const trimmed = zodyEndpointOrigin.trim();
  // fork（F3.1）：未配置端点不再回落官方地址，使用固定目录保证缓存隔离且可稳定读取。
  if (!trimmed) {
    return ZCODE_BUILTIN_UNCONFIGURED_ENDPOINT_KEY;
  }
  const normalized = normalizeZodyBuiltinEndpointOrigin(trimmed);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `endpoint-${digest}`;
}

export function normalizeZodyBuiltinEndpointOrigin(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("ZCode Built-in Endpoint Origin 不能为空");
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ZCode Built-in Endpoint Origin 只支持 HTTP(S)");
  }
  return url.origin;
}

function normalizeSegment(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new Error(`ZCode Built-in ${name} 不是合法路径段`);
  }
  return normalized;
}
