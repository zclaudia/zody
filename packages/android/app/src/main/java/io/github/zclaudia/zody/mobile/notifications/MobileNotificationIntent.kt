package io.github.zclaudia.zody.mobile.notifications

/**
 * MainActivity 消费的通知深链（M4-T2）。
 *
 * 点击卡片与点击按钮是两个独立动作：前者打开任务，后者提交权限选项；两者共用 opaque
 * backendId/notificationId，但写入不同的原生 pending 槽。
 */
internal sealed interface MobileNotificationIntent {
    val backendId: String
    val notificationId: String

    data class Click(
        override val backendId: String,
        override val notificationId: String,
    ) : MobileNotificationIntent

    data class Action(
        override val backendId: String,
        override val notificationId: String,
        val optionId: String,
        val optionKind: String,
    ) : MobileNotificationIntent
}

/** 与 Web 桥解析保持一致；超过上限的 id 不会被页面接受，写入原生槽只会永久 pending。 */
private const val MAX_NOTIFICATION_ID_CHARS = 256
private const val MAX_INTENT_URI_CHARS = 8_192
private val NOTIFICATION_OPTION_KINDS = setOf("allowOnce", "allowAlways", "deny")

/**
 * 配置变更/状态恢复会重投启动 Intent；同一 URI 已被消费时不再处理。
 * `allowReplay` 用于 `onNewIntent`：进程内的重复点击是用户的真实重试，交给页面队列去重。
 */
internal fun shouldHandleNotificationDeepLink(
    rawUri: String?,
    handledUri: String?,
    allowReplay: Boolean,
): Boolean = rawUri != null && (allowReplay || rawUri != handledUri)

/**
 * 纯字符串解析，便于 JVM focused 测试；Android `Uri` 只在 MainActivity 取 `dataString`。
 *
 * 不接受额外/重复查询参数：重复 key 的取值顺序在不同平台不一致，宁可拒绝也不猜。
 */
internal fun parseMobileNotificationIntent(rawUri: String?): MobileNotificationIntent? {
    if (rawUri.isNullOrBlank() || rawUri.length > MAX_INTENT_URI_CHARS) return null
    val uri = runCatching { java.net.URI(rawUri) }.getOrNull() ?: return null
    if (uri.scheme != "zody") return null
    val query = decodeQuery(uri.rawQuery) ?: return null
    val backendId = query["backendId"]?.takeIf(::isValidNotificationId) ?: return null
    val notificationId = query["notificationId"]?.takeIf(::isValidNotificationId) ?: return null
    return when {
        uri.host == "notification" && uri.path == "/v1" ->
            MobileNotificationIntent.Click(backendId, notificationId)

        uri.host == "notification-action" && uri.path == "/v1" -> {
            val optionId = query["optionId"]?.takeIf(::isValidNotificationId) ?: return null
            val optionKind = query["optionKind"]?.takeIf { it in NOTIFICATION_OPTION_KINDS } ?: return null
            MobileNotificationIntent.Action(backendId, notificationId, optionId, optionKind)
        }

        else -> null
    }
}

private fun isValidNotificationId(value: String): Boolean =
    value.isNotBlank() && value.length <= MAX_NOTIFICATION_ID_CHARS

private fun decodeQuery(rawQuery: String?): Map<String, String>? {
    if (rawQuery == null) return emptyMap()
    val result = LinkedHashMap<String, String>()
    for (part in rawQuery.split('&')) {
        if (part.isEmpty()) continue
        val separator = part.indexOf('=')
        val rawKey = if (separator >= 0) part.substring(0, separator) else part
        val rawValue = if (separator >= 0) part.substring(separator + 1) else ""
        val key = decodeComponent(rawKey) ?: return null
        val value = decodeComponent(rawValue) ?: return null
        if (key.isEmpty() || result.containsKey(key)) return null
        result[key] = value
    }
    return result
}

/**
 * 只做 percent-decoding：Android `Uri.getQueryParameter` 不会把 '+' 当空格，
 * 本应用生成 URI 时也已把 '+' 输出为 `%20`。原始 Unicode 字符按 UTF-8 编码，
 * 避免代理对（emoji）被逐 Char 截断。
 */
private fun decodeComponent(value: String): String? {
    val bytes = java.io.ByteArrayOutputStream(value.length)
    var index = 0
    while (index < value.length) {
        if (value[index] == '%') {
            if (index + 2 >= value.length) return null
            val byte = value.substring(index + 1, index + 3).toIntOrNull(16) ?: return null
            bytes.write(byte)
            index += 3
            continue
        }
        val codePoint = value.codePointAt(index)
        bytes.write(String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8))
        index += Character.charCount(codePoint)
    }
    return bytes.toByteArray().toString(Charsets.UTF_8)
}
