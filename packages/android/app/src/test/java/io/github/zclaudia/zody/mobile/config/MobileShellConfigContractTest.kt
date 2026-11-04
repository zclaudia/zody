package io.github.zclaudia.zody.mobile.config

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Shell 配置线格式必须与 `packages/shared/src/mobile-ui-bridge.ts` 的 strict schema 一致。
 * 这里覆盖归一化、release 传输限制和未知字段拒绝，避免原生侧另建一套宽松解析。
 */
class MobileShellConfigContractTest {
    @Test
    fun persistedConfigParsesSharedJsonShape() {
        val raw = """
            {
              "schemaVersion": 1,
              "gatewayUrl": "https://gateway.example/",
              "namespace": "zody",
              "credential": "zgd_device_credential",
              "backendId": "desktop-1",
              "configRevision": 7
            }
        """.trimIndent()

        val config = parsePersistedMobileShellConfig(raw, allowInsecureTransport = false)

        assertEquals(
            MobileShellConfig(
                gatewayUrl = "https://gateway.example",
                namespace = "zody",
                credential = "zgd_device_credential",
                backendId = "desktop-1",
                configRevision = 7,
            ),
            config,
        )
    }

    @Test
    fun gatewayUrlIsNormalizedLikeSharedContract() {
        assertEquals(
            "https://gateway.example/team",
            normalizeMobileShellGatewayUrl(" wss://Gateway.Example/team/// ", allowInsecureTransport = false),
        )
        assertEquals(
            "http://127.0.0.1:8787/base",
            normalizeMobileShellGatewayUrl("ws://127.0.0.1:8787/base/", allowInsecureTransport = true),
        )
        assertEquals(
            "https://gateway.example",
            normalizeMobileShellGatewayUrl("https://gateway.example:443/", allowInsecureTransport = false),
        )
    }

    @Test
    fun releaseRejectsInsecureGatewayAndDebugAllowsIt() {
        assertNull(normalizeMobileShellGatewayUrl("http://gateway.example", allowInsecureTransport = false))
        assertEquals(
            "http://gateway.example",
            normalizeMobileShellGatewayUrl("http://gateway.example", allowInsecureTransport = true),
        )
    }

    @Test
    fun gatewayRejectsUnsupportedAddressForms() {
        listOf(
            "",
            "relative/path",
            "ftp://gateway.example",
            "https://user:pass@gateway.example",
            "https://gateway.example/?token=1",
            "https://gateway.example/#fragment",
            "https://gateway.example:notaport",
        ).forEach { value ->
            assertNull("expected rejection for $value", normalizeMobileShellGatewayUrl(value, true))
        }
    }

    @Test
    fun gatewayRejectsBackslashDotSegmentsAndEncodedPathEscapes() {
        listOf(
            "https://gateway.example/a\\b",
            "https://gateway.example/a/../b",
            "https://gateway.example/a/./b",
            "https://gateway.example/%2e%2e/b",
            "https://gateway.example/%2E%2E/b",
            "https://gateway.example/a%2fb",
            "https://gateway.example/a%5cb",
            "https://gateway.example/a%00b",
            "https://gateway.example/a//b",
            "https://gateway.example/%252e%252e/b",
            "https://gateway.example/%ff",
            "https://gateway.example/a b",
        ).forEach { value ->
            assertNull("expected path escape rejection for $value", normalizeMobileShellGatewayUrl(value, true))
        }
    }

    @Test
    fun gatewayAllowsSafeDeploymentPrefixAndEncodedSafeCharacters() {
        assertEquals(
            "https://gateway.example/team.v1/base",
            normalizeMobileShellGatewayUrl("https://gateway.example/team.v1/base/", false),
        )
        assertEquals(
            "https://gateway.example/team",
            normalizeMobileShellGatewayUrl("https://gateway.example/%74eam", false),
        )
    }

