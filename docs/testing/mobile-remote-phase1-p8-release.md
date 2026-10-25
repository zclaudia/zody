# P8 Android release build and package inspection

Date: 2026-10-23

## Result

The earlier Android release variant compiled and packaged as an unsigned inspection APK with the `android.permission.DUMP` manifest protection. A normal signed `assembleRelease` is intentionally blocked because this environment has no Android release signing configuration. The unsigned artifact is not a publishable APK and was not installed on a device.

Historical inspection artifact (predates the latest credential/click fixes; not a current-source validation): `packages/android/app/build/outputs/apk/release/app-release-unsigned.apk` (SHA-256 `77a4a58a1048bb7a51eab5c0b188fc02e7667a5f9836734340823d557406461d`; 24 MiB on disk; 4,032 ZIP entries; built 2026-10-23 17:16 local time). Direct APK inspection confirms that exported `MobileNotificationRenderService` requires `android.permission.DUMP`, `usesCleartextTraffic=false`, and the packaged network security config is referenced. `apkanalyzer manifest print` and `aapt2 dump xmltree` read the manifest from this exact APK. `apksigner verify --print-certs` reports `DOES NOT VERIFY` / missing signature manifest, as expected for this unsigned artifact.

It was assembled with a temporary Gradle init script under `/tmp` that clears only the release variant's signing config, and with `:app:validateZodyReleaseSigning` excluded. No repository signing configuration was changed and no signing secret was read or printed. This is the post-IPC-fix inspection build; it supersedes the earlier unsigned artifact inspected before the Service DUMP gate was added. It remains unsigned and was not installed.

## Checks performed

- `node scripts/check-workspace-freshness.mjs`: baseline fresh; branch was 11 commits ahead and 0 behind `origin/main`.
- `fnm exec --using=24.14.0 pnpm architecture:check --changed`: passed, 0 violations.
- `:app:assembleRelease` with repository configuration: stopped at `validateZodyReleaseSigning`; all four required `ZODY_ANDROID_*` environment variables were absent. The build script reported variable names only.
- `:app:assembleRelease` with temporary unsigned-only init override: passed; retained log `/tmp/zody-release-1792510867/android-release-validation.log`.
- `:app:lintRelease` on that earlier post-IPC-fix release variant: passed, 0 errors and 35 warnings (`packages/android/app/build/reports/lint-results-release.txt`). The earlier report had 36 warnings; that count belongs to the prior build and is superseded. Remaining warnings include target SDK/update guidance, redundant Activity label, and Android Gradle Plugin/Gradle version suggestions; they do not fail the release lint gate.
- `:app:testDebugUnitTest`: passed.
- `apkanalyzer` and Android SDK `aapt2 dump xmltree` inspected that produced APK itself. The release merged manifest at `packages/android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml` also contains the DUMP gate; this is consistent with the artifact-level inspection.

The first combined Gradle invocation named a nonexistent `testReleaseUnitTest` task. The Android module exposes `testDebugUnitTest`; that actual task was run and passed. Release lint is separately available and passed when the signing gate was bypassed solely for inspection.

## Package findings

- Package ID `io.github.zclaudia.zody.mobile`, version `0.1.0` / code `1`, min SDK 24, target SDK 36.
- Permissions in the merged manifest: `INTERNET`, `ACCESS_NETWORK_STATE`, `CAMERA`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, and the generated non-exported dynamic-receiver permission. Camera hardware remains optional.
- `allowBackup=false`; release merged manifest has `usesCleartextTraffic=false` and references the network security config whose packaged XML keeps the base policy false and permits cleartext only for `127.0.0.1`.
- `MobileNotificationRenderService` remains exported for ntfy-bridge and requires `android.permission.DUMP`; the build-time regression check is specified in [notification Service authorization](../../specs/mobile-notification-render-service-authorization.md). An ordinary app UID (10195) was denied before Intent delivery by the Android component permission gate, while the privileged shell ntfy-bridge path passed its real notification, deep-idle, task-click, and read-receipt checks. See [IPC evidence](./evidence/mobile-remote-phase1-p8-ipc.json) and [Doze/permission evidence](./evidence/mobile-remote-phase1-p8-doze-permission.json). That historical unsigned artifact includes the manifest fix, but this APK itself was not installed; only the protected Debug APK was used for device checks.
- WebView settings in the release variant disable file/content access and mixed content. Only the bundled `https://appassets.androidplatform.net/assets/` main-frame URL remains in WebView; other HTTP(S) main-frame navigation goes to the system browser, and other schemes are rejected. The JavaScript interface is therefore exposed to the bundled application page. BuildConfig.DEBUG gates both WebView remote debugging and insecure Gateway transport; the release variant is built with DEBUG false.
- `isMinifyEnabled=false`, so this release currently does not run R8 and the annotated public `ZcodeMobileBridge` methods remain in the DEX. `proguard-rules.pro` has no bridge keep rule. If release minification is enabled later, add an explicit keep rule and verify these methods in the minified APK before shipping.
- No unexpected app receiver is present; AndroidX's exported ProfileInstallReceiver is protected by `android.permission.DUMP`. The app does not request broad storage permissions.
- The APK contains the bundled mobile Web assets and native libraries for arm64-v8a, armeabi-v7a, x86, and x86_64. Build output warns that `libandroidx.graphics.path.so` could not be stripped and is packaged as-is.

## Not established by this check

There is no valid signed release artifact or signer identity to verify, and no release APK was installed or run. Device evidence uses the protected Debug APK and does not establish HTTPS behavior against a production Gateway, OEM behavior, Shizuku deployment, or physical-device delivery. Those remain separate release acceptance evidence.
