package com.example.zcode_mobile.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.webkit.WebViewAssetLoader
import com.example.zcode_mobile.BuildConfig
import com.example.zcode_mobile.R
import com.example.zcode_mobile.bridge.AndroidMobileFileOpener
import com.example.zcode_mobile.bridge.DownloadsFileWriter
import com.example.zcode_mobile.bridge.EncryptedSharedPreferencesSecureStore
import com.example.zcode_mobile.bridge.FileChooserSpecs
import com.example.zcode_mobile.bridge.MobileBridgeEventDispatcher
import com.example.zcode_mobile.bridge.MobileBridgeLifecycleState
import com.example.zcode_mobile.bridge.MobileDownloadHandler
import com.example.zcode_mobile.bridge.ZcodeMobileBridge
import java.io.File

/**
 * 内置页面由 Gradle 从 `packages/web/dist-mobile-remote` 同步到 `assets/remote/`，
 * WebViewAssetLoader 把它映射为 `https://appassets.androidplatform.net/assets/remote/`。
 * 页面连接 gateway 走跨 origin 的 WSS/fetch，不再加载任何远端页面。
 */
private const val APP_ASSETS_HOST = "appassets.androidplatform.net"
private const val APP_ASSETS_PATH_PREFIX = "/assets/remote/"
private const val REMOTE_PAGE_PATH = "${APP_ASSETS_PATH_PREFIX}index.html"
private const val REMOTE_PAGE_URL = "https://$APP_ASSETS_HOST$REMOTE_PAGE_PATH"
private const val FILE_PROVIDER_SUFFIX = ".fileprovider"
private const val TAG = "ZcodeRemoteControlApp"

private data class PendingFileChooser(
    val callback: ValueCallback<Array<Uri>>,
    val params: WebChromeClient.FileChooserParams,
)

private data class CameraCapture(
    val uri: Uri,
    val file: File,
)

/**
 * 文件选择/拍照动作由 Compose 的 ActivityResult launcher 承载。
 * 用可变 holder 而不是局部函数，是因为权限回调要先于相机 launcher 的结果注册。
 */
