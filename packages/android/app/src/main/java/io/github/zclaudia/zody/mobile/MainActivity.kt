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
import io.github.zclaudia.zody.mobile.ui.RemoteControlApp
import io.github.zclaudia.zody.mobile.ui.theme.ZodymobileTheme

class MainActivity : ComponentActivity() {
    // M3：与 Compose 侧共享，通知权限弹窗也计入 prepareReload 的原生 veto。
    private val nativeOperationState = RemoteNativeOperationState()

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
        enableEdgeToEdge()
        dispatchNotificationClick(intent)

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
        dispatchNotificationClick(intent)
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

    private fun dispatchNotificationClick(intent: android.content.Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "zody") return
        val backendId = uri.getQueryParameter("backendId") ?: return
        val notificationId = uri.getQueryParameter("notificationId") ?: return
        if (!backendId.isNotBlank() || !notificationId.isNotBlank()) return
        val preferences = getSharedPreferences(
            io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.PREFS,
            MODE_PRIVATE,
        )
        if (uri.host == "notification" && uri.path == "/v1") {
            preferences.edit().putString(
                io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.KEY_PENDING_CLICK,
                org.json.JSONObject().put("backendId", backendId).put("notificationId", notificationId).toString(),
            ).apply()
            MobileNotificationClickDispatcher.publish(backendId, notificationId)
            return
        }
        // 第二批 E4：通知按钮与「打开任务」是两个动作——前者持久化 optionId 并走快速路径，
        // 不打开任务 UI；槽与 click 槽分离，互不吞掉对方的 pending 项。
        if (uri.host == "notification-action" && uri.path == "/v1") {
            val optionId = uri.getQueryParameter("optionId") ?: return
            val optionKind = uri.getQueryParameter("optionKind") ?: return
            if (!optionId.isNotBlank()) return
            if (optionKind != "allowOnce" && optionKind != "allowAlways" && optionKind != "deny") return
            preferences.edit().putString(
                io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient.KEY_PENDING_ACTION,
                org.json.JSONObject().put("backendId", backendId)
                    .put("notificationId", notificationId)
                    .put("optionId", optionId)
                    .put("optionKind", optionKind)
                    .toString(),
            ).apply()
            io.github.zclaudia.zody.mobile.bridge.MobileNotificationActionDispatcher.publish(
                backendId,
                notificationId,
                optionId,
                optionKind,
            )
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
    }
}
