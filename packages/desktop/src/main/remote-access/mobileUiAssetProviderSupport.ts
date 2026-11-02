import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MOBILE_UI_RELEASE_MANIFEST_FILE, MOBILE_UI_REMOTE_BASE_PATH } from "@zcode/shared";

/**
 * MobileUiAssetProvider 的纯辅助逻辑：URL → 制品路径映射、MIME、缓存头、CSP 与文件读取。
 *
 * 边界（spec 第 5 节）：
 * - 只认识 `/mobile-ui/release` 与 `${MOBILE_UI_REMOTE_BASE_PATH}` 两个前缀；
 * - 路径先 decode 再按段校验，最后用真实路径复查 root 包含性，绝不把任意路径拼进文件系统；
 * - 不读 settings、工作区、runtime snapshot，也不接触 Gateway 凭证。
 */

export const MOBILE_UI_RELEASE_ENDPOINT_PATH = "/mobile-ui/release";

/** 单次响应上限；超限直接 413，不能把超大文件整包读进内存。 */
export const DEFAULT_MOBILE_UI_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export const MOBILE_UI_CACHE_NO_STORE = "no-store";
export const MOBILE_UI_CACHE_NO_CACHE = "no-cache";
export const MOBILE_UI_CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

export type MobileUiAssetKind = "release" | "entry" | "immutable" | "revalidated";

export interface MobileUiAssetTarget {
  kind: MobileUiAssetKind;
  /** 相对 rootDir 的 POSIX 路径；读取前仍会再次做包含性校验。 */
  relativePath: string;
  contentType: string;
}

export type MobileUiPathResult =
  | { ok: true; target: MobileUiAssetTarget }
  | { ok: false; status: 404 };

export type MobileUiReadStatus = 403 | 404 | 413 | 500;

export type MobileUiAssetReadResult =
  | { ok: true; size: number; body?: Uint8Array }
  | { ok: false; status: MobileUiReadStatus };

export interface MobileUiSecurityContext {
  /** 当前 Gateway 的 HTTP(S) origin；只取 origin，不带路径、查询或凭证。 */
  gatewayHttpOrigin?: string;
  /** 当前 Gateway 的 WS(S) origin；未提供时会从 HTTP origin 推导。 */
  gatewayWsOrigin?: string;
}

const ALLOWED_CONTENT_TYPES = new Map<string, string>([
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["cjs", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["xml", "application/xml; charset=utf-8"],
  ["csv", "text/csv; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["avif", "image/avif"],
  ["ico", "image/x-icon"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["otf", "font/otf"],
  ["eot", "application/vnd.ms-fontobject"],
  ["bcmap", "application/octet-stream"],
  ["pfb", "application/octet-stream"],
  ["pdf", "application/pdf"],
  ["wasm", "application/wasm"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["ogv", "video/ogg"],
  ["vtt", "text/vtt; charset=utf-8"],
]);

/** Vite 默认把内容哈希拼在文件名的 `-` 或 `.` 之后；只有这种文件才允许 immutable。 */
const CONTENT_HASHED_FILE_PATTERN = /[.-][A-Za-z0-9_-]{8,64}\.[A-Za-z0-9]+$/;

/** 原始 URL 里出现编码斜杠/反斜杠/NUL 时一律拒绝，避免二次解码绕过分段检查。 */
const DANGEROUS_PERCENT_ESCAPE_PATTERN = /%(?:2f|5c|00)/i;

const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export function cacheControlForMobileUiAsset(kind: MobileUiAssetKind): string {
  switch (kind) {
    case "release":
    case "entry":
      return MOBILE_UI_CACHE_NO_STORE;
    case "immutable":
      return MOBILE_UI_CACHE_IMMUTABLE;
    case "revalidated":
      return MOBILE_UI_CACHE_NO_CACHE;
  }
}

/**
 * 把 Gateway 转交的请求路径映射到制品相对路径。
 *
 * 查询串被忽略（同一制品内容）；`#`、`//`、反斜杠、NUL、编码斜杠/反斜杠/NUL、
 * 点段、点文件和 Windows 盘符路径全部按 404 拒绝。
 */
export function parseMobileUiRequestPath(rawPath: string): MobileUiPathResult {
  if (typeof rawPath !== "string") {
    return rejectPath();
  }
  if (rawPath.includes("\\") || rawPath.includes("\0") || rawPath.includes("#")) {
    return rejectPath();
  }

  const queryIndex = rawPath.indexOf("?");
  const rawPathname = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  if (!rawPathname.startsWith("/") || rawPathname.includes("//")) {
    return rejectPath();
  }
  if (DANGEROUS_PERCENT_ESCAPE_PATTERN.test(rawPathname)) {
    return rejectPath();
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return rejectPath();
  }
  if (
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    pathname.includes("//") ||
    !pathname.startsWith("/")
  ) {
    return rejectPath();
  }

  if (pathname === MOBILE_UI_RELEASE_ENDPOINT_PATH) {
    return {
      ok: true,
      target: {
        kind: "release",
        relativePath: MOBILE_UI_RELEASE_MANIFEST_FILE,
        contentType: "application/json; charset=utf-8",
      },
    };
  }

  if (!pathname.startsWith(MOBILE_UI_REMOTE_BASE_PATH) || pathname.endsWith("/")) {
    return rejectPath();
  }
  const relativePath = pathname.slice(MOBILE_UI_REMOTE_BASE_PATH.length);
  // manifest 只能从 /mobile-ui/release 读取，避免同一文件出现第二条无缓存规则的路径。
  if (relativePath === "" || relativePath === MOBILE_UI_RELEASE_MANIFEST_FILE) {
    return rejectPath();
  }

  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return rejectPath();
    }
    // 点文件与 Windows 盘符/备用数据流都不属于发布制品。
    if (segment.startsWith(".") || segment.includes(":")) {
      return rejectPath();
    }
  }

  if (relativePath === "index.html") {
    return {
      ok: true,
      target: {
        kind: "entry",
        relativePath,
        contentType: "text/html; charset=utf-8",
      },
    };
  }

  const extension = extensionOf(relativePath);
  const contentType = extension ? ALLOWED_CONTENT_TYPES.get(extension) : undefined;
  if (!contentType) {
    return rejectPath();
  }
  const fileName = segments[segments.length - 1] ?? "";
  const immutable =
    relativePath.startsWith("assets/") && CONTENT_HASHED_FILE_PATTERN.test(fileName);
  return {
    ok: true,
    target: {
      kind: immutable ? "immutable" : "revalidated",
      relativePath,
      contentType,
    },
  };
}

/**
 * 异步读取制品文件。
 *
 * 安全顺序：词法包含检查 → lstat 拒绝符号链接/目录 → realpath 复查父目录没有逃逸 →
 * O_NOFOLLOW 打开 → fstat 再确认普通文件与大小上限。旧 hash 不存在就是 404，
 * 绝不按文件名回填当前版本。
 */
export async function readMobileUiAsset(input: {
  rootDir: string;
  relativePath: string;
  maxBytes: number;
  includeBody: boolean;
}): Promise<MobileUiAssetReadResult> {
  const segments = input.relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { ok: false, status: 404 };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(resolve(input.rootDir));
  } catch {
    return { ok: false, status: 404 };
  }

  const candidate = resolve(realRoot, ...segments);
  if (!isPathInside(realRoot, candidate)) {
    return { ok: false, status: 404 };
  }

  try {
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      return { ok: false, status: 404 };
    }

    // 父目录可能是符号链接；只有真实路径仍位于 root 内才继续。
    const canonicalPath = await realpath(candidate);
    if (!isPathInside(realRoot, canonicalPath)) {
      return { ok: false, status: 404 };
    }

    const handle = await open(canonicalPath, OPEN_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return { ok: false, status: 404 };
      }
      if (stat.size > input.maxBytes) {
        return { ok: false, status: 413 };
      }
      if (!input.includeBody) {
        return { ok: true, size: stat.size };
      }
      const body = await handle.readFile();
      if (body.byteLength > input.maxBytes) {
        return { ok: false, status: 413 };
      }
      return { ok: true, size: body.byteLength, body };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    return { ok: false, status: mapFileErrorStatus(error) };
  }
}

