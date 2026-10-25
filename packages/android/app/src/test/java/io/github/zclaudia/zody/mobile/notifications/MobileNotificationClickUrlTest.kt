package io.github.zclaudia.zody.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Test

class MobileNotificationClickUrlTest {
    @Test
    fun `builds deep link from opaque ids without relying on daemon click header`() {
        assertEquals(
            "zody://notification/v1?backendId=backend%20a&notificationId=notification%2F1",
            mobileNotificationClickUrl("backend a", "notification/1"),
        )
    }

    // 第二批 E4：按钮 deep link 只带 opaque id + 三类固定 optionKind，不带 label/命令。
    @Test
    fun `builds action deep link with option id and kind`() {
        assertEquals(
            "zody://notification-action/v1?backendId=b&notificationId=n&optionId=opt%201&optionKind=allowOnce",
            mobileNotificationActionUrl("b", "n", "opt 1", "allowOnce"),
        )
    }
}
