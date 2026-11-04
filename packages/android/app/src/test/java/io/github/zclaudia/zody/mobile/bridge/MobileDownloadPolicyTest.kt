package io.github.zclaudia.zody.mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileDownloadPolicyTest {
    @Test
    fun `classifies every download scheme the WebView can hand over`() {
        assertEquals(
            MobileDownloadPolicy.SourceKind.DATA_URL,
            MobileDownloadPolicy.classify("data:text/plain;base64,aGVsbG8="),
        )
        assertEquals(
            MobileDownloadPolicy.SourceKind.CONTENT_URI,
            MobileDownloadPolicy.classify("content://media/external/downloads/1"),
        )
        assertEquals(
            MobileDownloadPolicy.SourceKind.HTTP,
            MobileDownloadPolicy.classify("HTTPS://gateway.test/report.pdf"),
        )
        assertEquals(
            MobileDownloadPolicy.SourceKind.HTTP,
            MobileDownloadPolicy.classify("http://gateway.test/report.pdf"),
        )
        // blob: 只在渲染进程内可读，原生必须明确拒绝而不是尝试当文件读取。
        assertEquals(
            MobileDownloadPolicy.SourceKind.BLOB_UNSUPPORTED,
            MobileDownloadPolicy.classify("blob:https://remote.zody.local/abc"),
        )
        assertEquals(
            MobileDownloadPolicy.SourceKind.UNSUPPORTED,
            MobileDownloadPolicy.classify("file:///sdcard/secret"),
        )
    }

    @Test
    fun `only the captured session can finish the download`() {
        assertTrue(MobileDownloadPolicy.isCurrentSession("session-a", "session-a"))
        // backend 切换/Activity 重建后旧 session 不再是当前会话。
        assertFalse(MobileDownloadPolicy.isCurrentSession("session-a", "session-b"))
        assertFalse(MobileDownloadPolicy.isCurrentSession("session-a", null))
        assertFalse(MobileDownloadPolicy.isCurrentSession(null, "session-a"))
        assertFalse(MobileDownloadPolicy.isCurrentSession("  ", "  "))
    }

    @Test
    fun `prefers the explicit mime then the response and finally the file name`() {
        assertEquals(
            "image/png",
            MobileDownloadPolicy.resolveMimeType(
                requested = "image/png; charset=binary",
                response = "application/octet-stream",
                contentDisposition = "attachment; filename=\"report.pdf\"",
            ),
        )
        assertEquals(
            "application/pdf",
            MobileDownloadPolicy.resolveMimeType(
                requested = null,
                response = "application/pdf; charset=binary",
                contentDisposition = "attachment; filename=\"report.pdf\"",
            ),
        )
        assertEquals(
            "application/pdf",
            MobileDownloadPolicy.resolveMimeType(
                requested = " ",
                response = null,
                contentDisposition = "attachment; filename=\"report.pdf\"",
            ),
        )
    }

    @Test
    fun `resolves and sanitizes the download file name`() {
        assertEquals(
            "report.pdf",
            MobileDownloadPolicy.resolveFileName(
                url = "https://gateway.test/download?id=1",
                contentDisposition = "attachment; filename=\"../report.pdf\"",
                mimeType = "application/pdf",
            ),
        )
        assertEquals(
            "file.zip",
            MobileDownloadPolicy.resolveFileName(
                url = "https://gateway.test/a/file.zip?token=1",
                contentDisposition = null,
                mimeType = "application/zip",
            ),
        )
        assertEquals(
            "download.pdf",
            MobileDownloadPolicy.resolveFileName(
                url = "https://gateway.test/",
                contentDisposition = null,
                mimeType = "application/pdf",
            ),
        )
    }
}
