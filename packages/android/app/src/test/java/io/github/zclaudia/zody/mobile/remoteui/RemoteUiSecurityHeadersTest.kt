package io.github.zclaudia.zody.mobile.remoteui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteUiSecurityHeadersTest {
    /**
     * 这是桌面 `buildMobileUiContentSecurityPolicy` 的契约输出。两端必须逐指令一致；
     * 若产品策略调整，本测试与 desktop provider 测试必须同步修改，不能各自漂移。
     */
    private val desktopContractCsp = listOf(
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "connect-src 'self' https://gateway.example wss://gateway.example",
        "object-src 'none'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
    ).joinToString("; ")

    @Test
    fun `csp matches desktop provider contract exactly`() {
        assertEquals(
            desktopContractCsp,
            RemoteUiSecurityHeaders.contentSecurityPolicy(
                gatewayHttpOrigin = "https://gateway.example",
                gatewayWsOrigin = "wss://gateway.example",
            ),
        )
    }

    @Test
    fun `csp adds explicit ws origin and rejects credentials`() {
        val csp = RemoteUiSecurityHeaders.contentSecurityPolicy(
            gatewayHttpOrigin = "http://gateway.example:8080",
            gatewayWsOrigin = "ws://other.example:9000",
        )
        assertTrue(csp.contains("connect-src 'self' http://gateway.example:8080 ws://gateway.example:8080 ws://other.example:9000"))
        assertFalse(csp.contains("user:pass"))

        val withCredentials = RemoteUiSecurityHeaders.contentSecurityPolicy(
            gatewayHttpOrigin = "https://user:pass@gateway.example",
            gatewayWsOrigin = null,
        )
        assertTrue(withCredentials.contains("connect-src 'self'"))
        assertFalse(withCredentials.contains("gateway.example"))
    }

    @Test
    fun `success headers override upstream cache and security values`() {
        val headers = RemoteUiSecurityHeaders.successHeaders(
            kind = RemoteUiAssetKind.IMMUTABLE,
            contentType = "text/javascript; charset=utf-8",
            contentLength = 10,
            contentSecurityPolicy = desktopContractCsp,
            upstreamHeaders = mapOf(
                "Cache-Control" to "no-store",
                "Content-Type" to "text/plain",
                "Content-Length" to "999",
                "ETag" to "\"abc\"",
                "Vary" to "Accept-Encoding",
                "Set-Cookie" to "leak=1",
            ),
            statusCode = 200,
        )

        assertEquals(RemoteUiSecurityHeaders.IMMUTABLE, headers["Cache-Control"])
        assertEquals("text/javascript; charset=utf-8", headers["Content-Type"])
        assertEquals("10", headers["Content-Length"])
        assertEquals(desktopContractCsp, headers["Content-Security-Policy"])
        assertEquals("nosniff", headers["X-Content-Type-Options"])
        assertEquals("DENY", headers["X-Frame-Options"])
        assertEquals("no-referrer", headers["Referrer-Policy"])
        assertEquals("\"abc\"", headers["ETag"])
        assertEquals("Accept-Encoding", headers["Vary"])
        assertFalse(headers.containsKey("Set-Cookie"))
    }

    @Test
    fun `partial responses are never long term cacheable`() {
        val headers = RemoteUiSecurityHeaders.successHeaders(
            kind = RemoteUiAssetKind.IMMUTABLE,
            contentType = "video/mp4",
            contentLength = 4,
            contentSecurityPolicy = desktopContractCsp,
            statusCode = 206,
        )
        assertEquals("no-store", headers["Cache-Control"])
    }

    @Test
    fun `cache control follows desktop asset classification`() {
        assertEquals(
            "no-store",
            RemoteUiSecurityHeaders.cacheControlFor(RemoteUiAssetKind.RELEASE),
        )
        assertEquals(
            "no-store",
            RemoteUiSecurityHeaders.cacheControlFor(RemoteUiAssetKind.ENTRY),
        )
        assertEquals(
            "public, max-age=31536000, immutable",
            RemoteUiSecurityHeaders.cacheControlFor(RemoteUiAssetKind.IMMUTABLE),
        )
        assertEquals(
            "no-cache",
            RemoteUiSecurityHeaders.cacheControlFor(RemoteUiAssetKind.REVALIDATED),
        )
    }

    @Test
    fun `effective cache control honors upstream opt out and immutable max age`() {
        assertEquals(
            "public, max-age=31536000, immutable",
            RemoteUiSecurityHeaders.effectiveCacheControl(
                RemoteUiAssetKind.IMMUTABLE,
                upstreamCacheControl = null,
                statusCode = 200,
            ),
        )
        assertEquals(
            "public, max-age=60, immutable",
            RemoteUiSecurityHeaders.effectiveCacheControl(
                RemoteUiAssetKind.IMMUTABLE,
                upstreamCacheControl = "public, max-age=60, immutable",
                statusCode = 200,
            ),
        )
        assertEquals(
            "no-store",
            RemoteUiSecurityHeaders.effectiveCacheControl(
                RemoteUiAssetKind.IMMUTABLE,
                upstreamCacheControl = "no-store",
                statusCode = 200,
            ),
        )
        assertEquals(
            "no-cache",
            RemoteUiSecurityHeaders.effectiveCacheControl(
                RemoteUiAssetKind.IMMUTABLE,
                upstreamCacheControl = "no-cache",
                statusCode = 200,
            ),
        )
        assertEquals(
            "no-store",
            RemoteUiSecurityHeaders.effectiveCacheControl(
                RemoteUiAssetKind.IMMUTABLE,
                upstreamCacheControl = "public, max-age=31536000, immutable",
                statusCode = 206,
            ),
        )
    }

    @Test
    fun `error headers are bounded and 405 keeps allow`() {
        val methodNotAllowed = RemoteUiSecurityHeaders.errorHeaders(405)
        assertEquals("no-store", methodNotAllowed["Cache-Control"])
        assertEquals("0", methodNotAllowed["Content-Length"])
        assertEquals("nosniff", methodNotAllowed["X-Content-Type-Options"])
        assertEquals("GET, HEAD", methodNotAllowed["Allow"])
        assertNull(methodNotAllowed["Content-Security-Policy"])
        assertNull(methodNotAllowed["X-Frame-Options"])
        assertNull(methodNotAllowed["Referrer-Policy"])

        val badGateway = RemoteUiSecurityHeaders.errorHeaders(502)
        assertFalse(badGateway.containsKey("Allow"))
    }
}
