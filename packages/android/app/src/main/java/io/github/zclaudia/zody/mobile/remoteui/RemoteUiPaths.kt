package io.github.zclaudia.zody.mobile.remoteui

import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.Locale

/**
 * URL → Gateway 代理目标与纯路径校验。
 *
 * 只认识固定 Remote origin 和第 5 节允许的两类路径：
 * - `/mobile-ui/release`
 * - `/assets/remote/...`
 *
 * 校验顺序与桌面 MobileUiAssetProvider 一致：先拒绝编码斜杠/反斜杠/NUL 等危险转义，再解码，
 * 然后按段拒绝空段、点段、点文件和未知扩展名。这样 Android 与桌面不会各自放行不同路径。
 */
internal object RemoteUiPaths {
    private const val MAX_PATH_LENGTH = 4096
    private const val MAX_QUERY_LENGTH = 4096
    private const val MAX_BACKEND_ID_LENGTH = 256
    private const val MAX_BEARER_TOKEN_LENGTH = 8192

    private val DANGEROUS_PATH_ESCAPE =
        Regex("%(?:2f|5c|00|0d|0a)", RegexOption.IGNORE_CASE)
    private val DANGEROUS_QUERY_ESCAPE =
        Regex("%(?:00|0d|0a|5c)", RegexOption.IGNORE_CASE)
    private val SAFE_DECODED_PATH = Regex("^/[A-Za-z0-9._~/-]+$")
    private val SAFE_GATEWAY_BASE_PATH = Regex("^/[A-Za-z0-9._~/-]+$")
    private val SAFE_BACKEND_ID = Regex("^[A-Za-z0-9._~-]+$")
    private val CONTENT_HASHED_FILE_PATTERN =
        Regex("[.-][A-Za-z0-9_-]{8,64}\\.[A-Za-z0-9]+$")

    /** 与桌面 provider 的 ALLOWED_CONTENT_TYPES 对齐；未知扩展名一律不代理。 */
    private val ALLOWED_CONTENT_TYPES = mapOf(
        "js" to "text/javascript; charset=utf-8",
        "mjs" to "text/javascript; charset=utf-8",
        "cjs" to "text/javascript; charset=utf-8",
        "css" to "text/css; charset=utf-8",
        "json" to "application/json; charset=utf-8",
        "txt" to "text/plain; charset=utf-8",
        "xml" to "application/xml; charset=utf-8",
        "csv" to "text/csv; charset=utf-8",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "webp" to "image/webp",
        "gif" to "image/gif",
        "avif" to "image/avif",
        "ico" to "image/x-icon",
        "woff" to "font/woff",
        "woff2" to "font/woff2",
        "ttf" to "font/ttf",
        "otf" to "font/otf",
        "eot" to "application/vnd.ms-fontobject",
        "bcmap" to "application/octet-stream",
        "pfb" to "application/octet-stream",
        "pdf" to "application/pdf",
        "wasm" to "application/wasm",
        "mp4" to "video/mp4",
        "webm" to "video/webm",
        "mp3" to "audio/mpeg",
        "wav" to "audio/wav",
        "ogg" to "audio/ogg",
        "ogv" to "video/ogg",
        "vtt" to "text/vtt; charset=utf-8",
    )

