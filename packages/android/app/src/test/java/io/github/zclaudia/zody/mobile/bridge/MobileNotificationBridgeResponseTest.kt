package io.github.zclaudia.zody.mobile.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileNotificationBridgeResponseTest {
    @Test
    fun `keeps complete status JSON when daemon response exceeds legacy limit`() {
        val subscriptionId = "io.github.zclaudia.zody:zody:backend"
        val daemonStatus = JSONObject()
            .put(
                "subscriptions",
                JSONObject().put(
                    subscriptionId,
                    JSONObject()
                        .put("ntfy_url", "https://${"h".repeat(500)}")
                        .put("topic", "t".repeat(128))
                        .put("connected", false)
                        .put("status", "disconnected")
                        .put("last_error", "connection reset"),
                ),
            )
            .toString()
        assertTrue("fixture must exercise responses longer than 512 characters", daemonStatus.length > 512)

        val envelope = JSONObject(daemonSuccessEnvelope("ready", daemonStatus))
        val parsedStatus = JSONObject(envelope.getString("message"))

        assertEquals("ready", envelope.getString("status"))
        assertEquals(
            "connection reset",
            parsedStatus.getJSONObject("subscriptions").getJSONObject(subscriptionId).getString("last_error"),
        )
    }

    @Test
    fun `scoped cleanup cannot remove a different currently selected backend`() {
        assertTrue(shouldRemoveOwnedNotificationSubscription("backend-a", "backend-a"))
        assertEquals(false, shouldRemoveOwnedNotificationSubscription("backend-a", "backend-b"))
        assertEquals(false, shouldRemoveOwnedNotificationSubscription("backend-a", ""))
    }
}
