package io.github.zclaudia.zody.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M4-T2：MainActivity 的通知深链解析边界。
 *
 * 只接受本应用渲染通知时生成的两类 URI；解析失败返回 null，绝不写 pending 槽。
 * 这层与 Web `parseMobileNotificationClick/Action` 使用同一 256 字符 id 上限，
 * 避免原生写入一个 Web 必然拒绝、永远无法 ack 的 pending 项。
 */
class MobileNotificationIntentParseTest {
    @Test
    fun `parses the click deep link with decoded opaque ids`() {
        assertEquals(
            MobileNotificationIntent.Click(backendId = "backend a", notificationId = "notification/1"),
            parseMobileNotificationIntent(
                "zody://notification/v1?backendId=backend%20a&notificationId=notification%2F1",
            ),
        )
    }

    @Test
    fun `parses the permission action deep link with fixed option kind`() {
        assertEquals(
            MobileNotificationIntent.Action(
                backendId = "b",
                notificationId = "n",
                optionId = "opt 1",
                optionKind = "allowAlways",
            ),
            parseMobileNotificationIntent(
                "zody://notification-action/v1?backendId=b&notificationId=n&optionId=opt%201&optionKind=allowAlways",
            ),
        )
    }

    @Test
    fun `keeps plus signs literal like Android Uri query parsing`() {
        assertEquals(
            MobileNotificationIntent.Click(backendId = "a+b", notificationId = "n"),
            parseMobileNotificationIntent("zody://notification/v1?backendId=a+b&notificationId=n"),
        )
    }

    @Test
    fun `rejects wrong scheme, host, path and missing ids`() {
        assertNull(parseMobileNotificationIntent(null))
        assertNull(parseMobileNotificationIntent(""))
        assertNull(parseMobileNotificationIntent("https://notification/v1?backendId=b&notificationId=n"))
        assertNull(parseMobileNotificationIntent("zody://other/v1?backendId=b&notificationId=n"))
        assertNull(parseMobileNotificationIntent("zody://notification/v2?backendId=b&notificationId=n"))
        assertNull(parseMobileNotificationIntent("zody://notification/v1?backendId=b"))
        assertNull(parseMobileNotificationIntent("zody://notification/v1?backendId=&notificationId=n"))
        assertNull(parseMobileNotificationIntent("zody://notification/v1?backendId=b&notificationId="))
    }

    @Test
    fun `rejects malformed or unknown action payloads`() {
        assertNull(
            parseMobileNotificationIntent(
                "zody://notification-action/v1?backendId=b&notificationId=n&optionId=opt",
            ),
        )
        assertNull(
            parseMobileNotificationIntent(
                "zody://notification-action/v1?backendId=b&notificationId=n&optionId=&optionKind=deny",
            ),
        )
        assertNull(
            parseMobileNotificationIntent(
                "zody://notification-action/v1?backendId=b&notificationId=n&optionId=opt&optionKind=custom",
            ),
        )
    }

    @Test
    fun `suppresses only the same launch intent replayed by state restoration`() {
        val uri = "zody://notification/v1?backendId=b&notificationId=n"
        assertTrue(shouldHandleNotificationDeepLink(uri, null, allowReplay = false))
        assertFalse(shouldHandleNotificationDeepLink(uri, uri, allowReplay = false))
        // 进程内 onNewIntent 是用户的新点击，即使 URI 相同也允许重试；执行层再去重。
        assertTrue(shouldHandleNotificationDeepLink(uri, uri, allowReplay = true))
        assertTrue(shouldHandleNotificationDeepLink("$uri-other", uri, allowReplay = false))
        assertFalse(shouldHandleNotificationDeepLink(null, uri, allowReplay = true))
    }

    @Test
    fun `rejects duplicate keys, bad percent escapes and overlong ids`() {
        assertNull(
            parseMobileNotificationIntent(
                "zody://notification/v1?backendId=b&notificationId=n&notificationId=m",
            ),
        )
        assertNull(
            parseMobileNotificationIntent("zody://notification/v1?backendId=b&notificationId=%ZZ"),
        )
        assertNull(
            parseMobileNotificationIntent(
                "zody://notification/v1?backendId=b&notificationId=${"n".repeat(257)}",
            ),
        )
    }
}
