package io.github.zclaudia.zody.mobile.bridge

import android.util.Base64
import android.webkit.JavascriptInterface
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellController
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellTransitionResult
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Remote 页面可见的原生桥（spec 第 7 节）。
 *
 * 除只读 [getSessionContext] 外，所有会改变原生或远端状态的方法都必须携带当前 sessionId；
 * controller 在每次调用时检查代次，旧 id 返回稳定的 `stale-session` envelope。
 *
 * 成功 envelope 的字段：
 * - `saveFileBegin`：`token`
 * - `saveFileFinish`：`file: { uri, displayPath }`
 * - `openFile`：`opened: boolean`
 * - `notificationSyncSubscription` / `notificationGetStatus`：`status: <object|string>`
 * - `notificationGetPendingClick`：`click: <object|null>`
 * - `notificationGetPendingAction`：`action: <object|null>`
 * - `notificationShow`：`shown: boolean`
 * 其余状态变更只返回 `{ schemaVersion, ok: true }`。
 */
class ZodyRemoteBridge(
    private val controller: MobileShellController,
    private val appVersion: String,
    private val fileSaver: MobileFileSaver? = null,
    private val fileOpener: MobileFileOpener? = null,
    private val notificationBridge: RemoteNotificationBridge? = null,
    private val requestNotificationPermission: (() -> Unit)? = null,
    private val nativeReloadGuard: RemoteNativeReloadGuard? = null,
    private val decodeBase64: (String) -> ByteArray = { value ->
        Base64.decode(value, Base64.NO_WRAP)
    },
    private val newToken: () -> String = { UUID.randomUUID().toString() },
) {
    private data class SaveSessionEntry(
        val session: MobileFileSaveSession,
        val sequence: Long,
        val sessionId: String,
    )

    private val saveSessions = ConcurrentHashMap<String, SaveSessionEntry>()
    private val saveSessionSequence = AtomicLong()

    @JavascriptInterface
    fun getSessionContext(): String {
        val snapshot = controller.remoteSessionSnapshot()
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.SESSION_CONTEXT_INVALID)
        val context = JSONObject()
            .put("schemaVersion", MobileBridgeJson.SCHEMA_VERSION)
            .put("sessionId", snapshot.sessionId)
            .put("gatewayUrl", snapshot.gatewayUrl)
            .put("namespace", snapshot.namespace)
            .put("backendId", snapshot.backendId)
            .put("credential", snapshot.credential)
            .put("clientInstanceId", snapshot.clientInstanceId)
            .put("appVersion", appVersion)
            .put(
                "bridgeCapabilities",
                MobileBridgeJson.bridgeCapabilities(
                    appVersion = appVersion,
                    allowInsecureGatewayTransport = controller.bridgeCapabilities()
                        .contains("insecure-gateway-transport"),
                ),
            )
        return MobileBridgeJson.success { put("context", context) }
    }

    /** Remote 业务 Channel ready；在此之前通知 intent 只排队不派发。 */
    @JavascriptInterface
    fun markRemoteReady(sessionId: String): String =
        transitionResult(controller.markRemoteReady(sessionId))

    @JavascriptInterface
    fun returnShell(reason: String, sessionId: String): String =
        transitionResult(controller.returnShellFromRemote(reason, sessionId))

    /**
     * M3：Web 在执行 `window.location.reload()` 前请求原生 veto（spec 9.3）。
     *
     * 顺序固定：先校验当前 generation/session，再检查原生操作。原生只返回判定，绝不主动
     * reload；实际 reload 只由 Web controller 在全部 guard 通过后执行。
     *
     * 返回：
     * - `ready`：无原生阻塞，可执行 reload；
     * - `stale-session`：session 已失效、Activity 已销毁或页面不是当前 Remote；
     * - `native-busy`：文件选择、拍照、相机/通知权限弹窗或未完成保存会话仍在进行；
     * - `unsupported-capability`：宿主未接入原生操作状态、状态不可判定或参数非法，fail closed。
     */
    @JavascriptInterface
    fun prepareReload(sessionId: String, releaseId: String): String {
        sessionFailure(sessionId)?.let { return it }
        if (releaseId.isBlank() || releaseId.length > MAX_RELEASE_ID_CHARS) {
            return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        }
        // 旧 session 遗留的保存会话不能再 finish/abort，只按当前 session 判定 busy。
        if (saveSessions.values.any { it.sessionId == sessionId }) {
            return MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BUSY)
        }
        val guard = nativeReloadGuard
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        val busy = try {
            guard.isOperationInProgress()
        } catch (_: Exception) {
            return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        }
        if (busy) {
            return MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BUSY)
        }
        // 检查期间可能已发生导航/销毁；ready 必须基于同一代次。
        sessionFailure(sessionId)?.let { return it }
        return MobileBridgeJson.success { put("status", "ready") }
    }

    @JavascriptInterface
    fun saveFileBegin(sessionId: String, fileName: String, mimeType: String): String {
        sessionFailure(sessionId)?.let { return it }
        val saver = fileSaver
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            evictOrphanedSaveSessions()
            val token = newToken()
            val session = saver.begin(fileName, mimeType)
            saveSessions[token] = SaveSessionEntry(
                session = session,
                sequence = saveSessionSequence.incrementAndGet(),
                sessionId = sessionId,
            )
            MobileBridgeJson.success { put("token", token) }
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun saveFileAppend(sessionId: String, token: String, chunkBase64: String): String {
        sessionFailure(sessionId)?.let { return it }
        val entry = saveSessions[token]
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.INVALID_ARGUMENT)
        if (entry.sessionId != sessionId) {
            return MobileBridgeJson.failure(MobileBridgeErrors.STALE_SESSION)
        }
        if (chunkBase64.isBlank()) {
            return MobileBridgeJson.failure(MobileBridgeErrors.INVALID_ARGUMENT)
        }
        return try {
            val bytes = decodeBase64(chunkBase64)
            if (bytes.size > MAX_CHUNK_BYTES) {
                return MobileBridgeJson.failure(MobileBridgeErrors.INVALID_ARGUMENT)
            }
            entry.session.append(bytes)
            MobileBridgeJson.success()
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun saveFileFinish(sessionId: String, token: String): String {
        sessionFailure(sessionId)?.let { return it }
        val entry = saveSessions[token]
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.INVALID_ARGUMENT)
        if (entry.sessionId != sessionId) {
            return MobileBridgeJson.failure(MobileBridgeErrors.STALE_SESSION)
        }
        saveSessions.remove(token)
        return try {
            val saved = entry.session.finish()
            MobileBridgeJson.success {
                put(
                    "file",
                    JSONObject()
                        .put("uri", saved.uri)
                        .put("displayPath", saved.displayPath),
                )
            }
        } catch (_: Exception) {
            runCatching { entry.session.abort() }
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun saveFileAbort(sessionId: String, token: String): String {
        sessionFailure(sessionId)?.let { return it }
        val entry = saveSessions[token]
        if (entry != null && entry.sessionId != sessionId) {
            return MobileBridgeJson.failure(MobileBridgeErrors.STALE_SESSION)
        }
        saveSessions.remove(token)?.session?.abort()
        return MobileBridgeJson.success()
    }

    @JavascriptInterface
    fun openFile(sessionId: String, uri: String, mimeType: String): String {
        sessionFailure(sessionId)?.let { return it }
        val opener = fileOpener
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            MobileBridgeJson.success { put("opened", opener.open(uri, mimeType)) }
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun notificationSyncSubscription(sessionId: String, configJson: String): String {
        sessionFailure(sessionId)?.let { return it }
        val bridge = notificationBridge
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            MobileBridgeJson.success { putStatus(bridge.sync(configJson)) }
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun notificationGetPendingClick(sessionId: String): String {
        sessionFailure(sessionId)?.let { return it }
        val bridge = notificationBridge
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            MobileBridgeJson.success {
                putNullable("click", MobileBridgeJson.parseObjectOrNull(bridge.pendingClick()))
            }
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun notificationAcknowledgeClick(sessionId: String, notificationId: String): String =
        notificationOperation(sessionId) { it.acknowledgeClick(notificationId) }

    @JavascriptInterface
    fun notificationGetPendingAction(sessionId: String): String {
        sessionFailure(sessionId)?.let { return it }
        val bridge = notificationBridge
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            MobileBridgeJson.success {
                putNullable("action", MobileBridgeJson.parseObjectOrNull(bridge.pendingAction()))
            }
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun notificationAcknowledgeAction(sessionId: String, notificationId: String): String =
        notificationOperation(sessionId) { it.acknowledgeAction(notificationId) }

    @JavascriptInterface
    fun notificationCancel(sessionId: String, notificationId: String): String =
        notificationOperation(sessionId) { it.cancelNotification(notificationId) }

    @JavascriptInterface
    fun notificationSetActiveTarget(sessionId: String, targetKey: String?): String =
        notificationOperation(sessionId) { it.setActiveTarget(targetKey) }

    @JavascriptInterface
    fun notificationGetStatus(sessionId: String): String {
        sessionFailure(sessionId)?.let { return it }
        val bridge = notificationBridge
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            MobileBridgeJson.success { putStatus(bridge.status()) }
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun notificationRequestPermission(sessionId: String): String {
        sessionFailure(sessionId)?.let { return it }
        val request = requestNotificationPermission
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            request()
            MobileBridgeJson.success()
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    @JavascriptInterface
    fun notificationShow(sessionId: String, payloadJson: String): String {
        sessionFailure(sessionId)?.let { return it }
        val bridge = notificationBridge
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            MobileBridgeJson.success { put("shown", bridge.show(payloadJson)) }
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    private fun notificationOperation(
        sessionId: String,
        operation: (RemoteNotificationBridge) -> Unit,
    ): String {
        sessionFailure(sessionId)?.let { return it }
        val bridge = notificationBridge
            ?: return MobileBridgeJson.failure(MobileBridgeErrors.UNSUPPORTED_CAPABILITY)
        return try {
            operation(bridge)
            MobileBridgeJson.success()
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }
    }

    private fun sessionFailure(sessionId: String): String? {
        if (sessionId.isBlank() || sessionId.length > MAX_SESSION_ID_CHARS) {
            return MobileBridgeJson.failure(MobileBridgeErrors.STALE_SESSION)
        }
        return if (controller.isCurrentRemoteSession(sessionId)) {
            null
        } else {
            MobileBridgeJson.failure(MobileBridgeErrors.STALE_SESSION)
        }
    }

    private fun transitionResult(result: MobileShellTransitionResult): String =
        when (result) {
            MobileShellTransitionResult.Success -> MobileBridgeJson.success()
            is MobileShellTransitionResult.Failure ->
                MobileBridgeJson.failure(result.code, result.message)
        }

    private fun JSONObject.putStatus(raw: String) {
        val parsed = MobileBridgeJson.parseObjectOrNull(raw)
        if (parsed != null) put("status", parsed) else put("statusRaw", raw)
    }

    /**
     * 页面 reload/崩溃留下的会话不会再有 finish/abort；超过容量时按 begin 序号回收最早会话。
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

    companion object {
        const val GLOBAL_KEY = "ZodyRemoteBridge"

        private const val MAX_CHUNK_BYTES = 1024 * 1024
        private const val MAX_SAVE_SESSIONS = 8
        private const val MAX_SESSION_ID_CHARS = 256
        private const val MAX_RELEASE_ID_CHARS = 256
    }
}

/** M3：`prepareReload` 查询宿主原生操作；返回 true 表示必须 veto 本次 reload。 */
fun interface RemoteNativeReloadGuard {
    fun isOperationInProgress(): Boolean
}

/**
 * M3 原生 reload veto 的唯一状态所有者：记录尚未返回系统的原生操作。
 *
 * 只保存「操作占用系统 UI」这一事实，不保存回调、URI 或页面业务状态：
 * - 文件选择：`onShowFileChooser` 开始，取消/选择完成/宿主销毁时结束；
 * - 拍照：相机 Activity 启动前开始，结果回调结束；
 * - 相机权限：系统权限对话框弹出前开始，权限结果回调结束；
 * - 通知权限：MainActivity 发起请求前开始，`onRequestPermissionsResult` 结束。
 *
 * Activity 重建会随宿主创建新实例；旧实例在 Compose dispose 时 [clear]，不把上一代
 * busy 带入新会话。bridge 只读 [isBusy]，不复制原生操作状态。
 */
class RemoteNativeOperationState {
    enum class Operation {
        FILE_CHOOSER,
        CAMERA_CAPTURE,
        CAMERA_PERMISSION,
        NOTIFICATION_PERMISSION,
    }

    private val activeOperations = mutableSetOf<Operation>()

    @Synchronized
    fun begin(operation: Operation) {
        activeOperations += operation
    }

    @Synchronized
    fun end(operation: Operation) {
        activeOperations -= operation
    }

    @Synchronized
    fun isActive(operation: Operation): Boolean = operation in activeOperations

    @Synchronized
    fun isBusy(): Boolean = activeOperations.isNotEmpty()

    @Synchronized
    fun clear() {
        activeOperations.clear()
    }
}

/** Remote 页面所需的通知能力；由 Android 通知桥适配，JVM 测试可注入 fake。 */
interface RemoteNotificationBridge {
    fun sync(configJson: String): String
    fun pendingClick(): String?
    fun acknowledgeClick(notificationId: String)
    fun pendingAction(): String?
    fun acknowledgeAction(notificationId: String)
    fun cancelNotification(notificationId: String)
    fun setActiveTarget(targetKey: String?)
    fun status(): String
    fun show(payloadJson: String): Boolean
}

/** 把现有 [MobileNotificationBridgeClient] 适配到 Remote bridge 的最小接口。 */
class MobileNotificationBridgeAdapter(
    private val client: MobileNotificationBridgeClient,
) : RemoteNotificationBridge {
    override fun sync(configJson: String): String = client.sync(configJson)
    override fun pendingClick(): String? = client.pendingClick()
    override fun acknowledgeClick(notificationId: String) = client.acknowledgeClick(notificationId)
    override fun pendingAction(): String? = client.pendingAction()
    override fun acknowledgeAction(notificationId: String) = client.acknowledgeAction(notificationId)
    override fun cancelNotification(notificationId: String) = client.cancelNotification(notificationId)
    override fun setActiveTarget(targetKey: String?) = client.setActiveTarget(targetKey)
    override fun status(): String = client.status()
    override fun show(payloadJson: String): Boolean = client.show(payloadJson)
}
