import {
  MOBILE_UI_RELEASE_ID_PATTERN,
  MOBILE_UI_RELEASE_META_NAME,
  safeParseMobileUiReleaseManifest,
  type MobileUiReleaseManifest,
} from "@zody/shared";
import {
  MOBILE_REMOTE_RELEASE_REQUEST_TIMEOUT_MS,
  resolveMobileRemoteReleaseRequestUrl,
  type CheckMobileRemoteReleaseOptions,
} from "./mobileRemoteReleaseCheck.js";

/**
 * Remote 发布检测的 DTO 适配（spec 第 9.3、10、11 M3 节）。
 *
 * 本模块把 HTTP 结果收敛成控制器可分支的稳定 observation，不保存任何状态：
 * - 只有 200 + M1 严格 manifest 才是可比较的发布事实；
 * - 401/403、429、5xx、网络错误、无效 manifest 都是 failed；控制器据此保留当前文档；
 * - 请求路径与开发/生产凭证规则复用 M2-T2 的唯一实现，不另建第二条 URL 规则；
 * - 不记录凭证、URL 原文或响应正文。
 *
 * 发布轮询、二次确认和 reload 决策属于 `mobileUiReleaseController.ts`。
 */

export type MobileUiReleaseFailureReason =
  | "release-url-unavailable"
  | "network-error"
  | "login-invalid"
  | "rate-limited"
  | "server-error"
  | "http-error"
  | "invalid-manifest";

export type MobileUiReleaseObservation =
  | { kind: "observed"; manifest: MobileUiReleaseManifest }
  | { kind: "failed"; reason: MobileUiReleaseFailureReason; status?: number };

export interface FetchMobileUiReleaseObservationOptions {
  context: CheckMobileRemoteReleaseOptions["context"];
  isProduction?: boolean;
  /** 生产构建的 Remote origin；缺省取 `globalThis.location.origin`。 */
  origin?: string;
  fetcher?: typeof fetch;
}

function mapHttpFailure(status: number): MobileUiReleaseObservation {
  if (status === 401 || status === 403) {
    return { kind: "failed", reason: "login-invalid", status };
  }
  if (status === 429) {
    return { kind: "failed", reason: "rate-limited", status };
  }
  if (status >= 500) {
    return { kind: "failed", reason: "server-error", status };
  }
  return { kind: "failed", reason: "http-error", status };
}

/** 读取一次发布清单；任何异常都转成 `failed`，不抛出到轮询计时器。 */
export async function fetchMobileUiReleaseObservation(
  options: FetchMobileUiReleaseObservationOptions,
): Promise<MobileUiReleaseObservation> {
  const url = resolveMobileRemoteReleaseRequestUrl({
    context: options.context,
    ...(options.isProduction === undefined ? {} : { isProduction: options.isProduction }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  if (!url) {
    return { kind: "failed", reason: "release-url-unavailable" };
  }

  const isProduction = options.isProduction ?? import.meta.env.PROD;
  const headers: Record<string, string> = { accept: "application/json" };
  if (!isProduction) {
    // 生产由原生代理注入 Bearer；开发模式凭证只出现在请求头。
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
    return { kind: "failed", reason: "network-error" };
  }

  if (!response.ok) {
    return mapHttpFailure(response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "failed", reason: "invalid-manifest" };
  }
  const parsed = safeParseMobileUiReleaseManifest(payload);
  if (!parsed.success) {
    return { kind: "failed", reason: "invalid-manifest" };
  }
  return { kind: "observed", manifest: parsed.data };
}

/** 只认识 HTML 中 M1 注入的 24 位小写十六进制 meta；非法/缺失返回 undefined。 */
export function readMobileUiReleaseMetaReleaseId(
  documentLike: Pick<Document, "querySelector"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
): string | undefined {
  if (!documentLike) {
    return undefined;
  }
  let content: string | null | undefined;
  try {
    content = documentLike
      .querySelector<HTMLMetaElement>(`meta[name="${MOBILE_UI_RELEASE_META_NAME}"]`)
      ?.getAttribute("content");
  } catch {
    return undefined;
  }
  const value = content?.trim();
  return value && MOBILE_UI_RELEASE_ID_PATTERN.test(value) ? value : undefined;
}
