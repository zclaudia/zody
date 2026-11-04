package io.github.zclaudia.zody.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import io.github.zclaudia.zody.mobile.remote.RemoteControlKeepAliveService
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationClickDispatcher
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationPermissionDispatcher
import io.github.zclaudia.zody.mobile.bridge.RemoteNativeOperationState
import io.github.zclaudia.zody.mobile.notifications.MobileNotificationIntent
import io.github.zclaudia.zody.mobile.notifications.parseMobileNotificationIntent
import io.github.zclaudia.zody.mobile.notifications.shouldHandleNotificationDeepLink
import io.github.zclaudia.zody.mobile.ui.RemoteControlApp
import io.github.zclaudia.zody.mobile.ui.theme.ZodymobileTheme

class MainActivity : ComponentActivity() {
    // M3：与 Compose 侧共享，通知权限弹窗也计入 prepareReload 的原生 veto。
    private val nativeOperationState = RemoteNativeOperationState()

    /**
     * M4-T2：已经消费过的启动深链。
     *
     * 配置变更或状态恢复时系统会再次投递原始启动 Intent。若直接重放，会重新写 pending 槽，
     * 让已 ack 的通知再次执行。这里按 URI 记住已消费值，并且只在同一 Activity 状态恢复时
     * 重放抑制；进程内收到的新通知（URI 不同）仍会正常处理。未确认的 pending 由原生
     * SharedPreferences 持久保留，新页面在 Remote ready 后自行读取，不依赖 Intent 重放。
     */
    private var handledDeepLink: String? = null

    override fun onStart() {
        super.onStart()
        io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.setAppForeground(this, true)
    }

    override fun onStop() {
        io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.setAppForeground(this, false)
        super.onStop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handledDeepLink = savedInstanceState?.getString(STATE_HANDLED_DEEP_LINK)
        enableEdgeToEdge()
        dispatchNotificationClick(intent, allowReplay = false)

        // 安全要求：WebView 远程调试只在 debug 构建开启，release 包不暴露调试端口。
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        requestNotificationPermissionIfNeeded()

        // 方案要求保活服务只表达「有一个活动会话」，不再接收远端 URL。
        // 改造后内置页面就是会话本体，因此随 Activity 启动；真正的连接状态仍由页面协议恢复。
        RemoteControlKeepAliveService.start(this)

        setContent {
            ZodymobileTheme {
                RemoteControlApp(nativeOperationState = nativeOperationState)
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 进程内再次点击（例如失败后从系统卡片重试同一按钮）必须重新派发；
        // 执行层 at-most-once 由页面队列按 notificationId/optionId 保证。
        dispatchNotificationClick(intent, allowReplay = true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        handledDeepLink?.let { outState.putString(STATE_HANDLED_DEEP_LINK, it) }
    }

    @Deprecated("Permission result callback is retained for compatibility with the WebView bridge.")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) {
            // 授予、拒绝或系统取消都会回到这里；权限弹窗不再阻塞安全刷新。
            nativeOperationState.end(RemoteNativeOperationState.Operation.NOTIFICATION_PERMISSION)
            val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            MobileNotificationPermissionDispatcher.publish(granted)
        }
    }

    private fun dispatchNotificationClick(
        intent: android.content.Intent?,
        allowReplay: Boolean,
    ) {
        // M4-T2：解析与校验下沉到纯函数，MainActivity 只负责持久化 pending 和派发。
        // 非法/超长 id 不写槽，避免页面永远无法 ack 的 pending 项。
        val rawDeepLink = intent?.dataString ?: return
        // 只有状态恢复时的启动 Intent 重投递需要抑制；onNewIntent 是用户的新点击，允许重试。
        if (!shouldHandleNotificationDeepLink(rawDeepLink, handledDeepLink, allowReplay)) return
        val parsed = parseMobileNotificationIntent(rawDeepLink) ?: return
        handledDeepLink = rawDeepLink
        val preferences = getSharedPreferences(
            io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.PREFS,
            MODE_PRIVATE,
        )
        when (parsed) {
            is MobileNotificationIntent.Click -> {
                preferences.edit().putString(
                    io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.KEY_PENDING_CLICK,
                    org.json.JSONObject().put("backendId", parsed.backendId)
                        .put("notificationId", parsed.notificationId)
                        .toString(),
                ).apply()
                MobileNotificationClickDispatcher.publish(parsed.backendId, parsed.notificationId)
            }

            // 第二批 E4：通知按钮与「打开任务」是两个动作——前者持久化 optionId 并走快速路径，
            // 不打开任务 UI；槽与 click 槽分离，互不吞掉对方的 pending 项。
            is MobileNotificationIntent.Action -> {
                preferences.edit().putString(
                    io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.KEY_PENDING_ACTION,
                    org.json.JSONObject().put("backendId", parsed.backendId)
                        .put("notificationId", parsed.notificationId)
                        .put("optionId", parsed.optionId)
                        .put("optionKind", parsed.optionKind)
                        .toString(),
                ).apply()
                io.github.zclaudia.zody.mobile.bridge.MobileNotificationActionDispatcher.publish(
                    parsed.backendId,
                    parsed.notificationId,
                    parsed.optionId,
                    parsed.optionKind,
                )
            }
        }
    }

    override fun onDestroy() {
        // 横竖屏等配置变更会重建 Activity，此时保持前台服务不间断，避免保活空窗。
        if (!isChangingConfigurations) {
            RemoteControlKeepAliveService.stop(this)
        }
        super.onDestroy()
    }

    fun requestNotificationPermissionIfNeeded() {
        runOnUiThread { requestNotificationPermissionOnUiThread() }
    }

    private fun requestNotificationPermissionOnUiThread() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        // 同一时间只允许一个系统权限弹窗；避免重复请求让 busy 与回调配对错位。
        if (nativeOperationState.isActive(RemoteNativeOperationState.Operation.NOTIFICATION_PERMISSION)) {
            return
        }
        nativeOperationState.begin(RemoteNativeOperationState.Operation.NOTIFICATION_PERMISSION)
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 4001
        private const val STATE_HANDLED_DEEP_LINK = "zody.handledNotificationDeepLink"
    }
}
