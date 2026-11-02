package io.github.zclaudia.zody.mobile.config

import io.github.zclaudia.zody.mobile.bridge.SecureKeyValueStore
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Shell 配置 store 的 JVM 契约测试。
 *
 * 关键约束来自 spec 第 2/3/7 节：
 * - 构造 store 不得删除旧凭证；旧 schema 只检测，用户确认后才一次清理；
 * - save/clear 串行且 configRevision 单调递增；
 * - configRevision、backendId 和 clientInstanceId 由原生 store 唯一持有；
 * - 损坏配置 fail closed，不静默当作未配置。
 */
class MobileShellConfigStoreTest {
    private class InMemorySecureStore(
        initial: Map<String, String> = emptyMap(),
    ) : SecureKeyValueStore {
        private val values = Collections.synchronizedMap(LinkedHashMap<String, String>(initial))
        var setDelayMillis: Long = 0
        var failure: RuntimeException? = null
        val failSetKeys: MutableSet<String> = mutableSetOf()
        val failRemoveKeys: MutableSet<String> = mutableSetOf()

        fun snapshot(): Map<String, String> = synchronized(values) { values.toMap() }

        override fun get(key: String): String? = synchronized(values) { values[key] }

        override fun set(key: String, value: String) {
            if (setDelayMillis > 0) {
                Thread.sleep(setDelayMillis)
            }
            failure?.let { throw it }
            if (key in failSetKeys) {
                throw IllegalStateException("injected set failure for $key")
            }
            synchronized(values) { values[key] = value }
        }

        override fun remove(key: String) {
            failure?.let { throw it }
            if (key in failRemoveKeys) {
                throw IllegalStateException("injected remove failure for $key")
            }
            synchronized(values) { values.remove(key) }
        }
    }

    private fun store(
        secure: InMemorySecureStore,
        allowInsecureTransport: Boolean = false,
        newId: () -> String = { "generated-id-${counter.incrementAndGet()}" },
    ) = MobileShellConfigStore(
        secureStore = secure,
        allowInsecureTransport = allowInsecureTransport,
        newClientInstanceId = newId,
    )

    private val counter = AtomicInteger()

    private val validWrite = MobileShellConfigWrite(
        gatewayUrl = "https://gateway.example/",
        namespace = "zody",
        credential = "zgd_device_credential",
        backendId = "desktop-1",
    )

    private val legacyConfig = """
        {"gatewayUrl":"https://old-gateway.example","namespace":"zody","credential":"zgd_old_credential","backendId":"old-desktop"}
    """.trimIndent()

