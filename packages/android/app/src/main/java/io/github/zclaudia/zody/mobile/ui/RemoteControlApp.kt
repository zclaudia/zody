package io.github.zclaudia.zody.mobile.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.windowInsetsPadding
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
import androidx.compose.runtime.saveable.rememberSaveable
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
import io.github.zclaudia.zody.mobile.BuildConfig
import io.github.zclaudia.zody.mobile.MainActivity
import io.github.zclaudia.zody.mobile.R
import io.github.zclaudia.zody.mobile.bridge.AndroidMobileFileOpener
import io.github.zclaudia.zody.mobile.bridge.DownloadsFileWriter
import io.github.zclaudia.zody.mobile.bridge.EncryptedSharedPreferencesSecureStore
import io.github.zclaudia.zody.mobile.bridge.FileChooserSpecs
import io.github.zclaudia.zody.mobile.bridge.MobileBridgeEventDispatcher
import io.github.zclaudia.zody.mobile.bridge.MobileBridgeLifecycleState
import io.github.zclaudia.zody.mobile.bridge.MobileDownloadHandler
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationActionDispatcher
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeAdapter
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationBridgeClient
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationClickDispatcher
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationPermissionDispatcher
import io.github.zclaudia.zody.mobile.bridge.RemoteNativeOperationState
import io.github.zclaudia.zody.mobile.bridge.RemoteNativeReloadGuard
import io.github.zclaudia.zody.mobile.bridge.ZodyRemoteBridge
import io.github.zclaudia.zody.mobile.bridge.ZodyShellBridge
import io.github.zclaudia.zody.mobile.config.MobileShellConfigStore
import io.github.zclaudia.zody.mobile.config.MobileShellRepairReason
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptRequest
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptResponse
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiProxy
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiResponseCache
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiSessionContext
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellController
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellControllerHost
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellControllerListener
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellControllerState
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellOrigins
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellSource
import io.github.zclaudia.zody.mobile.ui.shell.RemoteUiInterceptOutcome
import io.github.zclaudia.zody.mobile.ui.shell.RemoteUiInterceptor
import io.github.zclaudia.zody.mobile.ui.shell.RemoteUiWebResponse
import io.github.zclaudia.zody.mobile.ui.shell.toWebResponse
import java.io.ByteArrayInputStream
import java.io.File

private const val FILE_PROVIDER_SUFFIX = ".fileprovider"
private const val TAG = "ZodyRemoteControlApp"

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

/**
 * Shell（APK assets）与 Remote（桌面只读 UI）共用一个 WebView。
 *
 * 导航、bridge 互斥、代次和 session 生命周期全部由 [MobileShellController] 串行管理；
 * 本 Composable 只保留 Android 平台能力（文件选择、拍照、通知 pending、系统栏、保活）和
 * WebView 的同步拦截器接线，不保存 task/session 业务状态。
 */
