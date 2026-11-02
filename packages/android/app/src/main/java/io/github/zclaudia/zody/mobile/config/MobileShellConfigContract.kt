package io.github.zclaudia.zody.mobile.config

import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException

/**
 * Shell 连接配置线格式（spec 第 2、3、7 节）。
 *
 * 字段与 `packages/shared/src/mobile-ui-bridge.ts` 的 strict schema 一一对应：
 * - 持久配置：`{ schemaVersion, gatewayUrl, namespace, credential, backendId?, configRevision }`
 * - 设置页草稿：`{ gatewayUrl, namespace, credential, backendId? }`
 *
 * 原生侧只负责校验/归一化并持久化；页面传入的 revision 一律忽略，由 store 写入时递增。
 */
data class MobileShellConfig(
    val gatewayUrl: String,
    val namespace: String,
    val credential: String,
    val backendId: String?,
    val configRevision: Long,
) {
    /**
     * 凭证不得进入日志。默认 data class toString 会打印全部字段，这里固定脱敏，
     * 避免控制器或诊断代码误把整个对象写进日志。
     */
    override fun toString(): String =
        "MobileShellConfig(gatewayUrl=$gatewayUrl, namespace=$namespace, credential=<redacted>, " +
            "backendId=$backendId, configRevision=$configRevision)"
}

/** 设置页提交的草稿；不含 `configRevision` 和 `schemaVersion`。 */
data class MobileShellConfigWrite(
    val gatewayUrl: String,
    val namespace: String,
    val credential: String,
    val backendId: String?,
) {
    override fun toString(): String =
        "MobileShellConfigWrite(gatewayUrl=$gatewayUrl, namespace=$namespace, " +
            "credential=<redacted>, backendId=$backendId)"
}

/**
 * 与 shared bridge 契约保持一致的常量。
 *
 * `CONFIG_STORAGE_KEY` 使用新的 key，旧 `config` key 只用于检测破坏性升级；
 * 构造 store 不会读取后删除任何旧值。
 */
object MobileShellConfigContract {
    const val SCHEMA_VERSION: Int = 1
    const val DEFAULT_NAMESPACE: String = "zody"
    const val CREDENTIAL_PREFIX: String = "zgd_"

    const val MAX_GATEWAY_URL_CHARS: Int = 2048
    const val MAX_NAMESPACE_CHARS: Int = 128
    const val MAX_CREDENTIAL_CHARS: Int = 512
    const val MAX_BACKEND_ID_CHARS: Int = 256
    const val MAX_CLIENT_INSTANCE_ID_CHARS: Int = 256
    const val MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991L

    /** 新 schema 的唯一持久配置 key。 */
    const val CONFIG_STORAGE_KEY: String = "zody-mobile-shell-config-v1"

    /** configRevision 单独保存：配置被清除后 revision 仍需单调递增。 */
    const val REVISION_STORAGE_KEY: String = "zody-mobile-shell-config-revision-v1"

    /** 按 backendId 保存的 clientInstanceId 映射（一个 key，便于破坏性升级时一次清理）。 */
    const val CLIENT_INSTANCE_IDS_STORAGE_KEY: String = "zody-mobile-shell-client-instance-ids-v1"

    /** 旧页面 `MobileRemoteConfigStore` 的 key；只用于检测旧 schema。 */
    const val LEGACY_CONFIG_STORAGE_KEY: String = "config"

    /** 旧页面按 backend 保存 clientInstanceId 的 key 前缀；只在用户确认后清理。 */
    const val LEGACY_CLIENT_INSTANCE_ID_PREFIX: String = "client-instance-id:"
}

/**
 * 归一化 Gateway 地址，规则与 shared `tryNormalizeRemoteAccessGatewayUrl` 一致：
 * - 统一 http/ws、https/wss；
 * - 去掉尾部斜杠，保留部署前缀；
 * - 拒绝相对地址、用户信息、query、fragment 和非法端口；
 * - release（`allowInsecureTransport=false`）只允许 https。
 */
fun normalizeMobileShellGatewayUrl(
    value: String,
    allowInsecureTransport: Boolean,
): String? {
    val trimmed = value.trim()
    if (trimmed.isEmpty() || trimmed.length > MobileShellConfigContract.MAX_GATEWAY_URL_CHARS) {
        return null
    }
    val uri = try {
        URI(trimmed)
    } catch (_: URISyntaxException) {
        return null
    }
    if (!uri.isAbsolute || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
        return null
    }
    val scheme = when (uri.scheme?.lowercase()) {
        "https", "wss" -> "https"
        "http", "ws" -> if (allowInsecureTransport) "http" else return null
        else -> return null
    }
    val host = uri.host?.lowercase() ?: return null
    val port = uri.port
    val normalizedPort = when {
        port == -1 -> ""
        scheme == "https" && port == 443 -> ""
        scheme == "http" && port == 80 -> ""
        port in 1..65535 -> ":$port"
        else -> return null
    }
    val path = uri.rawPath.orEmpty().trimEnd('/')
    return "$scheme://$host$normalizedPort$path"
}

