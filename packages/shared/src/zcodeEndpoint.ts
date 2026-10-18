import type { ZCodeEnv } from "./env.js";

/**
 * fork（F3.1）：默认端点为「未配置」。
 *
 * 空字符串是唯一未配置语义：消费方必须关闭对应远端能力或回落内置值，
 * 不得再默认指向官方地址。历史实现与 TEST_* 同址指向官方域名，
 * 导致未配置环境仍会向官方发请求（见 specs/fork-official-deps-removal-plan.md 3b）。
 */
export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = "";

/**
 * fork（F3.1）：测试环境占位端点。
 *
 * `example.invalid` 是 RFC 2606 保留域名，保证测试环境即使漏配也不会命中真实服务；
 * 真实的 fork 测试域由部署方通过 ZCODE_TEST_BASE_URL / ZCODE_BASE_URL 显式注入。
 */
export const TEST_ZCODE_ENDPOINT_ORIGIN = "https://example.invalid";

// fork（F4.11）：BigModel/OAuth/business 端点常量与解析函数（DEFAULT_BIGMODEL_API_ORIGIN、
// DEFAULT_ZAI_OAUTH_ORIGIN、DEFAULT_ZAI_BUSINESS_BASE_URL、ZAI_OAUTH_CLIENT_ID 及对应
// resolve/build 函数、RuntimeProductEndpointConfig）随官方账号体系删除。
// BYOK 的公开 API 地址（https://api.z.ai/api/anthropic、https://open.bigmodel.cn/api/anthropic
// 及标准 API 模板地址）在 config/provider/zcode-builtin.json 与 provider 配置中保留，不经过本文件。

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZCODE_BASE_URL?: string;
  ZCODE_ENDPOINT_ORIGIN?: string;
  ZCODE_TEST_BASE_URL?: string;
  ZCODE_PRODUCTION_BASE_URL?: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("ZCode endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ZCode endpoint origin must use http or https");
  }
  return parsed.origin;
}

export function resolveZCodeEndpointOrigin(options?: {
  env?: ZCodeEnv;
  envBaseOrigin?: string | null;
  overrideOrigin?: string | null;
}): string {
  const env = options?.env ?? "test";
  const envBaseOrigin = options?.envBaseOrigin?.trim();
  if (env === "production") {
    // fork（F3.1）：生产环境未显式配置时返回空（未配置），不再回落官方地址。
    return envBaseOrigin
      ? normalizeZCodeEndpointOrigin(envBaseOrigin)
      : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  }

  const overrideOrigin = options?.overrideOrigin?.trim();
  if (overrideOrigin) {
    return normalizeZCodeEndpointOrigin(overrideOrigin);
  }

  return envBaseOrigin ? normalizeZCodeEndpointOrigin(envBaseOrigin) : TEST_ZCODE_ENDPOINT_ORIGIN;
}

export function resolveRuntimeZCodeEnv(env: RuntimeZCodeEndpointEnv = {}): ZCodeEnv {
  // 独立 CLI / 服务测试未注入 ZCODE_ENV 时默认生产环境；桌面测试包会显式下发 ZCODE_ENV=test。
  // fork（F3.1）：「生产环境」只决定读取 ZCODE_PRODUCTION_BASE_URL，不再意味着官方地址；
  // 端点未配置时 resolveRuntimeZCodeEndpointOrigin 返回空字符串。
  return env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = {},
  options?: { overrideOrigin?: string | null },
): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedBaseOrigin =
    zcodeEnv === "production"
      ? readRuntimeEnvValue(env, "ZCODE_PRODUCTION_BASE_URL")
      : readRuntimeEnvValue(env, "ZCODE_TEST_BASE_URL");

  return resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin:
      readRuntimeEnvValue(env, "ZCODE_BASE_URL") ??
      readRuntimeEnvValue(env, "ZCODE_ENDPOINT_ORIGIN") ??
      scopedBaseOrigin,
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeApiUrl(env: RuntimeZCodeEndpointEnv = {}, path: string): string {
  const endpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);
  // fork（F3.1）：未配置端点时返回空字符串，消费方据此关闭远端能力；
  // 不能返回 `${""}${path}` 这类相对 URL（Node fetch 会直接抛 TypeError）。
  if (!endpointOrigin) {
    return "";
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${endpointOrigin}${normalizedPath}`;
}

export function rewriteZCodeEndpointUrl(
  input: string | URL,
  endpointOrigin: string,
  options: {
    /**
     * 要改写的源 origin。缺省使用 DEFAULT_ZCODE_ENDPOINT_ORIGIN。
     *
     * fork（F3.1）：DEFAULT 为空（未配置）时不做任何改写；需要改写构建期配置地址的
     * 调用方（例如遥测上报）必须显式传入自己的源 origin，不能再假设存在官方默认源。
     */
    sourceOrigin?: string;
  } = {},
): string | URL {
  const targetValue = endpointOrigin.trim();
  // 目标端点为「未配置」时保持原地址，避免拼出相对 URL。
  if (!targetValue) {
    return input;
  }
  const sourceValue = (options.sourceOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN).trim();
  // fork（F3.1）：没有显式源 origin 就没有可改写的默认地址。
  if (!sourceValue) {
    return input;
  }

  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  let sourceOrigin: string;
  try {
    parsed = new URL(originalUrl);
    sourceOrigin = new URL(sourceValue).origin;
  } catch {
    return input;
  }
  if (parsed.origin !== sourceOrigin) {
    return input;
  }

  const targetOrigin = normalizeZCodeEndpointOrigin(targetValue);
  if (targetOrigin === sourceOrigin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}
