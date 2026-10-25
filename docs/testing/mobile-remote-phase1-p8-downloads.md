# P8 MF08 Android Downloads验收

本文记录 MF08 的真实 APK UI 与 Android Downloads 验收。它补充
[第一批场景目录](./mobile-remote-phase1-cases.md)；不把组件夹具、JVM 测试或 instrumented writer 测试当作真实 UI 证据。

## Case-owned workspace

由 `packages/desktop/test/e2e/mobile-remote/manual-review/pending/prepare-mobile-download-fixture.mjs`
确定性生成文件到 `.tmp/mobile-remote-p8-push/desktop-home/ZodyProject/MF08-fixtures/`。这是 Gateway 所服务的 case-owned workspace 内独立目录，与 harness 的 state/temp 分开：

| 文件                               |     字节数 | SHA-256                                                            | 预期                             |
| ---------------------------------- | ---------: | ------------------------------------------------------------------ | -------------------------------- |
| `MF08-中文 文件名.bin`             |  1,048,749 | `fb3111f10b8bd9187acb8b23fd5f85c654d5a774f07079d177b5813aed3b9767` | 保存成功、名字与字节一致         |
| `MF08-limit-16MiB.bin`             | 16,777,216 | `3083cb6db4b9c8a7f5af84e81a900bef0f8b9547d9896d069e994afb49d572cf` | 上限精确可保存                   |
| `MF08-over-limit-16MiB-plus-1.bin` | 16,777,217 | `e46f7cdce1d3b5701fce97e865f3b5026c90ea9d4430a906721b6618c555df96` | 保存拒绝，Downloads 不出现该文件 |

fixture generator also writes `manifest.json` with paths, sizes, hashes and expected outcomes. It does not access Android or Downloads.

## Real APK UI run

需要已启动并连接该 workspace 的 isolated Gateway/Electron Host、API 29+ Android emulator/device，以及 debug APK 的 WebView debugging。先在 APK 中打开目标 fixture 的只读预览，然后针对每个文件运行：

```bash
node packages/desktop/test/e2e/mobile-remote/manual-review/pending/run-mobile-download-mf08.mjs 'MF08-中文 文件名.bin' --device emulator-5554
node packages/desktop/test/e2e/mobile-remote/manual-review/pending/run-mobile-download-mf08.mjs 'MF08-limit-16MiB.bin' --device emulator-5554
node packages/desktop/test/e2e/mobile-remote/manual-review/pending/run-mobile-download-mf08.mjs 'MF08-over-limit-16MiB-plus-1.bin' --device emulator-5554
```

Runner attaches to the running APK WebView through Playwright's Android `webView` API and clicks the actual `Save original` button. For positive saves it waits for MediaStore `IS_PENDING=0`, reads the committed file through `adb exec-out` as bytes, compares byte count and SHA-256 to the case manifest, and removes only the MediaStore row created by that invocation. It refuses to overwrite a pre-existing same-name Downloads item and verifies cleanup. For an over-limit file, the runner waits for the actual `File exceeds the 16 MiB mobile save limit.` toast, waits for the Save button to become enabled again, then asserts that Downloads has no matching row and captures the rejection state.

Run each filename from a clean case state. Record each runner JSON result with the APK version, Android API/device, connected workspace path, Gateway/Host process lifetime, and screen evidence showing the mobile file preview/save action. Do not leave `MF08-*` artifacts in Downloads or the workspace after the case is complete; the Downloads rows created by the runner are removed automatically, while the workspace fixture can be removed by deleting only `.tmp/mobile-remote-p8-push/desktop-home/ZodyProject/MF08-fixtures/`.

## Android failure cleanup fix

Inspection found one implementation gap in the already documented MF08 contract: stream flush/close errors were swallowed, MediaStore commit results were not checked, and an exception while opening a just-inserted MediaStore stream could leave an `IS_PENDING` row behind. `DownloadsFileWriter` now propagates close/commit errors, attempts to delete the row on finish failure, and deletes the inserted row when opening the output stream fails. Legacy FileProvider saves similarly delete partial files when finalization fails. JVM regression tests exercise flush/close failures and abort idempotency.

## Evidence status

All three real APK UI cases passed on 2026-10-23 against the root-installed APK (SHA-256 `6ed904aeedc3b2051b838bb638f12d3df00060d43d9ba0f788c888b74835dd0b`) on `emulator-5554`, Android API 34. The two positive cases ran while the initial isolated Gateway/Electron Host served the fixture workspace. The final over-limit case ran after a new isolated Gateway/Host served a local case-owned `ZodyProject`; the APK opened every fixture through Files and Save original was clicked. The credentials-free persistent record is [MF08 evidence JSON](./evidence/mobile-remote-phase1-mf08-downloads.json).

| File                               | UI result                                                          | MediaStore result                                                                            | Evidence                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MF08-中文 文件名.bin`             | Saved                                                              | 1,048,749 bytes; SHA-256 `fb3111f10b8bd9187acb8b23fd5f85c654d5a774f07079d177b5813aed3b9767`  | [preview screenshot](../../.tmp/mobile-remote-p8-push/artifacts/mf08/MF08-中文%20文件名.bin.png)                                                                                                       |
| `MF08-limit-16MiB.bin`             | Saved at the exact limit                                           | 16,777,216 bytes; SHA-256 `3083cb6db4b9c8a7f5af84e81a900bef0f8b9547d9896d069e994afb49d572cf` | [preview screenshot](../../.tmp/mobile-remote-p8-push/artifacts/mf08/MF08-limit-16MiB.bin.png)                                                                                                         |
| `MF08-over-limit-16MiB-plus-1.bin` | Rejected; exact limit-error toast shown and Save button re-enabled | No matching Downloads row; runner exited 0                                                   | [post-rejection screenshot](../../.tmp/mobile-remote-p8-push/artifacts/mf08/MF08-over-limit-16MiB-plus-1.bin.png); [runner output](../../.tmp/mobile-remote-p8-android/download-overlimit-result.json) |

The two positive runs reported their MediaStore URIs and the runner removed only those exact IDs using shell UID 2000; post-cleanup queries confirmed the rows were absent. The first successful Chinese-file run exposed that root UID 0 cannot issue provider deletion and the app UID lacks external-provider permission; shell UID 2000 successfully queried and deleted the exact owned URI. One early 16 MiB read through Playwright's Android shell did not yield usable evidence, so the runner now reads raw bytes through asynchronous `adb exec-out` and hashes the result before cleanup. The final 16 MiB run completed with the manifest hash. The earlier over-limit fixed-delay check and pre-save screenshot were insufficient; the final rerun supersedes them by asserting the exact error toast, waiting for Save to re-enable, and confirming no matching Downloads row. The runner exited 0. No `MF08-*` Downloads rows remain.

The positive-run screenshots were captured before saving and show the selected binary preview and save action. The over-limit screenshot was replaced by the final post-rejection capture showing the verified toast state. Fixture and runner preparation completed on 2026-10-23. Android JVM tests also pass, including the close/flush cleanup regressions; they are supplementary to this APK/UI evidence.
