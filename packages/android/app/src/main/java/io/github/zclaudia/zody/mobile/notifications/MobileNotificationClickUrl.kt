package io.github.zclaudia.zody.mobile.notifications

/** ntfy-bridge accepts only http(s) click headers, so rebuild the app URI from validated opaque ids. */
internal fun mobileNotificationClickUrl(backendId: String, notificationId: String): String =
    "zody://notification/v1?backendId=${encodeQueryValue(backendId)}&notificationId=${encodeQueryValue(notificationId)}"

/**
 * 第二批 E4：permission 通知按钮的 deep link。id 与 optionId 均为 opaque；optionKind 是
 * 三类固定值（脱敏分类，供页面把按钮意图映射到提交语义），不携带命令/路径。
 */
internal fun mobileNotificationActionUrl(
    backendId: String,
    notificationId: String,
    optionId: String,
    optionKind: String,
): String =
    "zody://notification-action/v1?backendId=${encodeQueryValue(backendId)}" +
        "&notificationId=${encodeQueryValue(notificationId)}&optionId=${encodeQueryValue(optionId)}" +
        "&optionKind=${encodeQueryValue(optionKind)}"

private fun encodeQueryValue(value: String): String =
    java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
