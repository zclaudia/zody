package io.github.zclaudia.zody.mobile.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileFileUrisTest {
    private val packageName = "io.github.zclaudia.zody.mobile"

    @Test
    fun `allows only MediaStore and this app's FileProvider content uris`() {
        assertTrue(
            MobileFileUris.isAllowedOpenUri(
                "content://media/external/downloads/42",
                packageName,
            ),
        )
        assertTrue(
            MobileFileUris.isAllowedOpenUri(
                "content://$packageName.fileprovider/downloads/report.pdf",
                packageName,
            ),
        )
    }

    @Test
    fun `rejects other apps, non-content schemes and malformed uris`() {
        assertFalse(
            MobileFileUris.isAllowedOpenUri(
                "content://com.example.other.fileprovider/secret.txt",
                packageName,
            ),
        )
        assertFalse(
            MobileFileUris.isAllowedOpenUri(
                "content://media.evil/external/downloads/42",
                packageName,
            ),
        )
        assertFalse(MobileFileUris.isAllowedOpenUri("file:///sdcard/report.pdf", packageName))
        assertFalse(MobileFileUris.isAllowedOpenUri("https://example.com/report.pdf", packageName))
        assertFalse(MobileFileUris.isAllowedOpenUri("not a uri", packageName))
        // userinfo 不能用于伪装 authority。
        assertFalse(
            MobileFileUris.isAllowedOpenUri(
                "content://user@media/external/downloads/42",
                packageName,
            ),
        )
    }
}
