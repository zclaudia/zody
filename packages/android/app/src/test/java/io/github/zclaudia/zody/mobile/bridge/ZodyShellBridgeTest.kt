package io.github.zclaudia.zody.mobile.bridge

import io.github.zclaudia.zody.mobile.config.MobileShellConfigStore
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptRequest
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptResponse
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiSessionContext
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellController
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellControllerHost
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellOrigins
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellSource
import io.github.zclaudia.zody.mobile.ui.shell.RemoteUiInterceptor
import io.github.zclaudia.zody.mobile.ui.shell.RemoteUiInterceptorFactory
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ZodyShellBridgeTest {
    private class InMemorySecureStore : SecureKeyValueStore {
        val values = mutableMapOf<String, String>()

        override fun get(key: String): String? = values[key]

        override fun set(key: String, value: String) {
            values[key] = value
        }

        override fun remove(key: String) {
            values.remove(key)
        }
    }

    private class NoopHost : MobileShellControllerHost {
        val loaded = mutableListOf<String>()

        override fun removeBridges() = Unit

        override fun installShellBridge() = Unit

        override fun installRemoteBridge() = Unit

        override fun loadUrl(url: String) {
            loaded += url
        }

        override fun showRepair(reason: io.github.zclaudia.zody.mobile.config.MobileShellRepairReason) = Unit

        override fun onRemoteReady(generation: Long, backendId: String) = Unit

        override fun dispatchNotificationClick(payloadJson: String) = Unit

        override fun dispatchNotificationAction(payloadJson: String) = Unit

        override fun dispatchNotificationPermissionChanged(granted: Boolean) = Unit
    }

    private class FakeInterceptorFactory : RemoteUiInterceptorFactory {
        override fun create(sessionContext: RemoteUiSessionContext): RemoteUiInterceptor =
            RemoteUiInterceptor { request: RemoteUiInterceptRequest ->
                RemoteUiInterceptResponse(
                    statusCode = 200,
                    reasonPhrase = "OK",
                    headers = emptyMap(),
                    body = ByteArray(0),
                    generation = request.generation,
                )
            }
    }

    private data class Environment(
        val controller: MobileShellController,
        val store: MobileShellConfigStore,
        val host: NoopHost,
        val bridge: ZodyShellBridge,
    )

    private fun environment(
        secureStore: InMemorySecureStore = InMemorySecureStore(),
        allowInsecureGatewayTransport: Boolean = true,
    ): Environment {
        val store = MobileShellConfigStore(
            secureStore,
            allowInsecureTransport = allowInsecureGatewayTransport,
        )
        val controller = MobileShellController(
            configStore = store,
            appVersion = "1.2.3",
            allowInsecureGatewayTransport = allowInsecureGatewayTransport,
            interceptorFactory = FakeInterceptorFactory(),
            mainExecutor = { runnable -> runnable.run() },
            newSessionId = { "session-1" },
        )
        val host = NoopHost()
        controller.attachHost(host)
        controller.start(restoreRemote = false)
        return Environment(
            controller = controller,
            store = store,
            host = host,
            bridge = ZodyShellBridge(
                controller = controller,
                configStore = store,
                appVersion = "1.2.3",
                allowInsecureGatewayTransport = allowInsecureGatewayTransport,
            ),
        )
    }

    private fun envelope(raw: String): JSONObject = JSONObject(raw)

    @Test
    fun `readConfig reports an unconfigured shell as ok with null config`() {
        val environment = environment()
        val result = envelope(environment.bridge.readConfig())

        assertTrue(result.getBoolean("ok"))
        assertEquals(1, result.getInt("schemaVersion"))
        assertTrue(result.isNull("config"))
    }

    @Test
    fun `saveConfig persists and increments configRevision`() {
        val environment = environment()
        val saved = envelope(
            environment.bridge.saveConfig(
                """{"gatewayUrl":"https://gateway.example","namespace":"zody",""" +
                    """"credential":"zgd_new","backendId":"backend-1"}""",
            ),
        )

        assertTrue(saved.getBoolean("ok"))
        val config = saved.getJSONObject("config")
        assertEquals(1L, config.getLong("configRevision"))
        assertEquals("https://gateway.example", config.getString("gatewayUrl"))
        assertEquals("backend-1", config.getString("backendId"))

        val second = envelope(
            environment.bridge.saveConfig(
                """{"gatewayUrl":"https://gateway.example","namespace":"zody",""" +
                    """"credential":"zgd_new","backendId":"backend-2"}""",
            ),
        )
        assertEquals(2L, second.getJSONObject("config").getLong("configRevision"))
    }

    @Test
    fun `openRemote rejects a stale revision and does not navigate`() {
        val environment = environment()
        environment.bridge.saveConfig(
            """{"gatewayUrl":"https://gateway.example","namespace":"zody",""" +
                """"credential":"zgd_new","backendId":"backend-1"}""",
        )
        environment.host.loaded.clear()

        val result = envelope(environment.bridge.openRemote("backend-1", 0.0))

        assertFalse(result.getBoolean("ok"))
        assertEquals("config-revision-stale", result.getJSONObject("error").getString("code"))
        assertTrue(environment.host.loaded.isEmpty())
        assertEquals(MobileShellSource.SHELL, environment.controller.currentSource())
    }

    @Test
    fun `openRemote navigates after revision validation and disables the shell bridge`() {
        val environment = environment()
        val saved = envelope(
            environment.bridge.saveConfig(
                """{"gatewayUrl":"https://gateway.example","namespace":"zody",""" +
                    """"credential":"zgd_new","backendId":"backend-1"}""",
            ),
        )
        val revision = saved.getJSONObject("config").getLong("configRevision")

        val result = envelope(environment.bridge.openRemote("backend-1", revision.toDouble()))

        assertTrue(result.getBoolean("ok"))
        assertEquals(MobileShellSource.REMOTE, environment.controller.currentSource())
        assertEquals(MobileShellOrigins.REMOTE_PAGE_URL, environment.host.loaded.last())

        val oldShellCall = envelope(environment.bridge.readConfig())
        assertFalse(oldShellCall.getBoolean("ok"))
        assertEquals(
            "native-bridge-unavailable",
            oldShellCall.getJSONObject("error").getString("code"),
        )
    }

    @Test
    fun `bridge info reflects debug and release transport capabilities`() {
        val debug = environment(allowInsecureGatewayTransport = true)
        val release = environment(allowInsecureGatewayTransport = false)

        val debugInfo = envelope(debug.bridge.getBridgeInfo()).getJSONObject("info")
        val releaseInfo = envelope(release.bridge.getBridgeInfo()).getJSONObject("info")

        assertTrue(debugInfo.getBoolean("allowsInsecureGatewayTransport"))
        assertFalse(releaseInfo.getBoolean("allowsInsecureGatewayTransport"))
        assertEquals(1, releaseInfo.getInt("bridgeVersion"))
        assertEquals("1.2.3", releaseInfo.getString("appVersion"))
    }

    @Test
    fun `diagnostics expose revision and backend without credential or gateway url`() {
        val environment = environment()
        val saved = envelope(
            environment.bridge.saveConfig(
                """{"gatewayUrl":"https://gateway.example","namespace":"zody",""" +
                    """"credential":"zgd_secret","backendId":"backend-1"}""",
            ),
        )

        val raw = environment.bridge.getDiagnostics()
        val diagnostics = envelope(raw).getJSONObject("diagnostics")

        assertEquals(1L, diagnostics.getLong("configRevision"))
        assertEquals("backend-1", diagnostics.getString("selectedBackendId"))
        assertFalse(raw.contains("zgd_secret"))
        assertFalse(raw.contains("gateway.example"))
        assertEquals(
            saved.getJSONObject("config").getLong("configRevision"),
            diagnostics.getLong("configRevision"),
        )
    }

    @Test
    fun `legacy schema is reported as config-invalid and only confirm clears it`() {
        val secureStore = InMemorySecureStore().apply {
            values["config"] = """{"gatewayUrl":"https://gateway.example","backendId":"old"}"""
        }
        val environment = environment(secureStore = secureStore)

        val result = envelope(environment.bridge.readConfig())
        assertFalse(result.getBoolean("ok"))
        assertEquals("config-invalid", result.getJSONObject("error").getString("code"))
        assertTrue(secureStore.values.containsKey("config"))

        assertTrue(environment.controller.confirmRepair())
        assertFalse(secureStore.values.containsKey("config"))
        assertEquals("ok", envelope(environment.bridge.readConfig()).let { if (it.getBoolean("ok")) "ok" else "fail" })
        assertNull(environment.store.readConfig())
    }

    @Test
    fun `clearConfig keeps the revision monotonic`() {
        val environment = environment()
        environment.bridge.saveConfig(
            """{"gatewayUrl":"https://gateway.example","namespace":"zody",""" +
                """"credential":"zgd_new","backendId":"backend-1"}""",
        )

        val cleared = envelope(environment.bridge.clearConfig())
        assertTrue(cleared.getBoolean("ok"))
        assertNull(environment.store.readConfig())

        val diagnostics = envelope(environment.bridge.getDiagnostics()).getJSONObject("diagnostics")
        assertTrue(diagnostics.getLong("configRevision") >= 2L)
    }
}
