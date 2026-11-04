import type { HttpHandler, HttpServeRequest, HttpServeResponse } from "@zclaudia/gateway-backend";
import { resolve } from "node:path";
import {
  DEFAULT_MOBILE_UI_MAX_RESPONSE_BYTES,
  buildMobileUiContentSecurityPolicy,
  buildMobileUiErrorHeaders,
  buildMobileUiSuccessHeaders,
  parseMobileUiRequestPath,
  readMobileUiAsset,
  type MobileUiSecurityContext,
} from "./mobileUiAssetProviderSupport.js";

export type { MobileUiSecurityContext } from "./mobileUiAssetProviderSupport.js";

export interface MobileUiAssetProviderLogger {
  debug?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
}

export type MobileUiSecurityContextResolver = () =>
  | MobileUiSecurityContext
  | undefined
  | Promise<MobileUiSecurityContext | undefined>;

export interface MobileUiAssetProviderOptions {
  /** 移动 UI 制品根目录（开发态 dist-mobile-remote / 打包态 resources/mobile-web）。 */
  rootDir: string;
  /** 每次请求读取当前 Gateway HTTP/WS origin；不得返回凭证。 */
  resolveSecurityContext?: MobileUiSecurityContextResolver;
  logger?: MobileUiAssetProviderLogger;
  /** 覆盖响应上限，主要用于测试；生产使用支持模块中的默认值。 */
  maxResponseBytes?: number;
}

/**
 * 桌面 MobileUiAssetProvider（spec 第 5 节）。
 *
 * 只读、无业务状态：把 Gateway HTTP-over-channel 转交的 GET/HEAD 请求映射到随桌面交付的
 * Remote 制品。它不 import Host、runtime、Repo 或 Service 实现，也不保存 task/session、
 * 快照或凭证；`resolveSecurityContext` 只用于生成 CSP 的 connect-src origin。
 *
 * 路由：
 * - `GET/HEAD /mobile-ui/release` → `release.json`（no-store）
 * - `GET/HEAD /assets/remote/index.html` → 入口 HTML（no-store）
 * - `GET/HEAD /assets/remote/assets/<hash>.<ext>` → immutable
 * - `GET/HEAD /assets/remote/<其它允许资源>` → no-cache
 * - 其它方法/路径 → 405/404，且 `Cache-Control: no-store`
 */
export function createMobileUiAssetProvider(options: MobileUiAssetProviderOptions): HttpHandler {
  const rootDir = resolve(options.rootDir);
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MOBILE_UI_MAX_RESPONSE_BYTES;
  const logger = options.logger;

  return async (request: HttpServeRequest): Promise<HttpServeResponse> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405);
    }
    if ((request.body?.byteLength ?? 0) > 0) {
      // GET/HEAD 不允许携带 body；网关代理只转发无 body 的只读请求。
      return errorResponse(400);
    }

    const parsed = parseMobileUiRequestPath(request.path);
    if (!parsed.ok) {
      return errorResponse(parsed.status);
    }

    const result = await readMobileUiAsset({
      rootDir,
      relativePath: parsed.target.relativePath,
      maxBytes,
      includeBody: request.method === "GET",
    });
    if (!result.ok) {
      if (parsed.target.kind === "immutable" && result.status === 404) {
        // 旧内容哈希缺失必须留下可诊断记录；但绝不能回填当前版本文件。
        logger?.warn?.("[mobile-ui] immutable asset not found", parsed.target.relativePath);
      } else {
        logger?.debug?.("[mobile-ui] asset request rejected", {
          path: parsed.target.relativePath,
          status: result.status,
        });
      }
      return errorResponse(result.status);
    }

    const securityContext = await resolveSecurityContext(options.resolveSecurityContext, logger);
    const headers = buildMobileUiSuccessHeaders({
      kind: parsed.target.kind,
      contentType: parsed.target.contentType,
      contentLength: result.size,
      contentSecurityPolicy: buildMobileUiContentSecurityPolicy(securityContext),
    });

    return {
      status: 200,
      headers,
      ...(request.method === "GET" && result.body !== undefined ? { body: result.body } : {}),
    };
  };
}

function errorResponse(status: number): HttpServeResponse {
  return {
    status,
    headers: buildMobileUiErrorHeaders(status),
  };
}

async function resolveSecurityContext(
  resolver: MobileUiSecurityContextResolver | undefined,
  logger: MobileUiAssetProviderLogger | undefined,
): Promise<MobileUiSecurityContext | undefined> {
  if (!resolver) {
    return undefined;
  }
  try {
    return await resolver();
  } catch {
    // CSP 上下文是旁路信息：读取失败时退回 `connect-src 'self'`，不能让整页 500。
    // 不记录异常对象，避免意外带出含凭证的 URL。
    logger?.warn?.("[mobile-ui] security context resolver failed");
    return undefined;
  }
}