    fun resolveRemoteUiUrl(rawUrl: String): RemoteUiPathResolution {
        if (rawUrl.isBlank() || rawUrl.length > MAX_PATH_LENGTH + MAX_QUERY_LENGTH + 256) {
            return rejectPath()
        }
        val uri = try {
            URI(rawUrl)
        } catch (_: Exception) {
            return rejectPath()
        }
        if (!uri.isAbsolute || uri.isOpaque) {
            return rejectPath()
        }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        val host = uri.host?.lowercase(Locale.ROOT)
        if (scheme != "https" || host != REMOTE_UI_HOST || uri.userInfo != null) {
            return RemoteUiPathResolution.Rejected(404, RemoteUiErrorCode.INVALID_ORIGIN)
        }
        val port = uri.port
        if (port != -1 && port != 443) {
            return RemoteUiPathResolution.Rejected(404, RemoteUiErrorCode.INVALID_ORIGIN)
        }
        if (uri.fragment != null) {
            return rejectPath()
        }

        val rawPath = uri.rawPath ?: return rejectPath()
        if (rawPath.length > MAX_PATH_LENGTH || !rawPath.startsWith("/")) {
            return rejectPath()
        }
        if (rawPath.contains("//") || rawPath.contains('\\') || rawPath.contains('\u0000')) {
            return rejectPath()
        }
        if (rawPath.any { it.code < 0x20 || it.code == 0x7F }) {
            return rejectPath()
        }
        if (DANGEROUS_PATH_ESCAPE.containsMatchIn(rawPath)) {
            return rejectPath()
        }
        val pathname = decodePercentEncodedPath(rawPath) ?: return rejectPath()
        if (!SAFE_DECODED_PATH.matches(pathname)) {
            return rejectPath()
        }

        val query = normalizeQuery(uri.rawQuery) ?: return rejectPath()

        if (pathname == REMOTE_UI_RELEASE_PATH) {
            return RemoteUiPathResolution.Allowed(
                pathname = pathname,
                query = query,
                kind = RemoteUiAssetKind.RELEASE,
                contentType = "application/json; charset=utf-8",
            )
        }

        if (!pathname.startsWith(REMOTE_UI_ASSET_BASE_PATH) || pathname.endsWith("/")) {
            return rejectPath()
        }
        val relativePath = pathname.substring(REMOTE_UI_ASSET_BASE_PATH.length)
        if (relativePath.isEmpty() || relativePath == REMOTE_UI_RELEASE_MANIFEST_FILE) {
            return rejectPath()
        }
        val segments = relativePath.split('/')
        for (segment in segments) {
            if (segment.isEmpty() || segment == "." || segment == "..") {
                return rejectPath()
            }
            // 点文件、Windows 盘符/备用数据流都不属于发布制品。
            if (segment.startsWith(".") || segment.contains(':')) {
                return rejectPath()
            }
        }

        if (relativePath == "index.html") {
            return RemoteUiPathResolution.Allowed(
                pathname = pathname,
                query = query,
                kind = RemoteUiAssetKind.ENTRY,
                contentType = "text/html; charset=utf-8",
            )
        }

        val extension = extensionOf(relativePath) ?: return rejectPath()
        val contentType = ALLOWED_CONTENT_TYPES[extension] ?: return rejectPath()
        val fileName = segments.last()
        val immutable =
            relativePath.startsWith("assets/") &&
                CONTENT_HASHED_FILE_PATTERN.containsMatchIn(fileName)
        return RemoteUiPathResolution.Allowed(
            pathname = pathname,
            query = query,
            kind = if (immutable) RemoteUiAssetKind.IMMUTABLE else RemoteUiAssetKind.REVALIDATED,
            contentType = contentType,
        )
    }

    fun normalizeSessionContext(
        context: RemoteUiSessionContext,
        requireHttpsGateway: Boolean,
    ): NormalizedRemoteUiSessionContext? {
        if (context.sessionId.isBlank()) {
            return null
        }
        if (
            context.backendId.length !in 1..MAX_BACKEND_ID_LENGTH ||
            !SAFE_BACKEND_ID.matches(context.backendId) ||
            context.backendId == "." ||
            context.backendId == ".."
        ) {
            return null
        }
        if (
            context.bearerToken.isBlank() ||
            context.bearerToken.length > MAX_BEARER_TOKEN_LENGTH ||
            context.bearerToken.any { it == '\r' || it == '\n' || it == '\u0000' }
        ) {
            return null
        }

        val uri = try {
            URI(context.gatewayBaseUrl.trim())
        } catch (_: Exception) {
            return null
        }
        if (!uri.isAbsolute || uri.isOpaque) {
            return null
        }
        val scheme = when (uri.scheme?.lowercase(Locale.ROOT)) {
            "http", "ws" -> "http"
            "https", "wss" -> "https"
            else -> return null
        }
        if (requireHttpsGateway && scheme != "https") {
            return null
        }
        if (uri.userInfo != null || uri.rawQuery != null || uri.fragment != null) {
            return null
        }
        val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotBlank() } ?: return null
        val rawPath = uri.rawPath ?: ""
        if (rawPath.length > MAX_PATH_LENGTH) {
            return null
        }
        if (rawPath.contains('\\') || rawPath.contains('\u0000')) {
            return null
        }
        if (DANGEROUS_PATH_ESCAPE.containsMatchIn(rawPath)) {
            return null
        }
        val decodedPath = if (rawPath.isEmpty() || rawPath == "/") {
            ""
        } else {
            decodePercentEncodedPath(rawPath) ?: return null
        }
        val normalizedPath = decodedPath.trimEnd('/')
        if (normalizedPath.isNotEmpty()) {
            if (!normalizedPath.startsWith("/") || normalizedPath.contains("//")) {
                return null
            }
            if (!SAFE_GATEWAY_BASE_PATH.matches(normalizedPath)) {
                return null
            }
            if (normalizedPath.split('/').any { it == "." || it == ".." }) {
                return null
            }
        }

