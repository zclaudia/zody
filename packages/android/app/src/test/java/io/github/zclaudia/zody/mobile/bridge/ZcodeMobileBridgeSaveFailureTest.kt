package io.github.zclaudia.zody.mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Base64

/**
 * ZcodeMobileBridge 保存失败与孤儿回收（MF08）的 JVM 单测。
 *
 * 页面侧取消/失败路径依赖两个原生契约：
 * 1. append/finish 抛错后页面会调用 saveFileAbort，桥必须已把会话从 saveSessions 移除，
 *    后续同 token 的 finish 只能报 Unknown token，不能复用已失败会话；
 * 2. 页面 reload/崩溃后不会再回调 abort/finish，超容量时按 begin 顺序回收最早会话并 abort，
 *    避免 IS_PENDING 行与半成品文件无限滞留。
 */
class ZcodeMobileBridgeSaveFailureTest {
    private class RecordingSaveSession(
        override val displayName: String,
        private val appendFailure: IOException? = null,
        private val finishFailure: IOException? = null,
    ) : MobileFileSaveSession {
        var aborted = false
        var finished = false

        override fun append(bytes: ByteArray) {
            appendFailure?.let { throw it }
        }

        override fun finish(): SavedMobileFile {
            finished = true
            finishFailure?.let { throw it }
            return SavedMobileFile(
                uri = "content://io.github.zclaudia.zody.mobile.fileprovider/downloads/$displayName",
                displayPath = "Download/$displayName",
            )
        }

        override fun abort() {
            aborted = true
        }
    }

    private class RecordingFileSaver(
        private val appendFailure: IOException? = null,
        private val finishFailure: IOException? = null,
    ) : MobileFileSaver {
        val sessions = mutableListOf<RecordingSaveSession>()

        override fun begin(fileName: String, mimeType: String): MobileFileSaveSession {
            val session = RecordingSaveSession(
                displayName = MobileFileNames.sanitize(fileName),
                appendFailure = appendFailure,
                finishFailure = finishFailure,
            )
            sessions += session
            return session
        }
    }

    private class InMemorySecureStore : SecureKeyValueStore {
        val values = mutableMapOf<String, String>()

        override fun get(key: String): String? = values[key]

        override fun set(key: String, value: String) {
            values[key] = value
        }

        override fun remove(key: String) {
            values.remove(key)
        }
    }

    private fun createBridge(saver: RecordingFileSaver) = ZcodeMobileBridge(
        secureStore = InMemorySecureStore(),
        fileSaver = saver,
        decodeBase64 = { value -> Base64.getDecoder().decode(value) },
    )

    @Test
    fun `append 抛 IOException 后页面 abort 清理会话且二次 finish 报未知 token`() {
        val saver = RecordingFileSaver(appendFailure = IOException("disk full"))
        val bridge = createBridge(saver)

        val token = bridge.saveFileBegin("report.pdf", "application/pdf")
        val append = runCatching {
            bridge.saveFileAppend(token, Base64.getEncoder().encodeToString("hello".toByteArray()))
        }
        assertTrue(append.exceptionOrNull() is IOException)

        bridge.saveFileAbort(token)
        val session = saver.sessions.single()
        assertTrue(session.aborted)
        assertFalse(session.finished)

        // 会话已被 abort 清除；同 token 的迟到 finish 只能报 Unknown token，不能复用失败会话。
        val secondFinish = runCatching { bridge.saveFileFinish(token) }
        assertTrue(secondFinish.exceptionOrNull() is IllegalArgumentException)
        assertEquals("Unknown save session token.", secondFinish.exceptionOrNull()?.message)
    }

    @Test
    fun `finish 抛 IOException 时会话被移除并 abort，不留下可复用的会话`() {
        val saver = RecordingFileSaver(finishFailure = IOException("media store rejected"))
        val bridge = createBridge(saver)

        val token = bridge.saveFileBegin("report.pdf", "application/pdf")
        bridge.saveFileAppend(token, Base64.getEncoder().encodeToString("hello".toByteArray()))

        val finish = runCatching { bridge.saveFileFinish(token) }
        assertTrue(finish.exceptionOrNull() is IOException)

        val session = saver.sessions.single()
        // finish 失败必须走 abort 清理半成品，且 token 已从 saveSessions 移除。
        assertTrue(session.aborted)
        val retryFinish = runCatching { bridge.saveFileFinish(token) }
        assertTrue(retryFinish.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun `超过容量上限时回收最早的孤儿会话`() {
        val saver = RecordingFileSaver()
        val bridge = createBridge(saver)
        val tokens = mutableListOf<String>()
        repeat(9) { index ->
            tokens += bridge.saveFileBegin("report-$index.pdf", "application/pdf")
        }

        // 页面 reload 场景：9 个 begin 都没有 finish/abort；第 9 个 begin 触发回收最早的一个。
        assertEquals(9, saver.sessions.size)
        assertTrue(saver.sessions.first().aborted)
        assertFalse(saver.sessions.last().aborted)
        // 被回收的 token 已不可用。
        val evictedFinish = runCatching { bridge.saveFileFinish(tokens.first()) }
        assertTrue(evictedFinish.exceptionOrNull() is IllegalArgumentException)
        // 其余会话仍然可以正常 finish。
        assertTrue(bridge.saveFileFinish(tokens.last()).contains("report-8.pdf"))
    }

    @Test
    fun `正常 finish 的会话不占用孤儿容量`() {
        val saver = RecordingFileSaver()
        val bridge = createBridge(saver)

        repeat(12) { index ->
            val token = bridge.saveFileBegin("report-$index.pdf", "application/pdf")
            bridge.saveFileFinish(token)
        }

        // 每次 finish 都即时移除会话，容量回收不会误伤任何已完成的保存。
        assertEquals(12, saver.sessions.size)
        assertTrue(saver.sessions.none { it.aborted })
    }
}
