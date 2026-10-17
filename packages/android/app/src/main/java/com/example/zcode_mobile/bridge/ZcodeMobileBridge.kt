package com.example.zcode_mobile.bridge

import android.util.Base64
import android.webkit.JavascriptInterface
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * 页面 ↔ Android 壳的原生桥（T6.2 安全存储/事件；T6.3 文件能力）。
 *
 * 通过 `WebView.addJavascriptInterface(..., "ZcodeMobileBridge")` 注入。`@JavascriptInterface`
 * 只能暴露平铺方法，所以安全存储用 `secureStoreGet/Set/Remove`，文件保存用
 * `saveFileBegin/Append/Finish/Abort`；页面侧 `packages/web/src/mobile-remote/` 的适配器会把
 * 它们归一化成 `IPlatformService` 的能力，其余页面代码不需要知道注入细节。
 *
 * 安全边界：WebView 只加载内置的 `appassets.androidplatform.net/assets/remote/` 页面，
 * 主框架导航离开该 origin 会被交给系统浏览器，因此这些方法不会暴露给任意远端页面。
 *
 * 文件保存按块传输：页面把每一块编码成 base64，桥解码后追加到会话；一次保存的最大块
 * 由 [MAX_CHUNK_BYTES] 限制，避免单次 JS 调用占用过多内存。
 */
class ZcodeMobileBridge(
    private val secureStore: SecureKeyValueStore,
    private val fileSaver: MobileFileSaver? = null,
    private val fileOpener: MobileFileOpener? = null,
    private val decodeBase64: (String) -> ByteArray = { value ->
        Base64.decode(value, Base64.NO_WRAP)
    },
) {
    private val saveSessions = ConcurrentHashMap<String, MobileFileSaveSession>()

    @JavascriptInterface
    fun secureStoreGet(key: String): String? {
        requireValidKey(key)
        return secureStore.get(key)
    }

    @JavascriptInterface
    fun secureStoreSet(key: String, value: String) {
        requireValidKey(key)
        secureStore.set(key, value)
    }

    @JavascriptInterface
    fun secureStoreRemove(key: String) {
        requireValidKey(key)
        secureStore.remove(key)
    }

    /**
     * 开始保存文件，返回本次保存的 token。
     * 页面随后调用 [saveFileAppend] 追加内容，最后调用 [saveFileFinish] 提交并打开。
     */
    @JavascriptInterface
    fun saveFileBegin(fileName: String, mimeType: String): String {
        val saver = requireFileSaver()
        val token = UUID.randomUUID().toString()
        saveSessions[token] = saver.begin(fileName, mimeType)
        return token
    }

    @JavascriptInterface
    fun saveFileAppend(token: String, chunkBase64: String) {
        val session = requireSession(token)
        require(chunkBase64.isNotBlank()) { "File chunk must not be blank." }
        val bytes = decodeBase64(chunkBase64)
        require(bytes.size <= MAX_CHUNK_BYTES) {
            "File chunk exceeds the $MAX_CHUNK_BYTES byte limit."
        }
        session.append(bytes)
    }

    /**
     * 提交保存，返回 `{"uri": "...", "displayPath": "Download/..."}`。
     * 页面用 uri 调用 [openFile]；displayPath 只用于展示保存位置。
     */
    @JavascriptInterface
    fun saveFileFinish(token: String): String {
        val session = requireSession(token)
        saveSessions.remove(token)
        return try {
            MobileFileNames.encodeSavedFile(session.finish())
        } catch (error: Throwable) {
            runCatching { session.abort() }
            throw error
        }
    }

    @JavascriptInterface
    fun saveFileAbort(token: String) {
        saveSessions.remove(token)?.abort()
    }

    /** 用系统默认应用打开刚保存的文件；返回 false 表示没有可用应用。 */
    @JavascriptInterface
    fun openFile(uri: String, mimeType: String): Boolean {
        val opener = fileOpener ?: throw IllegalStateException(
            "Opening files is not available in this build.",
        )
        return opener.open(uri, mimeType)
    }

    private fun requireFileSaver(): MobileFileSaver =
        fileSaver ?: throw IllegalStateException("Saving files is not available in this build.")

    private fun requireSession(token: String): MobileFileSaveSession {
        require(token.isNotBlank()) { "Save session token must not be blank." }
        return saveSessions[token]
            ?: throw IllegalArgumentException("Unknown save session token.")
    }

    private fun requireValidKey(key: String) {
        // 空 key 在 EncryptedSharedPreferences 里没有意义；明确失败比静默写入更安全。
        require(key.isNotBlank()) { "Secure store key must not be blank." }
    }

    private companion object {
        // 页面按 256 KiB 分块；留 4 倍余量，仍能挡住异常调用。
        const val MAX_CHUNK_BYTES = 1024 * 1024
    }
}
