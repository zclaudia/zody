package io.github.zclaudia.zody.mobile.remoteui

/**
 * Remote UI 原生代理的纯数据契约（spec 6.1/6.2/6.3）。
 *
 * 本包不读取 Android Store、不持有 task/session 业务状态，也不创建任何 UI 或 Activity 依赖；
 * `RemoteUiSessionContext` 由后续 MobileShellController 从当前会话填充。这样代理与缓存可以在
 * 普通 JVM 测试中验证，controller 只负责线程、导航代次和响应丢弃。
 */

/** Remote 页面唯一的应用内固定 origin；不做 DNS，也不加载公网页面。 */
const val REMOTE_UI_ORIGIN = "https://remote.zody.local"
const val REMOTE_UI_HOST = "remote.zody.local"

/** 与桌面 MobileUiAssetProvider 一致的只读路径。 */
const val REMOTE_UI_RELEASE_PATH = "/mobile-ui/release"
const val REMOTE_UI_ASSET_BASE_PATH = "/assets/remote/"
const val REMOTE_UI_RELEASE_MANIFEST_FILE = "release.json"

/** Gateway 的 HTTP-over-channel 代理前缀。 */
const val GATEWAY_PROXY_PATH_PREFIX = "/api/proxy/"

/** 单次响应上限，与桌面 provider 的 DEFAULT_MOBILE_UI_MAX_RESPONSE_BYTES 对齐。 */
const val DEFAULT_MAX_RESPONSE_BYTES: Int = 16 * 1024 * 1024
const val DEFAULT_MAX_CACHE_ENTRIES: Int = 128
const val DEFAULT_MAX_CACHE_BYTES: Long = 32L * 1024L * 1024L
const val DEFAULT_CONNECT_TIMEOUT_MILLIS: Int = 15_000
const val DEFAULT_READ_TIMEOUT_MILLIS: Int = 30_000
const val DEFAULT_IMMUTABLE_TTL_MILLIS: Long = 365L * 24L * 60L * 60L * 1000L

/**
 * controller 填充的只读会话数据。
 *
 * - [gatewayBaseUrl] 必须是归一化后的 http(s) 基址，可含部署前缀，但不能带凭证、query 或 fragment；
 * - [backendId] 用于 `/api/proxy/<backendId><path>`，只允许安全字符；
 * - [bearerToken] 只用于原生注入 `Authorization: Bearer`，不得写入日志、URL 或响应。
 */
data class RemoteUiSessionContext(
    val sessionId: String,
    val gatewayBaseUrl: String,
    val backendId: String,
    val bearerToken: String,
)

/**
 * WebView `shouldInterceptRequest` 的纯数据投影。
 *
 * [generation] 由 controller 在每次调用时传入并原样带回；proxy/cache 不保存它，也不据此
 * 淘汰任何业务状态。旧 generation 的响应由 controller 丢弃。
 */
data class RemoteUiInterceptRequest(
    val method: String,
    val url: String,
    val generation: Long,
    val requestHeaders: Map<String, String> = emptyMap(),
)

/** 可直接转换为 `WebResourceResponse` 的原生结果；[body] 为 null 表示没有响应体（HEAD/错误）。 */
data class RemoteUiInterceptResponse(
    val statusCode: Int,
    val reasonPhrase: String,
    val headers: Map<String, String>,
    val body: ByteArray?,
    val generation: Long,
    val fromCache: Boolean = false,
    val errorCode: RemoteUiErrorCode? = null,
) {
    /** `WebResourceResponse` 的 MIME 参数；不含 charset 时由 content-type 原样传递。 */
    val contentType: String?
        get() = headers.entries.firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }?.value
}

/** 与桌面 provider 的缓存分类保持一致。 */
enum class RemoteUiAssetKind {
    RELEASE,
    ENTRY,
    IMMUTABLE,
    REVALIDATED,
}

/** 路径/方法/上下文校验结果；错误码只用于原生诊断，不包含凭证或完整 URL。 */
enum class RemoteUiErrorCode {
    INVALID_METHOD,
    INVALID_ORIGIN,
    INVALID_PATH,
    INVALID_SESSION_CONTEXT,
    UPSTREAM_REDIRECT,
    RESPONSE_TOO_LARGE,
    CONNECT_TIMEOUT,
    READ_TIMEOUT,
    NETWORK_ERROR,
}

internal data class NormalizedRemoteUiSessionContext(
    val sessionId: String,
    val gatewayBaseUrl: String,
    val gatewayOrigin: String,
    val gatewayWsOrigin: String,
    val backendId: String,
    val bearerToken: String,
)

internal sealed interface RemoteUiPathResolution {
    data class Allowed(
        val pathname: String,
        val query: String,
        val kind: RemoteUiAssetKind,
        val contentType: String,
    ) : RemoteUiPathResolution

    data class Rejected(
        val status: Int,
        val code: RemoteUiErrorCode,
    ) : RemoteUiPathResolution
}