    @Test
    fun constructionDoesNotDeleteLegacyCredentials() {
        val secure = InMemorySecureStore(
            mapOf(
                MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY to legacyConfig,
                "${MobileShellConfigContract.LEGACY_CLIENT_INSTANCE_ID_PREFIX}old-desktop" to "old-client-id",
            ),
        )

        store(secure).inspect()

        assertEquals(legacyConfig, secure.get(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY))
        assertEquals(
            "old-client-id",
            secure.get("${MobileShellConfigContract.LEGACY_CLIENT_INSTANCE_ID_PREFIX}old-desktop"),
        )
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))
        assertNull(secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
    }

    @Test
    fun legacySchemaRequiresExplicitRepairAndClearsOnceAfterConfirmation() {
        val secure = InMemorySecureStore(
            mapOf(
                MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY to legacyConfig,
                "${MobileShellConfigContract.LEGACY_CLIENT_INSTANCE_ID_PREFIX}old-desktop" to "old-client-id",
            ),
        )
        val store = store(secure)

        assertEquals(
            MobileShellConfigState.RequiresRepair(MobileShellRepairReason.LEGACY_SCHEMA),
            store.inspect(),
        )
        try {
            store.readConfig()
            fail("legacy config must fail closed")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.REQUIRES_REPAIR, error.failure)
        }

        // 用户尚未确认：任何写入都不得覆盖旧凭证。
        try {
            store.saveConfig(validWrite)
            fail("save must wait for explicit repair confirmation")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.REQUIRES_REPAIR, error.failure)
        }
        assertEquals(legacyConfig, secure.get(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY))

        val result = store.confirmRepairAndClear()

        assertEquals(MobileShellRepairResult.Cleared(1), result)
        assertNull(secure.get(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY))
        assertNull(secure.get("${MobileShellConfigContract.LEGACY_CLIENT_INSTANCE_ID_PREFIX}old-desktop"))
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))
        assertEquals("1", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
        assertEquals(MobileShellConfigState.Unconfigured, store.inspect())

        // 重复启动/重复确认幂等，不再递增 revision。
        assertEquals(MobileShellRepairResult.NothingToRepair, store.confirmRepairAndClear())
        assertEquals("1", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
    }

    @Test
    fun corruptedConfigFailsClosedInsteadOfSilentlyClearing() {
        val secure = InMemorySecureStore(
            mapOf(MobileShellConfigContract.CONFIG_STORAGE_KEY to """{"schemaVersion":1"""),
        )
        val store = store(secure)

        assertEquals(
            MobileShellConfigState.RequiresRepair(MobileShellRepairReason.INVALID_CONFIG),
            store.inspect(),
        )
        try {
            store.readConfig()
            fail("corrupted config must fail closed")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.CONFIG_INVALID, error.failure)
        }
        // 只检测不删除。
        assertEquals("""{"schemaVersion":1""", secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))

        assertEquals(MobileShellRepairResult.Cleared(1), store.confirmRepairAndClear())
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))
        assertEquals(MobileShellConfigState.Unconfigured, store.inspect())
    }

    @Test
    fun saveWritesSharedContractAndRevisionIncreasesMonotonically() {
        val secure = InMemorySecureStore()
        val store = store(secure)

        val first = store.saveConfig(validWrite)
        val second = store.saveConfig(validWrite.copy(backendId = "desktop-2"))
        val clearedRevision = store.clearConfig()
        val third = store.saveConfig(validWrite)

        assertEquals(1, first.configRevision)
        assertEquals(2, second.configRevision)
        assertEquals(3, clearedRevision)
        assertEquals(4, third.configRevision)
        assertEquals("4", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))

        val persisted = JSONObject(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY)!!)
        assertEquals(
            setOf("schemaVersion", "gatewayUrl", "namespace", "credential", "backendId", "configRevision"),
            persisted.keys().asSequence().toSet(),
        )
        assertEquals("https://gateway.example", persisted.getString("gatewayUrl"))
        assertEquals(4, persisted.getLong("configRevision"))
    }

    @Test
    fun failedConfigWriteKeepsRevisionAdvancedAndNeverReportsSuccess() {
        val secure = InMemorySecureStore()
        val store = store(secure)
        secure.failSetKeys += MobileShellConfigContract.CONFIG_STORAGE_KEY

        try {
            store.saveConfig(validWrite)
            fail("config write failure must surface to the caller")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.WRITE_FAILED, error.failure)
        }

        // write-ahead：revision 已落盘，配置仍是未配置；调用方不会看到成功。
        assertEquals("1", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))
        assertEquals(MobileShellConfigState.Unconfigured, store.inspect())

        secure.failSetKeys.clear()
        val retried = store.saveConfig(validWrite)
        assertEquals(2, retried.configRevision)
        assertEquals("2", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
    }

    @Test
    fun failedRevisionWriteLeavesNoConfigAndRetryStartsAtOne() {
        val secure = InMemorySecureStore()
        val store = store(secure)
        secure.failSetKeys += MobileShellConfigContract.REVISION_STORAGE_KEY

        try {
            store.saveConfig(validWrite)
            fail("revision write failure must surface to the caller")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.WRITE_FAILED, error.failure)
        }
        assertNull(secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))

        secure.failSetKeys.clear()
        assertEquals(1, store.saveConfig(validWrite).configRevision)
    }

    @Test
    fun failedClearKeepsConfigVisibleButRevisionIsNotReusedOnRetry() {
        val secure = InMemorySecureStore()
        val store = store(secure)
        store.saveConfig(validWrite)
        secure.failRemoveKeys += MobileShellConfigContract.CONFIG_STORAGE_KEY

        try {
            store.clearConfig()
            fail("clear failure must surface to the caller")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.WRITE_FAILED, error.failure)
        }

        assertEquals("2", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
        assertEquals(
            MobileShellConfigState.Ready(
                MobileShellConfig(
                    gatewayUrl = "https://gateway.example",
                    namespace = "zody",
                    credential = "zgd_device_credential",
                    backendId = "desktop-1",
                    configRevision = 1,
                ),
            ),
            store.inspect(),
        )

        secure.failRemoveKeys.clear()
        assertEquals(3, store.clearConfig())
        assertEquals("3", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))
    }

    @Test
    fun failedRepairIsRecoverableAndRevisionIsNotReused() {
        val secure = InMemorySecureStore(
            mapOf(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY to legacyConfig),
        )
        val store = store(secure)
        secure.failRemoveKeys += MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY

        try {
            store.confirmRepairAndClear()
            fail("repair failure must surface to the caller")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.WRITE_FAILED, error.failure)
        }

        assertEquals("1", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
        assertEquals(legacyConfig, secure.get(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY))
        assertEquals(
            MobileShellConfigState.RequiresRepair(MobileShellRepairReason.LEGACY_SCHEMA),
            store.inspect(),
        )

        secure.failRemoveKeys.clear()
        assertEquals(MobileShellRepairResult.Cleared(2), store.confirmRepairAndClear())
        assertNull(secure.get(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY))
        assertEquals("2", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
    }

    @Test
    fun clientInstanceIdFailsClosedForLegacyOrCorruptedConfig() {
        val legacySecure = InMemorySecureStore(
            mapOf(MobileShellConfigContract.LEGACY_CONFIG_STORAGE_KEY to legacyConfig),
        )
        try {
            store(legacySecure).getOrCreateClientInstanceId("desktop-1")
            fail("legacy config must block new client identity writes")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.REQUIRES_REPAIR, error.failure)
        }
        assertNull(legacySecure.get(MobileShellConfigContract.CLIENT_INSTANCE_IDS_STORAGE_KEY))

        val corruptedSecure = InMemorySecureStore(
            mapOf(MobileShellConfigContract.CONFIG_STORAGE_KEY to "not-json"),
        )
        try {
            store(corruptedSecure).getOrCreateClientInstanceId("desktop-1")
            fail("corrupted config must block new client identity writes")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.CONFIG_INVALID, error.failure)
        }
        assertNull(corruptedSecure.get(MobileShellConfigContract.CLIENT_INSTANCE_IDS_STORAGE_KEY))
    }

    @Test
    fun corruptedRevisionFailsClosedAndRemainsRepairable() {
        val secure = InMemorySecureStore(
            mapOf(MobileShellConfigContract.REVISION_STORAGE_KEY to "not-a-revision"),
        )
        val store = store(secure)

        assertEquals(
            MobileShellConfigState.RequiresRepair(MobileShellRepairReason.INVALID_CONFIG),
            store.inspect(),
        )
        assertEquals(MobileShellRepairResult.Cleared(1), store.confirmRepairAndClear())
        assertEquals("1", secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY))
    }

    @Test
    fun saveRejectsInvalidDraftWithoutWriting() {
        val secure = InMemorySecureStore()
        val store = store(secure)

        try {
            store.saveConfig(validWrite.copy(credential = "not-a-device-credential"))
            fail("invalid credential must be rejected")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.INVALID_ARGUMENT, error.failure)
        }
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))
    }

    @Test
    fun releaseRejectsInsecureGatewayButDebugAccepts() {
        val releaseStore = store(InMemorySecureStore(), allowInsecureTransport = false)
        try {
            releaseStore.saveConfig(validWrite.copy(gatewayUrl = "http://127.0.0.1:8787"))
            fail("release store must reject http")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.INVALID_ARGUMENT, error.failure)
        }

        val debugStore = store(InMemorySecureStore(), allowInsecureTransport = true)
        assertEquals(
            "http://127.0.0.1:8787",
            debugStore.saveConfig(validWrite.copy(gatewayUrl = "http://127.0.0.1:8787")).gatewayUrl,
        )
    }

    @Test
    fun concurrentSavesAreSerializedAndRevisionsStayUnique() {
        val secure = InMemorySecureStore().apply { setDelayMillis = 1 }
        val store = store(secure)
        val threadCount = 12
        val start = CountDownLatch(1)
        val revisions = Collections.synchronizedSet(mutableSetOf<Long>())
        val executor = Executors.newFixedThreadPool(threadCount)

        repeat(threadCount) {
            executor.submit {
                start.await()
                revisions += store.saveConfig(validWrite).configRevision
            }
        }
        start.countDown()
        executor.shutdown()
        assertTrue(executor.awaitTermination(30, TimeUnit.SECONDS))

        assertEquals((1L..threadCount.toLong()).toSet(), revisions)
        assertEquals(
            threadCount.toLong().toString(),
            secure.get(MobileShellConfigContract.REVISION_STORAGE_KEY),
        )
    }

    @Test
    fun clientInstanceIdIsLazyPersistedAndScopedPerBackend() {
        val secure = InMemorySecureStore()
        val firstStore = store(secure)

        // 未请求前不生成 id。
        assertFalse(secure.snapshot().containsKey(MobileShellConfigContract.CLIENT_INSTANCE_IDS_STORAGE_KEY))

        val desktopOne = firstStore.getOrCreateClientInstanceId("desktop-1")
        assertEquals("generated-id-1", desktopOne)
        assertEquals(desktopOne, firstStore.getOrCreateClientInstanceId("desktop-1"))

        val desktopTwo = firstStore.getOrCreateClientInstanceId("desktop-2")
        assertNotEquals(desktopOne, desktopTwo)

        // 新 store 实例（模拟进程重启）继续复用同一 backend 的 id。
        val restartedStore = store(secure)
        assertEquals(desktopOne, restartedStore.getOrCreateClientInstanceId("desktop-1"))
        assertEquals(desktopTwo, restartedStore.getOrCreateClientInstanceId("desktop-2"))
        // 只有 desktop-1/desktop-2 两次生成；重启后复用，不再生成。
        assertEquals(2, counter.get())
    }

    @Test
    fun blankBackendForClientInstanceIdIsRejected() {
        try {
            store(InMemorySecureStore()).getOrCreateClientInstanceId("   ")
            fail("blank backendId must be rejected")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.INVALID_ARGUMENT, error.failure)
        }
    }

    @Test
    fun storeFailurePropagatesWithoutReportingSuccess() {
        val secure = InMemorySecureStore()
        val store = store(secure)
        secure.failure = IllegalStateException("keystore unavailable")

        try {
            store.saveConfig(validWrite)
            fail("storage failure must propagate")
        } catch (error: MobileShellConfigException) {
            assertEquals(MobileShellConfigFailure.WRITE_FAILED, error.failure)
        }
        assertNull(secure.get(MobileShellConfigContract.CONFIG_STORAGE_KEY))
    }

    @Test
    fun clearDoesNotRemoveClientInstanceIds() {
        val secure = InMemorySecureStore()
        val store = store(secure)
        val clientInstanceId = store.getOrCreateClientInstanceId("desktop-1")
        store.saveConfig(validWrite)

        store.clearConfig()

        assertEquals(clientInstanceId, store.getOrCreateClientInstanceId("desktop-1"))
    }
}
