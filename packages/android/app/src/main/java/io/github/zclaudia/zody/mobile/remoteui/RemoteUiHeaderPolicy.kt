package io.github.zclaudia.zody.mobile.remoteui

import java.util.Locale

/**
 * 请求/响应头白名单。
 *
 * 请求侧只转发 UI 资源加载真正需要的头；Authorization 由 proxy 原生注入，Cookie、Origin、
 * Referer、Host、条件请求头等都不转发，避免把页面凭证或浏览器上下文带给 Gateway。
 *
 * 响应侧采用白名单而不是黑名单：Set-Cookie、Location、Connection、Transfer-Encoding、
 * Upgrade、Proxy-* 等都不会进入 WebView。安全头由 [RemoteUiSecurityHeaders] 重新生成。
 */
internal object RemoteUiHeaderPolicy {
    private val REQUEST_ALLOWLIST = setOf(
        "accept",
        "accept-language",
        "range",
        "if-range",
    )

    private val RESPONSE_ALLOWLIST = setOf(
        "content-type",
        "content-length",
        "cache-control",
        "etag",
        "last-modified",
        "expires",
        "accept-ranges",
        "content-range",
        "vary",
    )

    fun filterRequestHeaders(headers: Map<String, String>): LinkedHashMap<String, String> {
        val filtered = LinkedHashMap<String, String>()
        for ((name, value) in headers) {
            val lower = name.lowercase(Locale.ROOT)
            if (lower !in REQUEST_ALLOWLIST || containsControlCharacters(value)) {
                continue
            }
            val canonical = when (lower) {
                "accept" -> "Accept"
                "accept-language" -> "Accept-Language"
                "range" -> "Range"
                "if-range" -> "If-Range"
                else -> continue
            }
            filtered[canonical] = value.trim()
        }
        return filtered
    }

    fun filterResponseHeaders(headers: Map<String, List<String>>): LinkedHashMap<String, String> {
        val filtered = LinkedHashMap<String, String>()
        for ((name, values) in headers) {
            val lower = name.lowercase(Locale.ROOT)
            if (lower !in RESPONSE_ALLOWLIST) {
                continue
            }
            val canonical = canonicalResponseHeaderName(lower) ?: continue
            val joined = values
                .filterNot(::containsControlCharacters)
                .joinToString(", ")
                .trim()
            if (joined.isEmpty()) {
                continue
            }
            filtered[canonical] = joined
        }
        return filtered
    }

    fun headerValue(headers: Map<String, List<String>>, name: String): String? =
        headers.entries
            .firstOrNull { it.key.equals(name, ignoreCase = true) }
            ?.value
            ?.joinToString(", ")
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

    fun hasHeader(headers: Map<String, List<String>>, name: String): Boolean =
        headers.keys.any { it.equals(name, ignoreCase = true) }

    fun canonicalResponseHeaderName(lower: String): String? = when (lower) {
        "content-type" -> "Content-Type"
        "content-length" -> "Content-Length"
        "cache-control" -> "Cache-Control"
        "etag" -> "ETag"
        "last-modified" -> "Last-Modified"
        "expires" -> "Expires"
        "accept-ranges" -> "Accept-Ranges"
        "content-range" -> "Content-Range"
        "vary" -> "Vary"
        else -> null
    }

    private fun containsControlCharacters(value: String): Boolean =
        value.any { it == '\r' || it == '\n' || it == '\u0000' || it.code < 0x20 }
}
