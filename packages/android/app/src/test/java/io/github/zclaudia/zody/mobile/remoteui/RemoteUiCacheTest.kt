package io.github.zclaudia.zody.mobile.remoteui

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteUiCacheTest {
    private fun key(
        backendId: String = "backend-1",
        gateway: String = "https://gateway.example",
        path: String = "/assets/remote/assets/index-abc12345.js",
        query: String = "",
    ) = RemoteUiCacheKey(gateway, backendId, path, query)

    private fun headers(cacheControl: String) = mapOf(
        "Cache-Control" to cacheControl,
        "Content-Type" to "text/javascript; charset=utf-8",
        "Content-Length" to "4",
    )

    @Test
    fun `caches immutable responses and returns the exact body`() {
        val cache = RemoteUiResponseCache()
        val body = byteArrayOf(1, 2, 3, 4)
        assertTrue(cache.putIfCacheable(key(), headers("public, max-age=31536000, immutable"), body))

        val cached = cache.get(key())
        assertNotNull(cached)
        assertArrayEquals(body, cached!!.body)
        assertEquals(1, cache.entryCount())
        assertEquals(4L, cache.cachedBytes())
    }

    @Test
    fun `does not cache no-store no-cache or private`() {
        for (cacheControl in listOf("no-store", "no-cache", "private, max-age=60", "public, max-age=60")) {
            val cache = RemoteUiResponseCache()
            assertFalse(
                "must not cache: $cacheControl",
                cache.putIfCacheable(key(), headers(cacheControl), byteArrayOf(1)),
            )
            assertNull(cache.get(key()))
        }
    }

    @Test
    fun `does not cache responses with set-cookie`() {
        val cache = RemoteUiResponseCache()
        val headers = headers("public, max-age=31536000, immutable") + ("Set-Cookie" to "a=b")
        assertFalse(cache.putIfCacheable(key(), headers, byteArrayOf(1)))
    }

    @Test
    fun `expires entries according to max-age and injected clock`() {
        var now = 1_000L
        val cache = RemoteUiResponseCache(
            clock = { now },
            defaultTtlMillis = 10_000L,
        )
        assertTrue(cache.putIfCacheable(key(), headers("public, max-age=1, immutable"), byteArrayOf(1)))

        now = 1_999L
        assertNotNull(cache.get(key()))
        now = 2_001L
        assertNull(cache.get(key()))
        assertEquals(0, cache.entryCount())
        assertEquals(0L, cache.cachedBytes())
    }

    @Test
    fun `uses default ttl when immutable has no max-age`() {
        var now = 0L
        val cache = RemoteUiResponseCache(clock = { now }, defaultTtlMillis = 5_000L)
        assertTrue(cache.putIfCacheable(key(), headers("immutable"), byteArrayOf(1)))
        now = 4_999L
        assertNotNull(cache.get(key()))
        now = 5_000L
        assertNull(cache.get(key()))
    }

    @Test
    fun `evicts least recently used entry by count`() {
        val cache = RemoteUiResponseCache(maxEntries = 2, maxTotalBytes = 1_000L)
        val a = key(path = "/assets/remote/assets/a-abc12345.js")
        val b = key(path = "/assets/remote/assets/b-abc12345.js")
        val c = key(path = "/assets/remote/assets/c-abc12345.js")
        val immutable = headers("public, max-age=31536000, immutable")

        assertTrue(cache.putIfCacheable(a, immutable, byteArrayOf(1)))
        assertTrue(cache.putIfCacheable(b, immutable, byteArrayOf(2)))
        assertNotNull(cache.get(a)) // A becomes most recently used; B is LRU.
        assertTrue(cache.putIfCacheable(c, immutable, byteArrayOf(3)))

        assertNull(cache.get(b))
        assertNotNull(cache.get(a))
        assertNotNull(cache.get(c))
        assertEquals(2, cache.entryCount())
    }

    @Test
    fun `evicts by total bytes instead of clearing the cache`() {
        val cache = RemoteUiResponseCache(maxEntries = 10, maxTotalBytes = 10L)
        val a = key(path = "/assets/remote/assets/a-abc12345.js")
        val b = key(path = "/assets/remote/assets/b-abc12345.js")
        val immutable = headers("public, max-age=31536000, immutable")

        assertTrue(cache.putIfCacheable(a, immutable, ByteArray(6)))
        assertTrue(cache.putIfCacheable(b, immutable, ByteArray(6)))
        assertEquals(1, cache.entryCount())
        assertEquals(6L, cache.cachedBytes())
        assertNull(cache.get(a))
        assertNotNull(cache.get(b))
    }

    @Test
    fun `does not cache a single response larger than the byte budget`() {
        val cache = RemoteUiResponseCache(maxEntries = 10, maxTotalBytes = 4L)
        assertFalse(
            cache.putIfCacheable(
                key(),
                headers("public, max-age=31536000, immutable"),
                ByteArray(5),
            ),
        )
        assertEquals(0, cache.entryCount())
    }

    @Test
    fun `isolates gateway backend path and query`() {
        val cache = RemoteUiResponseCache()
        val immutable = headers("public, max-age=31536000, immutable")
        val base = key()
        val variants = listOf(
            base.copy(gatewayBaseUrl = "https://other-gateway.example"),
            base.copy(backendId = "backend-2"),
            base.copy(pathname = "/assets/remote/assets/other-abc12345.js"),
            base.copy(query = "v=2"),
        )
        assertTrue(cache.putIfCacheable(base, immutable, byteArrayOf(1)))
        for (variant in variants) {
            assertNull("must not share cache with $variant", cache.get(variant))
            assertTrue(cache.putIfCacheable(variant, immutable, byteArrayOf(2)))
        }
        assertEquals(5, cache.entryCount())
    }

    @Test
    fun `replacing an entry updates byte accounting`() {
        val cache = RemoteUiResponseCache(maxEntries = 2, maxTotalBytes = 100L)
        val immutable = headers("public, max-age=31536000, immutable")
        assertTrue(cache.putIfCacheable(key(), immutable, ByteArray(10)))
        assertTrue(cache.putIfCacheable(key(), immutable, ByteArray(3)))
        assertEquals(1, cache.entryCount())
        assertEquals(3L, cache.cachedBytes())
    }

    @Test
    fun `clear resets entries and bytes`() {
        val cache = RemoteUiResponseCache()
        cache.putIfCacheable(
            key(),
            headers("public, max-age=31536000, immutable"),
            byteArrayOf(1, 2),
        )
        cache.clear()
        assertEquals(0, cache.entryCount())
        assertEquals(0L, cache.cachedBytes())
        assertNull(cache.get(key()))
    }
}
