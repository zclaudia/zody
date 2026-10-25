package io.github.zclaudia.zody.mobile.bridge

import android.content.Context
import android.content.Intent
import android.util.Base64
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.net.HttpURLConnection
import java.net.URL

/** Thin client for the separately installed ntfy-bridge daemon. It only upserts Zody's own id. */
class MobileNotificationBridgeClient(private val context: Context) {
    fun sync(configJson: String): String {
        val config = runCatching { JSONObject(configJson) }.getOrElse { return status("error", "invalid_config") }
        if (config.optBoolean("enabled", true).not()) return removeOwnedSubscription(config.optString("backendId"))
        val serverUrl = config.optString("ntfyUrl").trimEnd('/')
        val backendId = config.optString("backendId")
        val topic = config.optString("topic", backendId)
        val token = config.optString("authToken")
        if (backendId.isBlank() || topic.isBlank() || serverUrl.isBlank() || token.isBlank()) {
            return status("unavailable", "missing_subscription_fields")
        }
        val previousBackendId = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_BACKEND_ID, null)
        if (previousBackendId != null && previousBackendId != backendId) {
            request("DELETE", "/subscribe", JSONObject().put("id", subscriptionId(previousBackendId)).toString(), "ready")
        }
        val body = JSONObject().apply {
            put("id", subscriptionId(backendId))
            put("ntfy_url", serverUrl)
            put("topic", topic)
            put("auth_mode", "bearer")
            put("auth_token", token)
            put("package", context.packageName)
            put("receiver", ".notifications.MobileNotificationRenderService")
        }
        val result = request("POST", "/subscribe", body.toString(), "ready")
        if (JSONObject(result).optString("status") == "ready") {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_BACKEND_ID, backendId).apply()
        }
        return result
    }

    fun status(): String {
        if (!androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            return status("permission-denied", "notification_permission_denied")
        }
        val backendId = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_BACKEND_ID, null)
            ?: return status("unavailable", "subscription_not_configured")
        val envelope = runCatching { JSONObject(request("GET", "/status", null, "ready")) }.getOrNull()
            ?: return status("error", "invalid_daemon_status")
        if (envelope.optString("status") != "ready") return envelope.toString()
        val daemonStatus = runCatching { JSONObject(envelope.optString("message")) }.getOrNull()
            ?: return status("error", "invalid_daemon_status")
        val subscription = daemonStatus.optJSONObject("subscriptions")?.optJSONObject(subscriptionId(backendId))
            ?: return status("unavailable", "subscription_missing")
        val connected = subscription.optBoolean("connected", false)
        return JSONObject()
            .put("status", if (connected) "ready" else "unavailable")
            .put("connected", connected)
            .put("message", if (connected) "connected" else subscription.optString("status", "disconnected"))
            .toString()
    }

    fun show(payloadJson: String): Boolean {
        val payload = runCatching { JSONObject(payloadJson) }.getOrNull() ?: return false
        if (payload.optInt("version") != 1 || payload.optString("backendId").isBlank() ||
            payload.optString("notificationId").isBlank() || payload.optLong("expiresAt", 0L) <= System.currentTimeMillis()) return false
        val clickUrl = "zody://notification/v1?backendId=${UriEncode.encode(payload.getString("backendId"))}" +
            "&notificationId=${UriEncode.encode(payload.getString("notificationId"))}"
        return runCatching {
            val intent = Intent(context, io.github.zclaudia.zody.mobile.notifications.MobileNotificationRenderService::class.java)
                .putExtra("body", payload.toString())
                .putExtra("click_url", clickUrl)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
            true
        }.getOrDefault(false)
    }

    fun pendingClick(): String? = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getString(KEY_PENDING_CLICK, null)

    fun acknowledgeClick(notificationId: String) {
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val pending = preferences.getString(KEY_PENDING_CLICK, null) ?: return
        val currentId = runCatching { JSONObject(pending).optString("notificationId") }.getOrNull()
        if (currentId == notificationId) preferences.edit().remove(KEY_PENDING_CLICK).apply()
    }

    /**
     * 第二批 E4：通知按钮的 pending 槽。与 click 槽同语义——Activity 收到 action deep link 时
     * 持久化，页面冷启动后读取并消费；成功提交才 acknowledge（at-most-once 指页面只处理一次）。
     */
    fun pendingAction(): String? = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getString(KEY_PENDING_ACTION, null)

    fun acknowledgeAction(notificationId: String) {
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val pending = preferences.getString(KEY_PENDING_ACTION, null) ?: return
        val currentId = runCatching { JSONObject(pending).optString("notificationId") }.getOrNull()
        if (currentId == notificationId) preferences.edit().remove(KEY_PENDING_ACTION).apply()
    }

    /** 快速路径提交成功后取消系统卡片；找不到时静默（可能已被用户划掉）。 */
    fun cancelNotification(notificationId: String) {
        runCatching {
            androidx.core.app.NotificationManagerCompat.from(context).cancel(notificationId.hashCode())
        }
    }

    fun setActiveTarget(targetKey: String?) {
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val key = targetKey?.trim().orEmpty()
        preferences.edit().apply {
            if (key.isEmpty()) remove(KEY_ACTIVE_TARGET) else putString(KEY_ACTIVE_TARGET, key)
        }.apply()
    }

    private fun removeOwnedSubscription(backendId: String): String {
        if (backendId.isBlank()) return status("ready")
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // 迟到的旧 backend revoke/disable 不能删除已切换后的当前订阅。
        if (!shouldRemoveOwnedNotificationSubscription(preferences.getString(KEY_BACKEND_ID, null), backendId))
            return status("ready")
        val response = request("DELETE", "/subscribe", JSONObject().put("id", subscriptionId(backendId)).toString(), "ready")
        if (JSONObject(response).optString("status") == "ready") {
            if (preferences.getString(KEY_BACKEND_ID, null) == backendId)
                preferences.edit().remove(KEY_BACKEND_ID).apply()
        }
        return response
    }

    private fun request(method: String, path: String, body: String?, success: String): String {
        val connection = runCatching { URL("http://127.0.0.1:9595$path").openConnection() as HttpURLConnection }
            .getOrElse { return status("unavailable", "daemon_unavailable") }
        return try {
            connection.requestMethod = method
            connection.connectTimeout = 1_500
            connection.readTimeout = 2_500
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val response = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code in 200..299) {
                daemonSuccessEnvelope(success, response)
            } else {
                val state = if (response.contains("permission", ignoreCase = true)) "permission-denied" else "error"
                status(state, "daemon_http_$code")
            }
        } catch (_: Exception) {
            status("unavailable", "daemon_unavailable")
        } finally {
            connection.disconnect()
        }
    }

    private fun status(value: String, message: String? = null): String =
        JSONObject().put("status", value).apply { if (message != null) put("message", message) }.toString()

    private fun subscriptionId(backendId: String): String {
        val encoded = Base64.encodeToString(backendId.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        return "${context.packageName}:zody:$encoded"
    }

    companion object {
        const val PREFS = "mobile_notification_bridge"
        const val KEY_BACKEND_ID = "backend_id"
        const val KEY_PENDING_CLICK = "pending_click"
        const val KEY_PENDING_ACTION = "pending_notification_action_v1"
        const val KEY_ACTIVE_TARGET = "active_target"
        const val KEY_APP_FOREGROUND = "app_foreground"
        const val KEY_SEEN_NOTIFICATION_IDS = "seen_notification_ids_v1"

        fun setAppForeground(context: Context, foreground: Boolean) {
            // Foreground state is process-local: a killed app cannot leave behind a stale true flag.
            MobileNotificationForegroundState.set(foreground)
        }

        fun isAppForeground(): Boolean = MobileNotificationForegroundState.get()
    }
}