    @Test
    fun writeDraftAppliesDefaultsAndTrims() {
        val write = parseMobileShellConfigWriteJson(
            """{"gatewayUrl":"https://gateway.example/","namespace":"  ","credential":"  zgd_abc  ","backendId":"  pc-1  "}""",
            allowInsecureTransport = false,
        )

        assertEquals(
            MobileShellConfigWrite(
                gatewayUrl = "https://gateway.example",
                namespace = "zody",
                credential = "zgd_abc",
                backendId = "pc-1",
            ),
            write,
        )
    }

    @Test
    fun writeDraftTreatsBlankBackendAsUnselected() {
        val write = parseMobileShellConfigWriteJson(
            """{"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"zgd_abc","backendId":"   "}""",
            allowInsecureTransport = false,
        )

        assertEquals(null, write?.backendId)
    }

    @Test
    fun invalidCredentialAndRevisionAreRejected() {
        assertNull(
            parsePersistedMobileShellConfig(
                """{"schemaVersion":1,"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"token","configRevision":1}""",
                false,
            ),
        )
        assertNull(
            parsePersistedMobileShellConfig(
                """{"schemaVersion":1,"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"zgd_abc","configRevision":-1}""",
                false,
            ),
        )
        assertNull(
            parsePersistedMobileShellConfig(
                """{"schemaVersion":1,"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"zgd_abc","configRevision":1.5}""",
                false,
            ),
        )
        assertNull(
            parsePersistedMobileShellConfig(
                """{"schemaVersion":2,"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"zgd_abc","configRevision":1}""",
                false,
            ),
        )
    }

    @Test
    fun unknownFieldsAreRejectedOnBothShapes() {
        assertNull(
            parsePersistedMobileShellConfig(
                """{"schemaVersion":1,"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"zgd_abc","configRevision":1,"extra":true}""",
                false,
            ),
        )
        assertNull(
            parseMobileShellConfigWriteJson(
                """{"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"zgd_abc","configRevision":1}""",
                false,
            ),
        )
    }

    @Test
    fun serializedConfigUsesExactlySharedFieldNames() {
        val encoded = encodeMobileShellConfig(
            MobileShellConfig(
                gatewayUrl = "https://gateway.example",
                namespace = "zody",
                credential = "zgd_abc",
                backendId = null,
                configRevision = 3,
            ),
        )
        val json = JSONObject(encoded)

        assertEquals(
            setOf("schemaVersion", "gatewayUrl", "namespace", "credential", "configRevision"),
            json.keys().asSequence().toSet(),
        )
        assertEquals(1, json.getInt("schemaVersion"))
        assertEquals(3, json.getLong("configRevision"))
        assertFalse(json.has("backendId"))

        // 未选电脑时省略 backendId 也必须能读回，保持 shared optional 字段语义。
        assertEquals(
            MobileShellConfig(
                gatewayUrl = "https://gateway.example",
                namespace = "zody",
                credential = "zgd_abc",
                backendId = null,
                configRevision = 3,
            ),
            parsePersistedMobileShellConfig(encoded, allowInsecureTransport = false),
        )
    }

    @Test
    fun persistedConfigRequiresSharedRequiredFields() {
        assertNull(
            parsePersistedMobileShellConfig(
                """{"schemaVersion":1,"gatewayUrl":"https://gateway.example","namespace":"zody","credential":"zgd_abc"}""",
                false,
            ),
        )
    }

    @Test
    fun toStringDoesNotExposeGatewayOrCredential() {
        val config = MobileShellConfig(
            gatewayUrl = "https://internal-gateway.example/private",
            namespace = "zody",
            credential = "zgd_secret_value",
            backendId = "pc-1",
            configRevision = 1,
        )
        val write = MobileShellConfigWrite(
            gatewayUrl = "https://internal-gateway.example/private",
            namespace = "zody",
            credential = "zgd_secret_value",
            backendId = "pc-1",
        )

        listOf(config.toString(), write.toString()).forEach { rendered ->
            assertFalse(rendered.contains("internal-gateway.example"))
            assertFalse(rendered.contains("zgd_secret_value"))
            assertTrue(rendered.contains("<redacted>"))
        }
    }
}
