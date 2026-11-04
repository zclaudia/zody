package io.github.zclaudia.zody.mobile.remoteui

import java.io.IOException
import java.util.Locale

/**
 * Remote origin 的只读原生代理（spec 6.2/6.3）。
 *
 * 线程约束：`execute` 是同步阻塞调用，**只能由 WebView `shouldInterceptRequest` worker 调用**。
 * 本类刻意不引用 Android `Looper`，以保持纯 JVM 可测；controller 必须通过 [threadGuard] 断言
 * 当前线程不是主线程，并在 WebView interceptor 线程等待本次同步结果。任何网络等待都不会被
 * 转到 UI 线程。
 *
 * 职责边界：
 * - 只接受固定 `https://remote.zody.local` 的第 5 节 GET/HEAD 路径，其余请求本地拒绝；
 * - 从纯数据 [RemoteUiSessionContext] 取 Gateway 基址、backendId 和凭证，映射到
 *   `/api/proxy/<backendId><path>` 并原生注入 Bearer；
 * - 生成桌面 provider 同契约的 CSP/安全头与缓存分类，不假设 Gateway 会透传；
 * - 只在明确 immutable 的 GET 200 上使用进程内 LRU；缓存命中不产生业务状态；
 * - 响应原样带回调用方传入的 generation，controller 负责丢弃旧代次。
 *
 * 失败策略：所有失败都返回本地 [RemoteUiInterceptResponse]，不会退化为通用网络代理。
 */
