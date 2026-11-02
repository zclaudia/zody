package io.github.zclaudia.zody.mobile.bridge

import io.github.zclaudia.zody.mobile.config.MobileShellConfigStore
import io.github.zclaudia.zody.mobile.config.MobileShellConfigWrite
import io.github.zclaudia.zody.mobile.config.MobileShellRepairReason
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptRequest
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptResponse
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiSessionContext
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellController
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellControllerHost
import io.github.zclaudia.zody.mobile.ui.shell.RemoteUiInterceptor
import io.github.zclaudia.zody.mobile.ui.shell.RemoteUiInterceptorFactory
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class ZodyRemoteBridgeTest {
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
        override fun removeBridges() = Unit
        override fun installShellBridge() = Unit
        override fun installRemoteBridge() = Unit
        override fun loadUrl(url: String) = Unit
        override fun showRepair(reason: MobileShellRepairReason) = Unit
        override fun onRemoteReady(generation: Long, backendId: String) = Unit
        override fun dispatchNotificationClick(payloadJson: String) = Unit
        override fun dispatchNotificationAction(payloadJson: String) = Unit
        override fun dispatchNotificationPermissionChanged(granted: Boolean) = Unit
    }

    private class FakeInterceptorFactory : RemoteUiInterceptorFactory {
        override fun create(sessionContext: RemoteUiSessionContext): RemoteUiInterceptor =
            RemoteUiInterceptor { request ->
                RemoteUiInterceptResponse(
                    statusCode = 200,
                    reasonPhrase = "OK",
                    headers = emptyMap(),
                    body = ByteArray(0),
                    generation = request.generation,
                )
            }
    }

    private class FakeFileSaveSession(override val displayName: String) : MobileFileSaveSession {
        val bytes = mutableListOf<Byte>()
        var finished = false
        var aborted = false

        override fun append(bytes: ByteArray) {
            bytes.forEach { this.bytes += it }
        }

        override fun finish(): SavedMobileFile {
            finished = true
            return SavedMobileFile(
                uri = "content://io.github.zclaudia.zody.mobile.fileprovider/downloads/$displayName",
                displayPath = "Download/$displayName",
            )
        }

        override fun abort() {
            aborted = true
        }
    }

    private class FakeFileSaver : MobileFileSaver {
        lateinit var session: FakeFileSaveSession

        override fun begin(fileName: String, mimeType: String): MobileFileSaveSession {
            session = FakeFileSaveSession(MobileFileNames.sanitize(fileName))
            return session
        }
    }

    private class FakeFileOpener : MobileFileOpener {
        val opened = mutableListOf<Pair<String, String>>()

        override fun open(uri: String, mimeType: String): Boolean {
            opened += uri to mimeType
            return true
        }
    }

    private class FakeNotificationBridge : RemoteNotificationBridge {
        var lastSyncConfig: String? = null
        var lastActiveTarget: String? = "unset"

        override fun sync(configJson: String): String {
            lastSyncConfig = configJson
            return """{"status":"ready","message":"ok"}"""
        }

        override fun pendingClick(): String? =
            """{"backendId":"backend-1","notificationId":"notification-1"}"""

        override fun acknowledgeClick(notificationId: String) = Unit

        override fun pendingAction(): String? = null

        override fun acknowledgeAction(notificationId: String) = Unit

        override fun cancelNotification(notificationId: String) = Unit

        override fun setActiveTarget(targetKey: String?) {
            lastActiveTarget = targetKey
        }

        override fun status(): String = """{"status":"ready","connected":true}"""

        override fun show(payloadJson: String): Boolean = true
    }

    private data class Environment(
        val controller: MobileShellController,
        val bridge: ZodyRemoteBridge,
        val saver: FakeFileSaver,
        val opener: FakeFileOpener,
        val notifications: FakeNotificationBridge,
        val sessionId: String,
    )

    private fun environment(
        allowInsecureGatewayTransport: Boolean = true,
    ): Environment {
        val store = MobileShellConfigStore(
            InMemorySecureStore(),
            allowInsecureTransport = allowInsecureGatewayTransport,
        )
        store.saveConfig(
            MobileShellConfigWrite(
                gatewayUrl = "https://gateway.example",
                namespace = "zody",
                credential = "zgd_test_credential",
                backendId = "backend-1",
            ),
        )
        var sessionSequence = 0
        val controller = MobileShellController(
            configStore = store,
            appVersion = "1.2.3",
            allowInsecureGatewayTransport = allowInsecureGatewayTransport,
            interceptorFactory = FakeInterceptorFactory(),
            mainExecutor = { runnable -> runnable.run() },
            newSessionId = { "session-${++sessionSequence}" },
        )
        controller.attachHost(NoopHost())
        controller.start(restoreRemote = true)
        val saver = FakeFileSaver()
        val opener = FakeFileOpener()
        val notifications = FakeNotificationBridge()
        val bridge = ZodyRemoteBridge(
            controller = controller,
            appVersion = "1.2.3",
            fileSaver = saver,
            fileOpener = opener,
            notificationBridge = notifications,
            requestNotificationPermission = {},
            decodeBase64 = { value -> Base64.getDecoder().decode(value) },
        )
        return Environment(
            controller = controller,
            bridge = bridge,
            saver = saver,
            opener = opener,
            notifications = notifications,
            sessionId = controller.remoteSessionSnapshot()!!.sessionId,
        )
    }

    private fun envelope(raw: String): JSONObject = JSONObject(raw)

    @Test
    fun `session context exposes the read-only fields and debug capability`() {
        val environment = environment()
        val result = envelope(environment.bridge.getSessionContext())

        assertTrue(result.getBoolean("ok"))
        val context = result.getJSONObject("context")
        assertEquals(1, context.getInt("schemaVersion"))
        assertEquals(environment.sessionId, context.getString("sessionId"))
        assertEquals("https://gateway.example", context.getString("gatewayUrl"))
        assertEquals("zody", context.getString("namespace"))
        assertEquals("backend-1", context.getString("backendId"))
        assertEquals("zgd_test_credential", context.getString("credential"))
        assertEquals("1.2.3", context.getString("appVersion"))
        assertNotNull(context.getString("clientInstanceId"))

        val capabilities = context.getJSONObject("bridgeCapabilities")
        assertEquals(1, capabilities.getInt("bridgeVersion"))
        val values = capabilities.getJSONArray("capabilities").let { array ->
            (0 until array.length()).map { array.getString(it) }
        }
        assertTrue(values.contains("session-context"))
        assertTrue(values.contains("file-save"))
        assertTrue(values.contains("file-open"))
        assertTrue(values.contains("notifications"))
        assertTrue(values.contains("lifecycle"))
        assertTrue(values.contains("insecure-gateway-transport"))
    }

    @Test
    fun `release session context omits the insecure transport capability`() {
        val environment = environment(allowInsecureGatewayTransport = false)
        val context = envelope(environment.bridge.getSessionContext()).getJSONObject("context")
        val values = context.getJSONObject("bridgeCapabilities").getJSONArray("capabilities").let { array ->
            (0 until array.length()).map { array.getString(it) }
        }
        assertFalse(values.contains("insecure-gateway-transport"))
    }

    @Test
    fun `file calls require the current session and keep chunked save behavior`() {
        val environment = environment()

        val stale = envelope(
            environment.bridge.saveFileBegin("old-session", "report.pdf", "application/pdf"),
        )
        assertFalse(stale.getBoolean("ok"))
        assertEquals("stale-session", stale.getJSONObject("error").getString("code"))

        val begin = envelope(
            environment.bridge.saveFileBegin(environment.sessionId, "../report.pdf", "application/pdf"),
        )
        assertTrue(begin.getBoolean("ok"))
        val token = begin.getString("token")

        assertTrue(
            envelope(
                environment.bridge.saveFileAppend(
                    environment.sessionId,
                    token,
                    Base64.getEncoder().encodeToString("hello ".toByteArray()),
                ),
            ).getBoolean("ok"),
        )
        assertTrue(
            envelope(
                environment.bridge.saveFileAppend(
                    environment.sessionId,
                    token,
                    Base64.getEncoder().encodeToString("world".toByteArray()),
                ),
            ).getBoolean("ok"),
        )
        val finished = envelope(environment.bridge.saveFileFinish(environment.sessionId, token))
        assertTrue(finished.getBoolean("ok"))
        assertEquals("hello world", environment.saver.session.bytes.toByteArray().decodeToString())
        assertEquals(
            "Download/report.pdf",
            finished.getJSONObject("file").getString("displayPath"),
        )

        val opened = envelope(
            environment.bridge.openFile(
                environment.sessionId,
                "content://io.github.zclaudia.zody.mobile.fileprovider/downloads/report.pdf",
                "application/pdf",
            ),
        )
        assertTrue(opened.getBoolean("opened"))
        assertEquals(1, environment.opener.opened.size)
    }

    @Test
    fun `payload call with a token from another session is rejected`() {
        val environment = environment()
        val token = envelope(
            environment.bridge.saveFileBegin(environment.sessionId, "report.pdf", "application/pdf"),
        ).getString("token")

        val result = envelope(
            environment.bridge.saveFileAppend(
                "another-session",
                token,
                Base64.getEncoder().encodeToString("data".toByteArray()),
            ),
        )
        assertFalse(result.getBoolean("ok"))
        assertEquals("stale-session", result.getJSONObject("error").getString("code"))
    }

    @Test
    fun `notification calls require the session and preserve pending slot shapes`() {
        val environment = environment()

        val stale = envelope(environment.bridge.notificationGetPendingClick("old-session"))
        assertEquals("stale-session", stale.getJSONObject("error").getString("code"))

        val click = envelope(environment.bridge.notificationGetPendingClick(environment.sessionId))
        assertTrue(click.getBoolean("ok"))
        assertEquals("notification-1", click.getJSONObject("click").getString("notificationId"))

        val sync = envelope(
            environment.bridge.notificationSyncSubscription(
                environment.sessionId,
                """{"backendId":"backend-1"}""",
            ),
        )
        assertTrue(sync.getBoolean("ok"))
        assertEquals("ready", sync.getJSONObject("status").getString("status"))
        assertEquals("""{"backendId":"backend-1"}""", environment.notifications.lastSyncConfig)

        val action = envelope(environment.bridge.notificationGetPendingAction(environment.sessionId))
        assertTrue(action.getBoolean("ok"))
        assertTrue(action.isNull("action"))

        assertTrue(
            envelope(
                environment.bridge.notificationSetActiveTarget(environment.sessionId, "workspace-1"),
            ).getBoolean("ok"),
        )
        assertEquals("workspace-1", environment.notifications.lastActiveTarget)

        assertTrue(
            envelope(
                environment.bridge.notificationShow(
                    environment.sessionId,
                    """{"version":1}""",
                ),
            ).getBoolean("shown"),
        )
    }

    @Test
    fun `returnShell rejects stale ids and invalidates the current session after success`() {
        val environment = environment()

        val stale = envelope(environment.bridge.returnShell("switch", "old-session"))
        assertFalse(stale.getBoolean("ok"))
        assertEquals("stale-session", stale.getJSONObject("error").getString("code"))
        assertNotNull(environment.controller.remoteSessionSnapshot())

        val current = envelope(environment.bridge.returnShell("switch", environment.sessionId))
        assertTrue(current.getBoolean("ok"))
        assertNull(environment.controller.remoteSessionSnapshot())

        val afterReturn = envelope(environment.bridge.getSessionContext())
        assertFalse(afterReturn.getBoolean("ok"))
        assertEquals(
            "session-context-invalid",
            afterReturn.getJSONObject("error").getString("code"),
        )
        assertEquals(
            "stale-session",
            envelope(environment.bridge.saveFileAbort(environment.sessionId, "token"))
                .getJSONObject("error")
                .getString("code"),
        )
    }

    @Test
    fun `markRemoteReady rejects a stale session`() {
        val environment = environment()
        val result = envelope(environment.bridge.markRemoteReady("old-session"))
        assertFalse(result.getBoolean("ok"))
        assertEquals("stale-session", result.getJSONObject("error").getString("code"))
        assertTrue(envelope(environment.bridge.markRemoteReady(environment.sessionId)).getBoolean("ok"))
    }
}
