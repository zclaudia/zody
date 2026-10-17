package com.example.zcode_mobile.bridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android Keystore + EncryptedSharedPreferences 的真实存储读写（T6.2）。
 *
 * JVM 单测无法初始化 Android Keystore，所以加密落盘由设备/模拟器上的仪器测试覆盖：
 * 先验证读写删除，再检查 SharedPreferences 文件里没有凭证明文。
 */
@RunWith(AndroidJUnit4::class)
class EncryptedSharedPreferencesSecureStoreTest {
    @Test
    fun writesReadsAndRemovesValues() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = EncryptedSharedPreferencesSecureStore(context)
        val key = "t62-test-key"
        val value = "zgd_t62_secret_value"

        store.remove(key)
        assertNull(store.get(key))

        store.set(key, value)
        assertEquals(value, store.get(key))

        val prefsFile = File(context.dataDir, "shared_prefs/$STORE_FILE_NAME.xml")
        assertTrue("EncryptedSharedPreferences file should exist", prefsFile.isFile)
        assertFalse(
            "Credential must not be stored in plaintext",
            prefsFile.readText().contains(value),
        )

        store.remove(key)
        assertNull(store.get(key))
    }

    private companion object {
        // 与 EncryptedSharedPreferencesSecureStore.FILE_NAME 保持一致。
        const val STORE_FILE_NAME = "zcode_mobile_secure_store"
    }
}
