package io.github.zclaudia.zody.mobile.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import io.github.zclaudia.zody.mobile.MainActivity
import io.github.zclaudia.zody.mobile.R
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient
import org.json.JSONObject

/** 校验后的脱敏按钮；optionId 非空、optionKind ∈ {allowOnce, allowAlways, deny}，最多 3 个。 */
internal data class NotificationAction(val optionId: String, val optionKind: String)

/** Started by ntfy-bridge even when the WebView process has been reclaimed. */
class MobileNotificationRenderService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        val provisional = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_remote_control)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.mobile_notification_completed))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        // FGS must enter foreground before validating untrusted daemon extras, otherwise malformed
        // payloads make Android kill the whole Zody process for missing the FGS deadline.
        startForeground(FOREGROUND_ID, provisional)
        val body = intent?.getStringExtra("body")
        val payload = runCatching { JSONObject(body.orEmpty()) }.getOrNull()
        val backendId = payload?.optString("backendId").orEmpty()
        val notificationId = payload?.optString("notificationId").orEmpty()
        val targetKey = payload?.optString("targetKey")?.takeIf { it.isNotBlank() }
        val expiresAt = payload?.optLong("expiresAt", 0L) ?: 0L
        // ntfy-bridge only forwards http(s) click URLs; derive our app deep link from opaque ids.
        val clickUrl = mobileNotificationClickUrl(backendId, notificationId)
        val validClick = runCatching {
            val uri = Uri.parse(clickUrl)
            uri.scheme == "zody" && uri.host == "notification" && uri.path == "/v1" &&
                uri.getQueryParameter("backendId") == backendId &&
                uri.getQueryParameter("notificationId") == notificationId
        }.getOrDefault(false)
        if (payload?.optInt("version") != 1 || backendId.isBlank() || notificationId.isBlank() ||
            expiresAt <= System.currentTimeMillis() || !validClick) {
            Log.w("MobileNotifications", "ignored invalid envelope (parsed=${payload != null},version=${payload?.optInt("version")},hasBackend=${backendId.isNotBlank()},hasId=${notificationId.isNotBlank()},expires=${expiresAt > System.currentTimeMillis()},click=$validClick)")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf(startId)
            return START_NOT_STICKY
        }

        val preferences = getSharedPreferences(MobileNotificationBridgeClient.PREFS, MODE_PRIVATE)
        if (hasSeenNotification(preferences, backendId, notificationId, System.currentTimeMillis())) {
            Log.d("MobileNotifications", "ignored duplicate notification ID")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (shouldSuppressTaskNotification(
                MobileNotificationBridgeClient.isAppForeground(),
                preferences.getString(MobileNotificationBridgeClient.KEY_ACTIVE_TARGET, null),
                targetKey,
            )) {
            Log.d("MobileNotifications", "suppressed notification for active target")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf(startId)
            return START_NOT_STICKY
        }

        val isTestNotification = payload.optString("kind") == "test"
        val clickIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            if (!isTestNotification) {
                action = Intent.ACTION_VIEW
                data = Uri.parse(clickUrl)
            }
        }
        val contentIntent = PendingIntent.getActivity(
            this, notificationId.hashCode(), clickIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val genericBody = when (payload.optString("kind")) {
            "test" -> getString(R.string.mobile_notification_test)
            "permission" -> getString(R.string.mobile_notification_permission)
            "question" -> getString(R.string.mobile_notification_question)
            "failed" -> getString(R.string.mobile_notification_failed)
            else -> getString(R.string.mobile_notification_completed)
        }
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_remote_control)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(genericBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(genericBody))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        // 第二批 E4：仅 permission 通知带操作按钮。畸形 actions 只丢按钮不拒整卡
        // （正文/点击仍是合法通知）；按钮文案按 optionKind 取本地固定文案，不透传 label。
        if (payload.optString("kind") == "permission") {
            for (button in parseNotificationActions(payload)) {
                val actionIntent = Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    action = Intent.ACTION_VIEW
                    data = Uri.parse(
                        mobileNotificationActionUrl(
                            backendId,
                            notificationId,
                            button.optionId,
                            button.optionKind,
                        ),
                    )
                }
                val actionPendingIntent = PendingIntent.getActivity(
                    this,
                    "$notificationId:${button.optionId}".hashCode(),
                    actionIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                builder.addAction(0, actionLabel(button.optionKind), actionPendingIntent)
            }
        }
        val notification: Notification = builder.build()
        getSystemService(NotificationManager::class.java).notify(notificationId.hashCode(), notification)
        Log.i("MobileNotifications", "rendered notification")
        // 成功通知已经由 NotificationManager 独立发布；移除临时前台通知，避免残留 4702。
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun actionLabel(optionKind: String): String = when (optionKind) {
        "allowOnce" -> getString(R.string.mobile_notification_action_allow_once)
        "allowAlways" -> getString(R.string.mobile_notification_action_allow_always)
        "deny" -> getString(R.string.mobile_notification_action_deny)
        else -> getString(R.string.mobile_notification_action_allow_once)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(NotificationChannel(
                    CHANNEL_ID, getString(R.string.mobile_notification_channel), NotificationManager.IMPORTANCE_DEFAULT,
                ))
            }
        }
    }

    private fun hasSeenNotification(
        preferences: android.content.SharedPreferences,
        backendId: String,
        notificationId: String,
        now: Long,
    ): Boolean = synchronized(SEEN_IDS_LOCK) {
        val raw = preferences.getString(MobileNotificationBridgeClient.KEY_SEEN_NOTIFICATION_IDS, null)
        val seenAtById = LinkedHashMap<String, Long>()
        runCatching { JSONObject(raw.orEmpty()) }.getOrNull()?.let { stored ->
            val keys = stored.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val timestamp = stored.optLong(key, 0L)
                if (timestamp > 0L) seenAtById[key] = timestamp
            }
        }
        val key = JSONObject().put("backendId", backendId).put("notificationId", notificationId).toString()
        val duplicate = rememberMobileNotificationId(seenAtById, key, now)
        val serialized = JSONObject().apply { seenAtById.forEach { (id, at) -> put(id, at) } }.toString()
        if (!preferences.edit().putString(MobileNotificationBridgeClient.KEY_SEEN_NOTIFICATION_IDS, serialized).commit()) {
            // Persist-before-show preserves at-most-once delivery across process death.
            Log.w("MobileNotifications", "could not persist notification dedupe state")
            true
        } else duplicate
    }

    companion object {
        private const val CHANNEL_ID = "mobile_task_notifications"
        private const val FOREGROUND_ID = 4702
        private val SEEN_IDS_LOCK = Any()

        /** 畸形 actions 数组返回空列表（丢按钮不拒卡），供 JVM 单测直接覆盖。 */
        internal fun parseNotificationActions(payload: JSONObject): List<NotificationAction> {
            val raw = payload.optJSONArray("actions") ?: return emptyList()
            val actions = ArrayList<NotificationAction>(minOf(raw.length(), 3))
            for (index in 0 until raw.length()) {
                if (actions.size >= 3) break
                val item = raw.optJSONObject(index) ?: continue
                val optionId = item.optString("optionId")
                val optionKind = item.optString("optionKind")
                if (optionId.isBlank()) continue
                if (optionKind != "allowOnce" && optionKind != "allowAlways" && optionKind != "deny") continue
                actions.add(NotificationAction(optionId, optionKind))
            }
            return actions
        }
    }
}
