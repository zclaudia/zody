package com.example.zcode_mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ZcodeMobileBridge 的 JVM 单测（T6.2）。
 *
 * EncryptedSharedPreferences 需要 Android Keystore 运行时，由同一模块的仪器测试覆盖；
 * 这里用内存实现验证 @JavascriptInterface 对外契约：读写、删除、key 校验和错误传播。
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
}
