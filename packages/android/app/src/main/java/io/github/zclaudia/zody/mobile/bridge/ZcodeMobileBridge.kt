package io.github.zclaudia.zody.mobile.bridge

import android.util.Base64
import android.webkit.JavascriptInterface
import io.github.zclaudia.zody.mobile.BuildConfig
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

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
    private val mobileNotificationBridge: MobileNotificationBridgeClient? = null,
    private val requestNotificationPermission: (() -> Unit)? = null,
    private val decodeBase64: (String) -> ByteArray = { value ->
        Base64.decode(value, Base64.NO_WRAP)
    },
) {
    /**
     * 保存会话条目。
     *
     * MF08: 页面 reload/崩溃后不会再回调 finish/abort，IS_PENDING 行和 fd 会滞留成孤儿。
     * 记录单调序号（不用墙钟，避免同毫秒 begin 无法确定“最早”）用于容量超限时的最早孤儿回收。
     */
    private data class SaveSessionEntry(
        val session: MobileFileSaveSession,
        val sequence: Long,
    )

    private val saveSessions = ConcurrentHashMap<String, SaveSessionEntry>()
    private val saveSessionSequence = AtomicLong()

    @JavascriptInterface
    fun allowsInsecureGatewayTransport(): Boolean = BuildConfig.DEBUG

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
        evictOrphanedSaveSessions()
        val token = UUID.randomUUID().toString()
        saveSessions[token] = SaveSessionEntry(saver.begin(fileName, mimeType), saveSessionSequence.incrementAndGet())
        return token
    }

    @JavascriptInterface
    fun saveFileAppend(token: String, chunkBase64: String) {
        val session = requireSession(token).session
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
        val entry = requireSession(token)
        saveSessions.remove(token)
        return try {
            MobileFileNames.encodeSavedFile(entry.session.finish())
        } catch (error: Throwable) {
            runCatching { entry.session.abort() }
            throw error
        }
    }

    @JavascriptInterface
    fun saveFileAbort(token: String) {
        saveSessions.remove(token)?.session?.abort()
    }

    /** 用系统默认应用打开刚保存的文件；返回 false 表示没有可用应用。 */
    @JavascriptInterface
    fun openFile(uri: String, mimeType: String): Boolean {
        val opener = fileOpener ?: throw IllegalStateException(
            "Opening files is not available in this build.",
        )
        return opener.open(uri, mimeType)
    }

    @JavascriptInterface
    fun notificationSyncSubscription(configJson: String): String = requireNotificationBridge().sync(configJson)

    @JavascriptInterface
    fun notificationGetPendingClick(): String? = requireNotificationBridge().pendingClick()

    @JavascriptInterface
    fun notificationAcknowledgeClick(notificationId: String) = requireNotificationBridge().acknowledgeClick(notificationId)

    /** 第二批 E4：通知按钮 pending 槽（冷启动恢复）与提交成功后的卡片取消。 */
    @JavascriptInterface
    fun notificationGetPendingAction(): String? = requireNotificationBridge().pendingAction()

    @JavascriptInterface
    fun notificationAcknowledgeAction(notificationId: String) =
        requireNotificationBridge().acknowledgeAction(notificationId)

    @JavascriptInterface
    fun notificationCancel(notificationId: String) =
        requireNotificationBridge().cancelNotification(notificationId)

    @JavascriptInterface
    fun notificationSetActiveTarget(targetKey: String?) = requireNotificationBridge().setActiveTarget(targetKey)

    @JavascriptInterface
    fun notificationGetStatus(): String = requireNotificationBridge().status()

    @JavascriptInterface
    fun notificationRequestPermission() {
        requestNotificationPermission?.invoke()
            ?: throw IllegalStateException("Notification permission request is unavailable.")
    }

    @JavascriptInterface
    fun notificationShow(payloadJson: String): Boolean = requireNotificationBridge().show(payloadJson)

    private fun requireFileSaver(): MobileFileSaver =
        fileSaver ?: throw IllegalStateException("Saving files is not available in this build.")

    private fun requireSession(token: String): SaveSessionEntry {
        require(token.isNotBlank()) { "Save session token must not be blank." }
        return saveSessions[token]
            ?: throw IllegalArgumentException("Unknown save session token.")
    }

    /**
     * MF08: 页面 reload/崩溃留下的会话不会再有 finish/abort；超过容量上限时按 begin 序号
     * 回收最早（或已过期滞留）的会话并 abort，防止 IS_PENDING 行与半成品文件无限累积。
     */
    private fun evictOrphanedSaveSessions() {
        if (saveSessions.size < MAX_SAVE_SESSIONS) return
        val overflow = saveSessions.size - MAX_SAVE_SESSIONS + 1
        saveSessions.entries
            .sortedBy { it.value.sequence }
            .take(overflow)
            .forEach { entry ->
                if (saveSessions.remove(entry.key, entry.value)) {
                    runCatching { entry.value.session.abort() }
                }
            }
    }

    private fun requireNotificationBridge(): MobileNotificationBridgeClient = mobileNotificationBridge
        ?: throw IllegalStateException("Mobile notifications are unavailable in this build.")

    private fun requireValidKey(key: String) {
        // 空 key 在 EncryptedSharedPreferences 里没有意义；明确失败比静默写入更安全。
        require(key.isNotBlank()) { "Secure store key must not be blank." }
    }

    private companion object {
        // 页面按 256 KiB 分块；留 4 倍余量，仍能挡住异常调用。
        const val MAX_CHUNK_BYTES = 1024 * 1024

        // 单个 WebView 生命周期内同时存活的保存会话上限；超出时回收最早的孤儿会话。
        const val MAX_SAVE_SESSIONS = 8
    }
}