@Composable
fun RemoteControlApp(
    modifier: Modifier = Modifier,
    // M3：与 MainActivity 共享同一实例，通知权限请求也计入原生 veto；重建时随宿主新建。
    nativeOperationState: RemoteNativeOperationState = remember { RemoteNativeOperationState() },
) {
    val context = LocalContext.current
    val activity = context as? Activity
    val assetLoader = remember(context) {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
    }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var bridgeDispatcher by remember { mutableStateOf<MobileBridgeEventDispatcher?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var pageError by remember { mutableStateOf<String?>(null) }
    var controllerState by remember { mutableStateOf<MobileShellControllerState?>(null) }
    // Activity/进程重建时恢复上一 source；冷启动始终从 Shell 开始。
    var startRemote by rememberSaveable { mutableStateOf(false) }
    // 文件选择、拍照和相机权限由本 Composable 的 ActivityResult launcher 承载；
    // 状态只表达“系统 UI 尚未返回”，prepareReload 读取它做原生 veto。
    var pendingFileChooser by remember { mutableStateOf<PendingFileChooser?>(null) }
    var showFileSourceDialog by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    var pendingCameraFile by remember { mutableStateOf<File?>(null) }

    // 凭证存储随页面创建；Keystore 主密钥在首次读写时才初始化。
    val secureStore = remember(context) { EncryptedSharedPreferencesSecureStore(context) }
    val configStore = remember(context) {
        MobileShellConfigStore(secureStore, allowInsecureTransport = BuildConfig.DEBUG)
    }
    // T6.3：文件保存与打开共用 MediaStore/FileProvider 一条路径，DownloadListener 也复用它。
    val fileSaver = remember(context) { DownloadsFileWriter(context) }
    val fileOpener = remember(context) { AndroidMobileFileOpener(context) }
    val notificationBridge = remember(context) { MobileNotificationBridgeClient(context) }
    val downloadHandler = remember(context) {
        MobileDownloadHandler(context, fileSaver, fileOpener)
    }
    val remoteUiCache = remember { RemoteUiResponseCache() }
    val controller = remember(configStore) {
        MobileShellController(
            configStore = configStore,
            appVersion = BuildConfig.VERSION_NAME,
            allowInsecureGatewayTransport = BuildConfig.DEBUG,
            interceptorFactory = { sessionContext ->
                AndroidRemoteUiInterceptor(
                    sessionContext = sessionContext,
                    cache = remoteUiCache,
                    allowInsecureGatewayTransport = BuildConfig.DEBUG,
                )
            },
            mainExecutor = { runnable -> Handler(Looper.getMainLooper()).post(runnable) },
        )
    }
    val shellBridge = remember(controller, configStore) {
        ZodyShellBridge(
            controller = controller,
            configStore = configStore,
            appVersion = BuildConfig.VERSION_NAME,
            allowInsecureGatewayTransport = BuildConfig.DEBUG,
        )
    }
    val remoteBridge = remember(
        controller,
        fileSaver,
        fileOpener,
        notificationBridge,
        activity,
        nativeOperationState,
    ) {
        ZodyRemoteBridge(
            controller = controller,
            appVersion = BuildConfig.VERSION_NAME,
            fileSaver = fileSaver,
            fileOpener = fileOpener,
            notificationBridge = MobileNotificationBridgeAdapter(notificationBridge),
            requestNotificationPermission = {
                (activity as? MainActivity)?.requestNotificationPermissionIfNeeded()
            },
            nativeReloadGuard = RemoteNativeReloadGuard { nativeOperationState.isBusy() },
        )
    }
    val shellHost = remember(controller, shellBridge, remoteBridge) {
        WebViewShellHost(
            shellBridge = shellBridge,
            remoteBridge = remoteBridge,
            currentView = { webView },
            currentDispatcher = { bridgeDispatcher },
        )
    }

    fun completeFileChooser(uris: Array<Uri>?) {
        nativeOperationState.end(RemoteNativeOperationState.Operation.FILE_CHOOSER)
        nativeOperationState.end(RemoteNativeOperationState.Operation.CAMERA_CAPTURE)
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
        // 拍照取消或完成都会回到这里，先释放拍照 busy。
        nativeOperationState.end(RemoteNativeOperationState.Operation.CAMERA_CAPTURE)
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
        // 权限对话框已返回（授予、拒绝或系统取消），对应 busy 结束。
        nativeOperationState.end(RemoteNativeOperationState.Operation.CAMERA_PERMISSION)
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
            nativeOperationState.begin(RemoteNativeOperationState.Operation.CAMERA_PERMISSION)
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
            nativeOperationState.begin(RemoteNativeOperationState.Operation.CAMERA_CAPTURE)
            try {
                cameraLauncher.launch(intent)
            } catch (error: ActivityNotFoundException) {
                Log.w(TAG, "No camera app is available for attachment capture.", error)
                nativeOperationState.end(RemoteNativeOperationState.Operation.CAMERA_CAPTURE)
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
        nativeOperationState.begin(RemoteNativeOperationState.Operation.FILE_CHOOSER)
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

    // controller 的 source/generation/repair 状态是 Compose 的唯一只读来源。
    DisposableEffect(controller) {
        val listener = MobileShellControllerListener { state ->
            controllerState = state
            startRemote = state.source == MobileShellSource.REMOTE
        }
        controller.addListener(listener)
        onDispose { controller.removeListener(listener) }
    }

    // T6.2：Activity ON_START/ON_STOP 是“页面是否可见”的宿主事实，用它驱动页面暂停/恢复连接。
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

    // 通知 intent 先进入 controller；Remote ready 之前只排队，不向页面派发。
    DisposableEffect(controller) {
        val clickSubscription = MobileNotificationClickDispatcher.subscribe { backendId, notificationId ->
            controller.onNotificationClick(backendId, notificationId)
        }
        val permissionSubscription = MobileNotificationPermissionDispatcher.subscribe { granted ->
            controller.onNotificationPermissionChanged(granted)
        }
        val actionSubscription = MobileNotificationActionDispatcher.subscribe { backendId, notificationId, optionId, optionKind ->
            controller.onNotificationAction(backendId, notificationId, optionId, optionKind)
        }
        onDispose {
            clickSubscription.close()
            permissionSubscription.close()
            actionSubscription.close()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            // Activity 重建/销毁：先失效 controller，再清理随宿主生命周期结束的原生 busy 标记。
            controller.shutdown()
            nativeOperationState.clear()
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
                modifier = Modifier
                    .fillMaxSize()
                    // Bugfix: edge-to-edge 下 WebView 铺满整屏，页面头部压到状态栏、底部按钮压到手势条。
                    // 壳统一消费系统栏 insets（排除 IME，键盘行为维持 WebView 默认）；Android WebView
                    // 对 env(safe-area-inset-*) 的支持不可靠，安全区不能交给页面自处理。
                    .windowInsetsPadding(WindowInsets.safeDrawing.exclude(WindowInsets.ime)),
                factory = { viewContext ->
                    createRemoteControlWebView(
                        context = viewContext,
                        assetLoader = assetLoader,
                        controller = controller,
                        chromeClient = chromeClient,
                        downloadHandler = downloadHandler,
                        onLoadingChanged = { loading -> isLoading = loading },
                        onMainFrameError = { message -> pageError = message },
                    ).also { view ->
                        bridgeDispatcher = MobileBridgeEventDispatcher.forWebView(view)
                        webView = view
                        // 先挂 host，再由 controller 串行安装 Shell bridge 并加载 Shell。
                        controller.attachHost(shellHost)
                        controller.start(restoreRemote = startRemote)
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
                        // Shell 加载失败时重试仍是 Shell；Remote 失败已由 controller 回 Shell。
                        webView?.loadUrl(MobileShellOrigins.SHELL_PAGE_URL)
                    },
                )
            }
        }
    }

    if (controllerState?.repairReason != null) {
        AlertDialog(
            onDismissRequest = { controller.dismissRepair() },
            title = { Text(stringResource(R.string.mobile_shell_repair_title)) },
            text = { Text(stringResource(R.string.mobile_shell_repair_message)) },
            confirmButton = {
                TextButton(onClick = { controller.confirmRepair() }) {
                    Text(stringResource(R.string.mobile_shell_repair_confirm))
                }
            },
            dismissButton = {
                TextButton(onClick = { controller.dismissRepair() }) {
                    Text(stringResource(R.string.mobile_shell_repair_cancel))
                }
            },
        )
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

private class WebViewShellHost(
    private val shellBridge: ZodyShellBridge,
    private val remoteBridge: ZodyRemoteBridge,
    private val currentView: () -> WebView?,
    private val currentDispatcher: () -> MobileBridgeEventDispatcher?,
) : MobileShellControllerHost {
    override fun removeBridges() {
        currentView()?.apply {
            removeJavascriptInterface(ZodyShellBridge.GLOBAL_KEY)
            removeJavascriptInterface(ZodyRemoteBridge.GLOBAL_KEY)
        }
    }

    override fun installShellBridge() {
        currentView()?.addJavascriptInterface(shellBridge, ZodyShellBridge.GLOBAL_KEY)
    }

    override fun installRemoteBridge() {
        currentView()?.addJavascriptInterface(remoteBridge, ZodyRemoteBridge.GLOBAL_KEY)
    }

    override fun loadUrl(url: String) {
        currentView()?.loadUrl(url)
    }

    override fun showRepair(reason: MobileShellRepairReason) {
        // 重新配对确认框由 Compose 观察 controller 状态渲染；这里不需要额外的 View 操作。
    }

    override fun onRemoteReady(generation: Long, backendId: String) {
        // Remote ready 后 controller 已按代次/backend 派发排队的通知事件。
    }

    override fun dispatchNotificationClick(payloadJson: String) {
        currentDispatcher()?.dispatchNotificationClick(payloadJson)
    }

    override fun dispatchNotificationAction(payloadJson: String) {
        currentDispatcher()?.dispatchNotificationAction(payloadJson)
    }

    override fun dispatchNotificationPermissionChanged(granted: Boolean) {
        currentDispatcher()?.dispatchNotificationPermissionChanged(granted)
    }
}

private class AndroidRemoteUiInterceptor(
    sessionContext: RemoteUiSessionContext,
    cache: RemoteUiResponseCache,
    allowInsecureGatewayTransport: Boolean,
) : RemoteUiInterceptor {
    private val proxy = RemoteUiProxy(
        sessionContext = sessionContext,
        cache = cache,
        requireHttpsGateway = !allowInsecureGatewayTransport,
        threadGuard = {
            check(Looper.myLooper() != Looper.getMainLooper()) {
                "RemoteUiProxy must run on a WebView interceptor worker."
            }
        },
    )

    override fun execute(request: RemoteUiInterceptRequest): RemoteUiInterceptResponse =
        proxy.execute(request)
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
    controller: MobileShellController,
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
            // Debug 本地开发允许 http Gateway 的混合内容；release 保持 HTTPS-only。
            mixedContentMode = if (BuildConfig.DEBUG) WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                else WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString ZodyAndroid/${BuildConfig.VERSION_NAME}"
        }
        // bridge 不在这里安装：由 controller 在每次导航时先移除旧 bridge、再安装目标 bridge。
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
                val url = request.url.toString()
                // Remote origin 的 UI 请求全部走原生只读代理；其它请求（含 Gateway WSS/fetch）保持默认路径。
                if (MobileShellOrigins.isRemoteOrigin(url)) {
                    return when (
                        val outcome = controller.intercept(
                            method = request.method,
                            url = url,
                            requestHeaders = request.requestHeaders,
                        )
                    ) {
                        RemoteUiInterceptOutcome.Unavailable,
                        RemoteUiInterceptOutcome.Stale,
                        -> emptyInterceptResponse()
                        is RemoteUiInterceptOutcome.Completed ->
                            outcome.response.toWebResponse(request.method).toAndroidWebResponse()
                    }
                }
                // Shell 的 /assets/shell/ 由 AssetLoader 映射到 APK assets。
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
                val allowed = MobileShellOrigins.isAllowedSource(request.url.toString())
                if (request.isForMainFrame) {
                    if (allowed) {
                        return false
                    }
                    // 主框架离开两份固定 source 一律交给系统浏览器；非 http(s) scheme 不打开。
                    openExternalUrl(view.context, request.url)
                    return true
                }
                // 第三方 iframe 一律拦截，且不为子框架打开外部浏览器。
                return !allowed
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame != true) {
                    return
                }
                handleMainFrameFailure(
                    url = request.url.toString(),
                    message = error?.description?.toString().orEmpty(),
                    controller = controller,
                    onLoadingChanged = onLoadingChanged,
                    onMainFrameError = onMainFrameError,
                )
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?,
            ) {
                if (request?.isForMainFrame != true) {
                    return
                }
                val status = errorResponse?.statusCode ?: return
                if (status < 400) {
                    return
                }
                handleMainFrameFailure(
                    url = request.url.toString(),
                    message = "HTTP $status",
                    controller = controller,
                    onLoadingChanged = onLoadingChanged,
                    onMainFrameError = onMainFrameError,
                )
            }
        }
    }
}

