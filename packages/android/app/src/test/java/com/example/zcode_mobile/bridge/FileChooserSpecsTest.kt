package com.example.zcode_mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileChooserSpecsTest {
    @Test
    fun `offers the camera entry for image or unrestricted accept types`() {
        assertTrue(FileChooserSpecs.acceptsImages(emptyList()))
        assertTrue(FileChooserSpecs.acceptsImages(listOf("image/*")))
        assertTrue(FileChooserSpecs.acceptsImages(listOf("image/png", "image/jpeg")))
        assertTrue(FileChooserSpecs.acceptsImages(listOf("*/*")))
        assertFalse(FileChooserSpecs.acceptsImages(listOf("application/pdf")))
    }

    @Test
    fun `maps accept types to the document picker contract`() {
        assertEquals(
            FileChooserSpecs.PickerSpec("*/*", emptyList(), true),
            FileChooserSpecs.buildPickerSpec(emptyList(), allowMultiple = true),
        )
        assertEquals(
            FileChooserSpecs.PickerSpec("application/pdf", emptyList(), false),
            FileChooserSpecs.buildPickerSpec(listOf(" application/pdf "), allowMultiple = false),
        )
        assertEquals(
            FileChooserSpecs.PickerSpec(
                "*/*",
                listOf("image/*", "application/pdf"),
                true,
            ),
            FileChooserSpecs.buildPickerSpec(
                listOf("image/*", "application/pdf", "image/*"),
                allowMultiple = true,
            ),
        )
    }
}
