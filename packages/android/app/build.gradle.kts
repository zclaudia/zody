import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.Sync
import groovy.json.JsonSlurper
import javax.xml.parsers.DocumentBuilderFactory

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// 手机页面改为随 APK 内置：Gradle 构建时先跑根目录的 pnpm build:mobile-web，
// 再把产物同步到 app/src/main/assets/remote/（WebViewAssetLoader 只服务这个目录）。
// 生成目录已在 .gitignore 中排除；可用 -PmobileWebPnpm=<path> 覆盖 pnpm 可执行文件。
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
val mobileWebDistDir = layout.projectDirectory.dir("../../web/dist-mobile-remote")
val mobileWebAssetsDir = layout.projectDirectory.dir("src/main/assets/remote")
val mobileWebPnpm = providers.gradleProperty("mobileWebPnpm").getOrElse("pnpm")

val buildMobileWeb = tasks.register<Exec>("buildMobileWeb") {
    group = "mobile web"
    description = "Builds the bundled mobile web page via pnpm build:mobile-web."
    workingDir = repoRootDir
    if (System.getProperty("os.name").lowercase().contains("windows")) {
        // Windows 上 pnpm 是 .cmd 批处理，Gradle 的 Exec 需要经 cmd /c 启动。
        commandLine("cmd", "/c", mobileWebPnpm, "build:mobile-web")
    } else {
        commandLine(mobileWebPnpm, "build:mobile-web")
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

val syncMobileWebAssets = tasks.register<Sync>("syncMobileWebAssets") {
    group = "mobile web"
    description = "Syncs the built mobile web page into app/src/main/assets/remote."
    dependsOn(buildMobileWeb)
    from(mobileWebDistDir) {
        // build-mobile-web-release.mjs 已把 Vite 的 mobile.html 规范化为 index.html，并清理 sourcemap；
        // 这里不再重命名，也不保留 mobile.html 副本。release.json 随制品一并同步，M2 再决定 Shell 取舍。
        // 保留 **/*.map 排除作为兜底：即使有人绕过构建脚本，也不把整包源码塞进 APK。
        exclude("**/*.map")
    }
    into(mobileWebAssetsDir)
    doFirst {
        if (!mobileWebDistDir.file("index.html").asFile.isFile) {
            throw GradleException(
                "Mobile web build output is missing: ${mobileWebDistDir.file("index.html").asFile}. " +
                    "Run `pnpm build:mobile-web` or check the buildMobileWeb task output.",
            )
        }
    }
}

tasks.named("preBuild") {
    dependsOn(syncMobileWebAssets)
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
        versionCode = 1
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
