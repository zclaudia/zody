package com.example.zcode_mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 生命周期/返回键派发的 JVM 单测（T6.2）。
 * 真实 WebView 的 evaluateJavascript 由仪器测试/人工验证覆盖，这里锁定脚本契约与回退语义。
 */
class MobileBridgeEventDispatcherTest {
    private class FakeEvaluator {
        val scripts = mutableListOf<String>()
        var callback: ((String?) -> Unit)? = null

        fun dispatcher() =
            MobileBridgeEventDispatcher { script, resultCallback ->
                scripts += script
                callback = resultCallback
            }
    }

    @Test
    fun `dispatches foreground and background to the page host`() {
        val evaluator = FakeEvaluator()
        val dispatcher = evaluator.dispatcher()

        dispatcher.dispatchLifecycle(MobileBridgeLifecycleState.FOREGROUND)
        dispatcher.dispatchLifecycle(MobileBridgeLifecycleState.BACKGROUND)

        assertEquals(2, evaluator.scripts.size)
        assertTrue(evaluator.scripts[0].contains("window.ZcodeMobileBridgeHost"))
        assertTrue(evaluator.scripts[0].contains("onAppLifecycle('foreground')"))
        assertTrue(evaluator.scripts[1].contains("onAppLifecycle('background')"))
        // 生命周期事件是单向通知，不需要 JS 返回值。
        assertNull(evaluator.callback)
    }

    @Test
    fun `reports whether the page consumed the back key`() {
        val evaluator = FakeEvaluator()
        val dispatcher = evaluator.dispatcher()
        var handled: Boolean? = null

        assertTrue(dispatcher.dispatchBackPressed { handled = it })
        assertTrue(evaluator.scripts.single().contains("onBackPressed"))
        evaluator.callback?.invoke("true")

        assertTrue(handled == true)
    }

    @Test
    fun `treats null and false results as not handled`() {
        val evaluator = FakeEvaluator()
        val dispatcher = evaluator.dispatcher()
        val results = mutableListOf<Boolean>()

        dispatcher.dispatchBackPressed { results += it }
        evaluator.callback?.invoke("null")
        dispatcher.dispatchBackPressed { results += it }
        evaluator.callback?.invoke("false")

        assertEquals(listOf(false, false), results)
    }

    @Test
    fun `ignores a second back press while the first is pending`() {
        val evaluator = FakeEvaluator()
        val dispatcher = evaluator.dispatcher()
        var handled: Boolean? = null

        assertTrue(dispatcher.dispatchBackPressed { handled = it })
        assertFalse(dispatcher.dispatchBackPressed { handled = it })
        assertEquals(1, evaluator.scripts.size)
        assertNull(handled)

        evaluator.callback?.invoke("false")
        assertTrue(handled == false)
        // 前一次结束后可以继续处理下一次按键。
        assertTrue(dispatcher.dispatchBackPressed { handled = it })
    }
}
