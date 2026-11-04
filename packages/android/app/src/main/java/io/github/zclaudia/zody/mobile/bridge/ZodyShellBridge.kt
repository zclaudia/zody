package io.github.zclaudia.zody.mobile.bridge

import android.webkit.JavascriptInterface
import io.github.zclaudia.zody.mobile.config.MobileShellConfig
import io.github.zclaudia.zody.mobile.config.MobileShellConfigException
import io.github.zclaudia.zody.mobile.config.MobileShellConfigFailure
import io.github.zclaudia.zody.mobile.config.MobileShellConfigState
import io.github.zclaudia.zody.mobile.config.MobileShellConfigStore
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellTransitionResult
import io.github.zclaudia.zody.mobile.ui.shell.MobileShellController
import org.json.JSONObject

/**
 * Shell 页面唯一可见的原生桥（spec 第 7 节）。
 *
 * 只承载配对配置、打开 Remote 和诊断；不暴露文件、通知、业务或通用安全存储能力。
 * 所有方法都先校验当前 source 仍是 Shell，避免旧 Shell 文档在导航后继续读取凭证。
 * 每个方法都返回 shared `mobile-ui-bridge.ts` 的 JSON envelope。
 */
class ZodyShellBridge(
    private val controller: MobileShellController,
    private val configStore: MobileShellConfigStore,
    private val appVersion: String,
    private val allowInsecureGatewayTransport: Boolean,
) {
    @JavascriptInterface
    fun readConfig(): String {
        unavailableUnlessShell()?.let { return it }
        val state = try {
            configStore.inspect()
        } catch (error: MobileShellConfigException) {
            return failureFor(error)
        } catch (_: Exception) {
            return MobileBridgeJson.failure(MobileBridgeErrors.CONFIG_UNAVAILABLE)
        }
        return when (state) {
            MobileShellConfigState.Unconfigured -> MobileBridgeJson.success {
                put("config", JSONObject.NULL)
            }
            is MobileShellConfigState.Ready -> MobileBridgeJson.success {
                put("config", encodeConfig(state.config))
            }
            is MobileShellConfigState.RequiresRepair ->
                MobileBridgeJson.failure(MobileBridgeErrors.CONFIG_INVALID)
        }
    }

    @JavascriptInterface
    fun saveConfig(inputJson: String): String {
        unavailableUnlessShell()?.let { return it }
        return try {
            val config = configStore.saveConfigJson(inputJson)
            MobileBridgeJson.success { put("config", encodeConfig(config)) }
        } catch (error: MobileShellConfigException) {
            failureFor(error)
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.CONFIG_WRITE_FAILED)
        }
    }

    @JavascriptInterface
    fun clearConfig(): String {
        unavailableUnlessShell()?.let { return it }
        return try {
            configStore.clearConfig()
            MobileBridgeJson.success()
        } catch (error: MobileShellConfigException) {
            failureFor(error)
        } catch (_: Exception) {
            MobileBridgeJson.failure(MobileBridgeErrors.CONFIG_WRITE_FAILED)
        }
    }

    /**
     * 校验 revision 后才导航；失败不触发任何 WebView 操作。
     *
     * JavaScript 数字以 Double 传入；controller 只接受安全整数范围内的值。
     */
    @JavascriptInterface
    fun openRemote(backendId: String, expectedConfigRevision: Double): String {
        unavailableUnlessShell()?.let { return it }
        return transitionResult(
            controller.openRemoteFromShell(backendId, expectedConfigRevision),
        )
    }

    @JavascriptInterface
    fun getBridgeInfo(): String {
        unavailableUnlessShell()?.let { return it }
        return MobileBridgeJson.success {
            put(
                "info",
                JSONObject()
                    .put("schemaVersion", MobileBridgeJson.SCHEMA_VERSION)
                    .put("bridgeVersion", MobileBridgeJson.BRIDGE_VERSION)
                    .put("appVersion", appVersion)
                    .put("allowsInsecureGatewayTransport", allowInsecureGatewayTransport),
            )
        }
    }

    @JavascriptInterface
    fun getDiagnostics(): String {
        unavailableUnlessShell()?.let { return it }
        val revision = try {
            configStore.currentConfigRevision()
        } catch (error: MobileShellConfigException) {
            return failureFor(error)
        } catch (_: Exception) {
            return MobileBridgeJson.failure(MobileBridgeErrors.CONFIG_UNAVAILABLE)
        }
        val selectedBackendId = try {
            (configStore.inspect() as? MobileShellConfigState.Ready)?.config?.backendId
        } catch (_: Exception) {
            null
        }
        return MobileBridgeJson.success {
            val diagnostics = JSONObject()
                .put("schemaVersion", MobileBridgeJson.SCHEMA_VERSION)
                .put("configRevision", revision)
            selectedBackendId?.let { diagnostics.put("selectedBackendId", it) }
            controller.lastErrorCode()?.let { diagnostics.put("lastErrorCode", it) }
            put("diagnostics", diagnostics)
        }
    }

    private fun unavailableUnlessShell(): String? =
        if (controller.isShellSource()) {
            null
        } else {
            MobileBridgeJson.failure(MobileBridgeErrors.NATIVE_BRIDGE_UNAVAILABLE)
        }

    private fun transitionResult(result: MobileShellTransitionResult): String =
        when (result) {
            MobileShellTransitionResult.Success -> MobileBridgeJson.success()
            is MobileShellTransitionResult.Failure -> {
                controller.recordError(result.code)
                MobileBridgeJson.failure(result.code, result.message)
            }
        }

    private fun failureFor(error: MobileShellConfigException): String {
        val code = when (error.failure) {
            MobileShellConfigFailure.REQUIRES_REPAIR,
            MobileShellConfigFailure.CONFIG_INVALID,
            -> MobileBridgeErrors.CONFIG_INVALID
            MobileShellConfigFailure.WRITE_FAILED -> MobileBridgeErrors.CONFIG_WRITE_FAILED
            MobileShellConfigFailure.INVALID_ARGUMENT -> MobileBridgeErrors.INVALID_ARGUMENT
            MobileShellConfigFailure.STORAGE_UNAVAILABLE -> MobileBridgeErrors.CONFIG_UNAVAILABLE
        }
        controller.recordError(code)
        return MobileBridgeJson.failure(code)
    }

    private fun encodeConfig(config: MobileShellConfig): JSONObject =
        JSONObject()
            .put("schemaVersion", MobileBridgeJson.SCHEMA_VERSION)
            .put("gatewayUrl", config.gatewayUrl)
            .put("namespace", config.namespace)
            .put("credential", config.credential)
            .put("configRevision", config.configRevision)
            .apply { config.backendId?.let { put("backendId", it) } }

    companion object {
        const val GLOBAL_KEY = "ZodyShellBridge"
    }
}
