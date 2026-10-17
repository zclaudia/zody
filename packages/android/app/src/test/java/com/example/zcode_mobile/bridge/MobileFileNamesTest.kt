package com.example.zcode_mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MobileFileNamesTest {
    @Test
    fun `sanitizes path traversal and control characters`() {
        assertEquals("report.pdf", MobileFileNames.sanitize("../../etc/report.pdf"))
        assertEquals("report.pdf", MobileFileNames.sanitize("C:\\Users\\me\\report.pdf"))
        assertEquals("report.pdf", MobileFileNames.sanitize("  report\u0000.pdf  "))
        // 全是点的名字没有可用 basename，回落到默认名而不是保留隐藏文件/相对路径。
        assertEquals(MobileFileNames.DEFAULT_FILE_NAME, MobileFileNames.sanitize(".."))
    }

    @Test
    fun `falls back to a default name for empty input`() {
        assertEquals(MobileFileNames.DEFAULT_FILE_NAME, MobileFileNames.sanitize(""))
        assertEquals(MobileFileNames.DEFAULT_FILE_NAME, MobileFileNames.sanitize(" / "))
    }

    @Test
    fun `keeps the extension while truncating long names`() {
        val longName = "a".repeat(200) + ".tar"
        val sanitized = MobileFileNames.sanitize(longName)

        assertEquals(120, sanitized.length)
        assertEquals(".tar", sanitized.takeLast(4))
    }

    @Test
    fun `infers mime types and default download names`() {
        assertEquals("application/pdf", MobileFileNames.inferMimeType("Report.PDF"))
        assertEquals("image/png", MobileFileNames.inferMimeType("photo.png"))
        assertEquals("application/octet-stream", MobileFileNames.inferMimeType("unknown.bin"))
        assertEquals("download.pdf", MobileFileNames.defaultNameForMimeType("application/pdf"))
        assertEquals("download", MobileFileNames.defaultNameForMimeType("application/x-unknown"))
    }

    @Test
    fun `parses content disposition file names`() {
        assertEquals(
            "报告 2026.pdf",
            MobileFileNames.parseContentDispositionFileName(
                "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.pdf",
            ),
        )
        assertEquals(
            "report.pdf",
            MobileFileNames.parseContentDispositionFileName("attachment; filename=\"report.pdf\""),
        )
        assertEquals(
            "plain.txt",
            MobileFileNames.parseContentDispositionFileName("attachment; filename=plain.txt"),
        )
        assertNull(MobileFileNames.parseContentDispositionFileName(null))
        assertNull(MobileFileNames.parseContentDispositionFileName("attachment"))
    }

    @Test
    fun `extracts a file name from a url`() {
        assertEquals("file.zip", MobileFileNames.fileNameFromUrl("https://x.test/a/file.zip?token=1"))
        assertEquals("file.zip", MobileFileNames.fileNameFromUrl("https://x.test/a/file.zip#frag"))
        assertNull(MobileFileNames.fileNameFromUrl("https://x.test/"))
        // data:/content: 的路径不是文件名，不能把整段 base64/数据库 id 当下载名。
        assertNull(MobileFileNames.fileNameFromUrl("data:text/plain;base64,aGVsbG8="))
        assertNull(MobileFileNames.fileNameFromUrl("content://media/external/downloads/42"))
    }

    @Test
    fun `encodes the saved file as json for the page`() {
        val encoded = MobileFileNames.encodeSavedFile(
            SavedMobileFile(
                uri = "content://media/external/downloads/1",
                displayPath = "Download/a\"b.txt",
            ),
        )

        assertEquals(
            """{"uri":"content://media/external/downloads/1",""" +
                """"displayPath":"Download/a\"b.txt"}""",
            encoded,
        )
    }
}
