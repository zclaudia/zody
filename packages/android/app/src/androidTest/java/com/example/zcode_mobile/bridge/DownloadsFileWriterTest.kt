package com.example.zcode_mobile.bridge

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * MediaStore 下载写入的仪器测试（T6.3）。
 *
 * JVM 单测无法创建 MediaStore 行；这里在 API 29+ 设备/模拟器上真实写入「下载」目录，
 * 再按返回的 content URI 读回字节，确认分块追加、提交和清理都生效。
 */
@RunWith(AndroidJUnit4::class)
class DownloadsFileWriterTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val savedUris = mutableListOf<String>()

    @After
    fun cleanup() {
        for (uri in savedUris) {
            runCatching { context.contentResolver.delete(Uri.parse(uri), null, null) }
        }
    }

    @Test
    fun writesChunksIntoTheDownloadsCollection() {
        val expected = "ZCode T6.3 download test\n".toByteArray() + ByteArray(4096) { 7 }
        val writer = DownloadsFileWriter(context)

        val session = writer.begin("../t63-download-test.txt", "text/plain")
        session.append("ZCode T6.3 download test\n".toByteArray())
        session.append(ByteArray(4096) { 7 })
        val saved = session.finish()
        savedUris += saved.uri

        assertTrue("Download URI should be a content URI", saved.uri.startsWith("content://"))
        assertTrue("Display path should point at Downloads", saved.displayPath.startsWith("Download/"))
        val bytes = context.contentResolver.openInputStream(Uri.parse(saved.uri))!!.use {
            it.readBytes()
        }
        assertArrayEquals(expected, bytes)
    }

    @Test
    fun abortRemovesThePendingFile() {
        val writer = DownloadsFileWriter(context)
        val session = writer.begin("t63-abort-test.txt", "text/plain")
        session.append("partial".toByteArray())
        session.abort()

        val displayName = session.displayName
        val projection = arrayOf(android.provider.MediaStore.Downloads._ID)
        val selection = "${android.provider.MediaStore.Downloads.DISPLAY_NAME} = ?"
        val cursor = context.contentResolver.query(
            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            arrayOf(displayName),
            null,
        )
        cursor?.use {
            assertTrue("Aborted download should not be visible", it.count == 0)
        }
    }
}
