package io.github.zclaudia.zody.mobile.notifications

internal const val MOBILE_NOTIFICATION_SEEN_TTL_MS = 30L * 24 * 60 * 60 * 1000
internal const val MOBILE_NOTIFICATION_SEEN_MAX = 1_000

/** Prunes expired IDs and keeps the newest bounded set. Returns true when the ID was already seen. */
internal fun rememberMobileNotificationId(
    seenAtById: MutableMap<String, Long>,
    key: String,
    now: Long,
    retentionMs: Long = MOBILE_NOTIFICATION_SEEN_TTL_MS,
    maximum: Int = MOBILE_NOTIFICATION_SEEN_MAX,
): Boolean {
    seenAtById.entries.removeAll { (_, seenAt) -> seenAt + retentionMs <= now }
    if (seenAtById.containsKey(key)) return true
    seenAtById[key] = now
    if (seenAtById.size > maximum) {
        seenAtById.entries.sortedBy { it.value }.take(seenAtById.size - maximum).forEach { seenAtById.remove(it.key) }
    }
    return false
}