/**
 * 严格解析持久配置。任何字段缺失、类型不符、未知字段或无法归一化都返回 null，
 * 由 [MobileShellConfigStore] 判定为需要重新配对，而不是静默丢弃凭证。
 */
fun parsePersistedMobileShellConfig(
    raw: String,
    allowInsecureTransport: Boolean,
): MobileShellConfig? {
    val json = parseJsonObject(raw) ?: return null
    val required = setOf(
        "schemaVersion",
        "gatewayUrl",
        "namespace",
        "credential",
        "configRevision",
    )
    val allowed = required + "backendId"
    val keys = json.keys().asSequence().toSet()
    // backendId 是可选的；其余字段必须齐全，且不允许 shared strict schema 之外的字段。
    if (!keys.containsAll(required) || !allowed.containsAll(keys)) {
        return null
    }
    if (readJsonInteger(json, "schemaVersion") != MobileShellConfigContract.SCHEMA_VERSION.toLong()) {
        return null
    }
    val fields = parseConfigFields(json, allowInsecureTransport) ?: return null
    val revision = readJsonInteger(json, "configRevision") ?: return null
    if (revision < 0 || revision > MobileShellConfigContract.MAX_SAFE_INTEGER) {
        return null
    }
    return MobileShellConfig(
        gatewayUrl = fields.gatewayUrl,
        namespace = fields.namespace,
        credential = fields.credential,
        backendId = fields.backendId,
        configRevision = revision,
    )
}

/** 严格解析 `saveConfig` 的 JSON 入参；`schemaVersion` 等额外字段一律拒绝。 */
fun parseMobileShellConfigWriteJson(
    raw: String,
    allowInsecureTransport: Boolean,
): MobileShellConfigWrite? {
    val json = parseJsonObject(raw) ?: return null
    val allowed = setOf("gatewayUrl", "namespace", "credential", "backendId")
    if (!json.keys().asSequence().all { it in allowed }) {
        return null
    }
    return parseConfigFields(json, allowInsecureTransport)
}

/** 序列化为 shared 契约的持久 JSON；只写出已归一化且通过校验的值。 */
fun encodeMobileShellConfig(config: MobileShellConfig): String {
    val json = JSONObject()
        .put("schemaVersion", MobileShellConfigContract.SCHEMA_VERSION)
        .put("gatewayUrl", config.gatewayUrl)
        .put("namespace", config.namespace)
        .put("credential", config.credential)
        .put("configRevision", config.configRevision)
    config.backendId?.let { json.put("backendId", it) }
    return json.toString()
}

private fun parseJsonObject(raw: String): JSONObject? =
    try {
        JSONObject(raw)
    } catch (_: Exception) {
        null
    }

private fun parseConfigFields(
    json: JSONObject,
    allowInsecureTransport: Boolean,
): MobileShellConfigWrite? {
    val rawGatewayUrl = readJsonString(json, "gatewayUrl") ?: return null
    val rawNamespace = readJsonString(json, "namespace") ?: return null
    val rawCredential = readJsonString(json, "credential") ?: return null
    if (rawNamespace.length > MobileShellConfigContract.MAX_NAMESPACE_CHARS) {
        return null
    }
    val credential = rawCredential.trim()
    if (credential.isEmpty() || credential.length > MobileShellConfigContract.MAX_CREDENTIAL_CHARS) {
        return null
    }
    if (!credential.startsWith(MobileShellConfigContract.CREDENTIAL_PREFIX)) {
        return null
    }
    val gatewayUrl = normalizeMobileShellGatewayUrl(rawGatewayUrl, allowInsecureTransport) ?: return null
    val namespace = rawNamespace.trim().ifEmpty { MobileShellConfigContract.DEFAULT_NAMESPACE }

    val backendId = if (json.has("backendId")) {
        val rawBackendId = readJsonString(json, "backendId") ?: return null
        val trimmed = rawBackendId.trim()
        if (trimmed.isEmpty()) {
            null
        } else {
            if (trimmed.length > MobileShellConfigContract.MAX_BACKEND_ID_CHARS) {
                return null
            }
            trimmed
        }
    } else {
        null
    }

    return MobileShellConfigWrite(
        gatewayUrl = gatewayUrl,
        namespace = namespace,
        credential = credential,
        backendId = backendId,
    )
}

private fun readJsonString(json: JSONObject, key: String): String? {
    val value = json.opt(key) ?: return null
    return value as? String
}

private fun readJsonInteger(json: JSONObject, key: String): Long? {
    val value = json.opt(key) ?: return null
    return when (value) {
        is Int -> value.toLong()
        is Long -> value
        is Short -> value.toLong()
        is Byte -> value.toLong()
        is Number -> {
            val doubleValue = value.toDouble()
            if (!doubleValue.isFinite() || doubleValue % 1.0 != 0.0) {
                null
            } else {
                value.toLong()
            }
        }
        else -> null
    }
}
