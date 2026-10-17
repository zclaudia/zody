package com.example.zcode_mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * ZcodeMobileBridge 的 JVM 单测（T6.2/T6.3）。
 *
 * EncryptedSharedPreferences 需要 Android Keystore 运行时，由同一模块的仪器测试覆盖；
 * 这里用内存实现验证 @JavascriptInterface 对外契约：安全存储、文件分块保存、错误传播。
 */
class ZcodeMobileBridgeTest {
    private class InMemorySecureStore : SecureKeyValueStore {
        val values = mutableMapOf<String, String>()
        var failure: RuntimeException? = null

        override fun get(key: String): String? = values[key]

        override fun set(key: String, value: String) {
            failure?.let { throw it }
            values[key] = value
        }

        override fun remove(key: String) {
            failure?.let { throw it }
            values.remove(key)
        }
    }

    private class FakeFileSaveSession(
        override val displayName: String,
    ) : MobileFileSaveSession {
        val bytes = mutableListOf<Byte>()
        var finished = false
        var aborted = false

        override fun append(bytes: ByteArray) {
            bytes.forEach { this.bytes += it }
        }

        override fun finish(): SavedMobileFile {
            finished = true
            return SavedMobileFile(
                uri = "content://com.example.zcode_mobile.fileprovider/downloads/$displayName",
                displayPath = "Download/$displayName",
            )
        }

        override fun abort() {
            aborted = true
        }
    }

    private class FakeFileSaver : MobileFileSaver {
        var requestedFileName: String? = null
        var requestedMimeType: String? = null
        lateinit var session: FakeFileSaveSession

        override fun begin(fileName: String, mimeType: String): MobileFileSaveSession {
            requestedFileName = fileName
            requestedMimeType = mimeType
            session = FakeFileSaveSession(MobileFileNames.sanitize(fileName))
            return session
        }
    }

    private class FakeFileOpener : MobileFileOpener {
        val opened = mutableListOf<Pair<String, String>>()

        override fun open(uri: String, mimeType: String): Boolean {
            opened += uri to mimeType
            return true
        }
    }

    private fun createBridge(
        store: InMemorySecureStore = InMemorySecureStore(),
        saver: FakeFileSaver? = null,
        opener: FakeFileOpener? = null,
    ) = ZcodeMobileBridge(
        secureStore = store,
        fileSaver = saver,
        fileOpener = opener,
        decodeBase64 = { value -> Base64.getDecoder().decode(value) },
    )

    @Test
    fun `writes reads and removes a secure value`() {
        val store = InMemorySecureStore()
        val bridge = ZcodeMobileBridge(store)

        assertNull(bridge.secureStoreGet("config"))

        bridge.secureStoreSet("config", """{"credential":"zgd_test"}""")
        assertEquals("""{"credential":"zgd_test"}""", bridge.secureStoreGet("config"))
        assertEquals("""{"credential":"zgd_test"}""", store.values["config"])

        bridge.secureStoreRemove("config")
        assertNull(bridge.secureStoreGet("config"))
    }

    @Test
    fun `rejects blank keys`() {
        val bridge = ZcodeMobileBridge(InMemorySecureStore())

        val read = runCatching { bridge.secureStoreGet(" ") }
        val write = runCatching { bridge.secureStoreSet("", "value") }
        val remove = runCatching { bridge.secureStoreRemove("\t") }

        assertTrue(read.exceptionOrNull() is IllegalArgumentException)
        assertTrue(write.exceptionOrNull() is IllegalArgumentException)
        assertTrue(remove.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun `propagates storage failures to the page`() {
        val store = InMemorySecureStore()
        store.failure = IllegalStateException("keystore unavailable")
        val bridge = ZcodeMobileBridge(store)

        val write = runCatching { bridge.secureStoreSet("config", "zgd_test") }

        assertEquals("keystore unavailable", write.exceptionOrNull()?.message)
    }

    @Test
    fun `saves a file as base64 chunks and reports the saved uri`() {
        val saver = FakeFileSaver()
        val opener = FakeFileOpener()
        val bridge = createBridge(saver = saver, opener = opener)

        val token = bridge.saveFileBegin("../report.pdf", "application/pdf")
        bridge.saveFileAppend(token, Base64.getEncoder().encodeToString("hello ".toByteArray()))
        bridge.saveFileAppend(token, Base64.getEncoder().encodeToString("world".toByteArray()))
        val saved = bridge.saveFileFinish(token)

        assertEquals("../report.pdf", saver.requestedFileName)
        assertEquals("application/pdf", saver.requestedMimeType)
        assertEquals("hello world", saver.session.bytes.toByteArray().decodeToString())
        assertTrue(saver.session.finished)
        assertEquals(
            """{"uri":"content://com.example.zcode_mobile.fileprovider/downloads/report.pdf",""" +
                """"displayPath":"Download/report.pdf"}""",
            saved,
        )

        // 打开动作由页面在保存成功后调用，MIME 原样传回。
        assertTrue(
            bridge.openFile(
                "content://com.example.zcode_mobile.fileprovider/downloads/report.pdf",
                "application/pdf",
            ),
        )
        assertEquals(
            "content://com.example.zcode_mobile.fileprovider/downloads/report.pdf" to
                "application/pdf",
            opener.opened.single(),
        )
    }

    @Test
    fun `aborting a save removes the session without finishing`() {
        val saver = FakeFileSaver()
        val bridge = createBridge(saver = saver)

        val token = bridge.saveFileBegin("report.txt", "text/plain")
        bridge.saveFileAbort(token)

        assertTrue(saver.session.aborted)
        assertFalse(saver.session.finished)
        val finish = runCatching { bridge.saveFileFinish(token) }
        assertTrue(finish.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun `rejects unknown tokens and missing file capabilities`() {
        val bridge = createBridge(saver = FakeFileSaver())
        assertTrue(
            runCatching { bridge.saveFileFinish("missing") }.exceptionOrNull()
                is IllegalArgumentException,
        )

        val withoutFiles = ZcodeMobileBridge(InMemorySecureStore())
        assertTrue(
            runCatching { withoutFiles.saveFileBegin("a.txt", "text/plain") }
                .exceptionOrNull() is IllegalStateException,
        )
        assertTrue(
            runCatching { withoutFiles.openFile("content://media/1", "text/plain") }
                .exceptionOrNull() is IllegalStateException,
        )
    }

    @Test
    fun `rejects blank or oversized chunks`() {
        val bridge = createBridge(saver = FakeFileSaver())
        val token = bridge.saveFileBegin("a.bin", "application/octet-stream")

        assertTrue(
            runCatching { bridge.saveFileAppend(token, " ") }.exceptionOrNull()
                is IllegalArgumentException,
        )

        val oversized = Base64.getEncoder().encodeToString(ByteArray(1024 * 1024 + 1))
        assertTrue(
            runCatching { bridge.saveFileAppend(token, oversized) }.exceptionOrNull()
                is IllegalArgumentException,
        )
    }
}
