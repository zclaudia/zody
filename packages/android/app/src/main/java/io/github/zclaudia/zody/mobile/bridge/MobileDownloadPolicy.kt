package io.github.zclaudia.zody.mobile.bridge

/**
 * WebView 下载的纯规则（T6.3 / M4-T1）。
 *
 * DownloadListener 把 URL 交给原生后，真正落盘发生在后台线程。这里把「来源 scheme 是否支持」
 * 和「发起下载的 session 是否仍是当前 Remote 会话」抽成无 Android 依赖的规则，便于 JVM 测试
 * 覆盖 blob/未知 scheme 拒绝与 backend 切换后的 stale 下载丢弃。
 */
internal object MobileDownloadPolicy {
    enum class SourceKind {
        DATA_URL,
        CONTENT_URI,
        HTTP,
        /** blob: 只在渲染进程内可读，原生不能当文件读取。 */
        BLOB_UNSUPPORTED,
        UNSUPPORTED,
    }

    fun classify(url: String): SourceKind = when {
        url.startsWith("data:", ignoreCase = true) -> SourceKind.DATA_URL
        url.startsWith("content:", ignoreCase = true) -> SourceKind.CONTENT_URI
        url.startsWith("http:", ignoreCase = true) ||
            url.startsWith("https:", ignoreCase = true) -> SourceKind.HTTP
        url.startsWith("blob:", ignoreCase = true) -> SourceKind.BLOB_UNSUPPORTED
        else -> SourceKind.UNSUPPORTED
    }

    /**
     * 下载开始时捕获的 session 必须与当前 Remote session 一致。
     *
     * 返回 false 时既不能继续写入，也不能打开已经读完的文件：backend 切换后旧页面发起的
     * 文件动作必须按 stale 丢弃（spec 9.2）。
     */
    fun isCurrentSession(capturedSessionId: String?, currentSessionId: String?): Boolean =
        !capturedSessionId.isNullOrBlank() && capturedSessionId == currentSessionId

    fun resolveMimeType(
        requested: String?,
        response: String?,
        contentDisposition: String?,
    ): String {
        requested?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        response?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return MobileFileNames.inferMimeType(
            MobileFileNames.parseContentDispositionFileName(contentDisposition).orEmpty(),
        )
    }

    fun resolveFileName(
        url: String,
        contentDisposition: String?,
        mimeType: String,
    ): String {
        val candidate = MobileFileNames.parseContentDispositionFileName(contentDisposition)
            ?: MobileFileNames.fileNameFromUrl(url)
            ?: MobileFileNames.defaultNameForMimeType(mimeType)
        return MobileFileNames.sanitize(candidate)
    }
}

/**
 * 文件打开 URI allowlist（spec 第 8 节）。
 *
 * Remote 页面虽然是桌面提供的可信代码，原生桥仍只把本应用 FileProvider 与 MediaStore 产出的
 * content URI 交给外部应用，避免页面把任意 content provider 暴露给 ACTION_VIEW。
 * 用 `java.net.URI` 解析，规则可在 JVM 单测覆盖。
 */
internal object MobileFileUris {
    private const val MEDIA_AUTHORITY = "media"

    fun isAllowedOpenUri(uri: String, packageName: String): Boolean {
        val parsed = runCatching { java.net.URI(uri) }.getOrNull() ?: return false
        if (!parsed.scheme.equals("content", ignoreCase = true)) {
            return false
        }
        if (parsed.userInfo != null) {
            return false
        }
        val authority = parsed.authority ?: return false
        return authority == MEDIA_AUTHORITY || authority == "$packageName.fileprovider"
    }
}
