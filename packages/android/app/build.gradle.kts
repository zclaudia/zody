import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.Sync
import groovy.json.JsonSlurper
import javax.xml.parsers.DocumentBuilderFactory

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// 新版 APK 只内置轻 Shell：Gradle 构建时先跑根目录的 pnpm build:mobile-shell，
// 再把 packages/web/dist-mobile-shell 同步到 app/src/main/assets/shell/
// （WebViewAssetLoader 固定服务 /assets/shell/）。完整 Remote 制品随桌面交付，
// 不再进入 APK；生成目录不进入提交，可用 -PmobileShellPnpm=<path> 覆盖 pnpm 可执行文件。
val repoRootDir: File = rootProject.projectDir.parentFile.parentFile
val releaseVersion = (JsonSlurper().parse(repoRootDir.resolve("package.json")) as Map<*, *>)["version"]
    as? String ?: throw GradleException("Root package.json must define the Zody version.")
val releaseSigning = listOf(
    "ZODY_ANDROID_KEYSTORE_FILE",
    "ZODY_ANDROID_KEYSTORE_PASSWORD",
    "ZODY_ANDROID_KEY_ALIAS",
    "ZODY_ANDROID_KEY_PASSWORD",
).associateWith { providers.environmentVariable(it).orNull }
val hasReleaseSigning = releaseSigning.values.all { !it.isNullOrBlank() }
val validateZodyReleaseSigning = tasks.register("validateZodyReleaseSigning") {
    doLast {
        val missing = releaseSigning.filterValues { it.isNullOrBlank() }.keys
        if (missing.isNotEmpty()) {
            throw GradleException("Zody release signing requires: ${missing.joinToString()}")
        }
        if (!file(releaseSigning.getValue("ZODY_ANDROID_KEYSTORE_FILE")!!).isFile) {
            throw GradleException("Zody release keystore file does not exist.")
        }
    }
}
val mobileShellDistDir = layout.projectDirectory.dir("../../web/dist-mobile-shell")
val mobileShellAssetsDir = layout.projectDirectory.dir("src/main/assets/shell")
val legacyRemoteAssetsDir = layout.projectDirectory.dir("src/main/assets/remote")
val mobileShellPnpm = providers.gradleProperty("mobileShellPnpm").getOrElse("pnpm")

val buildMobileShell = tasks.register<Exec>("buildMobileShell") {
    group = "mobile web"
    description = "Builds the lightweight shell page via pnpm build:mobile-shell."
    workingDir = repoRootDir
    if (System.getProperty("os.name").lowercase().contains("windows")) {
        // Windows 上 pnpm 是 .cmd 批处理，Gradle 的 Exec 需要经 cmd /c 启动。
        commandLine("cmd", "/c", mobileShellPnpm, "build:mobile-shell")
    } else {
        commandLine(mobileShellPnpm, "build:mobile-shell")
    }
}

val verifyNotificationRenderServicePermission = tasks.register("verifyNotificationRenderServicePermission") {
    group = "verification"
    description = "Ensures the external notification render Service stays protected by Android's DUMP permission."
    val manifestFile = layout.projectDirectory.file("src/main/AndroidManifest.xml")
    inputs.file(manifestFile)
    doLast {
        val documentFactory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val document = documentFactory.newDocumentBuilder().parse(manifestFile.asFile)
        val androidNamespace = "http://schemas.android.com/apk/res/android"
        val serviceNodes = document.getElementsByTagName("service")
        val renderService = (0 until serviceNodes.length)
            .mapNotNull { serviceNodes.item(it) as? org.w3c.dom.Element }
            .firstOrNull {
                it.getAttributeNS(androidNamespace, "name") == ".notifications.MobileNotificationRenderService"
            } ?: throw GradleException("MobileNotificationRenderService must remain declared in AndroidManifest.xml.")

        check(renderService.getAttributeNS(androidNamespace, "exported") == "true") {
            "MobileNotificationRenderService must remain exported for the root/shell ntfy-bridge caller."
        }
        check(renderService.getAttributeNS(androidNamespace, "permission") == "android.permission.DUMP") {
            "MobileNotificationRenderService must require android.permission.DUMP; shell/root ntfy-bridge calls rely on this privileged boundary."
        }
    }
}

// 旧版本会把完整 Remote 同步到 src/main/assets/remote/；该目录已被 gitignore，
// 升级构建时必须主动删除，否则残留会让 APK 继续携带旧 Remote 制品。
val clearLegacyRemoteAssets = tasks.register<Delete>("clearLegacyRemoteAssets") {
    group = "mobile web"
    description = "Removes the legacy full Remote assets directory from the APK sources."
    delete(legacyRemoteAssetsDir)
}

val syncMobileShellAssets = tasks.register<Sync>("syncMobileShellAssets") {
    group = "mobile web"
    description = "Syncs the built lightweight shell page into app/src/main/assets/shell."
    dependsOn(buildMobileShell)
    dependsOn(clearLegacyRemoteAssets)
    from(mobileShellDistDir) {
        // Shell 构建允许本地 http gateway；但 sourcemap 不属于发布制品，保留兜底排除。
        exclude("**/*.map")
    }
    into(mobileShellAssetsDir)
    doFirst {
        if (!mobileShellDistDir.file("index.html").asFile.isFile) {
            throw GradleException(
                "Mobile shell build output is missing: ${mobileShellDistDir.file("index.html").asFile}. " +
                    "Run `pnpm build:mobile-shell` or check the buildMobileShell task output.",
            )
        }
        if (legacyRemoteAssetsDir.asFile.exists()) {
            throw GradleException(
                "Legacy mobile Remote assets still exist after cleanup: ${legacyRemoteAssetsDir.asFile}.",
            )
        }
    }
}

tasks.named("preBuild") {
    dependsOn(syncMobileShellAssets)
    dependsOn(verifyNotificationRenderServicePermission)
}

android {
    namespace = "io.github.zclaudia.zody.mobile"
    buildToolsVersion = "36.1.0"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "io.github.zclaudia.zody.mobile"
        minSdk = 24
        targetSdk = 36
        // 破坏性升级：移除内置完整 Remote 并切换到新配置 schema，versionCode 必须大于旧的 1。
        versionCode = 2
        versionName = releaseVersion

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }

    signingConfigs {
        create("zodyRelease") {
            if (hasReleaseSigning) {
                storeFile = file(releaseSigning.getValue("ZODY_ANDROID_KEYSTORE_FILE")!!)
                storePassword = releaseSigning.getValue("ZODY_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = releaseSigning.getValue("ZODY_ANDROID_KEY_ALIAS")
                keyPassword = releaseSigning.getValue("ZODY_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        debug {
            // 真机连本地 gateway 时允许 http（浏览器开发模式）；release 仍只允许 https。
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
            signingConfig = signingConfigs.getByName("zodyRelease")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

// 原模板 release 没有独立签名配置；前置校验禁止发布时悄悄生成 unsigned/debug 身份的 APK。
tasks.configureEach {
    if (name == "preReleaseBuild" || name == "validateSigningRelease") {
        dependsOn(validateZodyReleaseSigning)
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.webkit)
    testImplementation(libs.junit)
    testImplementation(libs.json)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
