package io.github.zclaudia.zody.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileNotificationSeenIdsTest {
    @Test
    fun `recognizes duplicate IDs without refreshing their original timestamp`() {
        val seen = linkedMapOf<String, Long>()
        assertFalse(rememberMobileNotificationId(seen, "same", 100L))
        assertTrue(rememberMobileNotificationId(seen, "same", 200L))
        assertEquals(mapOf("same" to 100L), seen)
    }

    @Test
    fun `expires IDs at the retention boundary`() {
        val seen = linkedMapOf("old" to 100L)
        assertFalse(rememberMobileNotificationId(seen, "old", 100L + MOBILE_NOTIFICATION_SEEN_TTL_MS))
        assertEquals(mapOf("old" to 100L + MOBILE_NOTIFICATION_SEEN_TTL_MS), seen)
    }

    @Test
    fun `keeps the newest bounded set when capacity is exceeded`() {
        val seen = linkedMapOf("oldest" to 10L, "newer" to 20L)
        assertFalse(rememberMobileNotificationId(seen, "new", 30L, retentionMs = 100L, maximum = 2))
        assertEquals(mapOf("newer" to 20L, "new" to 30L), seen)
        assertFalse(rememberMobileNotificationId(seen, "oldest", 31L, retentionMs = 100L, maximum = 2))
    }
}
