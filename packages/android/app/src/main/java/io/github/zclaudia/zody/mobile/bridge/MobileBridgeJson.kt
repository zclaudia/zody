package io.github.zclaudia.zody.mobile.bridge

import org.json.JSONObject

/**
 * 原生桥 JSON envelope（shared `mobile-ui-bridge.ts`）。
 *
 * 页面只能按 `error.code` 分支；`message` 只用于诊断，不得包含凭证、URL 原文或业务数据。
 * 成功 envelope 的额外字段由具体命令定义，全部为 additive。
 */
internal object MobileBridgeJson {
    const val SCHEMA_VERSION: Int = 1
    const val BRIDGE_VERSION: Int = 1
    const val MAX_ERROR_MESSAGE_CHARS: Int = 512

    fun success(build: JSONObject.() -> Unit = {}): String =
        JSONObject()
            .put("schemaVersion", SCHEMA_VERSION)
            .put("ok", true)
            .apply(build)
            .toString()

    fun failure(code: String, message: String? = null): String {
        val error = JSONObject().put("code", code)
        if (message != null) {
            error.put("message", message.take(MAX_ERROR_MESSAGE_CHARS))
        }
        return JSONObject()
            .put("schemaVersion", SCHEMA_VERSION)
            .put("ok", false)
            .put("error", error)
            .toString()
    }

    fun bridgeCapabilities(
        appVersion: String,
        allowInsecureGatewayTransport: Boolean,
    ): JSONObject {
        val capabilities = JSONObject()
            .put("schemaVersion", SCHEMA_VERSION)
            .put("bridgeVersion", BRIDGE_VERSION)
            .put("appVersion", appVersion)
            .put(
                "capabilities",
                org.json.JSONArray(
                    buildList {
                        add("session-context")
                        add("file-save")
                        add("file-open")
                        add("notifications")
                        add("lifecycle")
                        if (allowInsecureGatewayTransport) add("insecure-gateway-transport")
                    },
                ),
            )
        return capabilities
    }

    fun parseObjectOrNull(raw: String?): JSONObject? =
        if (raw == null) null else runCatching { JSONObject(raw) }.getOrNull()
}

/** 把可选对象放进 envelope；`JSONObject.NULL` 保持与 shared `nullable` 语义一致。 */
internal fun JSONObject.putNullable(name: String, value: JSONObject?) {
    put(name, value ?: JSONObject.NULL)
}

/** shared 契约中的稳定错误码，Android 侧只使用这里的常量。 */
internal object MobileBridgeErrors {
    const val NATIVE_BRIDGE_UNAVAILABLE = "native-bridge-unavailable"
    const val INVALID_ARGUMENT = "invalid-argument"
    const val CONFIG_UNAVAILABLE = "config-unavailable"
    const val CONFIG_INVALID = "config-invalid"
    const val CONFIG_REVISION_STALE = "config-revision-stale"
    const val CONFIG_WRITE_FAILED = "config-write-failed"
    const val BACKEND_NOT_FOUND = "backend-not-found"
    const val BACKEND_REMOTE_CONTROL_UNSUPPORTED = "backend-remote-control-unsupported"
    const val BACKEND_UI_UNSUPPORTED = "backend-ui-unsupported"
    const val OPEN_REMOTE_FAILED = "open-remote-failed"
    const val SESSION_CONTEXT_INVALID = "session-context-invalid"
    const val STALE_SESSION = "stale-session"
    const val NATIVE_BUSY = "native-busy"
    const val BRIDGE_VERSION_UNSUPPORTED = "bridge-version-unsupported"
    const val UNSUPPORTED_CAPABILITY = "unsupported-capability"
}