        val portPart = if (
            uri.port != -1 &&
            !((scheme == "http" && uri.port == 80) || (scheme == "https" && uri.port == 443))
        ) {
            ":${uri.port}"
        } else {
            ""
        }
        val origin = "$scheme://$host$portPart"
        val wsScheme = if (scheme == "https") "wss" else "ws"
        return NormalizedRemoteUiSessionContext(
            sessionId = context.sessionId,
            gatewayBaseUrl = "$origin$normalizedPath",
            gatewayOrigin = origin,
            gatewayWsOrigin = "$wsScheme://$host$portPart",
            backendId = context.backendId,
            bearerToken = context.bearerToken,
        )
    }

    fun buildGatewayProxyUrl(
        context: NormalizedRemoteUiSessionContext,
        path: RemoteUiPathResolution.Allowed,
    ): String {
        val querySuffix = if (path.query.isEmpty()) "" else "?${path.query}"
        return "${context.gatewayBaseUrl}$GATEWAY_PROXY_PATH_PREFIX" +
            "${context.backendId}${path.pathname}$querySuffix"
    }

    fun statusForError(code: RemoteUiErrorCode): Int = when (code) {
        RemoteUiErrorCode.INVALID_METHOD -> 405
        RemoteUiErrorCode.INVALID_ORIGIN,
        RemoteUiErrorCode.INVALID_PATH -> 404
        RemoteUiErrorCode.INVALID_SESSION_CONTEXT -> 502
        RemoteUiErrorCode.UPSTREAM_REDIRECT -> 502
        RemoteUiErrorCode.RESPONSE_TOO_LARGE -> 413
        RemoteUiErrorCode.CONNECT_TIMEOUT,
        RemoteUiErrorCode.READ_TIMEOUT -> 504
        RemoteUiErrorCode.NETWORK_ERROR -> 502
    }

    fun reasonPhraseFor(statusCode: Int): String = when (statusCode) {
        200 -> "OK"
        204 -> "No Content"
        206 -> "Partial Content"
        301 -> "Moved Permanently"
        302 -> "Found"
        303 -> "See Other"
        304 -> "Not Modified"
        307 -> "Temporary Redirect"
        308 -> "Permanent Redirect"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        408 -> "Request Timeout"
        413 -> "Payload Too Large"
        429 -> "Too Many Requests"
        500 -> "Internal Server Error"
        502 -> "Bad Gateway"
        503 -> "Service Unavailable"
        504 -> "Gateway Timeout"
        else -> "HTTP $statusCode"
    }

    private fun decodePercentEncodedPath(raw: String): String? {
        val bytes = ByteArrayOutputStream(raw.length)
        var index = 0
        while (index < raw.length) {
            val char = raw[index]
            if (char == '%') {
                if (index + 2 >= raw.length) {
                    return null
                }
                val high = Character.digit(raw[index + 1], 16)
                val low = Character.digit(raw[index + 2], 16)
                if (high < 0 || low < 0) {
                    return null
                }
                bytes.write((high shl 4) or low)
                index += 3
            } else {
                if (char.code > 0x7F) {
                    // 发布制品的路径是 ASCII；拒绝非 ASCII，避免平台间编码差异。
                    return null
                }
                bytes.write(char.code)
                index += 1
            }
        }
        val decoded = String(bytes.toByteArray(), Charsets.UTF_8)
        // 0xFFFD 表示 UTF-8 解码时出现了替换字符，按非法路径拒绝。
        return if (decoded.indexOf(0xFFFD.toChar()) >= 0) null else decoded
    }

    private fun normalizeQuery(rawQuery: String?): String? {
        if (rawQuery == null) {
            return ""
        }
        if (rawQuery.length > MAX_QUERY_LENGTH) {
            return null
        }
        if (rawQuery.any { it.code < 0x20 || it.code == 0x7F }) {
            return null
        }
        if (rawQuery.contains('\\') || rawQuery.contains('#')) {
            return null
        }
        if (DANGEROUS_QUERY_ESCAPE.containsMatchIn(rawQuery)) {
            return null
        }
        return rawQuery
    }

    private fun extensionOf(relativePath: String): String? {
        val lastSegment = relativePath.substring(relativePath.lastIndexOf('/') + 1)
        val dotIndex = lastSegment.lastIndexOf('.')
        if (dotIndex <= 0 || dotIndex == lastSegment.length - 1) {
            return null
        }
        return lastSegment.substring(dotIndex + 1).lowercase(Locale.ROOT)
    }

    private fun rejectPath(): RemoteUiPathResolution.Rejected =
        RemoteUiPathResolution.Rejected(404, RemoteUiErrorCode.INVALID_PATH)
}
