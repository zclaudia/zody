package io.github.zclaudia.zody.mobile.remoteui

import java.net.URI
import java.util.Locale

/**
 * 原生补齐 Gateway 会剥离的安全头（spec 6.2）。
 *
 * M1 实测 Gateway 的响应头 allowlist 只保留 content-type/content-length/cache-control/etag 等，
 * provider 设置的 CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 和 405 Allow
 * 不会到达手机。因此这里不是“透传上游头”，而是 Android 侧按桌面 provider 的同一产品契约重新生成：
 * 固定指令、固定缓存分类和当前 Gateway origin 都由本对象决定。
 */
internal object RemoteUiSecurityHeaders {
    const val NO_STORE = "no-store"
    const val NO_CACHE = "no-cache"
    const val IMMUTABLE = "public, max-age=31536000, immutable"

    private val CACHE_CONTROL_KEYS = setOf("cache-control", "content-type", "content-length")

    fun cacheControlFor(kind: RemoteUiAssetKind): String = when (kind) {
        RemoteUiAssetKind.RELEASE,
        RemoteUiAssetKind.ENTRY -> NO_STORE
        RemoteUiAssetKind.IMMUTABLE -> IMMUTABLE
        RemoteUiAssetKind.REVALIDATED -> NO_CACHE
    }

    /**
     * 上游明确禁止缓存时，最终响应也必须禁止缓存，避免 WebView 自身再缓存一次；
     * 否则按桌面 provider 的资源分类输出。
     */
    fun effectiveCacheControl(
        kind: RemoteUiAssetKind,
        upstreamCacheControl: String?,
        statusCode: Int,
    ): String {
        if (statusCode != 200) {
            return NO_STORE
        }
        val lower = upstreamCacheControl?.lowercase(Locale.ROOT) ?: ""
        if (lower.contains("no-store") || lower.contains("private")) {
            return NO_STORE
        }
        if (lower.contains("no-cache")) {
            return NO_CACHE
        }
        // 上游已是 immutable 时保留其 max-age，避免把桌面给的较短 TTL 放大。
        if (lower.contains("immutable")) {
            return upstreamCacheControl!!.trim()
        }
        return cacheControlFor(kind)
    }

    /**
     * 与 `buildMobileUiContentSecurityPolicy` 逐指令一致。
     *
     * `connect-src` 仅包含 'self'、当前 Gateway HTTP origin、由其派生的 WS origin，以及显式提供的
     * WS origin；绝不拼接凭证、路径或通配脚本源。
     */
    fun contentSecurityPolicy(
        gatewayHttpOrigin: String?,
        gatewayWsOrigin: String?,
    ): String {
        val connectSources = linkedSetOf("'self'")
        val httpOrigin = normalizeOrigin(gatewayHttpOrigin, setOf("http", "https"))
        if (httpOrigin != null) {
            connectSources.add(httpOrigin)
            deriveWebSocketOrigin(httpOrigin)?.let(connectSources::add)
        }
        normalizeOrigin(gatewayWsOrigin, setOf("ws", "wss"))?.let(connectSources::add)

        return listOf(
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "media-src 'self' blob:",
            "worker-src 'self' blob:",
            "manifest-src 'self'",
            "connect-src ${connectSources.joinToString(" ")}",
            "object-src 'none'",
            "frame-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
        ).joinToString("; ")
    }

    /**
     * 成功响应的最终头。
     *
     * [upstreamHeaders] 已由 [RemoteUiHeaderPolicy] 过滤；其中 ETag/Last-Modified/Expires/Vary/
     * Content-Range 等条件与范围元数据保留，但内容类型、长度和缓存策略始终由原生契约覆盖。
     */
    fun successHeaders(
        kind: RemoteUiAssetKind,
        contentType: String,
        contentLength: Long,
        contentSecurityPolicy: String,
        upstreamHeaders: Map<String, String> = emptyMap(),
        statusCode: Int = 200,
        cacheControl: String? = null,
    ): LinkedHashMap<String, String> {
        val headers = LinkedHashMap<String, String>()
        for ((name, value) in upstreamHeaders) {
            val lower = name.lowercase(Locale.ROOT)
            if (lower in CACHE_CONTROL_KEYS) {
                continue
            }
            val canonical = canonicalResponseHeaderName(lower) ?: continue
            headers[canonical] = value
        }
        headers["Cache-Control"] = cacheControl
            ?: if (statusCode == 200) cacheControlFor(kind) else NO_STORE
        headers["Content-Type"] = contentType
        headers["Content-Length"] = contentLength.coerceAtLeast(0L).toString()
        headers["Content-Security-Policy"] = contentSecurityPolicy
        headers["X-Content-Type-Options"] = "nosniff"
        headers["X-Frame-Options"] = "DENY"
        headers["Referrer-Policy"] = "no-referrer"
        return headers
    }

    /**
     * 错误响应只保留 no-store/nosniff；405 按桌面契约补 `Allow`，否则 WebView 拿不到方法信息。
     */
    fun errorHeaders(statusCode: Int): LinkedHashMap<String, String> {
        val headers = LinkedHashMap<String, String>()
        headers["Cache-Control"] = NO_STORE
        headers["Content-Length"] = "0"
        headers["X-Content-Type-Options"] = "nosniff"
        if (statusCode == 405) {
            headers["Allow"] = "GET, HEAD"
        }
        return headers
    }

    private fun canonicalResponseHeaderName(lower: String): String? = when (lower) {
        "etag" -> "ETag"
        "last-modified" -> "Last-Modified"
        "expires" -> "Expires"
        "vary" -> "Vary"
        "accept-ranges" -> "Accept-Ranges"
        "content-range" -> "Content-Range"
        else -> null
    }

    private fun normalizeOrigin(value: String?, allowedSchemes: Set<String>): String? {
        val trimmed = value?.trim()
        if (trimmed.isNullOrEmpty()) {
            return null
        }
        val parsed = try {
            URI(trimmed)
        } catch (_: Exception) {
            return null
        }
        if (!parsed.isAbsolute || parsed.isOpaque) {
            return null
        }
        val scheme = parsed.scheme?.lowercase(Locale.ROOT) ?: return null
        if (scheme !in allowedSchemes) {
            return null
        }
        val host = parsed.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotBlank() } ?: return null
        // 凭证绝不进入 CSP；带 userinfo 的值直接丢弃。
        if (parsed.userInfo != null || parsed.rawQuery != null || parsed.fragment != null) {
            return null
        }
        val defaultPort = (scheme == "http" && parsed.port == 80) ||
            (scheme == "https" && parsed.port == 443) ||
            (scheme == "ws" && parsed.port == 80) ||
            (scheme == "wss" && parsed.port == 443) ||
            parsed.port == -1
        val portPart = if (defaultPort) "" else ":${parsed.port}"
        return "$scheme://$host$portPart"
    }

    private fun deriveWebSocketOrigin(httpOrigin: String): String? {
        val parsed = try {
            URI(httpOrigin)
        } catch (_: Exception) {
            return null
        }
        val host = parsed.host ?: return null
        val portPart = if (parsed.port == -1) "" else ":${parsed.port}"
        return when (parsed.scheme?.lowercase(Locale.ROOT)) {
            "https" -> "wss://$host$portPart"
            "http" -> "ws://$host$portPart"
            else -> null
        }
    }
}
