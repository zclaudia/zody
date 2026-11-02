package io.github.zclaudia.zody.mobile.ui.shell

import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptResponse
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteUiWebResponseTest {
    private fun response(
        statusCode: Int = 200,
        headers: Map<String, String> = mapOf(
            "Content-Type" to "text/html; charset=utf-8",
            "Content-Security-Policy" to "default-src 'none'",
            "X-Frame-Options" to "DENY",
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
            "Cache-Control" to "no-store",
        ),
        body: ByteArray? = "<html></html>".toByteArray(),
    ): RemoteUiInterceptResponse =
        RemoteUiInterceptResponse(
            statusCode = statusCode,
            reasonPhrase = "OK",
            headers = headers,
            body = body,
            generation = 3L,
        )

    @Test
    fun `splits mime and charset and preserves native security headers`() {
        val web = response().toWebResponse("GET")

        assertEquals("text/html", web.mimeType)
        assertEquals("utf-8", web.encoding)
        assertEquals(200, web.statusCode)
        assertArrayEquals("<html></html>".toByteArray(), web.body)

        // WebResourceResponse 用自己的 MIME/charset 字段；头表只保留安全/缓存头，并统一小写。
        assertEquals("default-src 'none'", web.headers["content-security-policy"])
        assertEquals("DENY", web.headers["x-frame-options"])
        assertEquals("nosniff", web.headers["x-content-type-options"])
        assertEquals("no-referrer", web.headers["referrer-policy"])
        assertEquals("no-store", web.headers["cache-control"])
        assertFalse(web.headers.containsKey("content-type"))
    }

    @Test
    fun `HEAD responses always produce an empty stream while keeping metadata`() {
        val web = response(body = "ignored".toByteArray()).toWebResponse("HEAD")

        assertEquals(0, web.body.size)
        assertEquals("text/html", web.mimeType)
        assertEquals("utf-8", web.encoding)
        assertEquals("no-store", web.headers["cache-control"])
    }

    @Test
    fun `error responses produce an empty stream and retain 405 allow`() {
        val web = response(
            statusCode = 405,
            headers = mapOf(
                "Content-Type" to "text/plain; charset=utf-8",
                "Allow" to "GET, HEAD",
                "Cache-Control" to "no-store",
            ),
            body = null,
        ).toWebResponse("GET")

        assertEquals(405, web.statusCode)
        assertEquals(0, web.body.size)
        assertEquals("GET, HEAD", web.headers["allow"])
        assertEquals("no-store", web.headers["cache-control"])
    }

    @Test
    fun `content type without charset keeps a null encoding`() {
        val web = response(
            headers = mapOf("Content-Type" to "application/javascript"),
        ).toWebResponse("GET")

        assertEquals("application/javascript", web.mimeType)
        assertNull(web.encoding)
        assertTrue(web.body.isNotEmpty())
    }

    @Test
    fun `quoted charset is unwrapped`() {
        val web = response(
            headers = mapOf("Content-Type" to "text/css; charset=\"UTF-8\""),
        ).toWebResponse("GET")

        assertEquals("text/css", web.mimeType)
        assertEquals("UTF-8", web.encoding)
    }
}
