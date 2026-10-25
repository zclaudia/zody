package io.github.zclaudia.zody.mobile.notifications

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 第二批 E4：envelope actions 的校验边界——畸形只丢按钮，不拒整卡。 */
class MobileNotificationActionParseTest {
    private fun parse(payloadJson: String): List<NotificationAction> =
        MobileNotificationRenderService.parseNotificationActions(JSONObject(payloadJson))

    @Test
    fun `keeps only fixed kinds with non-blank option ids, capped at three`() {
        val actions = parse(
            """{"actions":[
                {"optionId":"opt-custom","optionKind":"custom"},
                {"optionId":"opt-once","optionKind":"allowOnce"},
                {"optionId":"","optionKind":"deny"},
                {"optionId":"opt-always","optionKind":"allowAlways"},
                {"optionId":"opt-deny","optionKind":"deny"},
                {"optionId":"opt-4th","optionKind":"deny"}
            ]}""",
        )
        assertEquals(
            listOf(
                NotificationAction("opt-once", "allowOnce"),
                NotificationAction("opt-always", "allowAlways"),
                NotificationAction("opt-deny", "deny"),
            ),
            actions,
        )
    }

    @Test
    fun `missing actions array or malformed entries yield an empty list`() {
        assertEquals(
            emptyList<NotificationAction>(),
            MobileNotificationRenderService.parseNotificationActions(JSONObject()),
        )
        assertTrue(
            parse("""{"actions":["not-an-object",{"optionKind":"deny"}]}""").isEmpty(),
        )
    }
}
