package com.example.zcode_mobile.bridge

import android.webkit.JavascriptInterface

/**
 * 页面 ↔ Android 壳的原生桥（T6.2）。
 *
 * 通过 `WebView.addJavascriptInterface(..., "ZcodeMobileBridge")` 注入。`@JavascriptInterface`
 * 只能暴露平铺方法，所以这里用 `secureStoreGet/Set/Remove`；页面侧
 * `packages/web/src/mobile-remote/mobileRemoteSecureStore.ts` 会把它们归一化成
 * `secureStore.get/set/remove`，其余页面代码不需要知道注入细节。
 *
 * 安全边界：WebView 只加载内置的 `appassets.androidplatform.net/assets/remote/` 页面，
 * 主框架导航离开该 origin 会被交给系统浏览器，因此这些方法不会暴露给任意远端页面。
 */
class ZcodeMobileBridge(private val secureStore: SecureKeyValueStore) {
    @JavascriptInterface
    fun secureStoreGet(key: String): String? {
        requireValidKey(key)
        return secureStore.get(key)
    }

    @JavascriptInterface
    fun secureStoreSet(key: String, value: String) {
        requireValidKey(key)
        secureStore.set(key, value)
    }

    @JavascriptInterface
    fun secureStoreRemove(key: String) {
        requireValidKey(key)
        secureStore.remove(key)
    }

    private fun requireValidKey(key: String) {
        // 空 key 在 EncryptedSharedPreferences 里没有意义；明确失败比静默写入更安全。
        require(key.isNotBlank()) { "Secure store key must not be blank." }
    }
}
