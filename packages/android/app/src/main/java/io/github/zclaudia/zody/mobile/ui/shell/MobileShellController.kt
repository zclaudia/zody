package io.github.zclaudia.zody.mobile.ui.shell

import io.github.zclaudia.zody.mobile.config.MobileShellConfig
import io.github.zclaudia.zody.mobile.config.MobileShellConfigState
import io.github.zclaudia.zody.mobile.config.MobileShellConfigStore
import io.github.zclaudia.zody.mobile.config.MobileShellRepairReason
import io.github.zclaudia.zody.mobile.remoteui.REMOTE_UI_ASSET_BASE_PATH
import io.github.zclaudia.zody.mobile.remoteui.REMOTE_UI_ORIGIN
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiErrorCode
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptRequest
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptResponse
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiPaths
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiSecurityHeaders
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiSessionContext
import org.json.JSONObject
import java.net.URI
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/** 当前 WebView 只加载两份可信源之一；互斥由 controller 串行维护。 */
enum class MobileShellSource {
    SHELL,
    REMOTE,
}

/**
 * Controller 对 UI 的只读投影。不包含凭证、Gateway 原文或任何 task/session 业务状态。
 *
 * [generation] 是导航代次；[remoteReady] 只在 Remote 页面显式调用 `markRemoteReady` 后为 true。
 */
data class MobileShellControllerState(
    val source: MobileShellSource?,
    val generation: Long,
    val repairReason: MobileShellRepairReason?,
    val remoteReady: Boolean,
    val lastErrorCode: String?,
)

/** Remote 会话的只读快照，仅供 `ZodyRemoteBridge.getSessionContext()` 生成线格式。 */
data class RemoteSessionSnapshot(
    val sessionId: String,
    val gatewayUrl: String,
    val namespace: String,
    val backendId: String,
    val credential: String,
    val clientInstanceId: String,
)

/**
 * `ZodyShellBridge.openRemote` / `ZodyRemoteBridge.returnShell` 的原生结果。
 *
 * [code] 使用 `packages/shared/src/mobile-ui-bridge.ts` 的稳定错误码；页面只按 code 分支。
 */
sealed interface MobileShellTransitionResult {
    data object Success : MobileShellTransitionResult

    data class Failure(
        val code: String,
        val message: String? = null,
    ) : MobileShellTransitionResult
}

/**
 * 代理工厂。把真实 `RemoteUiProxy` 的创建留给 Android 层，controller 与 JVM 测试只依赖
 * 这个最小接口，不需要 WebView / Looper。
 */
fun interface RemoteUiInterceptorFactory {
    fun create(sessionContext: RemoteUiSessionContext): RemoteUiInterceptor
}

fun interface RemoteUiInterceptor {
    fun execute(request: RemoteUiInterceptRequest): RemoteUiInterceptResponse
}

/** 一次 `shouldInterceptRequest` 的原生结果。 */
sealed interface RemoteUiInterceptOutcome {
    /** 当前没有 Remote 会话：返回本地空错误，绝不退化为通用网络代理。 */
    data object Unavailable : RemoteUiInterceptOutcome

    /** 请求完成。 */
    data class Completed(val response: RemoteUiInterceptResponse) : RemoteUiInterceptOutcome

    /** 请求在途时代次已变化；controller 丢弃该响应，WebView 只得到空流。 */
    data object Stale : RemoteUiInterceptOutcome
}

/** 宿主（Activity/Compose WebView）必须实现的导航与事件出口。 */
interface MobileShellControllerHost {
    fun removeBridges()

    fun installShellBridge()

    fun installRemoteBridge()

    fun loadUrl(url: String)

    fun showRepair(reason: MobileShellRepairReason)

    fun onRemoteReady(generation: Long, backendId: String)

    fun dispatchNotificationClick(payloadJson: String)

    fun dispatchNotificationAction(payloadJson: String)

    fun dispatchNotificationPermissionChanged(granted: Boolean)
}

fun interface MobileShellControllerListener {
    fun onStateChanged(state: MobileShellControllerState)
}

/** Shell / Remote 的精确 origin 与路径 allowlist（spec 6.1）。 */
object MobileShellOrigins {
    const val SHELL_ORIGIN = "https://appassets.androidplatform.net"
    const val SHELL_PATH_PREFIX = "/assets/shell/"
    const val SHELL_PAGE_URL = "$SHELL_ORIGIN${SHELL_PATH_PREFIX}index.html"
    const val REMOTE_PAGE_URL = "$REMOTE_UI_ORIGIN${REMOTE_UI_ASSET_BASE_PATH}index.html"

