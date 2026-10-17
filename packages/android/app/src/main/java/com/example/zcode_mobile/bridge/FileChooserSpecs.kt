package com.example.zcode_mobile.bridge

/**
 * `onShowFileChooser` 的纯决策逻辑（T6.3）。
 *
 * 不直接依赖 `WebChromeClient.FileChooserParams`，这样 JVM 单测可以覆盖 accept 类型、
 * 多选和拍照入口的判定。
 */
object FileChooserSpecs {
    /** 空 accept 视为任意文件；包含 image/* 或 */* 时提供拍照入口。 */
    fun acceptsImages(acceptTypes: List<String>): Boolean {
        val normalized = acceptTypes.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        return normalized.isEmpty() ||
            normalized.any { it == "*/*" || it == "*" || it.startsWith("image/") }
    }

    data class PickerSpec(
        val type: String,
        val mimeTypes: List<String>,
        val allowMultiple: Boolean,
    )

    /** 把 WebView 的 acceptTypes 映射成 ACTION_OPEN_DOCUMENT 的 type/EXTRA_MIME_TYPES。 */
    fun buildPickerSpec(acceptTypes: List<String>, allowMultiple: Boolean): PickerSpec {
        val normalized = acceptTypes.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        return when {
            normalized.isEmpty() -> PickerSpec("*/*", emptyList(), allowMultiple)
            normalized.size == 1 -> PickerSpec(normalized.first(), emptyList(), allowMultiple)
            else -> PickerSpec("*/*", normalized, allowMultiple)
        }
    }
}