private class FileChooserActions {
    var launchCamera: () -> Unit = {}
    var launchDocuments: () -> Unit = {}
}

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
    // T6.3：文件保存与打开共用 MediaStore/FileProvider 一条路径，DownloadListener 也复用它。
    val fileSaver = remember(context) { DownloadsFileWriter(context) }
    val fileOpener = remember(context) { AndroidMobileFileOpener(context) }
    val downloadHandler = remember(context) {
        MobileDownloadHandler(context, fileSaver, fileOpener)
    }
    val bridge = remember(secureStore, fileSaver, fileOpener) {
        ZcodeMobileBridge(secureStore, fileSaver, fileOpener)
    }

    var pendingFileChooser by remember { mutableStateOf<PendingFileChooser?>(null) }
    var showFileSourceDialog by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    var pendingCameraFile by remember { mutableStateOf<File?>(null) }

    fun completeFileChooser(uris: Array<Uri>?) {
        val pending = pendingFileChooser
        pendingFileChooser = null
        showFileSourceDialog = false
        pending?.callback?.onReceiveValue(uris)
    }

    fun clearCameraCapture() {
        pendingCameraFile?.let { file -> runCatching { file.delete() } }
        pendingCameraFile = null
        pendingCameraUri = null
    }

    val documentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            completeFileChooser(null)
            return@rememberLauncherForActivityResult
        }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index).uri?.let(uris::add)
            }
        }
        data.data?.let(uris::add)
        completeFileChooser(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val uri = pendingCameraUri
        if (result.resultCode == Activity.RESULT_OK && uri != null) {
            // 拍摄成功后保留缓存文件，交给 WebView 读取；系统会在缓存压力下自行清理。
            pendingCameraFile = null
            pendingCameraUri = null
            completeFileChooser(arrayOf(uri))
        } else {
            clearCameraCapture()
            completeFileChooser(null)
        }
    }

    val actions = remember { FileChooserActions() }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        // 拒绝拍照权限时回退到系统文件选择器，用户仍能添加附件。
        if (granted) {
            actions.launchCamera()
        } else {
            actions.launchDocuments()
        }
    }

    fun requestCameraCapture() {
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            actions.launchCamera()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    actions.launchCamera = {
        val capture = createCameraCapture(context)
        if (capture == null) {
            completeFileChooser(null)
        } else {
            pendingCameraUri = capture.uri
            pendingCameraFile = capture.file
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, capture.uri)
                addFlags(
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                        Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
            try {
                cameraLauncher.launch(intent)
            } catch (error: ActivityNotFoundException) {
                Log.w(TAG, "No camera app is available for attachment capture.", error)
                clearCameraCapture()
                completeFileChooser(null)
            }
        }
    }

    actions.launchDocuments = {
        val pending = pendingFileChooser
        if (pending == null) {
            showFileSourceDialog = false
        } else {
            val spec = FileChooserSpecs.buildPickerSpec(
                acceptTypes = pending.params.acceptTypes.toList(),
                allowMultiple = pending.params.mode ==
                    WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE,
            )
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = spec.type
                if (spec.mimeTypes.isNotEmpty()) {
                    putExtra(Intent.EXTRA_MIME_TYPES, spec.mimeTypes.toTypedArray())
                }
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, spec.allowMultiple)
            }
            try {
                documentLauncher.launch(intent)
            } catch (error: ActivityNotFoundException) {
                Log.w(TAG, "No document picker is available for attachments.", error)
                completeFileChooser(null)
            }
        }
    }

    fun requestFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ) {
        // 上一次选择还没结束时，先按取消处理，避免页面一直等不到回调。
        pendingFileChooser?.callback?.onReceiveValue(null)
        pendingFileChooser = PendingFileChooser(callback, params)
        when {
            params.isCaptureEnabled -> requestCameraCapture()
            FileChooserSpecs.acceptsImages(params.acceptTypes.toList()) ->
                showFileSourceDialog = true
            else -> actions.launchDocuments()
        }
    }

    val chromeClient = remember {
        object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                if (filePathCallback == null || fileChooserParams == null) {
                    return false
                }
                requestFileChooser(filePathCallback, fileChooserParams)
                return true
            }
        }
    }

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
            // 页面销毁时把未完成的文件选择按取消收尾，避免 WebView 的回调悬挂。
            pendingFileChooser?.callback?.onReceiveValue(null)
            pendingFileChooser = null
            pendingCameraFile?.let { file -> runCatching { file.delete() } }
            pendingCameraFile = null
            pendingCameraUri = null
            downloadHandler.shutdown()
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
                        bridge = bridge,
                        chromeClient = chromeClient,
                        downloadHandler = downloadHandler,
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

    if (showFileSourceDialog) {
        AlertDialog(
            onDismissRequest = {
                clearCameraCapture()
                completeFileChooser(null)
            },
            title = { Text(stringResource(R.string.remote_attachment_source_title)) },
            text = { Text(stringResource(R.string.remote_attachment_source_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showFileSourceDialog = false
                        requestCameraCapture()
                    },
                ) {
                    Text(stringResource(R.string.remote_attachment_take_photo))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showFileSourceDialog = false
                        actions.launchDocuments()
                    },
                ) {
                    Text(stringResource(R.string.remote_attachment_choose_file))
                }
            },
        )
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
    bridge: ZcodeMobileBridge,
    chromeClient: WebChromeClient,
    downloadHandler: MobileDownloadHandler,
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
        addJavascriptInterface(bridge, "ZcodeMobileBridge")
        webChromeClient = chromeClient
        // 页面自身发起的下载（a[download] 等）与 saveFile 共用 MediaStore/打开路径。
        setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            if (url != null) {
                downloadHandler.enqueue(url, userAgent, contentDisposition, mimeType)
            }
        }
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

private fun createCameraCapture(context: Context): CameraCapture? {
    val directory = File(context.cacheDir, "camera")
    if (!directory.isDirectory && !directory.mkdirs()) {
        Log.w(TAG, "Unable to create the camera cache directory.")
        return null
    }
    return try {
        val file = File.createTempFile("zcode-photo-", ".jpg", directory)
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}$FILE_PROVIDER_SUFFIX",
            file,
        )
        CameraCapture(uri, file)
    } catch (error: Exception) {
        Log.w(TAG, "Unable to create a camera output file.", error)
        null
    }
}