class RemoteUiProxy(
    sessionContext: RemoteUiSessionContext,
    private val cache: RemoteUiResponseCache = RemoteUiResponseCache(),
    private val connectTimeoutMillis: Int = DEFAULT_CONNECT_TIMEOUT_MILLIS,
    private val readTimeoutMillis: Int = DEFAULT_READ_TIMEOUT_MILLIS,
    private val maxResponseBytes: Int = DEFAULT_MAX_RESPONSE_BYTES,
    requireHttpsGateway: Boolean = false,
    private val threadGuard: (() -> Unit)? = null,
    private val transport: RemoteUiHttpTransport = HttpUrlConnectionTransport(),
) {
    init {
        require(connectTimeoutMillis >= 0) { "connectTimeoutMillis must be non-negative" }
        require(readTimeoutMillis >= 0) { "readTimeoutMillis must be non-negative" }
        require(maxResponseBytes >= 0) { "maxResponseBytes must be non-negative" }
    }

    private val normalizedContext: NormalizedRemoteUiSessionContext? =
        RemoteUiPaths.normalizeSessionContext(sessionContext, requireHttpsGateway)

    /** 仅用于 controller 诊断；不包含任何凭证。 */
    val hasValidSessionContext: Boolean
        get() = normalizedContext != null

    fun execute(request: RemoteUiInterceptRequest): RemoteUiInterceptResponse {
        // controller 注入的断言必须在任何缓存/网络访问之前执行；抛错说明线程接错，直接暴露。
        threadGuard?.invoke()

        val generation = request.generation
        val method = request.method.trim().uppercase(Locale.ROOT)
        if (method != "GET" && method != "HEAD") {
            return localError(405, RemoteUiErrorCode.INVALID_METHOD, generation)
        }

        val context = normalizedContext
            ?: return localError(502, RemoteUiErrorCode.INVALID_SESSION_CONTEXT, generation)

        val resolution = RemoteUiPaths.resolveRemoteUiUrl(request.url)
        if (resolution is RemoteUiPathResolution.Rejected) {
            return localError(resolution.status, resolution.code, generation)
        }
        val path = resolution as RemoteUiPathResolution.Allowed
        val key = RemoteUiCacheKey(
            gatewayBaseUrl = context.gatewayBaseUrl,
            backendId = context.backendId,
            pathname = path.pathname,
            query = path.query,
        )

        if (method == "GET") {
            cache.get(key)?.let { cached ->
                return RemoteUiInterceptResponse(
                    statusCode = 200,
                    reasonPhrase = RemoteUiPaths.reasonPhraseFor(200),
                    headers = cached.headers,
                    body = cached.body,
                    generation = generation,
                    fromCache = true,
                )
            }
        }

        // 请求头白名单后由原生注入凭证；页面传来的 Authorization/Cookie 永远不会被转发。
        val requestHeaders = RemoteUiHeaderPolicy.filterRequestHeaders(request.requestHeaders)
        requestHeaders["Authorization"] = "Bearer ${context.bearerToken}"
        requestHeaders["Accept-Encoding"] = "identity"

        val transportResponse = try {
            transport.execute(
                RemoteUiHttpRequest(
                    url = RemoteUiPaths.buildGatewayProxyUrl(context, path),
                    method = method,
                    headers = requestHeaders,
                    connectTimeoutMillis = connectTimeoutMillis,
                    readTimeoutMillis = readTimeoutMillis,
                    maxResponseBytes = maxResponseBytes,
                ),
            )
        } catch (error: RemoteUiTransportException) {
            return localError(RemoteUiPaths.statusForError(error.code), error.code, generation)
        } catch (_: IOException) {
            return localError(502, RemoteUiErrorCode.NETWORK_ERROR, generation)
        }

        if (transportResponse.redirect) {
            return localError(502, RemoteUiErrorCode.UPSTREAM_REDIRECT, generation)
        }
        if (transportResponse.exceededLimit) {
            return localError(413, RemoteUiErrorCode.RESPONSE_TOO_LARGE, generation)
        }

        val statusCode = transportResponse.statusCode
        if (statusCode !in 200..299) {
            // 错误、429、5xx 不缓存；405 的 Allow 由原生补齐（Gateway 会剥离该头）。
            return RemoteUiInterceptResponse(
                statusCode = statusCode,
                reasonPhrase = RemoteUiPaths.reasonPhraseFor(statusCode),
                headers = RemoteUiSecurityHeaders.errorHeaders(statusCode),
                body = null,
                generation = generation,
            )
        }

        val body = transportResponse.body
        val contentLength = when {
            method == "HEAD" -> transportResponse.declaredContentLength ?: 0L
            body != null -> body.size.toLong()
            else -> 0L
        }
        if (contentLength > maxResponseBytes) {
            return localError(413, RemoteUiErrorCode.RESPONSE_TOO_LARGE, generation)
        }

        val upstreamHeaders = RemoteUiHeaderPolicy.filterResponseHeaders(transportResponse.headers)
        val upstreamCacheControl =
            RemoteUiHeaderPolicy.headerValue(transportResponse.headers, "cache-control")
        val responseHeaders = RemoteUiSecurityHeaders.successHeaders(
            kind = path.kind,
            contentType = path.contentType,
            contentLength = contentLength,
            contentSecurityPolicy = RemoteUiSecurityHeaders.contentSecurityPolicy(
                context.gatewayOrigin,
                context.gatewayWsOrigin,
            ),
            upstreamHeaders = upstreamHeaders,
            statusCode = statusCode,
            cacheControl = RemoteUiSecurityHeaders.effectiveCacheControl(
                kind = path.kind,
                upstreamCacheControl = upstreamCacheControl,
                statusCode = statusCode,
            ),
        )

        if (
            method == "GET" &&
            statusCode == 200 &&
            path.kind == RemoteUiAssetKind.IMMUTABLE &&
            body != null &&
            canUseLongTermCache(transportResponse.headers, upstreamCacheControl)
        ) {
            // 缓存最终响应头（含原生 Content-Type/CSP），并只在路径分类与上游 cache-control
            // 都允许长期缓存时写入；no-store/no-cache/private 绝不被路径哈希“洗白”。
            cache.putIfCacheable(key, responseHeaders, body)
        }

        return RemoteUiInterceptResponse(
            statusCode = statusCode,
            reasonPhrase = RemoteUiPaths.reasonPhraseFor(statusCode),
            headers = responseHeaders,
            body = body,
            generation = generation,
        )
    }

    private fun canUseLongTermCache(
        upstreamHeaders: Map<String, List<String>>,
        upstreamCacheControl: String?,
    ): Boolean {
        if (RemoteUiHeaderPolicy.hasHeader(upstreamHeaders, "set-cookie")) {
            return false
        }
        val lowerCacheControl = upstreamCacheControl?.lowercase(Locale.ROOT) ?: ""
        if (
            lowerCacheControl.contains("no-store") ||
            lowerCacheControl.contains("no-cache") ||
            lowerCacheControl.contains("private")
        ) {
            return false
        }
        val vary = RemoteUiHeaderPolicy.headerValue(upstreamHeaders, "vary")
            ?.lowercase(Locale.ROOT)
            ?: return true
        // 代理固定发送 Accept-Encoding: identity；其它 Vary 维度（语言、Authorization 等）
        // 无法由当前缓存 key 表达，宁可不缓存也不跨请求复用错误内容。
        return vary.isEmpty() || vary.split(',').map { it.trim() }.all { it == "accept-encoding" }
    }

    private fun localError(
        statusCode: Int,
        code: RemoteUiErrorCode,
        generation: Long,
    ): RemoteUiInterceptResponse = RemoteUiInterceptResponse(
        statusCode = statusCode,
        reasonPhrase = RemoteUiPaths.reasonPhraseFor(statusCode),
        headers = RemoteUiSecurityHeaders.errorHeaders(statusCode),
        body = null,
        generation = generation,
        errorCode = code,
    )
}