// 断连诊断或多订阅会使 /status 超过 512 字符；截断后再解析会把合法状态误报为无效 JSON。
internal fun daemonSuccessEnvelope(success: String, response: String): String =
    JSONObject().put("status", success).put("message", response).toString()

internal fun shouldRemoveOwnedNotificationSubscription(currentBackendId: String?, requestedBackendId: String): Boolean =
    requestedBackendId.isNotBlank() && currentBackendId == requestedBackendId

internal object MobileNotificationForegroundState {
    @Volatile private var foreground: Boolean = false
    fun set(value: Boolean) { foreground = value }
    fun get(): Boolean = foreground
}

object MobileNotificationClickDispatcher {
    private val listeners = CopyOnWriteArrayList<(String, String) -> Unit>()
    fun subscribe(listener: (String, String) -> Unit): AutoCloseable {
        listeners.add(listener)
        return AutoCloseable { listeners.remove(listener) }
    }
    fun publish(backendId: String, notificationId: String) {
        listeners.forEach { listener -> runCatching { listener(backendId, notificationId) } }
    }
}

object MobileNotificationPermissionDispatcher {
    private val listeners = CopyOnWriteArrayList<(Boolean) -> Unit>()
    fun subscribe(listener: (Boolean) -> Unit): AutoCloseable {
        listeners.add(listener)
        return AutoCloseable { listeners.remove(listener) }
    }
    fun publish(granted: Boolean) { listeners.forEach { listener -> runCatching { listener(granted) } } }
}

/** 第二批 E4：通知按钮点击（backendId, notificationId, optionId, optionKind）→ 页面快速路径。 */
object MobileNotificationActionDispatcher {
    private val listeners = CopyOnWriteArrayList<(String, String, String, String) -> Unit>()
    fun subscribe(listener: (String, String, String, String) -> Unit): AutoCloseable {
        listeners.add(listener)
        return AutoCloseable { listeners.remove(listener) }
    }
    fun publish(backendId: String, notificationId: String, optionId: String, optionKind: String) {
        listeners.forEach { listener ->
            runCatching { listener(backendId, notificationId, optionId, optionKind) }
        }
    }
}

private object UriEncode {
    fun encode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
