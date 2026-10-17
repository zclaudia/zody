import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.Sync

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// 手机页面改为随 APK 内置：Gradle 构建时先跑根目录的 pnpm build:mobile-web，
// 再把产物同步到 app/src/main/assets/remote/（WebViewAssetLoader 只服务这个目录）。
// 生成目录已在 .gitignore 中排除；可用 -PmobileWebPnpm=<path> 覆盖 pnpm 可执行文件。
val repoRootDir: File = rootProject.projectDir.parentFile.parentFile
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

val syncMobileWebAssets = tasks.register<Sync>("syncMobileWebAssets") {
    group = "mobile web"
    description = "Syncs the built mobile web page into app/src/main/assets/remote."
    dependsOn(buildMobileWeb)
    from(mobileWebDistDir) {
        // Vite 的 HTML 产物名跟随源文件名（mobile.html）；壳按方案约定加载 index.html。
        rename("mobile.html", "index.html")
        // 手机构建用 hidden sourcemap：保留在 dist 里供本地调试，但不把整包源码塞进 APK。
        exclude("**/*.map")
    }
    into(mobileWebAssetsDir)
    doFirst {
        if (!mobileWebDistDir.file("mobile.html").asFile.isFile) {
            throw GradleException(
                "Mobile web build output is missing: ${mobileWebDistDir.file("mobile.html").asFile}. " +
                    "Run `pnpm build:mobile-web` or check the buildMobileWeb task output.",
            )
        }
    }
}

tasks.named("preBuild") {
    dependsOn(syncMobileWebAssets)
}

android {
    namespace = "com.example.zcode_mobile"
    buildToolsVersion = "36.1.0"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.example.zcode_mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }

    buildTypes {
        debug {
            // 真机连本地 gateway 时允许 http（浏览器开发模式）；release 仍只允许 https。
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
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
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
