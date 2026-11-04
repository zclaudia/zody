package io.github.zclaudia.zody.mobile.remoteui

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.util.Locale

/** 已构造好的 Gateway 请求；只由 proxy 在 WebView interceptor worker 上同步调用。 */
data class RemoteUiHttpRequest(
    val url: String,
    val method: String,
    val headers: Map<String, String>,
    val connectTimeoutMillis: Int,
    val readTimeoutMillis: Int,
    val maxResponseBytes: Int,
)

data class RemoteUiTransportResponse(
    val statusCode: Int,
    val headers: Map<String, List<String>>,
    val body: ByteArray?,
    val declaredContentLength: Long?,
    val exceededLimit: Boolean,
    val redirect: Boolean,
)

class RemoteUiTransportException(
    val code: RemoteUiErrorCode,
    cause: Throwable? = null,
) : IOException(cause)

/** 允许测试替换传输层；生产默认使用平台同步 [HttpURLConnection]。 */
interface RemoteUiHttpTransport {
    fun execute(request: RemoteUiHttpRequest): RemoteUiTransportResponse
}

/**
 * 平台同步 HTTP（Android 上即 `HttpURLConnection`）。
 *
 * 约束：
 * - 不跟随重定向，3xx 由 proxy 映射为本地 502，Location 不进入 WebView；
 * - 显式 `Accept-Encoding: identity`，响应体在读取过程中按字节上限截断，声明的超大
 *   Content-Length 在读取前就被拒绝；
 * - 只读取有界响应体；错误流只做有界排空，不进入缓存或响应；
 * - 连接/读取超时映射为稳定错误码，抛出异常时绝不把 URL、头或凭证写进日志。
 */
class HttpUrlConnectionTransport : RemoteUiHttpTransport {
    override fun execute(request: RemoteUiHttpRequest): RemoteUiTransportResponse {
        val url = try {
            URI(request.url).toURL()
        } catch (error: Exception) {
            throw RemoteUiTransportException(RemoteUiErrorCode.NETWORK_ERROR, error)
        }
        val connection = try {
            url.openConnection() as HttpURLConnection
        } catch (error: IOException) {
            throw RemoteUiTransportException(RemoteUiErrorCode.NETWORK_ERROR, error)
        }

        try {
            connection.connectTimeout = request.connectTimeoutMillis
            connection.readTimeout = request.readTimeoutMillis
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.doInput = true
            connection.doOutput = false
            connection.requestMethod = request.method
            for ((name, value) in request.headers) {
                connection.setRequestProperty(name, value)
            }
            connection.setRequestProperty("Accept-Encoding", "identity")

            try {
                connection.connect()
            } catch (error: SocketTimeoutException) {
                throw RemoteUiTransportException(RemoteUiErrorCode.CONNECT_TIMEOUT, error)
            } catch (error: IOException) {
                throw RemoteUiTransportException(RemoteUiErrorCode.NETWORK_ERROR, error)
            }

            val statusCode = try {
                connection.responseCode
            } catch (error: SocketTimeoutException) {
                throw RemoteUiTransportException(RemoteUiErrorCode.READ_TIMEOUT, error)
            } catch (error: IOException) {
                throw RemoteUiTransportException(RemoteUiErrorCode.NETWORK_ERROR, error)
            }
            val headers = normalizeHeaders(connection.headerFields)
            val declaredContentLength = RemoteUiHeaderPolicy
                .headerValue(headers, "content-length")
                ?.toLongOrNull()
                ?.takeIf { it >= 0 }

            if (statusCode in 300..399) {
                // 绝不读取或转发 Location；redirect 由 proxy 转成 502。
                return RemoteUiTransportResponse(
                    statusCode = statusCode,
                    headers = headers,
                    body = null,
                    declaredContentLength = declaredContentLength,
                    exceededLimit = false,
                    redirect = true,
                )
            }

            if (request.method == "HEAD" || statusCode !in 200..299) {
                if (statusCode !in 200..299) {
                    drainBounded(connection.errorStream, request.maxResponseBytes)
                }
                val exceeded = declaredContentLength != null &&
                    declaredContentLength > request.maxResponseBytes
                return RemoteUiTransportResponse(
                    statusCode = statusCode,
                    headers = headers,
                    body = null,
                    declaredContentLength = declaredContentLength,
                    exceededLimit = exceeded,
                    redirect = false,
                )
            }

            if (declaredContentLength != null && declaredContentLength > request.maxResponseBytes) {
                return RemoteUiTransportResponse(
                    statusCode = statusCode,
                    headers = headers,
                    body = null,
                    declaredContentLength = declaredContentLength,
                    exceededLimit = true,
                    redirect = false,
                )
            }

            val body = readBounded(connection.inputStream, request.maxResponseBytes)
                ?: return RemoteUiTransportResponse(
                    statusCode = statusCode,
                    headers = headers,
                    body = null,
                    declaredContentLength = declaredContentLength,
                    exceededLimit = true,
                    redirect = false,
                )
            return RemoteUiTransportResponse(
                statusCode = statusCode,
                headers = headers,
                body = body,
                declaredContentLength = declaredContentLength,
                exceededLimit = false,
                redirect = false,
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun normalizeHeaders(fields: Map<String, List<String>>?): Map<String, List<String>> {
        if (fields.isNullOrEmpty()) {
            return emptyMap()
        }
        val normalized = LinkedHashMap<String, MutableList<String>>()
        for (entry in fields.entries) {
            // HttpURLConnection.headerFields 用 null key 表示状态行，必须跳过。
            val name = entry.key ?: continue
            val lower = name.lowercase(Locale.ROOT)
            normalized.getOrPut(lower) { mutableListOf() }.addAll(entry.value)
        }
        return normalized
    }

    /** 返回 null 表示超过上限；调用方转 413，绝不把超大 body 放进内存。 */
    private fun readBounded(stream: InputStream?, maxBytes: Int): ByteArray? {
        if (stream == null) {
            return ByteArray(0)
        }
        val output = ByteArrayOutputStream(minOf(maxBytes, 64 * 1024))
        val buffer = ByteArray(READ_BUFFER_BYTES)
        var total = 0
        try {
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) {
                    break
                }
                total += read
                if (total > maxBytes) {
                    return null
                }
                output.write(buffer, 0, read)
            }
        } catch (error: SocketTimeoutException) {
            throw RemoteUiTransportException(RemoteUiErrorCode.READ_TIMEOUT, error)
        } catch (error: IOException) {
            throw RemoteUiTransportException(RemoteUiErrorCode.NETWORK_ERROR, error)
        }
        return output.toByteArray()
    }

    private fun drainBounded(stream: InputStream?, maxBytes: Int) {
        if (stream == null) {
            return
        }
        val buffer = ByteArray(READ_BUFFER_BYTES)
        var total = 0
        try {
            while (total <= maxBytes) {
                val read = stream.read(buffer)
                if (read < 0) {
                    return
                }
                total += read
            }
        } catch (_: IOException) {
            // 错误流只用于排空连接；失败不影响原始状态码，也不记录异常内容。
        }
    }

    private companion object {
        const val READ_BUFFER_BYTES = 16 * 1024
    }
}
