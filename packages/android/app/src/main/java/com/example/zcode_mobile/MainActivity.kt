package com.example.zcode_mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.example.zcode_mobile.remote.RemoteControlKeepAliveService
import com.example.zcode_mobile.ui.RemoteControlApp
import com.example.zcode_mobile.ui.theme.ZcodemobileTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // 安全要求：WebView 远程调试只在 debug 构建开启，release 包不暴露调试端口。
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        requestNotificationPermissionIfNeeded()

        // 方案要求保活服务只表达「有一个活动会话」，不再接收远端 URL。
        // 改造后内置页面就是会话本体，因此随 Activity 启动；真正的连接状态仍由页面协议恢复。
        RemoteControlKeepAliveService.start(this)

        setContent {
            ZcodemobileTheme {
                RemoteControlApp()
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

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 4001
    }
}
