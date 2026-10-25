# Mobile remote phase 1 Android evidence

Gateway credential scope narrowing and full revocation separately passed with a real self-hosted ntfy instance ([revocation evidence](./mobile-remote-phase1-p8-revocation.md)). A real two-window Desktop/Gateway search run also passed after fixing disconnected restoration placeholders shadowing the connected owner ([Host isolation](./mobile-remote-phase1-p8-host-isolation.md)). The latest continuation below adds Android revoked-credential and multi-Host notification-click evidence; the full MC matrix remains pending.

## Final continuation — 2026-10-23 (P8 release acceptance remains incomplete)

- Final WDIO A/B/C/D stages passed. The Android process remained alive across a Desktop restart. Fresh A/B/D real OS notification-card clicks reached the exact DOM session/body; network evidence verified workspace identity and `remoteSession`, with read=1 and native pending=null.
- After C credential revocation, task DOM, bridge, read, and subscription counts were all zero while the old card remained pending. After replacing credentials through Android Settings, C routed to the correct Host A and recorded read=1.
- APK SHA-256: `e708716d946bb06a6624e2e1ecc385fd2345e10ec3b21dd09f99b3cf57db58ad`. Durable redacted evidence: [P8 credential-click JSON](./evidence/mobile-remote-phase1-p8-credential-click.json).
- Verification: 8 suites/75 tests; Android 35 JVM tests; Android lint 0 errors/36 warnings; repository typecheck/lint 0 errors/310 warnings and architecture 0 violations. No release or deployment occurred.
- P8 is not a release pass. OEM physical devices, Shizuku, WSL, signed release installation, Android scope-shrink UI, and the complete MC matrix remain pending. The complete remaining notification/search/file/dual-client and environment scope is indexed in the [P8 handoff checklist](./mobile-remote-phase1-cases.md#p8-剩余验收交接2026-10-23-停测后的状态). The unsigned inspection APK SHA-256 `77a4a58a1048bb7a51eab5c0b188fc02e7667a5f9836734340823d557406461d` predates these changes and is historical, not a current-source inspection build.

## Earlier P8 continuation — 2026-10-23

The real CLI/runtime → isolated Gateway → self-hosted ntfy → Android System UI → matching task → exactly one scoped read receipt path passed on the Android 14/API 34 `sdk_gphone64_arm64` emulator. The protected Debug APK SHA-256 was `c772feb78b96da781c8c706a9ac37263c86dd1b100e4386bc146865795fc4e28`. With the KeepAlive service stopped, the app process absent, the emulator unplugged, and no battery exemption, forced deep IDLE was still active at receipt and the independent root ntfy-bridge 0.4.0 delivered the notification. The card click opened the expected task and recorded one read receipt. This was not force-stop. The first deep-IDLE run had a system_server watchdog reset during wake and did not pass the click assertion; the second run passed. See [Doze/permission evidence](./evidence/mobile-remote-phase1-p8-doze-permission.json).

On that protected APK, revoking `POST_NOTIFICATIONS` yielded zero system task cards even though Gateway accepted delivery and the render service ran; restoring it yielded one card. A separate targetSdk 35, zero-permission probe running as ordinary app UID 10195 verified the service's declared `android.permission.DUMP` gate and recorded `DENIED_ANDROID_PERMISSION_DUMP` after a matching `SecurityException`. The privileged shell/root bridge positive path is covered by the Doze evidence. See [IPC evidence](./evidence/mobile-remote-phase1-p8-ipc.json).

The standard signed `assembleRelease` remains blocked because the four `ZODY_ANDROID_*` signing variables are absent. At the time of that earlier inspection, unsigned APK SHA-256 `77a4a58a1048bb7a51eab5c0b188fc02e7667a5f9836734340823d557406461d` included the `android.permission.DUMP` manifest protection; direct APK inspection confirmed it. This unsigned APK was not publishable or installed and predates the latest changes, so it is historical rather than a current-source inspection build. Do not treat unsigned artifacts or the tested Debug APK as a signed release install. See [release build inspection](./mobile-remote-phase1-p8-release.md).

The real APK Downloads UI passed all three MF08 cases: Chinese/spaced binary and exact 16 MiB saves with byte/hash checks and precise cleanup, plus 16 MiB+1 rejection with the exact error toast, Save button recovery, and no Downloads artifact. The final result supersedes the earlier fixed-delay check and pre-save screenshot: [MF08 evidence](./mobile-remote-phase1-p8-downloads.md). Original Android preferences were restored and byte-verified after the run; the case-owned daemon, subscription data and ADB forwards were removed.

The earlier Downloads/native verification Debug APK SHA-256 was `6ed904aeedc3b2051b838bb638f12d3df00060d43d9ba0f788c888b74835dd0b`; its 34 JVM tests across 11 suites passed. The later protected Debug APK used for Doze/IPC is `c772feb78b96da781c8c706a9ac37263c86dd1b100e4386bc146865795fc4e28`. Doze and OS notification permission behavior are now verified on the API34 emulator, but OEM physical devices, Shizuku, signed release installation, and the remaining scope-shrink/same-identity owner/device matrix remain unverified. Whole-credential revocation/replacement and different-identity multi-Host clicks passed later, as recorded above. Earlier records below describe their narrower evidence.

## Earlier automated verification

- `fnm exec --using=24.14.0 ./gradlew :app:assembleDebug :app:testDebugUnitTest` passed from `packages/android` on 2026-10-23. The build ran `buildMobileWeb` and `syncMobileWebAssets`; neither task was skipped. Gradle reports 46 actionable tasks (22 executed, 24 up to date).
- Android unit tests: 30 tests across 9 suites, 0 failures, 0 skipped. The notification seen-ID tests cover duplicate IDs, 30-day expiry, and bounded capacity.
- Test-kind notifications build their PendingIntent without an `ACTION_VIEW` action or notification deep-link URI, so they do not enqueue a pending notification click.
- Mobile notification service tests passed: 14 tests across the public reader contract suite and two SQLite adapter suites, including quiet-period pruning triggered by feed and click-reference reads.
- The `packages/services/src/mobile-notifications` TypeScript directory was formatted with Oxfmt.

## Emulator evidence

A previous manual run on the available API 34 emulator used a temporary HTTP upstream and an independent ntfy bridge. With Zody sent to the background and its process killed using `am kill` (not force-stop), the bridge rendered a generic Android notification. This establishes the tested background process-reclaim path for that setup.

Separate synthetic receiver tests on API 34 verified the actual Android system notification card:

- Cold click opened MainActivity and persisted the expected opaque notification reference.
- After HOME → ordinary `am kill`, redelivery of the same ID logged `ignored duplicate notification ID` and did not recreate the card.
- A warm retest started with a clean notification tray and one `question` notification. The Activity PID stayed 16698 before/after clicking the card; the expected pending reference was observed on the second bounded poll. This proves the warm native intent handoff, not navigation to a Gateway task.
- Initial grouped-card taps launched the application via MAIN/LAUNCHER and did not consume the content intent; those attempts are not counted as warm-click success. The later single-card check passed without a code change.
- Only generated test pending/seen entries were removed after confirming the app process was absent. Final checks found no app notification records or test references; other preferences and subscriptions were not modified.

Evidence logs: `/tmp/zody-native-notification-check.txt`, `/tmp/zody-native-root-warm-result.txt`; the latter is the final warm-click result. These device checks injected receiver payloads with `am start-foreground-service`; they do not prove the complete Gateway → self-hosted ntfy → Android → authenticated task route. During the initial subagent setup, one `am force-stop` was mistakenly used; it is explicitly excluded from ordinary process-reclaim evidence. Subsequent process-reclaim checks used HOME → `am kill`, and normal Activity launch cleared the stopped state. Final warm-test cleanup found the WebView-bound app still alive after `am kill`; only that test process was terminated with `run-as` + SIGTERM before removing its generated preference keys. That cleanup is not counted as process-reclaim verification.

## Remaining device coverage

OEM-specific background restrictions, Downloads/file scenarios beyond MF08, and the production ntfy plus Gateway deployment remain untested. A deep-IDLE test on one API34 emulator does not establish behavior on OEM physical devices or ordinary unprivileged daemons during Doze; the tested bridge was an independent root daemon using shell delivery. Shizuku deployment, force-stop guarantees, and signed release installation were not tested. The initial Doze attempt's watchdog reset is retained in the evidence JSON and excluded from the successful click result.
