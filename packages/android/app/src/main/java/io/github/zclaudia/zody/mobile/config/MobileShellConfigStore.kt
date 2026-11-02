package io.github.zclaudia.zody.mobile.config

import io.github.zclaudia.zody.mobile.bridge.SecureKeyValueStore
import org.json.JSONObject
import java.util.UUID

/** 需要重新配对的原因；页面按此决定提示文案，原生不返回旧凭证。 */
enum class MobileShellRepairReason {
    /** 旧 schema 的 `config` key 仍存在，必须先由用户确认破坏性升级。 */
    LEGACY_SCHEMA,

    /** 新 schema 配置损坏或 revision 不可解析；fail closed，不静默清除。 */
    INVALID_CONFIG,
}

/** 配置 store 的只读状态。构造 store 不会改变它。 */
sealed interface MobileShellConfigState {
    data object Unconfigured : MobileShellConfigState

    data class Ready(val config: MobileShellConfig) : MobileShellConfigState

    data class RequiresRepair(val reason: MobileShellRepairReason) : MobileShellConfigState
}

/** 用户确认后的清理结果；重复调用返回 [NothingToRepair]。 */
sealed interface MobileShellRepairResult {
    data object NothingToRepair : MobileShellRepairResult

    data class Cleared(val configRevision: Long) : MobileShellRepairResult
}

/** store 内部失败分类；桥层再映射到 shared 的稳定错误码。 */
enum class MobileShellConfigFailure {
    REQUIRES_REPAIR,
    CONFIG_INVALID,
    WRITE_FAILED,
    INVALID_ARGUMENT,
    STORAGE_UNAVAILABLE,
}

