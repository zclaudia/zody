package com.example.zcode_mobile.bridge

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 安全存储的最小接口（T6.2）。
 *
 * 生产实现走 Android Keystore + EncryptedSharedPreferences；抽成接口是为了让 JVM 单测
 * 能用内存实现覆盖桥的读写/删除与错误传播，而不依赖 Android Keystore 运行时。
 */
interface SecureKeyValueStore {
    fun get(key: String): String?

    fun set(key: String, value: String)

    fun remove(key: String)
}

/**
 * 手机远控凭证存储（T6.2）。
 *
 * 方案「状态归属」要求手机端 gateway 配置、设备凭证和所选电脑落在 Android 原生安全存储：
 * - `MasterKey` 由 Android Keystore 生成并持有 AES256-GCM 主密钥，永不导出；
 * - `EncryptedSharedPreferences` 用 AES256-SIV 加密 key、AES256-GCM 加密 value。
 *
 * 文件只属于本应用（`allowBackup=false` 避免进入备份）。页面通过
 * `ZcodeMobileBridge.secureStoreGet/Set/Remove` 访问，不接触明文文件。
 */
// security-crypto 1.1.0 把 EncryptedSharedPreferences/MasterKey 标记为 deprecated，但方案明确要求
// 这组 API；后续迁移时只需替换本类实现，SecureKeyValueStore 与桥契约不变。
@Suppress("DEPRECATION")
class EncryptedSharedPreferencesSecureStore(context: Context) : SecureKeyValueStore {
    private val appContext = context.applicationContext

    // 首次访问才创建：Keystore 初始化失败时由具体读写调用把错误抛回 JS，而不是让 Activity 启动崩溃。
    private val preferences: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override fun get(key: String): String? = preferences.getString(key, null)

    override fun set(key: String, value: String) {
        // 用 commit 而不是 apply：@JavascriptInterface 方法返回时写入必须已经落盘，
        // 设置页才能在返回后立即读到凭证；失败要抛回页面，不能静默丢凭证。
        check(preferences.edit().putString(key, value).commit()) {
            "Failed to persist the secure value."
        }
    }

    override fun remove(key: String) {
        check(preferences.edit().remove(key).commit()) {
            "Failed to remove the secure value."
        }
    }

    companion object {
        private const val FILE_NAME = "zcode_mobile_secure_store"
    }
}
