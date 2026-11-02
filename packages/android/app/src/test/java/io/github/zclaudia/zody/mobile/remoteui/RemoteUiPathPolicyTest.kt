package io.github.zclaudia.zody.mobile.remoteui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteUiPathPolicyTest {
    private val origin = REMOTE_UI_ORIGIN

    @Test
    fun `accepts release entry immutable and revalidated paths`() {
        val release = allowed("$origin/mobile-ui/release")
        assertEquals(RemoteUiAssetKind.RELEASE, release.kind)
        assertEquals("application/json; charset=utf-8", release.contentType)
        assertEquals("", release.query)

        val entry = allowed("$origin/assets/remote/index.html")
        assertEquals(RemoteUiAssetKind.ENTRY, entry.kind)
        assertEquals("text/html; charset=utf-8", entry.contentType)

        val immutable = allowed("$origin/assets/remote/assets/index-AbC12345.js")
        assertEquals(RemoteUiAssetKind.IMMUTABLE, immutable.kind)
        assertEquals("text/javascript; charset=utf-8", immutable.contentType)

        val font = allowed("$origin/assets/remote/assets/inter-abc12345.woff2")
        assertEquals(RemoteUiAssetKind.IMMUTABLE, font.kind)
        assertEquals("font/woff2", font.contentType)

        val revalidated = allowed("$origin/assets/remote/docs/manual.pdf")
        assertEquals(RemoteUiAssetKind.REVALIDATED, revalidated.kind)
        assertEquals("application/pdf", revalidated.contentType)

        // 先解码再校验：只编码了无保留字符的路径与明文路径等价。
        val encodedEntry = allowed("$origin/assets/remote/%69ndex.html")
        assertEquals(RemoteUiAssetKind.ENTRY, encodedEntry.kind)
    }

    @Test
    fun `keeps query for cache key and gateway forwarding`() {
        val allowed = allowed("$origin/mobile-ui/release?cache=1&lang=zh")
        assertEquals("cache=1&lang=zh", allowed.query)
    }

    @Test
    fun `rejects non fixed remote origins`() {
        assertRejected("http://remote.zody.local/assets/remote/index.html")
        assertRejected("https://remote.zody.local.evil/assets/remote/index.html")
        assertRejected("https://evil.example/assets/remote/index.html")
        assertRejected("https://remote.zody.local:8443/assets/remote/index.html")
        assertRejected("https://user:pass@remote.zody.local/assets/remote/index.html")
        assertRejected("wss://remote.zody.local/assets/remote/index.html")
    }

    @Test
    fun `rejects fragments and malformed urls`() {
        assertRejected("$origin/assets/remote/index.html#frag")
        assertRejected("not a url")
        assertRejected("")
        assertRejected("$origin")
    }

    @Test
    fun `rejects path escapes duplicates and dangerous escapes`() {
        val rejected = listOf(
            "$origin//assets/remote/index.html",
            "$origin/assets/remote/../secret.txt",
            "$origin/assets/remote/%2e%2e/secret.txt",
            "$origin/assets/remote/%2Fsecret.txt",
            "$origin/assets/remote/%5csecret.txt",
            "$origin/assets/remote/index%00.html",
            "$origin/assets/remote/index%0d.html",
            "$origin/assets/remote/.hidden.js",
            "$origin/assets/remote/assets/index-abc12345.js/",
            "$origin/assets/remote/release.json",
            "$origin/api/proxy/backend-1/mobile-ui/release",
            "$origin/other/path.js",
        )
        rejected.forEach(::assertRejected)
    }

    @Test
    fun `rejects unknown extensions and windows style segments`() {
        assertRejected("$origin/assets/remote/assets/index-abc12345.exe")
        assertRejected("$origin/assets/remote/assets/index-abc12345")
        assertRejected("$origin/assets/remote/assets/index-abc12345.js:stream")
        assertRejected("$origin/assets/remote/assets/%252e%252e.js")
    }

    @Test
    fun `normalizes gateway base url and derives csp origins`() {
        val normalized = normalize(
            RemoteUiSessionContext(
                sessionId = "session-1",
                gatewayBaseUrl = "wss://Gateway.Example:8443/deploy/",
                backendId = "backend-1",
                bearerToken = "token-value",
            ),
        )
        assertEquals("https://gateway.example:8443/deploy", normalized.gatewayBaseUrl)
        assertEquals("https://gateway.example:8443", normalized.gatewayOrigin)
        assertEquals("wss://gateway.example:8443", normalized.gatewayWsOrigin)
    }

    @Test
    fun `rejects invalid session context`() {
        val valid = RemoteUiSessionContext(
            sessionId = "session-1",
            gatewayBaseUrl = "https://gateway.example",
            backendId = "backend-1",
            bearerToken = "token-value",
        )
        assertNotNullNormalized(valid)

        assertNull(
            "backend path traversal must be rejected",
            normalizeOrNull(valid.copy(backendId = "../backend")),
        )
        assertNull("empty backend", normalizeOrNull(valid.copy(backendId = "")))
        assertNull("dot backend", normalizeOrNull(valid.copy(backendId = "..")))
        assertNull("gateway credentials", normalizeOrNull(valid.copy(gatewayBaseUrl = "https://u:p@gw.example")))
        assertNull("gateway query", normalizeOrNull(valid.copy(gatewayBaseUrl = "https://gw.example?x=1")))
        assertNull("gateway fragment", normalizeOrNull(valid.copy(gatewayBaseUrl = "https://gw.example#x")))
        assertNull("gateway escape", normalizeOrNull(valid.copy(gatewayBaseUrl = "https://gw.example/a/../b")))
        assertNull("empty token", normalizeOrNull(valid.copy(bearerToken = "")))
        assertNull("newline token", normalizeOrNull(valid.copy(bearerToken = "a\nb")))
        assertNull(
            "https required",
            RemoteUiPaths.normalizeSessionContext(
                valid.copy(gatewayBaseUrl = "http://gw.example"),
                requireHttpsGateway = true,
            ),
        )
    }

    @Test
    fun `builds gateway proxy url with backend prefix and query`() {
        val normalized = normalize(
            RemoteUiSessionContext(
                sessionId = "session-1",
                gatewayBaseUrl = "https://gateway.example/base",
                backendId = "backend-1",
                bearerToken = "token-value",
            ),
        )
        val target = RemoteUiPaths.buildGatewayProxyUrl(
            normalized,
            allowed("$origin/assets/remote/index.html?v=2"),
        )
        assertEquals(
            "https://gateway.example/base/api/proxy/backend-1/assets/remote/index.html?v=2",
            target,
        )
    }

    @Test
    fun `maps stable error codes to local statuses`() {
        assertEquals(405, RemoteUiPaths.statusForError(RemoteUiErrorCode.INVALID_METHOD))
        assertEquals(404, RemoteUiPaths.statusForError(RemoteUiErrorCode.INVALID_ORIGIN))
        assertEquals(404, RemoteUiPaths.statusForError(RemoteUiErrorCode.INVALID_PATH))
        assertEquals(502, RemoteUiPaths.statusForError(RemoteUiErrorCode.INVALID_SESSION_CONTEXT))
        assertEquals(502, RemoteUiPaths.statusForError(RemoteUiErrorCode.UPSTREAM_REDIRECT))
        assertEquals(413, RemoteUiPaths.statusForError(RemoteUiErrorCode.RESPONSE_TOO_LARGE))
        assertEquals(504, RemoteUiPaths.statusForError(RemoteUiErrorCode.CONNECT_TIMEOUT))
        assertEquals(504, RemoteUiPaths.statusForError(RemoteUiErrorCode.READ_TIMEOUT))
        assertEquals(502, RemoteUiPaths.statusForError(RemoteUiErrorCode.NETWORK_ERROR))
    }

    private fun allowed(url: String): RemoteUiPathResolution.Allowed {
        val result = RemoteUiPaths.resolveRemoteUiUrl(url)
        assertTrue("expected allowed but got $result for $url", result is RemoteUiPathResolution.Allowed)
        return result as RemoteUiPathResolution.Allowed
    }

    private fun assertRejected(url: String) {
        val result = RemoteUiPaths.resolveRemoteUiUrl(url)
        assertTrue("expected rejected but got $result for $url", result is RemoteUiPathResolution.Rejected)
        assertTrue((result as RemoteUiPathResolution.Rejected).status in setOf(404, 405))
    }

    private fun normalize(context: RemoteUiSessionContext): NormalizedRemoteUiSessionContext =
        normalizeOrNull(context) ?: error("expected valid context: $context")

    private fun normalizeOrNull(context: RemoteUiSessionContext): NormalizedRemoteUiSessionContext? =
        RemoteUiPaths.normalizeSessionContext(context, requireHttpsGateway = false)

    private fun assertNotNullNormalized(context: RemoteUiSessionContext) {
        assertNotNull(RemoteUiPaths.normalizeSessionContext(context, requireHttpsGateway = false))
    }

    private fun assertNotNull(value: Any?) {
        assertTrue(value != null)
    }
}
