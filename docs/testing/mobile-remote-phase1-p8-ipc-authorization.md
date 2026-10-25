# P8 notification Service IPC authorization

Date: 2026-10-23

The `MobileNotificationRenderService` previously accepted explicit starts from any app UID. The fix preserves the separately installed ntfy-bridge integration while adding `android.permission.DUMP` to the exported Service. A build-time Gradle task validates that the Service remains exported and retains exactly this permission; `preBuild` depends on the check for every Android variant. The decision and caller/permission contract are recorded in [the dedicated spec](../../specs/mobile-notification-render-service-authorization.md).

The compatibility check used the ntfy-bridge source at `/Users/zhvala/SourceCode/ntfy-bridge/sse.go`: it runs `am start-foreground-service` using `su 2000 -c` first and falls back to its daemon UID (root). AOSP Android 14's Shell manifest requests `DUMP`, platform permission configuration assigns it to shell UID, and the ActivityManager component permission check permits root UID. The root task separately confirmed `com.android.shell` has `DUMP` on its emulator. Android's [Service manifest contract](https://developer.android.com/guide/topics/manifest/service-element) states that callers without the Service's declared permission cannot start it and their Intent is not delivered.

## Build and package evidence

- `:app:verifyNotificationRenderServicePermission`: passed directly.
- `:app:assembleDebug`, `:app:assembleRelease`, `:app:testDebugUnitTest`, `:app:lintDebug`, and `:app:lintRelease`: passed together. The release task used a temporary `/tmp` Gradle init override to clear release signing for inspection and excluded only `:app:validateZodyReleaseSigning`; the repository signing configuration remained untouched. No signing secrets were read.
- Debug lint: 0 errors, 36 warnings. Release lint: 0 errors, 35 warnings.
- `apkanalyzer manifest print` confirmed both merged manifests retain `exported=true` and `permission="android.permission.DUMP"`.
- `BuildConfig.DEBUG` is true in Debug and false in Release. This permission change does not change the existing debug/release transport boundary.

## Device evidence (Android 14 / API 34)

The ordinary-app negative and the privileged receiver path both passed on the emulator, using the protected Debug APK with SHA-256 `c772feb78b96da781c8c706a9ac37263c86dd1b100e4386bc146865795fc4e28`:

- The v3 probe ran under app UID `10195`, target SDK 35, with zero declared permissions. It resolved the explicit service through its package visibility query and confirmed `ServiceInfo.permission` was exactly `android.permission.DUMP`. At `2026-10-23 17:35:49.112`, `startForegroundService` threw a `SecurityException` whose message contained that permission; the probe recorded `DENIED_ANDROID_PERMISSION_DUMP`. This is the expected Android component gate result.
- The earlier v2 probe's `START_ACCEPTED` is excluded. It lacked package visibility and did not check a null `ComponentName`; the call had not established that the target Service started.
- Separately installed root ntfy-bridge shell delivery remained authorized. With the Zody process absent and device deep-idle active, the real runtime → Gateway → ntfy path produced a system notification; tapping it opened the correct task and recorded exactly one read receipt.
- Revoking Android notification permission produced zero system task cards while Gateway accepted the push and the receiver Service ran. Restoring permission returned native status to ready and the next test push produced one card.
- Cleanup restored all four original preference files byte-for-byte, restored notification permission, returned Doze to active, reset battery state, removed the owned daemon, uninstalled the probe, and removed temporary credentials.

Persistent machine-readable evidence: [IPC authorization](./evidence/mobile-remote-phase1-p8-ipc.json) and [Doze / permission recovery](./evidence/mobile-remote-phase1-p8-doze-permission.json). The Doze evidence does not cover OEM devices, ordinary unprivileged daemon networking during Doze, Shizuku deployment, force-stop delivery, or installation of a signed release APK.

| Artifact                                                                  |   Size | SHA-256                                                                                                                                           |
| ------------------------------------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/android/app/build/outputs/apk/debug/app-debug.apk`              | 30 MiB | `c772feb78b96da781c8c706a9ac37263c86dd1b100e4386bc146865795fc4e28`                                                                                |
| `packages/android/app/build/outputs/apk/release/app-release-unsigned.apk` | 24 MiB | `77a4a58a1048bb7a51eab5c0b188fc02e7667a5f9836734340823d557406461d` (current post-fix inspection APK; manifest contains `android.permission.DUMP`) |

The current release APK is unsigned and inspection-only; it was not installed. It includes the DUMP manifest protection confirmed by direct APK inspection, but the protected Debug APK alone was installed and exercised in the device checks above. This unsigned release artifact does not establish signed-release installation or signer identity.
