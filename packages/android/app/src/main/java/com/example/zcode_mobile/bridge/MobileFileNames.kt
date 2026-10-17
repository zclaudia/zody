package com.example.zcode_mobile.bridge

/**
 * 文件名与 MIME 的纯 Kotlin 规则（T6.3）。
 *
 * 这些规则被保存、下载和拍照三条路径共用，且不依赖 Android 运行时，
 * 因此可以在 JVM 单测里覆盖路径穿越、空名和超长名等边界。
 */
object MobileFileNames {
    const val DEFAULT_FILE_NAME = "download"

    private const val MAX_NAME_CHARS = 120
    private const val MAX_EXTENSION_CHARS = 12

    private val MIME_BY_EXTENSION = mapOf(
        "txt" to "text/plain",
        "log" to "text/plain",
        "md" to "text/markdown",
        "json" to "application/json",
        "csv" to "text/csv",
        "pdf" to "application/pdf",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "svg" to "image/svg+xml",
        "zip" to "application/zip",
        "gz" to "application/gzip",
        "mp4" to "video/mp4",
        "webm" to "video/webm",
        "mp3" to "audio/mpeg",
        "wav" to "audio/wav",
    )

    /**
     * 清洗页面/下载给出的文件名。
     *
     * 只保留 basename，去掉控制字符与路径分隔符，并把长度压到 120 字符以内；
     * 为空时返回 [DEFAULT_FILE_NAME]（有扩展名时保留扩展名）。
     */
    fun sanitize(fileName: String): String {
        val basename = fileName
            .replace('\\', '/')
            .substringAfterLast('/')
            .filterNot { it.isISOControl() }
            .trim()
            .trimStart('.')
        if (basename.isEmpty()) {
            return DEFAULT_FILE_NAME
        }
        return truncate(basename)
    }

    /** 按扩展名推断 MIME；未知类型用 `application/octet-stream`，避免把文件当文本打开。 */
    fun inferMimeType(fileName: String): String {
        val extension = fileName.substringAfterLast('.', "").lowercase()
        return MIME_BY_EXTENSION[extension] ?: "application/octet-stream"
    }

    /** 下载地址没有给出文件名时，按 MIME 生成一个带扩展名的默认名。 */
    fun defaultNameForMimeType(mimeType: String?): String {
        val normalized = mimeType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        val extension = MIME_BY_EXTENSION.entries.firstOrNull { it.value == normalized }?.key
        return if (extension == null) DEFAULT_FILE_NAME else "$DEFAULT_FILE_NAME.$extension"
    }

    /** 把实现返回的结果编码成桥可返回给页面的 JSON（页面只依赖这两个字段）。 */
    fun encodeSavedFile(saved: SavedMobileFile): String {
        return """{"uri":${jsonString(saved.uri)},"displayPath":${jsonString(saved.displayPath)}}"""
    }

    /**
     * 解析 Content-Disposition 里的文件名。
     *
     * 只处理常见的 `filename*="UTF-8''..."` 与 `filename="..."`，其余交给 URL 猜名。
     */
    fun parseContentDispositionFileName(contentDisposition: String?): String? {
        val header = contentDisposition?.trim().orEmpty()
        if (header.isEmpty()) {
            return null
        }
        val encoded = Regex("""filename\*\s*=\s*UTF-8''([^;]+)""", RegexOption.IGNORE_CASE)
            .find(header)
            ?.groupValues
            ?.getOrNull(1)
            ?.trim()
            ?.trim('"')
        if (!encoded.isNullOrEmpty()) {
            return runCatching { java.net.URLDecoder.decode(encoded, "UTF-8") }.getOrNull()
        }
        return Regex("""filename\s*=\s*"([^"]+)"""", RegexOption.IGNORE_CASE)
            .find(header)
            ?.groupValues
            ?.getOrNull(1)
            ?: Regex("""filename\s*=\s*([^;]+)""", RegexOption.IGNORE_CASE)
                .find(header)
                ?.groupValues
                ?.getOrNull(1)
                ?.trim()
                ?.trim('"')
                ?.takeIf { it.isNotEmpty() }
    }

    /** 从 URL 取出最后一个路径段作为文件名；没有可用段时返回 null。 */
    fun fileNameFromUrl(url: String): String? {
        // data:/content: 的「路径」是内容或数据库 id，不是文件名；交给 MIME 生成默认名。
        if (url.startsWith("data:", ignoreCase = true) ||
            url.startsWith("content:", ignoreCase = true)
        ) {
            return null
        }
        val withoutQuery = url.substringBefore('?').substringBefore('#')
        val name = withoutQuery.substringAfterLast('/')
        return name.takeIf { it.isNotBlank() }
    }

    private fun truncate(name: String): String {
        if (name.length <= MAX_NAME_CHARS) {
            return name
        }
        val dot = name.lastIndexOf('.')
        val extension = if (dot > 0 && name.length - dot - 1 in 1..MAX_EXTENSION_CHARS) {
            name.substring(dot)
        } else {
            ""
        }
        val base = if (extension.isEmpty()) name else name.substring(0, dot)
        return base.take(MAX_NAME_CHARS - extension.length) + extension
    }

    private fun jsonString(value: String): String {
        val builder = StringBuilder(value.length + 2)
        builder.append('"')
        for (char in value) {
            when (char) {
                '"' -> builder.append("\\\"")
                '\\' -> builder.append("\\\\")
                '\n' -> builder.append("\\n")
                '\r' -> builder.append("\\r")
                '\t' -> builder.append("\\t")
                else -> {
                    if (char < ' ') {
                        builder.append("\\u")
                        builder.append(char.code.toString(16).padStart(4, '0'))
                    } else {
                        builder.append(char)
                    }
                }
            }
        }
        builder.append('"')
        return builder.toString()
    }
}
