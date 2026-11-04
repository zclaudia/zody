package io.github.zclaudia.zody.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ApplicationIdentityTest {
    @Test
    fun releaseIdentityMatchesZody() {
        // applicationId 和签名身份保持不变；破坏性升级只提高 versionCode。
        assertEquals("io.github.zclaudia.zody.mobile", BuildConfig.APPLICATION_ID)
        assertEquals("0.1.0", BuildConfig.VERSION_NAME)
        assertEquals(2, BuildConfig.VERSION_CODE)
        assertTrue(BuildConfig.VERSION_CODE > 1)
    }
}
