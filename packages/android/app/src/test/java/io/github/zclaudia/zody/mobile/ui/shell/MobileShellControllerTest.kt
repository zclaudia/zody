package io.github.zclaudia.zody.mobile.ui.shell

import io.github.zclaudia.zody.mobile.bridge.SecureKeyValueStore
import io.github.zclaudia.zody.mobile.config.MobileShellConfigState
import io.github.zclaudia.zody.mobile.config.MobileShellConfigStore
import io.github.zclaudia.zody.mobile.config.MobileShellConfigWrite
import io.github.zclaudia.zody.mobile.config.MobileShellRepairReason
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptRequest
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiInterceptResponse
import io.github.zclaudia.zody.mobile.remoteui.RemoteUiSessionContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileShellControllerTest {
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

    private class RecordingHost : MobileShellControllerHost {
        val events = mutableListOf<String>()
        val notifications = mutableListOf<String>()
        val ready = mutableListOf<String>()

        override fun removeBridges() {
            events += "remove"
        }

        override fun installShellBridge() {
            events += "install-shell"
        }

        override fun installRemoteBridge() {
            events += "install-remote"
        }

        override fun loadUrl(url: String) {
            events += "load:$url"
        }

        override fun showRepair(reason: MobileShellRepairReason) {
            events += "repair:$reason"
        }

        override fun onRemoteReady(generation: Long, backendId: String) {
            ready += "$generation:$backendId"
        }

        override fun dispatchNotificationClick(payloadJson: String) {
            notifications += "click:$payloadJson"
        }

        override fun dispatchNotificationAction(payloadJson: String) {
            notifications += "action:$payloadJson"
        }

        override fun dispatchNotificationPermissionChanged(granted: Boolean) {
            notifications += "permission:$granted"
        }
    }

    private class RecordingInterceptorFactory : RemoteUiInterceptorFactory {
        val contexts = mutableListOf<RemoteUiSessionContext>()
        var behavior: (RemoteUiInterceptRequest) -> RemoteUiInterceptResponse = { request ->
            RemoteUiInterceptResponse(
                statusCode = 200,
                reasonPhrase = "OK",
                headers = mapOf("Content-Type" to "text/html; charset=utf-8"),
                body = "body".toByteArray(),
                generation = request.generation,
            )
        }

        override fun create(sessionContext: RemoteUiSessionContext): RemoteUiInterceptor {
            contexts += sessionContext
            return RemoteUiInterceptor { request -> behavior(request) }
        }
    }

    private fun newStore(
        backendId: String? = "backend-1",
        allowInsecure: Boolean = true,
    ): MobileShellConfigStore {
        val store = MobileShellConfigStore(InMemorySecureStore(), allowInsecureTransport = allowInsecure)
        store.saveConfig(
            MobileShellConfigWrite(
                gatewayUrl = "https://gateway.example",
                namespace = "zody",
                credential = "zgd_test_credential",
                backendId = backendId,
            ),
        )
        return store
    }

    private fun newController(
        store: MobileShellConfigStore,
        factory: RecordingInterceptorFactory = RecordingInterceptorFactory(),
        allowInsecure: Boolean = true,
    ): Pair<MobileShellController, RecordingInterceptorFactory> {
        var sequence = 0
        val controller = MobileShellController(
            configStore = store,
            appVersion = "1.2.3",
            allowInsecureGatewayTransport = allowInsecure,
            interceptorFactory = factory,
            mainExecutor = { runnable -> runnable.run() },
            newSessionId = { "session-${++sequence}" },
        )
        return controller to factory
    }

    private fun startedController(
        store: MobileShellConfigStore = newStore(),
        factory: RecordingInterceptorFactory = RecordingInterceptorFactory(),
        restoreRemote: Boolean = false,
    ): Triple<MobileShellController, RecordingHost, RecordingInterceptorFactory> {
        val (controller, recordedFactory) = newController(store, factory)
        val host = RecordingHost()
        controller.attachHost(host)
        controller.start(restoreRemote)
        return Triple(controller, host, recordedFactory)
    }

    @Test
    fun `cold start installs shell bridge and loads the shell source`() {
        val (controller, host, _) = startedController()

        assertEquals(
            listOf(
                "remove",
                "install-shell",
                "load:${MobileShellOrigins.SHELL_PAGE_URL}",
            ),
            host.events,
        )
        assertEquals(MobileShellSource.SHELL, controller.currentSource())
        assertEquals(1L, controller.state().generation)
    }

    @Test
    fun `restore with ready config installs the only remote bridge`() {
        val (controller, host, factory) = startedController(restoreRemote = true)

        assertEquals(
            listOf(
                "remove",
                "install-remote",
                "load:${MobileShellOrigins.REMOTE_PAGE_URL}",
            ),
            host.events,
        )
        assertEquals(MobileShellSource.REMOTE, controller.currentSource())
        assertEquals(1, factory.contexts.size)
        assertEquals("backend-1", factory.contexts.single().backendId)
        assertEquals("zgd_test_credential", factory.contexts.single().bearerToken)
    }

    @Test
    fun `openRemote rejects stale revision and mismatched backend without navigating`() {
        val store = newStore()
        val revision = store.readConfig()!!.configRevision
        val (controller, host, _) = startedController(store)
        host.events.clear()

        val stale = controller.openRemoteFromShell("backend-1", (revision - 1).toDouble())
        assertTrue(stale is MobileShellTransitionResult.Failure)
        assertEquals("config-revision-stale", (stale as MobileShellTransitionResult.Failure).code)
        assertTrue(host.events.isEmpty())

        val wrongBackend = controller.openRemoteFromShell("backend-2", revision.toDouble())
        assertEquals(
            "backend-not-found",
            (wrongBackend as MobileShellTransitionResult.Failure).code,
        )
        assertTrue(host.events.isEmpty())
    }

    @Test
    fun `openRemote removes old bridge before installing remote and invalidates the session on return`() {
        val store = newStore()
        val revision = store.readConfig()!!.configRevision
        val (controller, host, _) = startedController(store)
        host.events.clear()

        assertEquals(
            MobileShellTransitionResult.Success,
            controller.openRemoteFromShell("backend-1", revision.toDouble()),
        )
        assertEquals(
            listOf(
                "remove",
                "install-remote",
                "load:${MobileShellOrigins.REMOTE_PAGE_URL}",
            ),
            host.events,
        )
        val sessionId = controller.remoteSessionSnapshot()!!.sessionId
        assertTrue(controller.isCurrentRemoteSession(sessionId))
        assertEquals(2L, controller.state().generation)

        host.events.clear()
        assertEquals(
            MobileShellTransitionResult.Success,
            controller.returnShellFromRemote("user-requested", sessionId),
        )
        assertEquals(
            listOf(
                "remove",
                "install-shell",
                "load:${MobileShellOrigins.SHELL_PAGE_URL}",
            ),
            host.events,
        )
        assertFalse(controller.isCurrentRemoteSession(sessionId))
        assertEquals(
            "stale-session",
            (controller.returnShellFromRemote("again", sessionId) as MobileShellTransitionResult.Failure).code,
        )
        assertNull(controller.remoteSessionSnapshot())
    }

    @Test
    fun `rapid navigation applies only the newest queued generation`() {
        val store = newStore()
        val revision = store.readConfig()!!.configRevision
        val queued = mutableListOf<Runnable>()
        val controller = MobileShellController(
            configStore = store,
            appVersion = "1.2.3",
            allowInsecureGatewayTransport = true,
            interceptorFactory = RecordingInterceptorFactory(),
            mainExecutor = { runnable -> queued += runnable },
            newSessionId = { "session-rapid" },
        )
        val host = RecordingHost()
        fun drain() {
            while (queued.isNotEmpty()) {
                queued.removeAt(0).run()
            }
        }

        controller.attachHost(host)
        controller.start(restoreRemote = false)
        drain()
        assertEquals(MobileShellSource.SHELL, controller.currentSource())
        host.events.clear()

        controller.openRemoteFromShell("backend-1", revision.toDouble())
        controller.returnShellFromRemote("quick-switch", "session-rapid")
        drain()

        // Remote 命令在真正执行前已过期，不能安装 Remote bridge；只有最新 Shell 导航生效。
        assertEquals(
            listOf(
                "remove",
                "install-shell",
                "load:${MobileShellOrigins.SHELL_PAGE_URL}",
            ),
            host.events,
        )
        assertEquals(MobileShellSource.SHELL, controller.currentSource())
        assertEquals(3L, controller.state().generation)
    }

    @Test
    fun `proxy response from an older generation is discarded`() {
        val store = newStore()
        val revision = store.readConfig()!!.configRevision
        val factory = RecordingInterceptorFactory()
        val (controller, _, _) = startedController(store, factory)
        controller.openRemoteFromShell("backend-1", revision.toDouble())
        val sessionId = controller.remoteSessionSnapshot()!!.sessionId

        factory.behavior = { request ->
            controller.returnShellFromRemote("switch", sessionId)
            RemoteUiInterceptResponse(
                statusCode = 200,
                reasonPhrase = "OK",
                headers = emptyMap(),
                body = byteArrayOf(1),
                generation = request.generation,
            )
        }

        val outcome = controller.intercept(
            method = "GET",
            url = "${MobileShellOrigins.REMOTE_PAGE_URL}?v=1",
            requestHeaders = emptyMap(),
        )

        assertTrue(outcome is RemoteUiInterceptOutcome.Stale)
        assertEquals(MobileShellSource.SHELL, controller.currentSource())
    }

    @Test
    fun `proxy is unavailable without an active remote session`() {
        val (controller, _, _) = startedController()
        val outcome = controller.intercept(
            method = "GET",
            url = MobileShellOrigins.REMOTE_PAGE_URL,
            requestHeaders = emptyMap(),
        )
        assertEquals(RemoteUiInterceptOutcome.Unavailable, outcome)
    }

    @Test
    fun `notifications stay queued until remote reports ready for the same backend`() {
        val (controller, host, _) = startedController(restoreRemote = true)
        val sessionId = controller.remoteSessionSnapshot()!!.sessionId

        controller.onNotificationClick("backend-1", "notification-1")
        assertTrue(host.notifications.isEmpty())

        assertEquals(MobileShellTransitionResult.Success, controller.markRemoteReady(sessionId))
        assertEquals(1, host.notifications.size)
        assertTrue(host.notifications.single().contains("notification-1"))
        assertEquals(listOf("1:backend-1"), host.ready)

        // ready 后新事件立即派发。
        controller.onNotificationAction("backend-1", "notification-2", "allowOnce", "allowOnce")
        assertEquals(2, host.notifications.size)
        assertTrue(host.notifications.last().startsWith("action:"))
    }

    @Test
    fun `notification for another backend is not dispatched to the current remote session`() {
        val (controller, host, _) = startedController(restoreRemote = true)
        val sessionId = controller.remoteSessionSnapshot()!!.sessionId

        controller.markRemoteReady(sessionId)
        controller.onNotificationClick("backend-2", "notification-1")

        assertTrue(host.notifications.isEmpty())
    }

    @Test
    fun `retains another backend pending click and action until that backend is ready`() {
        val store = newStore(backendId = "backend-1")
        val (controller, host, _) = startedController(store, restoreRemote = true)
        val firstSession = controller.remoteSessionSnapshot()!!.sessionId
        assertEquals(MobileShellTransitionResult.Success, controller.markRemoteReady(firstSession))

        // 当前 Remote 是 backend-1；backend-2 的点击与按钮动作都必须保留，不能派发到错误会话。
        controller.onNotificationClick("backend-2", "notification-b")
        controller.onNotificationAction("backend-2", "notification-b", "opt", "deny")
        assertTrue(host.notifications.isEmpty())

        assertEquals(
            MobileShellTransitionResult.Success,
            controller.returnShellFromRemote("switch", firstSession),
        )
        store.saveConfig(
            MobileShellConfigWrite(
                gatewayUrl = "https://gateway.example",
                namespace = "zody",
                credential = "zgd_test_credential",
                backendId = "backend-2",
            ),
        )
        val revision = store.readConfig()!!.configRevision
        assertEquals(
            MobileShellTransitionResult.Success,
            controller.openRemoteFromShell("backend-2", revision.toDouble()),
        )
        val secondSession = controller.remoteSessionSnapshot()!!.sessionId
        assertEquals(MobileShellTransitionResult.Success, controller.markRemoteReady(secondSession))

        assertEquals(2, host.notifications.size)
        assertTrue(host.notifications[0].startsWith("click:"))
        assertTrue(host.notifications[0].contains("notification-b"))
        assertTrue(host.notifications[1].startsWith("action:"))
        assertTrue(host.notifications[1].contains("\"optionKind\":\"deny\""))

        // 重复 ready 不会再次派发已经消费的事件。
        controller.markRemoteReady(secondSession)
        assertEquals(2, host.notifications.size)
    }

    @Test
    fun `stale ready and shutdown cannot dispatch retained pending notifications`() {
        val (controller, host, _) = startedController(restoreRemote = true)
        val sessionId = controller.remoteSessionSnapshot()!!.sessionId
        controller.onNotificationClick("backend-1", "notification-1")

        assertEquals(
            "stale-session",
            (controller.markRemoteReady("old-session") as MobileShellTransitionResult.Failure).code,
        )
        assertTrue(host.notifications.isEmpty())

        // Activity 销毁会丢弃内存队列；durable pending 槽由原生 SharedPreferences 保留，
        // 由下一次 Remote ready 的页面重新读取，不能在这里误 ack。
        controller.shutdown()
        controller.start(restoreRemote = true)
        val restoredSession = controller.remoteSessionSnapshot()!!.sessionId
        controller.markRemoteReady(restoredSession)
        assertTrue(host.notifications.isEmpty())
    }

    @Test
    fun `requiring repair shows confirmation and confirmRepairAndClear removes the legacy schema`() {
        val secureStore = InMemorySecureStore().apply {
            values["config"] = """{"gatewayUrl":"https://gateway.example","backendId":"old-backend"}"""
        }
        val store = MobileShellConfigStore(secureStore, allowInsecureTransport = true)
        val (controller, _) = newController(store)
        val host = RecordingHost()
        controller.attachHost(host)
        controller.start(restoreRemote = false)

        assertEquals(
            MobileShellRepairReason.LEGACY_SCHEMA,
            controller.state().repairReason,
        )
        assertTrue(host.events.contains("repair:LEGACY_SCHEMA"))

        assertTrue(controller.confirmRepair())
        assertNull(controller.state().repairReason)
        assertEquals(MobileShellConfigState.Unconfigured, store.inspect())
        assertFalse(secureStore.values.containsKey("config"))
        assertTrue((secureStore.values["zody-mobile-shell-config-revision-v1"]?.toLong() ?: 0L) > 0L)
    }

    @Test
    fun `restore falls back to shell when the saved config has no backend`() {
        val (controller, host, factory) = startedController(
            store = newStore(backendId = null),
            restoreRemote = true,
        )

        assertEquals(MobileShellSource.SHELL, controller.currentSource())
        assertEquals("load:${MobileShellOrigins.SHELL_PAGE_URL}", host.events.last())
        assertTrue(factory.contexts.isEmpty())
    }

    @Test
    fun `capabilities include insecure transport only in debug builds`() {
        val debugController = newController(newStore(), allowInsecure = true).first
        val releaseController = newController(newStore(), allowInsecure = false).first

        assertTrue(debugController.bridgeCapabilities().contains("insecure-gateway-transport"))
        assertFalse(releaseController.bridgeCapabilities().contains("insecure-gateway-transport"))
        assertEquals(
            listOf("session-context", "file-save", "file-open", "notifications", "lifecycle"),
            releaseController.bridgeCapabilities(),
        )
    }

    @Test
    fun `source allowlist accepts only the two trusted origins`() {
        assertTrue(MobileShellOrigins.isAllowedSource(MobileShellOrigins.SHELL_PAGE_URL))
        assertTrue(MobileShellOrigins.isAllowedSource("${MobileShellOrigins.REMOTE_PAGE_URL}#/task/1"))
        assertTrue(
            MobileShellOrigins.isAllowedSource(
                "${MobileShellOrigins.REMOTE_PAGE_URL.removeSuffix("index.html")}assets/index-abc.js",
            ),
        )
        assertFalse(MobileShellOrigins.isAllowedSource("https://example.com/"))
        assertFalse(MobileShellOrigins.isAllowedSource("http://remote.zody.local/assets/remote/index.html"))
        assertFalse(MobileShellOrigins.isAllowedSource("https://remote.zody.local/other/index.html"))
        assertFalse(MobileShellOrigins.isAllowedSource("https://remote.zody.local/assets/remote/../secret"))
        assertTrue(MobileShellOrigins.isRemoteOrigin(MobileShellOrigins.REMOTE_PAGE_URL))
        assertFalse(MobileShellOrigins.isRemoteOrigin(MobileShellOrigins.SHELL_PAGE_URL))
    }
}
