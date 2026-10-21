package io.github.zclaudia.zody.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class ApplicationIdentityTest {
    @Test
    fun releaseIdentityMatchesZody() {
        assertEquals("io.github.zclaudia.zody.mobile", BuildConfig.APPLICATION_ID)
        assertEquals("0.1.0", BuildConfig.VERSION_NAME)
        assertEquals(1, BuildConfig.VERSION_CODE)
    }
}