/**
 * CSP 只允许同源脚本与本应用需要的资源类型；connect-src 由调用方提供的当前 Gateway
 * HTTP/WS origin 组成，绝不拼接凭证、路径或通配脚本源。
 */
export function buildMobileUiContentSecurityPolicy(context?: MobileUiSecurityContext): string {
  const connectSources = new Set<string>(["'self'"]);
  const httpOrigin = normalizeOrigin(context?.gatewayHttpOrigin, ["http:", "https:"]);
  if (httpOrigin) {
    connectSources.add(httpOrigin);
    const derivedWsOrigin = deriveWebSocketOrigin(httpOrigin);
    if (derivedWsOrigin) {
      connectSources.add(derivedWsOrigin);
    }
  }
  const wsOrigin = normalizeOrigin(context?.gatewayWsOrigin, ["ws:", "wss:"]);
  if (wsOrigin) {
    connectSources.add(wsOrigin);
  }

  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function buildMobileUiSuccessHeaders(input: {
  kind: MobileUiAssetKind;
  contentType: string;
  contentLength: number;
  contentSecurityPolicy: string;
}): Record<string, string> {
  return {
    "Cache-Control": cacheControlForMobileUiAsset(input.kind),
    "Content-Type": input.contentType,
    "Content-Length": String(input.contentLength),
    "Content-Security-Policy": input.contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

export function buildMobileUiErrorHeaders(status: number): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": MOBILE_UI_CACHE_NO_STORE,
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff",
  };
  if (status === 405) {
    headers.Allow = "GET, HEAD";
  }
  return headers;
}

function rejectPath(): MobileUiPathResult {
  return { ok: false, status: 404 };
}

function extensionOf(relativePath: string): string | undefined {
  const lastSegment = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
    return undefined;
  }
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

function isPathInside(root: string, candidate: string): boolean {
  const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparableCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relativePath = relative(comparableRoot, comparableCandidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function mapFileErrorStatus(error: unknown): MobileUiReadStatus {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
    case "EISDIR":
    case "ELOOP":
      return 404;
    case "EACCES":
    case "EPERM":
      return 403;
    default:
      return 500;
  }
}

function normalizeOrigin(
  value: string | undefined,
  protocols: readonly string[],
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  // 凭证绝不进入 CSP；带 userinfo 的配置直接丢弃，由调用方保证传入纯 origin。
  if (parsed.username || parsed.password || !protocols.includes(parsed.protocol)) {
    return undefined;
  }
  return parsed.origin;
}

function deriveWebSocketOrigin(httpOrigin: string): string | undefined {
  const parsed = new URL(httpOrigin);
  if (parsed.protocol === "https:") {
    return `wss://${parsed.host}`;
  }
  if (parsed.protocol === "http:") {
    return `ws://${parsed.host}`;
  }
  return undefined;
}
