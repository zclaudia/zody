package com.example.zcode_mobile.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.webkit.WebViewAssetLoader
import com.example.zcode_mobile.BuildConfig
import com.example.zcode_mobile.R
import com.example.zcode_mobile.bridge.EncryptedSharedPreferencesSecureStore
import com.example.zcode_mobile.bridge.MobileBridgeEventDispatcher
import com.example.zcode_mobile.bridge.MobileBridgeLifecycleState
import com.example.zcode_mobile.bridge.ZcodeMobileBridge

/**
 * 内置页面由 Gradle 从 `packages/web/dist-mobile-remote` 同步到 `assets/remote/`，
 * WebViewAssetLoader 把它映射为 `https://appassets.androidplatform.net/assets/remote/`。
 * 页面连接 gateway 走跨 origin 的 WSS/fetch，不再加载任何远端页面。
 */
private const val APP_ASSETS_HOST = "appassets.androidplatform.net"
private const val APP_ASSETS_PATH_PREFIX = "/assets/remote/"
private const val REMOTE_PAGE_PATH = "${APP_ASSETS_PATH_PREFIX}index.html"
private const val REMOTE_PAGE_URL = "https://$APP_ASSETS_HOST$REMOTE_PAGE_PATH"

@Composable
fun RemoteControlApp(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val assetLoader = remember(context) {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
    }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var bridgeDispatcher by remember { mutableStateOf<MobileBridgeEventDispatcher?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var pageError by remember { mutableStateOf<String?>(null) }
    val activity = context as? Activity
    // 凭证存储随页面创建；Keystore 主密钥在首次读写时才初始化。
    val secureStore = remember(context) { EncryptedSharedPreferencesSecureStore(context) }

    // 返回键先分发给页面（浮层/聊天页优先），页面未消费时再回退 WebView 历史或退出 App。
    BackHandler(enabled = webView != null) {
        val view = webView ?: return@BackHandler
        val dispatcher = bridgeDispatcher ?: return@BackHandler
        dispatcher.dispatchBackPressed { handled ->
            if (!handled) {
                if (view.canGoBack()) {
                    view.goBack()
                } else {
                    activity?.finish()
                }
            }
        }
    }

    // T6.2：Activity ON_START/ON_STOP 是“页面是否可见”的宿主事实，用它驱动页面暂停/恢复连接。
    // 权限弹窗、配置变更不会触发 ON_STOP，避免把短暂遮挡误判成后台。
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, webView, bridgeDispatcher) {
        val dispatcher = bridgeDispatcher
        if (dispatcher == null) {
            onDispose {}
        } else {
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_START ->
                        dispatcher.dispatchLifecycle(MobileBridgeLifecycleState.FOREGROUND)
                    Lifecycle.Event.ON_STOP ->
                        dispatcher.dispatchLifecycle(MobileBridgeLifecycleState.BACKGROUND)
                    else -> Unit
                }
            }
            lifecycleOwner.lifecycle.addObserver(observer)
            onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.destroy()
            webView = null
            bridgeDispatcher = null
        }
    }

    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { viewContext ->
                    createRemoteControlWebView(
                        context = viewContext,
                        assetLoader = assetLoader,
                        secureStore = secureStore,
                        onLoadingChanged = { loading -> isLoading = loading },
                        onMainFrameError = { message -> pageError = message },
                    ).also { view ->
                        bridgeDispatcher = MobileBridgeEventDispatcher.forWebView(view)
                        webView = view
                        view.loadUrl(REMOTE_PAGE_URL)
                    }
                },
            )
            if (isLoading) {
                LinearProgressIndicator(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .fillMaxWidth()
                        .statusBarsPadding(),
                )
            }
            pageError?.let { message ->
                RemoteControlErrorOverlay(
                    message = message,
                    onRetry = {
                        pageError = null
                        webView?.reload()
                    },
                )
            }
        }
    }
}

@Composable
private fun RemoteControlErrorOverlay(
    message: String,
    onRetry: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = stringResource(R.string.remote_load_failed_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
            Button(onClick = onRetry) {
                Text(stringResource(R.string.remote_retry_button))
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createRemoteControlWebView(
    context: Context,
    assetLoader: WebViewAssetLoader,
    secureStore: EncryptedSharedPreferencesSecureStore,
    onLoadingChanged: (Boolean) -> Unit,
    onMainFrameError: (String) -> Unit,
): WebView {
    CookieManager.getInstance().setAcceptCookie(true)

    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        overScrollMode = WebView.OVER_SCROLL_NEVER
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString ZCodeAndroid/${BuildConfig.VERSION_NAME}"
        }
        // 只加载内置页面；离开 appassets 的主框架导航会被交给系统浏览器，桥不会暴露给远端页面。
        addJavascriptInterface(ZcodeMobileBridge(secureStore), "ZcodeMobileBridge")
        webChromeClient = object : WebChromeClient() {}
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                // 只有 appassets.androidplatform.net 会命中 AssetLoader；gateway 的 fetch/WSS 返回 null 走网络。
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                onLoadingChanged(true)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                onLoadingChanged(false)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (!request.isForMainFrame) {
                    return false
                }
                if (isBundledPageUrl(request.url)) {
                    return false
                }
                // 内置页面是唯一可信入口：其它导航一律交给系统浏览器，WebView 不再加载远端页面。
                openExternalUrl(view.context, request.url)
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame != true) {
                    return
                }
                onLoadingChanged(false)
                onMainFrameError(error?.description?.toString().orEmpty())
            }
        }
    }
}

private fun isBundledPageUrl(uri: Uri): Boolean {
    return uri.scheme == "https" &&
        uri.host == APP_ASSETS_HOST &&
        uri.path.orEmpty().startsWith(APP_ASSETS_PATH_PREFIX)
}

private fun openExternalUrl(context: Context, uri: Uri) {
    // 只把 http(s) 交给系统；javascript:/file: 等 scheme 不开放。
    if (uri.scheme != "http" && uri.scheme != "https") {
        return
    }
    val intent = Intent(Intent.ACTION_VIEW, uri)
    runCatching {
        context.startActivity(intent)
    }
}