private fun handleMainFrameFailure(
    url: String,
    message: String,
    controller: MobileShellController,
    onLoadingChanged: (Boolean) -> Unit,
    onMainFrameError: (String) -> Unit,
) {
    onLoadingChanged(false)
    if (controller.isRemoteSource() && MobileShellOrigins.isRemoteOrigin(url)) {
        // Remote 入口/资源失败：只释放手机侧 transport 并回 Shell，不重建桌面 runtime。
        controller.onRemoteLoadFailure()
        return
    }
    if (!controller.isRemoteSource() && MobileShellOrigins.isShellPage(url)) {
        onMainFrameError(message)
    }
}

private fun RemoteUiWebResponse.toAndroidWebResponse(): WebResourceResponse =
    WebResourceResponse(
        mimeType,
        encoding,
        statusCode,
        reasonPhrase,
        headers,
        ByteArrayInputStream(body),
    )

private fun emptyInterceptResponse(): WebResourceResponse =
    WebResourceResponse(
        "text/plain",
        "utf-8",
        503,
        "Service Unavailable",
        mapOf(
            "cache-control" to "no-store",
            "x-content-type-options" to "nosniff",
        ),
        ByteArrayInputStream(ByteArray(0)),
    )

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
        val file = File.createTempFile("zody-photo-", ".jpg", directory)
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
