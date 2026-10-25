package io.github.zclaudia.zody.mobile.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import io.github.zclaudia.zody.mobile.bridge.MobileNotificationForegroundState

class MobileNotificationSuppressionTest {
    @Test
    fun `suppresses only exact currently visible target`() {
        assertTrue(shouldSuppressTaskNotification(true, "target-a", "target-a"))
        assertFalse(shouldSuppressTaskNotification(true, "target-a", "target-b"))
        assertFalse(shouldSuppressTaskNotification(false, "target-a", "target-a"))
        assertFalse(shouldSuppressTaskNotification(true, null, "target-a"))
        assertFalse(shouldSuppressTaskNotification(true, "target-a", null))
    }

    @Test
    fun `process restart starts with app foreground false`() {
        MobileNotificationForegroundState.set(false)
        assertFalse(MobileNotificationForegroundState.get())
        assertFalse(shouldSuppressTaskNotification(MobileNotificationForegroundState.get(), "target-a", "target-a"))
    }
}
