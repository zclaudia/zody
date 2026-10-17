package com.example.zcode_mobile.bridge

import android.webkit.WebView
import java.util.concurrent.atomic.AtomicBoolean

/** 宿主 → 页面的生命周期事件（T6.2）。与页面 `PlatformAppLifecycleState` 的取值一致。 */
enum class MobileBridgeLifecycleState(val wireValue: String) {
    FOREGROUND("foreground"),
    BACKGROUND("background"),
}

/**
 * 把 Android 生命周期和返回键事件派发到页面（T6.2）。
 *
 * `@JavascriptInterface` 只支持页面 → 宿主方向；反方向由 `WebView.evaluateJavascript`
 * 调用页面安装的 `ZcodeMobileBridgeHost`：
 * - `onAppLifecycle("foreground" | "background")`：页面据此 suspend / 恢复连接；
 * - `onBackPressed(): boolean`：页面同步返回是否消费这次返回键。
 *
 * 通过构造注入 `evaluateJavascript`，JVM 单测可以断言脚本内容与回退语义，不需要真实 WebView。
 */
class MobileBridgeEventDispatcher(
    private val evaluateJavascript: (script: String, callback: ((String?) -> Unit)?) -> Unit,
) {
    // 返回键的 JS 求值是异步的；连续按键时只保留第一次请求，避免同一次返回被处理两次。
    private val backPending = AtomicBoolean(false)

    fun dispatchLifecycle(state: MobileBridgeLifecycleState) {
        evaluateJavascript(
            "window.$HOST_OBJECT_NAME&&typeof window.$HOST_OBJECT_NAME.onAppLifecycle==='function'&&" +
                "window.$HOST_OBJECT_NAME.onAppLifecycle('${state.wireValue}');",
            null,
        )
    }

    /**
     * 询问页面是否消费返回键。
     *
     * @return false 表示上一次询问尚未结束，调用方应忽略这次按键；
     *         true 表示已发起询问，`onHandled` 会在 UI 线程回调。
     */
    fun dispatchBackPressed(onHandled: (Boolean) -> Unit): Boolean {
        if (!backPending.compareAndSet(false, true)) {
            return false
        }
        evaluateJavascript(BACK_SCRIPT) { result ->
            backPending.set(false)
            // evaluateJavascript 返回 JSON 字面量；页面没有宿主对象时是 "null"。
            onHandled(result == "true")
        }
        return true
    }

    companion object {
        const val HOST_OBJECT_NAME = "ZcodeMobileBridgeHost"

        // 页面 handler 必须同步返回；异常按“未消费”处理，让宿主仍能回退历史/退出。
        private const val BACK_SCRIPT =
            "(function(){try{var h=window.$HOST_OBJECT_NAME;" +
                "return !!(h&&typeof h.onBackPressed==='function'&&h.onBackPressed());}" +
                "catch(e){return false;}})()"

        fun forWebView(webView: WebView): MobileBridgeEventDispatcher =
            MobileBridgeEventDispatcher { script, callback ->
                webView.evaluateJavascript(script) { result -> callback?.invoke(result) }
            }
    }
}
