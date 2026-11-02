package io.github.zclaudia.zody.mobile.remoteui

import java.util.Locale

/**
 * 进程内缓存 key。
 *
 * 包含 Gateway 基址（含 origin 与部署前缀）、backendId、规范化路径和 query。对“Gateway origin”
 * 的要求是最小隔离维度；这里使用完整基址是更严格的超集，避免同一 origin 下不同部署前缀串缓存。
 * 不同 backend 的 key 永不相等。
 */
data class RemoteUiCacheKey(
    val gatewayBaseUrl: String,
    val backendId: String,
    val pathname: String,
    val query: String,
)

data class RemoteUiCachedResponse(
    val headers: Map<String, String>,
    val body: ByteArray,
)

/**
 * 有界 LRU（spec 6.3）。
 *
 * - 只接收明确 `immutable` 的 GET 200 最终响应；
 * - `no-store`/`no-cache`/`private`、错误、重定向、HEAD 和部分响应都不进入缓存；
 * - 同时按条数和 body 总字节数回收，超限只淘汰最久未使用的条目，不清空整个缓存；
 * - [clock] 可注入，便于 JVM 测试 TTL；不持久化任何内容，也不创建业务状态。
 */
class RemoteUiResponseCache(
    private val maxEntries: Int = DEFAULT_MAX_CACHE_ENTRIES,
    private val maxTotalBytes: Long = DEFAULT_MAX_CACHE_BYTES,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val defaultTtlMillis: Long = DEFAULT_IMMUTABLE_TTL_MILLIS,
) {
    private data class Entry(
        val response: RemoteUiCachedResponse,
        val expiresAtMillis: Long,
        val sizeBytes: Long,
    )

    // accessOrder=true：get 会把条目移动到队尾，队首即 LRU。
    private val entries = object : LinkedHashMap<RemoteUiCacheKey, Entry>(16, 0.75f, true) {}
    private val lock = Any()
    private var totalBytes = 0L

    fun get(key: RemoteUiCacheKey): RemoteUiCachedResponse? = synchronized(lock) {
        val entry = entries[key] ?: return null
        if (entry.expiresAtMillis <= clock()) {
            entries.remove(key)
            totalBytes -= entry.sizeBytes
            return null
        }
        entry.response
    }

    /**
     * 仅当最终头含 `immutable` 且没有禁止缓存指令时写入。
     * 返回 true 表示已缓存；单个条目超过总字节上限时不缓存。
     */
    fun putIfCacheable(
        key: RemoteUiCacheKey,
        headers: Map<String, String>,
        body: ByteArray,
    ): Boolean = synchronized(lock) {
        if (maxEntries <= 0) {
            return false
        }
        val cacheControl = headers.entries
            .firstOrNull { it.key.equals("Cache-Control", ignoreCase = true) }
            ?.value
            ?.lowercase(Locale.ROOT)
            ?: return false
        if (!cacheControl.contains("immutable")) {
            return false
        }
        if (
            cacheControl.contains("no-store") ||
            cacheControl.contains("no-cache") ||
            cacheControl.contains("private")
        ) {
            return false
        }
        if (headers.keys.any { it.equals("Set-Cookie", ignoreCase = true) }) {
            return false
        }

        val sizeBytes = body.size.toLong()
        if (sizeBytes > maxTotalBytes) {
            return false
        }
        val ttlMillis = maxAgeMillis(cacheControl) ?: defaultTtlMillis
        if (ttlMillis <= 0) {
            return false
        }
        val now = clock()
        val expiresAt = if (ttlMillis > Long.MAX_VALUE - now) Long.MAX_VALUE else now + ttlMillis

        entries.remove(key)?.let { totalBytes -= it.sizeBytes }
        entries[key] = Entry(
            response = RemoteUiCachedResponse(headers.toMap(), body),
            expiresAtMillis = expiresAt,
            sizeBytes = sizeBytes,
        )
        totalBytes += sizeBytes

        val iterator = entries.entries.iterator()
        while ((entries.size > maxEntries || totalBytes > maxTotalBytes) && iterator.hasNext()) {
            val eldest = iterator.next()
            iterator.remove()
            totalBytes -= eldest.value.sizeBytes
        }
        true
    }

    fun clear() = synchronized(lock) {
        entries.clear()
        totalBytes = 0L
    }

    fun entryCount(): Int = synchronized(lock) { entries.size }

    fun cachedBytes(): Long = synchronized(lock) { totalBytes }

    private fun maxAgeMillis(cacheControl: String): Long? {
        val match = MAX_AGE_PATTERN.find(cacheControl) ?: return null
        val seconds = match.groupValues[1].toLongOrNull() ?: return null
        if (seconds <= 0L) {
            return 0L
        }
        return if (seconds > Long.MAX_VALUE / 1000L) Long.MAX_VALUE else seconds * 1000L
    }

    private companion object {
        val MAX_AGE_PATTERN = Regex("(?:^|,)\\s*max-age\\s*=\\s*(\\d+)", RegexOption.IGNORE_CASE)
    }
}
