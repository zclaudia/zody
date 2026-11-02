package io.github.zclaudia.zody.mobile.remoteui

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RemoteUiProxyTest {
    private lateinit var server: FakeGatewayServer

    @Before
    fun setUp() {
        server = FakeGatewayServer()
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun `maps path injects bearer and adds native security headers`() {
        val body = """{"releaseId":"abc"}""".toByteArray()
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = body,
                headers = mapOf(
                    "Content-Type" to "application/json",
                    "Cache-Control" to "no-store",
                ),
            )
        }

        val response = proxy().execute(
            request(
                url = "$REMOTE_UI_ORIGIN/mobile-ui/release",
                requestHeaders = mapOf(
                    "Accept" to "application/json",
                    "Accept-Language" to "zh-CN",
                    "Cookie" to "session=leak",
                    "Origin" to REMOTE_UI_ORIGIN,
                    "Referer" to "$REMOTE_UI_ORIGIN/assets/remote/index.html",
                    "Authorization" to "Bearer page-supplied-token",
                    "X-Custom" to "drop-me",
                ),
                generation = 41L,
            ),
        )

        assertEquals(200, response.statusCode)
        assertEquals(41L, response.generation)
        assertFalse(response.fromCache)
        assertNull(response.errorCode)
        assertArrayEquals(body, response.body)

        val recorded = server.requests.single()
        assertEquals("/api/proxy/backend-1/mobile-ui/release", recorded.path)
        assertEquals("Bearer secret-token", recorded.header("Authorization"))
        assertEquals("application/json", recorded.header("Accept"))
        assertEquals("zh-CN", recorded.header("Accept-Language"))
        assertEquals("identity", recorded.header("Accept-Encoding"))
        assertNull(recorded.header("Cookie"))
        assertNull(recorded.header("Origin"))
        assertNull(recorded.header("Referer"))
        assertNull(recorded.header("X-Custom"))
        assertFalse(recorded.header("Authorization")!!.contains("page-supplied-token"))

        assertEquals("application/json; charset=utf-8", header(response, "Content-Type"))
        assertEquals("no-store", header(response, "Cache-Control"))
        assertEquals("nosniff", header(response, "X-Content-Type-Options"))
        assertEquals("DENY", header(response, "X-Frame-Options"))
        assertEquals("no-referrer", header(response, "Referrer-Policy"))
        val csp = header(response, "Content-Security-Policy")!!
        assertTrue(csp.startsWith("default-src 'none'; script-src 'self';"))
        assertTrue(csp.contains("connect-src 'self' ${server.baseUrl} ${server.baseUrl.replaceFirst("http:", "ws:")};"))
        assertTrue(csp.contains("frame-ancestors 'none'"))
        assertTrue(csp.contains("base-uri 'none'"))
    }

    @Test
    fun `caches immutable get only and reuses cached body with current generation`() {
        val body = "console.log(1)".toByteArray()
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = body,
                headers = mapOf(
                    "Content-Type" to "text/javascript",
                    "Cache-Control" to "public, max-age=31536000, immutable",
                    "ETag" to "\"v1\"",
                ),
            )
        }
        val proxy = proxy()
        val immutableUrl = "$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js"

        val first = proxy.execute(request(immutableUrl, generation = 1L))
        assertFalse(first.fromCache)
        assertEquals(1, server.requestCount())

        val second = proxy.execute(request(immutableUrl, generation = 2L))
        assertTrue(second.fromCache)
        assertEquals(2L, second.generation)
        assertArrayEquals(body, second.body)
        assertEquals("text/javascript; charset=utf-8", header(second, "Content-Type"))
        assertEquals("public, max-age=31536000, immutable", header(second, "Cache-Control"))
        assertEquals("\"v1\"", header(second, "ETag"))
        assertEquals(1, server.requestCount())

        val head = proxy.execute(request(immutableUrl, method = "HEAD", generation = 3L))
        assertNull(head.body)
        assertFalse(head.fromCache)
        assertEquals(2, server.requestCount())

        // HEAD 不写缓存，也不影响已有 GET 缓存。
        val third = proxy.execute(request(immutableUrl, generation = 4L))
        assertTrue(third.fromCache)
        assertEquals(2, server.requestCount())
    }

    @Test
    fun `does not cache when upstream opts out even for hashed assets`() {
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = "x".toByteArray(),
                headers = mapOf(
                    "Content-Type" to "text/javascript",
                    "Cache-Control" to "no-store",
                ),
            )
        }
        val proxy = proxy()
        val url = "$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js"

        val first = proxy.execute(request(url, generation = 1L))
        val second = proxy.execute(request(url, generation = 2L))
        assertFalse(first.fromCache)
        assertFalse(second.fromCache)
        assertEquals(2, server.requestCount())
        assertEquals("no-store", header(first, "Cache-Control"))
        assertEquals("no-store", header(second, "Cache-Control"))
    }

    @Test
    fun `does not cache immutable asset that varies on a non identity header`() {
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = "x".toByteArray(),
                headers = mapOf(
                    "Content-Type" to "text/javascript",
                    "Cache-Control" to "public, max-age=31536000, immutable",
                    "Vary" to "Accept-Language",
                ),
            )
        }
        val proxy = proxy()
        val url = "$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js"
        assertFalse(proxy.execute(request(url, generation = 1L)).fromCache)
        assertFalse(proxy.execute(request(url, generation = 2L)).fromCache)
        assertEquals(2, server.requestCount())
    }

    @Test
    fun `query participates in cache key`() {
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = "x".toByteArray(),
                headers = mapOf(
                    "Content-Type" to "text/javascript",
                    "Cache-Control" to "public, max-age=31536000, immutable",
                ),
            )
        }
        val proxy = proxy()
        val base = "$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js"

        assertFalse(proxy.execute(request("$base?v=1", generation = 1L)).fromCache)
        assertFalse(proxy.execute(request("$base?v=2", generation = 2L)).fromCache)
        assertTrue(proxy.execute(request("$base?v=1", generation = 3L)).fromCache)
        assertEquals(2, server.requestCount())
    }

    @Test
    fun `cache is isolated per backend even with a shared cache`() {
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = "x".toByteArray(),
                headers = mapOf(
                    "Content-Type" to "text/javascript",
                    "Cache-Control" to "public, max-age=31536000, immutable",
                ),
            )
        }
        val sharedCache = RemoteUiResponseCache()
        val url = "$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js"
        val backendOne = proxy(backendId = "backend-1", cache = sharedCache)
        val backendTwo = proxy(backendId = "backend-2", cache = sharedCache)

        assertFalse(backendOne.execute(request(url, generation = 1L)).fromCache)
        assertFalse(backendTwo.execute(request(url, generation = 2L)).fromCache)
        assertTrue(backendOne.execute(request(url, generation = 3L)).fromCache)
        assertTrue(backendTwo.execute(request(url, generation = 4L)).fromCache)
        assertEquals(2, server.requestCount())
        assertTrue(server.requests.any { it.path.startsWith("/api/proxy/backend-1/") })
        assertTrue(server.requests.any { it.path.startsWith("/api/proxy/backend-2/") })
    }

    @Test
    fun `rejects non read methods with 405 and never contacts gateway`() {
        val response = proxy().execute(
            request("$REMOTE_UI_ORIGIN/mobile-ui/release", method = "POST", generation = 9L),
        )
        assertEquals(405, response.statusCode)
        assertEquals("GET, HEAD", header(response, "Allow"))
        assertEquals("no-store", header(response, "Cache-Control"))
        assertEquals(RemoteUiErrorCode.INVALID_METHOD, response.errorCode)
        assertEquals(9L, response.generation)
        assertEquals(0, server.requestCount())
    }

    @Test
    fun `rejects paths outside the UI allowlist and other origins`() {
        val proxy = proxy()
        val escaped = proxy.execute(
            request("$REMOTE_UI_ORIGIN/api/proxy/backend-1/mobile-ui/release", generation = 1L),
        )
        assertEquals(404, escaped.statusCode)
        assertEquals(RemoteUiErrorCode.INVALID_PATH, escaped.errorCode)

        val wrongOrigin = proxy.execute(
            request("https://evil.example/assets/remote/index.html", generation = 2L),
        )
        assertEquals(404, wrongOrigin.statusCode)
        assertEquals(RemoteUiErrorCode.INVALID_ORIGIN, wrongOrigin.errorCode)

        val traversal = proxy.execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/%2e%2e/secret.txt", generation = 3L),
        )
        assertEquals(404, traversal.statusCode)
        assertEquals(0, server.requestCount())
    }

    @Test
    fun `does not follow redirects or forward location`() {
        server.responder = { exchange ->
            respond(
                exchange,
                status = 302,
                headers = mapOf("Location" to "https://evil.example/redirected"),
            )
        }
        val response = proxy().execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/index.html", generation = 5L),
        )
        assertEquals(502, response.statusCode)
        assertEquals(RemoteUiErrorCode.UPSTREAM_REDIRECT, response.errorCode)
        assertNull(header(response, "Location"))
        assertEquals("no-store", header(response, "Cache-Control"))
        assertEquals(1, server.requestCount())
    }

    @Test
    fun `enforces declared and streamed response size limits`() {
        val proxy = proxy(maxResponseBytes = 16)

        server.responder = { exchange ->
            respond(exchange, status = 200, body = ByteArray(32))
        }
        val declared = proxy.execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js", generation = 1L),
        )
        assertEquals(413, declared.statusCode)
        assertEquals(RemoteUiErrorCode.RESPONSE_TOO_LARGE, declared.errorCode)
        assertNull(declared.body)

        server.responder = { exchange ->
            respond(exchange, status = 200, body = ByteArray(32), chunked = true)
        }
        val streamed = proxy.execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js", generation = 2L),
        )
        assertEquals(413, streamed.statusCode)
        assertEquals(RemoteUiErrorCode.RESPONSE_TOO_LARGE, streamed.errorCode)

        // JDK HttpServer 会为 HEAD 省略 Content-Length，无法用 fake server 验证声明长度上限；
        // 这里用 transport 结果覆盖 proxy 的 HEAD 超限分支。
        val headTransport = object : RemoteUiHttpTransport {
            override fun execute(request: RemoteUiHttpRequest): RemoteUiTransportResponse =
                RemoteUiTransportResponse(
                    statusCode = 200,
                    headers = emptyMap(),
                    body = null,
                    declaredContentLength = 32L,
                    exceededLimit = true,
                    redirect = false,
                )
        }
        val head = RemoteUiProxy(
            sessionContext = context(),
            maxResponseBytes = 16,
            transport = headTransport,
        ).execute(
            request(
                "$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js",
                method = "HEAD",
                generation = 3L,
            ),
        )
        assertEquals(413, head.statusCode)
        assertEquals(RemoteUiErrorCode.RESPONSE_TOO_LARGE, head.errorCode)
        assertEquals(2, server.requestCount())
    }

    @Test
    fun `maps read timeout to 504`() {
        server.responder = { exchange ->
            respond(exchange, status = 200, body = "late".toByteArray(), delayMillis = 500)
        }
        val response = proxy(readTimeoutMillis = 100).execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/index.html", generation = 6L),
        )
        assertEquals(504, response.statusCode)
        assertEquals(RemoteUiErrorCode.READ_TIMEOUT, response.errorCode)
        assertEquals(6L, response.generation)
        assertEquals("no-store", header(response, "Cache-Control"))
    }

    @Test
    fun `maps transport connect timeout to 504 without contacting server`() {
        val timeoutTransport = object : RemoteUiHttpTransport {
            override fun execute(request: RemoteUiHttpRequest): RemoteUiTransportResponse =
                throw RemoteUiTransportException(RemoteUiErrorCode.CONNECT_TIMEOUT)
        }
        val response = RemoteUiProxy(
            sessionContext = context(),
            transport = timeoutTransport,
        ).execute(request("$REMOTE_UI_ORIGIN/assets/remote/index.html", generation = 7L))

        assertEquals(504, response.statusCode)
        assertEquals(RemoteUiErrorCode.CONNECT_TIMEOUT, response.errorCode)
        assertEquals(0, server.requestCount())
    }

    @Test
    fun `strips cookie location and arbitrary response headers but keeps validators`() {
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = "x".toByteArray(),
                headers = mapOf(
                    "Content-Type" to "text/javascript",
                    "Cache-Control" to "public, max-age=31536000, immutable",
                    "Set-Cookie" to "session=leak",
                    "Location" to "https://evil.example/",
                    "Authorization" to "Bearer leak",
                    "X-Secret" to "drop",
                    "ETag" to "\"abc\"",
                    "Last-Modified" to "Wed, 21 Oct 2026 07:28:00 GMT",
                    "Expires" to "Thu, 21 Oct 2027 07:28:00 GMT",
                    "Vary" to "Accept-Encoding",
                    "Accept-Ranges" to "bytes",
                ),
            )
        }
        val response = proxy().execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js", generation = 1L),
        )
        assertEquals(200, response.statusCode)
        assertNull(header(response, "Set-Cookie"))
        assertNull(header(response, "Location"))
        assertNull(header(response, "Authorization"))
        assertNull(header(response, "X-Secret"))
        assertEquals("\"abc\"", header(response, "ETag"))
        assertEquals("Wed, 21 Oct 2026 07:28:00 GMT", header(response, "Last-Modified"))
        assertEquals("Thu, 21 Oct 2027 07:28:00 GMT", header(response, "Expires"))
        assertEquals("Accept-Encoding", header(response, "Vary"))
        assertEquals("bytes", header(response, "Accept-Ranges"))
    }

    @Test
    fun `passes upstream errors through with no-store and adds allow for 405`() {
        server.responder = { exchange ->
            respond(exchange, status = 405, body = "stripped".toByteArray())
        }
        val proxy = proxy()
        val first = proxy.execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/index.html", generation = 1L),
        )
        val second = proxy.execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/index.html", generation = 2L),
        )
        assertEquals(405, first.statusCode)
        assertEquals("GET, HEAD", header(first, "Allow"))
        assertEquals("no-store", header(first, "Cache-Control"))
        assertEquals("nosniff", header(first, "X-Content-Type-Options"))
        assertNull(first.body)
        assertNull(first.errorCode)
        assertEquals(2, server.requestCount())
        assertFalse(second.fromCache)
    }

    @Test
    fun `does not cache upstream 5xx`() {
        server.responder = { exchange ->
            respond(exchange, status = 500, body = "boom".toByteArray())
        }
        val proxy = proxy()
        val url = "$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js"
        val first = proxy.execute(request(url, generation = 1L))
        val second = proxy.execute(request(url, generation = 2L))
        assertEquals(500, first.statusCode)
        assertEquals(500, second.statusCode)
        assertFalse(first.fromCache)
        assertFalse(second.fromCache)
        assertEquals("no-store", header(first, "Cache-Control"))
        assertNull(first.body)
        assertEquals(2, server.requestCount())
    }

    @Test
    fun `uses path derived content type instead of upstream value`() {
        server.responder = { exchange ->
            respond(
                exchange,
                status = 200,
                body = "x".toByteArray(),
                headers = mapOf(
                    "Content-Type" to "text/plain",
                    "Cache-Control" to "no-cache",
                ),
            )
        }
        val response = proxy().execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/assets/index-abc12345.js", generation = 1L),
        )
        assertEquals("text/javascript; charset=utf-8", header(response, "Content-Type"))
        assertEquals("no-cache", header(response, "Cache-Control"))
    }

    @Test
    fun `rejects invalid session context without contacting gateway`() {
        val invalidBackend = RemoteUiProxy(
            RemoteUiSessionContext(
                sessionId = "session-1",
                gatewayBaseUrl = server.baseUrl,
                backendId = "../backend",
                bearerToken = "secret-token",
            ),
        )
        assertFalse(invalidBackend.hasValidSessionContext)
        val response = invalidBackend.execute(
            request("$REMOTE_UI_ORIGIN/mobile-ui/release", generation = 1L),
        )
        assertEquals(502, response.statusCode)
        assertEquals(RemoteUiErrorCode.INVALID_SESSION_CONTEXT, response.errorCode)

        val httpsOnly = RemoteUiProxy(
            sessionContext = context(),
            requireHttpsGateway = true,
        )
        assertFalse(httpsOnly.hasValidSessionContext)
        assertEquals(
            502,
            httpsOnly.execute(request("$REMOTE_UI_ORIGIN/mobile-ui/release", generation = 2L)).statusCode,
        )
        assertEquals(0, server.requestCount())
    }

    @Test
    fun `invokes controller supplied thread guard before any work`() {
        var invoked = false
        val proxy = proxy(threadGuard = { invoked = true })
        val response = proxy.execute(
            request("$REMOTE_UI_ORIGIN/assets/remote/index.html", method = "POST", generation = 1L),
        )
        assertTrue(invoked)
        assertEquals(405, response.statusCode)
    }

    private fun context(backendId: String = "backend-1"): RemoteUiSessionContext =
        RemoteUiSessionContext(
            sessionId = "session-1",
            gatewayBaseUrl = server.baseUrl,
            backendId = backendId,
            bearerToken = "secret-token",
        )

    private fun proxy(
        backendId: String = "backend-1",
        cache: RemoteUiResponseCache = RemoteUiResponseCache(),
        maxResponseBytes: Int = DEFAULT_MAX_RESPONSE_BYTES,
        readTimeoutMillis: Int = 5_000,
        threadGuard: (() -> Unit)? = null,
    ): RemoteUiProxy = RemoteUiProxy(
        sessionContext = context(backendId),
        cache = cache,
        connectTimeoutMillis = 5_000,
        readTimeoutMillis = readTimeoutMillis,
        maxResponseBytes = maxResponseBytes,
        requireHttpsGateway = false,
        threadGuard = threadGuard,
    )

    private fun request(
        url: String,
        method: String = "GET",
        generation: Long = 1L,
        requestHeaders: Map<String, String> = emptyMap(),
    ): RemoteUiInterceptRequest = RemoteUiInterceptRequest(
        method = method,
        url = url,
        generation = generation,
        requestHeaders = requestHeaders,
    )

    private fun header(response: RemoteUiInterceptResponse, name: String): String? =
        response.headers.entries
            .firstOrNull { it.key.equals(name, ignoreCase = true) }
            ?.value
}
