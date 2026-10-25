package io.github.zclaudia.zody.mobile.notifications

/** Suppress OS banners only for the exact visible task target; missing keys remain deliverable. */
internal fun shouldSuppressTaskNotification(
    appForeground: Boolean,
    activeTargetKey: String?,
    notificationTargetKey: String?,
): Boolean = appForeground && !activeTargetKey.isNullOrBlank() && notificationTargetKey == activeTargetKey