/** 不携带凭证的稳定失败；message 只用于诊断。 */
class MobileShellConfigException(
    val failure: MobileShellConfigFailure,
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

/**
 * Gateway、namespace、凭证、选中 backend、configRevision 和 clientInstanceId 的唯一持久所有者
 * （spec 第 2、3、7 节）。
 *
 * 设计约束：
 * - 构造时零 IO，绝不静默删除旧凭证；旧 schema 只由 [inspect] 检测，必须用户确认后调用
 *   [confirmRepairAndClear] 才清理；
 * - [saveConfig]、[clearConfig]、[confirmRepairAndClear]、[getOrCreateClientInstanceId] 串行执行；
 * - 每次写入（含清除）先持久化下一 configRevision（write-ahead），再写/删配置；配置被清除后
 *   revision 仍单调。这里不是数据库事务：第二步失败时调用方收到异常、不会当作成功，旧配置保持
 *   可见，重试会基于已落盘的更高 revision 继续递增，绝不回退或复用 revision；
 * - `clientInstanceId` 按 backendId 懒生成并持久化，同一 backend 复用、不同 backend 不同；
 * - 保存/读取失败直接抛出，不返回“成功”或半份配置；消息不含凭证。
 *
 * 该 store 只处理配置，不创建 WebView/Activity，也不保存 task/session 业务状态。
 */
class MobileShellConfigStore(
    private val secureStore: SecureKeyValueStore,
    private val allowInsecureTransport: Boolean,
    private val newClientInstanceId: () -> String = { UUID.randomUUID().toString() },
) {
    private val lock = Any()

    /** 只读检测；不写入、不删除。损坏或旧 schema 由 [MobileShellConfigState.RequiresRepair] 表达。 */
    fun inspect(): MobileShellConfigState = synchronized(lock) { inspectLocked() }

    /**
     * 读取当前配置。未配置返回 null；旧 schema 或损坏配置 fail closed，
     * 调用方必须先走重新配对确认。
     */
    fun readConfig(): MobileShellConfig? = synchronized(lock) {
        when (val state = inspectLocked()) {
            MobileShellConfigState.Unconfigured -> null
            is MobileShellConfigState.Ready -> state.config
            is MobileShellConfigState.RequiresRepair -> throw state.toException()
        }
    }

    /**
     * 写入设置页草稿并递增 configRevision。
     *
     * 旧 schema 未确认前拒绝写入，避免覆盖掉用户尚未确认要删除的凭证。
     */
    fun saveConfig(write: MobileShellConfigWrite): MobileShellConfig = synchronized(lock) {
        val state = inspectLocked()
        if (state is MobileShellConfigState.RequiresRepair) {
            throw state.toException()
        }
        val normalized = normalizeWrite(write)
        val currentRevision = when (state) {
            is MobileShellConfigState.Ready -> state.config.configRevision
            else -> 0L
        }
        val nextRevision = nextRevision(currentRevision)
        val config = MobileShellConfig(
            gatewayUrl = normalized.gatewayUrl,
            namespace = normalized.namespace,
            credential = normalized.credential,
            backendId = normalized.backendId,
            configRevision = nextRevision,
        )
        // write-ahead：先落盘 revision 再写配置。若配置写入失败，调用方收到异常且旧配置仍在；
        // 重试从已落盘的 revision 继续递增，不会复用刚失败的 revision。
        writeOrThrow(MobileShellConfigContract.REVISION_STORAGE_KEY, nextRevision.toString())
        writeOrThrow(MobileShellConfigContract.CONFIG_STORAGE_KEY, encodeMobileShellConfig(config))
        config
    }

    /** 解析并保存桥收到的 JSON 草稿；非法 JSON 按 invalid-argument 处理。 */
    fun saveConfigJson(inputJson: String): MobileShellConfig {
        val write = parseMobileShellConfigWriteJson(inputJson, allowInsecureTransport)
            ?: throw MobileShellConfigException(
                MobileShellConfigFailure.INVALID_ARGUMENT,
                "Shell config draft is invalid.",
            )
        return saveConfig(write)
    }

    /** 清除新 schema 配置并递增 revision；不清除按 backend 保存的 clientInstanceId。 */
    fun clearConfig(): Long = synchronized(lock) {
        val state = inspectLocked()
        if (state is MobileShellConfigState.RequiresRepair) {
            throw state.toException()
        }
        val currentRevision = when (state) {
            is MobileShellConfigState.Ready -> state.config.configRevision
            else -> 0L
        }
        val nextRevision = nextRevision(currentRevision)
        // 同样 write-ahead：清除失败时配置还在，但 revision 已前进；重试不会复用旧值。
        writeOrThrow(MobileShellConfigContract.REVISION_STORAGE_KEY, nextRevision.toString())
        removeOrThrow(MobileShellConfigContract.CONFIG_STORAGE_KEY)
        nextRevision
    }

    /**
     * 用户确认破坏性升级后的原子清理入口。
     *
     * 只有 [inspect] 仍处于 `RequiresRepair` 时才删除旧 `config`、旧 backend 的
     * `client-instance-id:*`、新配置和新 clientInstanceId 映射；一次调用完成并递增 revision。
     * 未确认（Unconfigured/Ready）返回 [MobileShellRepairResult.NothingToRepair]，不触碰存储。
     * 重复调用幂等；底层写入中途失败时调用方收到异常，再次调用会从剩余状态继续清理。
     * 这是串行 + write-ahead 的可恢复流程，不是真正事务：revision 先落盘，因此失败重试不会复用。
     */
    fun confirmRepairAndClear(): MobileShellRepairResult = synchronized(lock) {
        val state = inspectLocked()
        if (state !is MobileShellConfigState.RequiresRepair) {
            return@synchronized MobileShellRepairResult.NothingToRepair
        }

        val legacy = readValue(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY)
        val legacyBackendId = parseLegacyBackendId(legacy)
        // repair 可能面对损坏的 revision key；readRevisionSafe 已把不可解析值降为 0，
        // 这里直接递增并覆盖写回，避免再次读取坏值导致无法恢复。
        val currentRevision = readRevisionSafe() ?: 0L
        val nextRevision = incrementRevision(currentRevision)

        // write-ahead：即使后续删除失败，revision 也不复用；调用方收到异常，状态仍是待修复。
        writeOrThrow(MobileShellConfigContract.REVISION_STORAGE_KEY, nextRevision.toString())
        removeOrThrow(MobileShellConfigContract.CONFIG_STORAGE_KEY)
        removeOrThrow(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY)
        removeOrThrow(MobileShellConfigContract.CLIENT_INSTANCE_IDS_STORAGE_KEY)
        legacyBackendId?.let {
            removeOrThrow("${MobileShellConfigContract.LEGACY_CLIENT_INSTANCE_ID_PREFIX}$it")
        }
        MobileShellRepairResult.Cleared(nextRevision)
    }

    /**
     * 读取或懒生成指定 backend 的 clientInstanceId 并持久化。
     * 同一 backend 跨进程/升级后复用；换 backend 得到不同 id。
     */
    fun getOrCreateClientInstanceId(backendId: String): String = synchronized(lock) {
        // 旧 schema/损坏配置必须先重新配对；不能在未确认的升级状态写新的持久身份。
        val state = inspectLocked()
        if (state is MobileShellConfigState.RequiresRepair) {
            throw state.toException()
        }
        val normalizedBackendId = backendId.trim()
        if (normalizedBackendId.isEmpty() ||
            normalizedBackendId.length > MobileShellConfigContract.MAX_BACKEND_ID_CHARS
        ) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.INVALID_ARGUMENT,
                "A bounded backendId is required to resolve a client instance id.",
            )
        }

        val ids = readClientInstanceIds()
        ids[normalizedBackendId]?.let { existing ->
            if (existing.isBlank() ||
                existing.length > MobileShellConfigContract.MAX_CLIENT_INSTANCE_ID_CHARS
            ) {
                throw MobileShellConfigException(
                    MobileShellConfigFailure.CONFIG_INVALID,
                    "Stored client instance id is invalid.",
                )
            }
            return@synchronized existing
        }

        val generated = newClientInstanceId().trim()
        if (generated.isEmpty() ||
            generated.length > MobileShellConfigContract.MAX_CLIENT_INSTANCE_ID_CHARS
        ) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.CONFIG_INVALID,
                "Generated client instance id is invalid.",
            )
        }
        ids[normalizedBackendId] = generated
        writeOrThrow(MobileShellConfigContract.CLIENT_INSTANCE_IDS_STORAGE_KEY, encodeClientInstanceIds(ids))
        generated
    }

    /** 当前可见的 revision（含已清除后仍保留的单调计数），供诊断使用。 */
    fun currentConfigRevision(): Long = synchronized(lock) {
        val state = inspectLocked()
        val stored = readRevision()
        if (state is MobileShellConfigState.Ready) {
            maxOf(stored, state.config.configRevision)
        } else {
            stored
        }
    }

    private fun inspectLocked(): MobileShellConfigState {
        val legacy = readValue(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY)
        // 旧 schema 优先：即使新配置已存在，也等用户确认后才允许继续。
        if (legacy != null) {
            return MobileShellConfigState.RequiresRepair(MobileShellRepairReason.LEGACY_SCHEMA)
        }
        val rawConfig = readValue(MobileShellConfigContract.CONFIG_STORAGE_KEY)
        if (rawConfig == null) {
            // 未配置也要校验 revision key：损坏的 revision 不能继续被写入路径复用。
            // 按 INVALID_CONFIG 进入重新配对/清理流程，避免损坏后无恢复入口。
            val revisionOk = try {
                readRevision()
                true
            } catch (_: MobileShellConfigException) {
                false
            }
            return if (revisionOk) {
                MobileShellConfigState.Unconfigured
            } else {
                MobileShellConfigState.RequiresRepair(MobileShellRepairReason.INVALID_CONFIG)
            }
        }
        val config = parsePersistedMobileShellConfig(rawConfig, allowInsecureTransport)
            ?: return MobileShellConfigState.RequiresRepair(MobileShellRepairReason.INVALID_CONFIG)
        // revision key 损坏同样 fail closed；不把配置当成可继续使用。
        val revisionOk = try {
            readRevision()
            true
        } catch (_: MobileShellConfigException) {
            false
        }
        if (!revisionOk) {
            return MobileShellConfigState.RequiresRepair(MobileShellRepairReason.INVALID_CONFIG)
        }
        return MobileShellConfigState.Ready(config)
    }

    private fun normalizeWrite(write: MobileShellConfigWrite): MobileShellConfigWrite {
        val gatewayUrl = normalizeMobileShellGatewayUrl(write.gatewayUrl, allowInsecureTransport)
            ?: throw MobileShellConfigException(
                MobileShellConfigFailure.INVALID_ARGUMENT,
                "Gateway URL is invalid for this build.",
            )
        val namespace = write.namespace.trim().ifEmpty { MobileShellConfigContract.DEFAULT_NAMESPACE }
        if (namespace.length > MobileShellConfigContract.MAX_NAMESPACE_CHARS) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.INVALID_ARGUMENT,
                "Namespace is too long.",
            )
        }
        val credential = write.credential.trim()
        if (credential.isEmpty() ||
            credential.length > MobileShellConfigContract.MAX_CREDENTIAL_CHARS ||
            !credential.startsWith(MobileShellConfigContract.CREDENTIAL_PREFIX)
        ) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.INVALID_ARGUMENT,
                "Device credential is invalid.",
            )
        }
        val backendId = write.backendId?.trim()?.ifEmpty { null }
        if (backendId != null && backendId.length > MobileShellConfigContract.MAX_BACKEND_ID_CHARS) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.INVALID_ARGUMENT,
                "backendId is too long.",
            )
        }
        return MobileShellConfigWrite(
            gatewayUrl = gatewayUrl,
            namespace = namespace,
            credential = credential,
            backendId = backendId,
        )
    }

    private fun nextRevision(currentConfigRevision: Long): Long {
        val stored = readRevision()
        return incrementRevision(maxOf(stored, currentConfigRevision))
    }

    private fun incrementRevision(base: Long): Long {
        if (base >= MobileShellConfigContract.MAX_SAFE_INTEGER) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.WRITE_FAILED,
                "Config revision is exhausted.",
            )
        }
        return base + 1
    }

    private fun readRevision(): Long {
        val raw = readValue(MobileShellConfigContract.REVISION_STORAGE_KEY) ?: return 0L
        val parsed = raw.toLongOrNull()
            ?: throw MobileShellConfigException(
                MobileShellConfigFailure.CONFIG_INVALID,
                "Stored config revision is invalid.",
            )
        if (parsed < 0 || parsed > MobileShellConfigContract.MAX_SAFE_INTEGER) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.CONFIG_INVALID,
                "Stored config revision is out of range.",
            )
        }
        return parsed
    }

    private fun readRevisionSafe(): Long? =
        try {
            readRevision()
        } catch (_: MobileShellConfigException) {
            null
        }

    private fun readClientInstanceIds(): MutableMap<String, String> {
        val raw = readValue(MobileShellConfigContract.CLIENT_INSTANCE_IDS_STORAGE_KEY)
            ?: return mutableMapOf()
        val json = try {
            JSONObject(raw)
        } catch (_: Exception) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.CONFIG_INVALID,
                "Stored client instance ids are invalid.",
            )
        }
        val result = mutableMapOf<String, String>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = json.opt(key) as? String
                ?: throw MobileShellConfigException(
                    MobileShellConfigFailure.CONFIG_INVALID,
                    "Stored client instance ids are invalid.",
                )
            result[key] = value
        }
        return result
    }

    private fun encodeClientInstanceIds(ids: Map<String, String>): String {
        val json = JSONObject()
        ids.forEach { (backendId, clientInstanceId) -> json.put(backendId, clientInstanceId) }
        return json.toString()
    }

    private fun parseLegacyBackendId(raw: String?): String? {
        if (raw == null) {
            return null
        }
        val backendId = try {
            JSONObject(raw).optString("backendId", "").trim()
        } catch (_: Exception) {
            ""
        }
        return backendId.takeIf {
            it.isNotEmpty() && it.length <= MobileShellConfigContract.MAX_BACKEND_ID_CHARS
        }
    }

    private fun readValue(key: String): String? =
        try {
            secureStore.get(key)
        } catch (error: Exception) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.STORAGE_UNAVAILABLE,
                "Secure storage is unavailable.",
                error,
            )
        }

    private fun writeOrThrow(key: String, value: String) {
        try {
            secureStore.set(key, value)
        } catch (error: Exception) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.WRITE_FAILED,
                "Failed to persist shell config.",
                error,
            )
        }
    }

    private fun removeOrThrow(key: String) {
        try {
            secureStore.remove(key)
        } catch (error: Exception) {
            throw MobileShellConfigException(
                MobileShellConfigFailure.WRITE_FAILED,
                "Failed to clear shell config.",
                error,
            )
        }
    }
}

private fun MobileShellConfigState.RequiresRepair.toException(): MobileShellConfigException =
    when (reason) {
        MobileShellRepairReason.LEGACY_SCHEMA -> MobileShellConfigException(
            MobileShellConfigFailure.REQUIRES_REPAIR,
            "Stored shell config uses the legacy schema and requires explicit re-pairing.",
        )
        MobileShellRepairReason.INVALID_CONFIG -> MobileShellConfigException(
            MobileShellConfigFailure.CONFIG_INVALID,
            "Stored shell config is invalid.",
        )
    }