    /** 主框架只允许 Shell / Remote 的固定 origin + 路径前缀。 */
    fun isAllowedSource(url: String): Boolean {
        val parsed = parse(url) ?: return false
        if (parsed.scheme?.lowercase() != "https" || parsed.userInfo != null) return false
        val path = parsed.path.orEmpty()
        return when (parsed.host?.lowercase()) {
            "appassets.androidplatform.net" -> path.startsWith(SHELL_PATH_PREFIX) && !hasDotSegment(path)
            "remote.zody.local" -> path.startsWith(REMOTE_UI_ASSET_BASE_PATH) && !hasDotSegment(path)
            else -> false
        }
    }

    /** Shell 文档（含 SPA 路由）用于宿主区分“Shell 加载失败”和已返回 Shell 的迟到 Remote 错误。 */
    fun isShellPage(url: String): Boolean {
        val parsed = parse(url) ?: return false
        return parsed.scheme?.lowercase() == "https" &&
            parsed.host?.lowercase() == "appassets.androidplatform.net" &&
            parsed.path.orEmpty().startsWith(SHELL_PATH_PREFIX) &&
            parsed.userInfo == null
    }

    /** Remote origin 的请求交给原生只读代理；其它 origin 继续走默认网络/AssetLoader。 */
    fun isRemoteOrigin(url: String): Boolean {
        val parsed = parse(url) ?: return false
        return parsed.scheme?.lowercase() == "https" &&
            parsed.host?.lowercase() == "remote.zody.local" &&
            parsed.userInfo == null
    }

    private fun parse(url: String): URI? =
        try {
            URI(url)
        } catch (_: Exception) {
            null
        }

    private fun hasDotSegment(path: String): Boolean =
        path.split('/').any { it == "." || it == ".." }
}

/**
 * Shell/Remote 双源导航与原生桥的唯一串行所有者（spec 第 3、7、9.1、9.2 节）。
 *
 * 状态归属：
 * - 本类只持有当前 source、导航 generation、Remote sessionId 和当前会话快照；
 * - Gateway/凭证/backend/configRevision/clientInstanceId 的唯一持久所有者仍是
 *   [MobileShellConfigStore]；本类每次导航/诊断按需读取，不复制配置写路径；
 * - task/session 业务状态不在本类保存或重建。
 *
 * 导航时序（全部在 [mainExecutor] 串行执行）：
 * 1. 先递增 generation 并让旧 Remote sessionId 立即失效；
 * 2. 移除旧 bridge（[MobileShellControllerHost.removeBridges]）；
 * 3. 安装目标 source 的唯一 bridge；
 * 4. 加载目标固定 origin。
 * 迟到的旧代次代理响应由 [intercept] 丢弃。
 */
