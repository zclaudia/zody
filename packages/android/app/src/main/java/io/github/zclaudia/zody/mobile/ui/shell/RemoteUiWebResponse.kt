package io.github.zclaudia.zody.mobile.ui.shell

import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptResponse
import java.util.Locale

/**
 * `WebResourceResponse` 的纯 JVM 投影。
 *
 * WebView 的平台 API 要求把 Content-Type 拆成 MIME/charset，且 HEAD/错误只能给空流；这里先做纯数据
 * 转换，Android 侧只负责构造 `WebResourceResponse`，JVM 测试可以验证 MIME/charset、空流和安全头。
 */
data class RemoteUiWebResponse(
    val mimeType: String,
    val encoding: String?,
    val statusCode: Int,
    val reasonPhrase: String,
    val headers: Map<String, String>,
    val body: ByteArray,
)

fun RemoteUiInterceptResponse.toWebResponse(requestMethod: String): RemoteUiWebResponse {
    val contentType = headers.entries
        .firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }
        ?.value
    val mimeType = contentType
        ?.substringBefore(';')
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: "text/plain"
    val encoding = contentType
        ?.split(';')
        ?.drop(1)
        ?.map { it.trim() }
        ?.firstOrNull { it.startsWith("charset=", ignoreCase = true) }
        ?.substringAfter('=')
        ?.trim()
        ?.trim('"')
        ?.takeIf { it.isNotEmpty() }

    // WebResourceResponse 自身携带 MIME/charset；头表只需保留原生补齐的安全/缓存头。
    val responseHeaders = headers.entries
        .filterNot { it.key.equals("Content-Type", ignoreCase = true) }
        .associate { it.key.lowercase(Locale.ROOT) to it.value }

    val isEmpty = requestMethod.equals("HEAD", ignoreCase = true) ||
        statusCode !in 200..299 ||
        body == null
    return RemoteUiWebResponse(
        mimeType = mimeType,
        encoding = encoding,
        statusCode = statusCode,
        reasonPhrase = reasonPhrase,
        headers = responseHeaders,
        body = if (isEmpty) ByteArray(0) else body,
    )
}
