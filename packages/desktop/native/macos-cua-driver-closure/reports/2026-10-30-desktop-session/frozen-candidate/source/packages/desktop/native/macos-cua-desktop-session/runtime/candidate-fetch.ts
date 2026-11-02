import { Readable } from "node:stream";
import nodeFetch from "node-fetch";

/**
 * 候选 sealed Host/CLI 的唯一网络适配。
 *
 * --jitless 下没有 WebAssembly，undici 的 llhttp wasm 不能作为候选运行时；
 * 这里使用仓库锁定的 node-fetch@3.3.2 真实实现。该模块只由 candidate entry
 * 显式安装，不修改产品默认 fetch，也不为 proxy/custom CA 伪造成功。
 */

export class CandidateFetchUnsupportedError extends Error {
  readonly code = "ERR_CANDIDATE_FETCH_UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "CandidateFetchUnsupportedError";
  }
}

type RequestLike = {
  readonly url: string;
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: unknown;
  readonly bodyUsed?: boolean;
  readonly signal?: AbortSignal;
  readonly redirect?: RequestRedirect;
};

const UNSUPPORTED_INIT_KEYS = [
  "dispatcher",
  "agent",
  "proxy",
  "proxyUrl",
  "ca",
  "cert",
  "key",
  "rejectUnauthorized",
  "insecureHTTPParser",
] as const;

function isRequestLike(input: unknown): input is RequestLike {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as { url?: unknown; method?: unknown };
  return typeof candidate.url === "string" && typeof candidate.method === "string";
}

function isWebReadableStream(value: unknown): value is ReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  );
}

function isNodeReadable(value: unknown): value is Readable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

function toNodeFetchBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (isNodeReadable(body)) return body;
  if (isWebReadableStream(body)) return Readable.fromWeb(body as never);
  return body;
}

function rejectUnsupportedInit(init: RequestInit & Record<string, unknown>): void {
  for (const key of UNSUPPORTED_INIT_KEYS) {
    if (key in init && init[key] !== undefined) {
      throw new CandidateFetchUnsupportedError(
        `candidate fetch does not support ${key}; refusing to fall back to a direct connection`,
      );
    }
  }
  if (init.mode !== undefined && init.mode !== "cors" && init.mode !== "same-origin") {
    throw new CandidateFetchUnsupportedError(`candidate fetch does not support mode=${init.mode}`);
  }
  if (init.credentials !== undefined && init.credentials !== "omit") {
    throw new CandidateFetchUnsupportedError(
      `candidate fetch does not support credentials=${init.credentials}`,
    );
  }
  if (init.cache !== undefined && init.cache !== "default") {
    throw new CandidateFetchUnsupportedError(`candidate fetch does not support cache=${init.cache}`);
  }
  if (init.integrity !== undefined && init.integrity !== "") {
    throw new CandidateFetchUnsupportedError("candidate fetch does not support integrity");
  }
}

function decorateResponse(response: Response, url: string, redirected: boolean, type: string): Response {
  Object.defineProperties(response, {
    url: { value: url, enumerable: true, configurable: true },
    redirected: { value: redirected, enumerable: true, configurable: true },
    type: { value: type || "default", enumerable: true, configurable: true },
  });
  const clone = response.clone.bind(response);
  Object.defineProperty(response, "clone", {
    value: () => decorateResponse(clone(), url, redirected, type),
    enumerable: true,
    configurable: true,
  });
  return response;
}

async function toNativeResponse(nodeResponse: {
  body: Readable | null;
  headers: HeadersInit;
  redirected: boolean;
  status: number;
  statusText: string;
  type: string;
  url: string;
}): Promise<Response> {
  if (nodeResponse.status < 200 || nodeResponse.status > 599) {
    throw new CandidateFetchUnsupportedError(
      `native Response cannot represent HTTP status ${nodeResponse.status}`,
    );
  }
  const nullBody =
    nodeResponse.status === 204 || nodeResponse.status === 205 || nodeResponse.status === 304;
  const body = nullBody || nodeResponse.body === null ? null : Readable.toWeb(nodeResponse.body);
  const response = new Response(body, {
    status: nodeResponse.status,
    statusText: nodeResponse.statusText,
    headers: nodeResponse.headers,
  });
  return decorateResponse(response, nodeResponse.url, nodeResponse.redirected, nodeResponse.type);
}

function abortErrorFrom(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "AbortError") return error;
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  return error;
}

export async function candidateFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const extendedInit = init as RequestInit & Record<string, unknown>;
  rejectUnsupportedInit(extendedInit);

  const requestLike = isRequestLike(input) ? input : undefined;
  const url = requestLike?.url ?? (input instanceof URL ? input.toString() : String(input));
  if (requestLike?.bodyUsed) {
    throw new TypeError("Cannot fetch a Request whose body has already been used");
  }

  const headers = new Headers(extendedInit.headers ?? requestLike?.headers);
  const method = extendedInit.method ?? requestLike?.method ?? "GET";
  const hasInitBody = Object.prototype.hasOwnProperty.call(extendedInit, "body");
  const body = hasInitBody
    ? toNodeFetchBody(extendedInit.body)
    : toNodeFetchBody(requestLike?.body ?? null);
  const redirect = extendedInit.redirect ?? requestLike?.redirect;
  const signal = extendedInit.signal ?? requestLike?.signal;

  const nodeInit: Record<string, unknown> = { headers, method };
  if (body !== null && body !== undefined) nodeInit.body = body;
  if (redirect !== undefined) nodeInit.redirect = redirect;
  if (signal !== undefined) nodeInit.signal = signal;
  if (extendedInit.referrer !== undefined) nodeInit.referrer = extendedInit.referrer;
  if (extendedInit.referrerPolicy !== undefined) nodeInit.referrerPolicy = extendedInit.referrerPolicy;
  if (typeof extendedInit.follow === "number") nodeInit.follow = extendedInit.follow;
  if (typeof extendedInit.compress === "boolean") nodeInit.compress = extendedInit.compress;
  if (typeof extendedInit.highWaterMark === "number") {
    nodeInit.highWaterMark = extendedInit.highWaterMark;
  }

  try {
    const nodeResponse = await nodeFetch(url, nodeInit as never);
    return await toNativeResponse(nodeResponse as never);
  } catch (error) {
    throw abortErrorFrom(error);
  }
}

export function installCandidateFetch(): void {
  if (globalThis.fetch === candidateFetch) return;
  globalThis.fetch = candidateFetch;
}