class MobileShellController(
    private val configStore: MobileShellConfigStore,
    private val appVersion: String,
    private val allowInsecureGatewayTransport: Boolean,
    private val interceptorFactory: RemoteUiInterceptorFactory,
    private val mainExecutor: (Runnable) -> Unit = { runnable -> runnable.run() },
    private val newSessionId: () -> String = { UUID.randomUUID().toString() },
) {
    private class RemoteSession(
        val id: String,
        val config: MobileShellConfig,
        val clientInstanceId: String,
        val interceptor: RemoteUiInterceptor,
        var ready: Boolean = false,
    )

    private data class PendingNotification(
        val type: NotificationType,
        val backendId: String,
        val payloadJson: String,
    )

    private enum class NotificationType {
        CLICK,
        ACTION,
    }

    private data class NavigationCommand(
        val generation: Long,
        val source: MobileShellSource,
        val url: String,
        val repairReason: MobileShellRepairReason?,
    )

    private data class InterceptSnapshot(
        val generation: Long,
        val interceptor: RemoteUiInterceptor,
    )

    private val lock = Any()
    private val listeners = CopyOnWriteArrayList<MobileShellControllerListener>()
    private val pendingNotifications = ArrayDeque<PendingNotification>()

    private var host: MobileShellControllerHost? = null
    private var started = false
    private var source: MobileShellSource? = null
    private var generation = 0L
    private var session: RemoteSession? = null
    private var repairReason: MobileShellRepairReason? = null
    private var lastErrorCode: String? = null

    fun addListener(listener: MobileShellControllerListener) {
        listeners += listener
        listener.onStateChanged(state())
    }

    fun removeListener(listener: MobileShellControllerListener) {
        listeners -= listener
    }

    fun state(): MobileShellControllerState = synchronized(lock) { snapshotLocked() }

    fun currentSource(): MobileShellSource? = synchronized(lock) { source }

    fun isShellSource(): Boolean = synchronized(lock) { started && source == MobileShellSource.SHELL }

    fun isRemoteSource(): Boolean = synchronized(lock) { started && source == MobileShellSource.REMOTE }

    fun lastErrorCode(): String? = synchronized(lock) { lastErrorCode }

    /** 当前 Remote 会话是否仍是 controller 认可的 sessionId（Remote bridge 的 stale 防护）。 */
    fun isCurrentRemoteSession(sessionId: String): Boolean = synchronized(lock) {
        started && source == MobileShellSource.REMOTE && session?.id == sessionId
    }

    fun remoteSessionSnapshot(): RemoteSessionSnapshot? = synchronized(lock) {
        if (!started || source != MobileShellSource.REMOTE) return@synchronized null
        session?.let {
            RemoteSessionSnapshot(
                sessionId = it.id,
                gatewayUrl = it.config.gatewayUrl,
                namespace = it.config.namespace,
                backendId = it.config.backendId ?: return@synchronized null,
                credential = it.config.credential,
                clientInstanceId = it.clientInstanceId,
            )
        }
    }

    /** Debug 构建追加 `insecure-gateway-transport`；Release 绝不包含。 */
    fun bridgeCapabilities(): List<String> {
        val capabilities = mutableListOf(
            "session-context",
            "file-save",
            "file-open",
            "notifications",
            "lifecycle",
        )
        if (allowInsecureGatewayTransport) capabilities += "insecure-gateway-transport"
        return capabilities
    }

    fun attachHost(host: MobileShellControllerHost) {
        var command: NavigationCommand? = null
        synchronized(lock) {
            this.host = host
            // Activity 重建后 WebView 是新实例：按当前不可变快照重新安装 bridge 并重载。
            if (started && source != null) {
                command = NavigationCommand(
                    generation = generation,
                    source = source!!,
                    url = pageUrlFor(source!!),
                    repairReason = repairReason,
                )
            }
        }
        command?.let(::applyNavigation)
        notifyState()
    }

    fun detachHost() {
        synchronized(lock) { host = null }
    }

    /**
     * 首次启动：只读 inspect，RequiresRepair 只记录原因并展示确认框，绝不静默清理。
     *
     * [restoreRemote] 来自 Activity/进程重建时保存的上一 source；只有配置 Ready 且已选 backend
     * 才恢复 Remote，否则回 Shell。用户首次冷启动始终从 Shell 开始。
     */
    fun start(restoreRemote: Boolean) {
        var command: NavigationCommand? = null
        var repair: MobileShellRepairReason? = null
        synchronized(lock) {
            if (started) return@synchronized
            started = true
            val inspected = try {
                configStore.inspect()
            } catch (_: Exception) {
                lastErrorCode = "config-unavailable"
                null
            }
            when (inspected) {
                is MobileShellConfigState.RequiresRepair -> {
                    repair = inspected.reason
                    command = shellCommandLocked(inspected.reason)
                }
                is MobileShellConfigState.Ready -> {
                    val backendId = inspected.config.backendId
                    if (restoreRemote && backendId != null) {
                        val built = buildRemoteCommandLocked(inspected.config, backendId)
                        if (built.first != null) {
                            command = built.first
                        } else {
                            lastErrorCode = built.second
                            command = shellCommandLocked(null)
                        }
                    } else {
                        command = shellCommandLocked(null)
                    }
                }
                MobileShellConfigState.Unconfigured -> command = shellCommandLocked(null)
                null -> command = shellCommandLocked(null)
            }
        }
        command?.let(::applyNavigation)
        notifyState()
    }

    /**
     * Shell → Remote。先校验 expectedConfigRevision 和 backendId，任何失败都不导航。
     *
     * 返回值在导航命令入队后立即返回；真正的 WebView 操作由 [mainExecutor] 串行执行。
     */
    fun openRemoteFromShell(
        backendId: String,
        expectedConfigRevision: Double,
    ): MobileShellTransitionResult {
        val normalizedBackendId = backendId.trim()
        if (normalizedBackendId.isEmpty() || normalizedBackendId.length > MAX_BACKEND_ID_CHARS) {
            return fail("invalid-argument", "A bounded backendId is required.")
        }
        if (!expectedConfigRevision.isFinite() ||
            expectedConfigRevision < 0 ||
            expectedConfigRevision % 1.0 != 0.0 ||
            expectedConfigRevision > MAX_SAFE_INTEGER_DOUBLE
        ) {
            return fail("invalid-argument", "expectedConfigRevision must be a safe integer.")
        }

        var command: NavigationCommand? = null
        var failure: MobileShellTransitionResult? = null
        synchronized(lock) {
            if (!started || source != MobileShellSource.SHELL) {
                failure = MobileShellTransitionResult.Failure("open-remote-failed")
            } else {
                val inspected = try {
                    configStore.inspect()
                } catch (_: Exception) {
                    null
                }
                when (inspected) {
                    is MobileShellConfigState.Ready -> {
                        val config = inspected.config
                        when {
                            config.configRevision != expectedConfigRevision.toLong() ->
                                failure = MobileShellTransitionResult.Failure("config-revision-stale")
                            config.backendId != normalizedBackendId ->
                                failure = MobileShellTransitionResult.Failure("backend-not-found")
                            else -> {
                                val built = buildRemoteCommandLocked(config, normalizedBackendId)
                                command = built.first
                                if (built.first == null) {
                                    failure = MobileShellTransitionResult.Failure(
                                        built.second ?: "open-remote-failed",
                                    )
                                }
                            }
                        }
                    }
                    is MobileShellConfigState.RequiresRepair ->
                        failure = MobileShellTransitionResult.Failure("config-invalid")
                    MobileShellConfigState.Unconfigured, null ->
                        failure = MobileShellTransitionResult.Failure("config-unavailable")
                }
            }
        }
        command?.let(::applyNavigation)
        (failure as? MobileShellTransitionResult.Failure)?.let { recordError(it.code) }
        notifyState()
        return failure ?: MobileShellTransitionResult.Success
    }

    /** Remote → Shell；旧 sessionId 一律 stale-session，不执行导航。 */
    fun returnShellFromRemote(
        reason: String,
        sessionId: String,
    ): MobileShellTransitionResult {
        var command: NavigationCommand? = null
        var failure: MobileShellTransitionResult? = null
        synchronized(lock) {
            if (!started || source != MobileShellSource.REMOTE || session?.id != sessionId) {
                failure = MobileShellTransitionResult.Failure("stale-session")
            } else {
                command = shellCommandLocked(null)
            }
        }
        command?.let(::applyNavigation)
        (failure as? MobileShellTransitionResult.Failure)?.let { recordError(it.code) }
        notifyState()
        return failure ?: MobileShellTransitionResult.Success
    }

    /** Remote 业务 Channel 真正 ready 后才允许派发通知 intent。 */
    fun markRemoteReady(sessionId: String): MobileShellTransitionResult {
        var backendId: String? = null
        var readyGeneration = 0L
        val pending = mutableListOf<PendingNotification>()
        synchronized(lock) {
            val current = session
            if (!started || source != MobileShellSource.REMOTE || current?.id != sessionId) {
                return fail("stale-session")
            }
            current.ready = true
            readyGeneration = generation
            backendId = current.config.backendId
            val iterator = pendingNotifications.iterator()
            while (iterator.hasNext()) {
                val event = iterator.next()
                if (event.backendId == backendId) {
                    pending += event
                    iterator.remove()
                }
            }
        }
        val readyBackend = backendId ?: return MobileShellTransitionResult.Success
        mainExecutor {
            val currentHost = synchronized(lock) {
                if (started && source == MobileShellSource.REMOTE && generation == readyGeneration && session?.ready == true) {
                    host
                } else {
                    null
                }
            }
            currentHost?.onRemoteReady(readyGeneration, readyBackend)
            pending.forEach { event -> dispatchToHost(currentHost, event) }
        }
        notifyState()
        return MobileShellTransitionResult.Success
    }

    /**
     * `shouldInterceptRequest` 的同步入口：只由 WebView interceptor worker 调用。
     *
     * 代理在网络等待时不持有 controller 锁；返回前重新校验 generation，代次变化一律丢弃。
     */
    fun intercept(
        method: String,
        url: String,
        requestHeaders: Map<String, String>,
    ): RemoteUiInterceptOutcome {
        val snapshot = synchronized(lock) {
            if (!started || source != MobileShellSource.REMOTE) {
                return RemoteUiInterceptOutcome.Unavailable
            }
            val current = session ?: return RemoteUiInterceptOutcome.Unavailable
            InterceptSnapshot(generation, current.interceptor)
        }
        val response = try {
            snapshot.interceptor.execute(
                RemoteUiInterceptRequest(
                    method = method,
                    url = url,
                    generation = snapshot.generation,
                    requestHeaders = requestHeaders,
                ),
            )
        } catch (_: Throwable) {
            // 代理内部异常也不能退回通用网络路径；返回本地空错误。
            RemoteUiInterceptResponse(
                statusCode = 502,
                reasonPhrase = RemoteUiPaths.reasonPhraseFor(502),
                headers = RemoteUiSecurityHeaders.errorHeaders(502),
                body = null,
                generation = snapshot.generation,
                errorCode = RemoteUiErrorCode.NETWORK_ERROR,
            )
        }
        val stillCurrent = synchronized(lock) {
            started && source == MobileShellSource.REMOTE && generation == snapshot.generation
        }
        return if (stillCurrent) {
            RemoteUiInterceptOutcome.Completed(response)
        } else {
            RemoteUiInterceptOutcome.Stale
        }
    }

    fun onNotificationClick(backendId: String, notificationId: String) {
        enqueueNotification(
            PendingNotification(
                type = NotificationType.CLICK,
                backendId = backendId,
                payloadJson = JSONObject()
                    .put("backendId", backendId)
                    .put("notificationId", notificationId)
                    .toString(),
            ),
        )
    }

    fun onNotificationAction(
        backendId: String,
        notificationId: String,
        optionId: String,
        optionKind: String,
    ) {
        if (optionKind != "allowOnce" && optionKind != "allowAlways" && optionKind != "deny") return
        enqueueNotification(
            PendingNotification(
                type = NotificationType.ACTION,
                backendId = backendId,
                payloadJson = JSONObject()
                    .put("backendId", backendId)
                    .put("notificationId", notificationId)
                    .put("optionId", optionId)
                    .put("optionKind", optionKind)
                    .toString(),
            ),
        )
    }

    fun onNotificationPermissionChanged(granted: Boolean) {
        mainExecutor {
            val currentHost = synchronized(lock) {
                if (started && source == MobileShellSource.REMOTE) host else null
            }
            currentHost?.dispatchNotificationPermissionChanged(granted)
        }
    }

    /**
     * 用户确认破坏性升级后一次性清理旧 schema；绝不调用 [MobileShellConfigStore.clearConfig]
     * 代替，也不静默删除任何凭证。
     */
    fun confirmRepair(): Boolean {
        val cleared = try {
            configStore.confirmRepairAndClear()
            true
        } catch (_: Exception) {
            false
        }
        var command: NavigationCommand? = null
        synchronized(lock) {
            if (cleared) {
                repairReason = null
                lastErrorCode = null
                // 重新加载 Shell，让页面以“未配置”状态重新开始配对。
                if (source == MobileShellSource.SHELL) command = shellCommandLocked(null)
            } else {
                lastErrorCode = "config-write-failed"
            }
        }
        command?.let(::applyNavigation)
        notifyState()
        return cleared
    }

    fun dismissRepair() {
        synchronized(lock) { repairReason = null }
        notifyState()
    }

    /** Remote 页面/入口加载失败：只释放手机侧 transport 并回 Shell，不重建桌面 runtime。 */
    fun onRemoteLoadFailure() {
        var command: NavigationCommand? = null
        synchronized(lock) {
            if (started && source == MobileShellSource.REMOTE) {
                lastErrorCode = "open-remote-failed"
                command = shellCommandLocked(null)
            }
        }
        command?.let(::applyNavigation)
        notifyState()
    }

    /** Activity 销毁：递增代次、失效 session、丢弃所有未派发事件；不触碰持久配置。 */
    fun shutdown() {
        synchronized(lock) {
            started = false
            generation += 1
            session = null
            source = null
            host = null
            repairReason = null
            pendingNotifications.clear()
        }
        notifyState()
    }

    fun recordError(code: String) {
        synchronized(lock) {
            if (lastErrorCode == code) return@synchronized
            lastErrorCode = code
        }
        notifyState()
    }

    private fun enqueueNotification(event: PendingNotification) {
        if (event.backendId.isBlank() || event.backendId.length > MAX_BACKEND_ID_CHARS) return
        var dispatch = false
        synchronized(lock) {
            val current = session
            dispatch = started &&
                source == MobileShellSource.REMOTE &&
                current?.ready == true &&
                current.config.backendId == event.backendId
            if (!dispatch) {
                if (pendingNotifications.size >= MAX_PENDING_NOTIFICATIONS) {
                    pendingNotifications.removeFirst()
                }
                pendingNotifications.addLast(event)
            }
        }
        if (dispatch) {
            mainExecutor {
                val currentHost = synchronized(lock) {
                    if (started && source == MobileShellSource.REMOTE && session?.ready == true) host else null
                }
                dispatchToHost(currentHost, event)
            }
        }
    }

    private fun dispatchToHost(
        currentHost: MobileShellControllerHost?,
        event: PendingNotification,
    ) {
        when (event.type) {
            NotificationType.CLICK -> currentHost?.dispatchNotificationClick(event.payloadJson)
            NotificationType.ACTION -> currentHost?.dispatchNotificationAction(event.payloadJson)
        }
    }

    private fun buildRemoteCommandLocked(
        config: MobileShellConfig,
        backendId: String,
    ): Pair<NavigationCommand?, String?> {
        val clientInstanceId = try {
            configStore.getOrCreateClientInstanceId(backendId)
        } catch (_: Exception) {
            return null to "config-invalid"
        }
        val sessionId = newSessionId().trim()
        if (sessionId.isEmpty() || sessionId.length > MAX_SESSION_ID_CHARS) {
            return null to "open-remote-failed"
        }
        val interceptor = try {
            interceptorFactory.create(
                RemoteUiSessionContext(
                    sessionId = sessionId,
                    gatewayBaseUrl = config.gatewayUrl,
                    backendId = backendId,
                    bearerToken = config.credential,
                ),
            )
        } catch (_: Exception) {
            return null to "open-remote-failed"
        }
        generation += 1
        source = MobileShellSource.REMOTE
        session = RemoteSession(
            id = sessionId,
            config = config,
            clientInstanceId = clientInstanceId,
            interceptor = interceptor,
        )
        repairReason = null
        lastErrorCode = null
        return NavigationCommand(
            generation = generation,
            source = MobileShellSource.REMOTE,
            url = MobileShellOrigins.REMOTE_PAGE_URL,
            repairReason = null,
        ) to null
    }

    private fun shellCommandLocked(repair: MobileShellRepairReason?): NavigationCommand {
        generation += 1
        source = MobileShellSource.SHELL
        session = null
        repairReason = repair
        return NavigationCommand(
            generation = generation,
            source = MobileShellSource.SHELL,
            url = MobileShellOrigins.SHELL_PAGE_URL,
            repairReason = repair,
        )
    }

    private fun applyNavigation(command: NavigationCommand) {
        mainExecutor {
            synchronized(lock) {
                val currentHost = host ?: return@synchronized
                if (!started ||
                    command.generation != generation ||
                    command.source != source
                ) {
                    return@synchronized
                }
                // 严格顺序：移除旧 bridge → 安装目标 bridge → 导航。
                currentHost.removeBridges()
                when (command.source) {
                    MobileShellSource.SHELL -> currentHost.installShellBridge()
                    MobileShellSource.REMOTE -> currentHost.installRemoteBridge()
                }
                currentHost.loadUrl(command.url)
                command.repairReason?.let { currentHost.showRepair(it) }
            }
        }
    }

    private fun snapshotLocked(): MobileShellControllerState =
        MobileShellControllerState(
            source = source,
            generation = generation,
            repairReason = repairReason,
            remoteReady = session?.ready == true,
            lastErrorCode = lastErrorCode,
        )

    private fun notifyState() {
        val snapshot = synchronized(lock) { snapshotLocked() }
        mainExecutor {
            listeners.forEach { listener -> runCatching { listener.onStateChanged(snapshot) } }
        }
    }

    private fun fail(code: String, message: String? = null): MobileShellTransitionResult =
        MobileShellTransitionResult.Failure(code, message)

    private fun pageUrlFor(source: MobileShellSource): String = when (source) {
        MobileShellSource.SHELL -> MobileShellOrigins.SHELL_PAGE_URL
        MobileShellSource.REMOTE -> MobileShellOrigins.REMOTE_PAGE_URL
    }

    private companion object {
        const val MAX_SAFE_INTEGER_DOUBLE = 9_007_199_254_740_991.0
        const val MAX_BACKEND_ID_CHARS = 256
        const val MAX_SESSION_ID_CHARS = 256
        const val MAX_PENDING_NOTIFICATIONS = 16
    }
}
