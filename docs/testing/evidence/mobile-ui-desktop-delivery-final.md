# 移动端主 UI 随桌面交付：M4-T5 最终发布验证与交接

日期：2026-11-04

分支：`feat/mobile-ui-desktop-delivery`

最终验证范围：`git diff main...HEAD`（M1–M3、M4-T1/T2/T3）加上工作区中已完成的 M4-T4 清理改动。M4-T5 本身只新增本证据文件，不修改产品代码或测试。

本记录只描述实际执行的命令、真实输出和可复现证据。未执行或环境不支持的项目单独列为“未验证”，不推断通过。

## 1. 环境与边界

| 项目          | 事实                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 主机          | macOS arm64（Darwin 25.6.0）                                                                                                 |
| Node          | 所有命令通过 `fnm exec --using=24.14.0` 使用 `v24.14.0`，与 `mise.toml` 一致；系统默认 `v22.23.2`，`mise` 不可用             |
| pnpm          | `10.33.2`                                                                                                                    |
| Android       | `emulator-5582`，AVD `zoom_chat_magisk_api34`（model `sdk_gphone64_arm64`），Android 14（API 34），arm64-v8a                 |
| WebView       | Chrome/113.0.5672.136，`adb forward tcp:9222` + CDP                                                                          |
| Gateway       | 复用现有本地共享实例，`/health` 返回 200；未重启、未改写配置；本文件不记录地址、凭证或管理令牌                               |
| 凭证          | 复用主检出既有 device/backend 凭证；未临时签发新凭证；未在输出、证据或提交中写入凭证                                         |
| 桌面 provider | 真实 `RemoteGatewayBackend` + `MobileUiAssetProvider`（`scripts/mobile-m2-t6/desktop-provider-harness.mjs`）                 |
| APK           | `versionCode=2`、`versionName=0.1.0`、Debug 签名；SHA-256 `92dec9a1ffd4afc5849c4ce73585442bfb3e7bdf771de1f7ab3cb058c68276e2` |
| Release 夹具  | `/tmp/zody-m3-releases`（`prepare-release-fixtures.mjs` 生成 A/B/incompatible/invalid）                                      |

`emulator -list-avds` 同时列出 `zoom_chat_magisk_api34` 与 `hermes_api34`；当前连接的 `emulator-5582` 就是 M3 证据使用的 `zoom_chat_magisk_api34`（`ro.boot.qemu.avd_name`），无需另起 AVD。`ro.product.model` 显示为 `sdk_gphone64_arm64` 是系统镜像型号，不是 AVD 名。

## 2. 最终修改清单

### 2.1 已提交（`git log --oneline main..HEAD`，共 45 个提交）

移动 UI 交付功能相关提交覆盖：

- M1：shared release/bridge 契约、Remote release 确定性构建、桌面 `MobileUiAssetProvider`、`serveHttp` 生命周期、桌面打包装配。
- M2：Shell/Remote 双入口、双 bridge、`MobileShellController`、`RemoteUiProxy`、generation/sessionId、进程内缓存、破坏性重配对。
- M3：`MobileUiReleaseController`、刷新 guard 注册、原生 `prepareReload` veto、replayable 恢复。
- M4-T1/T2/T3：文件能力、通知深链、桌面 continuous 与手机 replayable 回归。
- 分支中还包含 7 个 `upstream-v3.17.1: F01–F07` 提交（rpc/server/services/zcode-server-cli 等）；它们不属于本计划，本任务只由 `typecheck`/`lint` 全局覆盖，不纳入移动 UI 验收结论。

### 2.2 工作区中的 M4-T4 清理（未提交）

| 文件                                                                            | 变化                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/web/src/mobile-remote/mobileRemoteSecureStore.ts`                     | 删除旧 `ZcodeMobileBridge` secureStore 发现与原生降级；生产只保留 fail-closed 实现 |
| `packages/web/src/mobile-remote/mobileRemoteNativeHost.ts`                      | 删除带 `sessionId` 首参的旧事件格式兼容分支，只接受单参宿主事件                    |
| `packages/web/test/mobileRemoteSecureStore.test.ts`                             | 同步删除旧桥测试，保留开发 localStorage 与 fail-closed 断言                        |
| `packages/web/test/mobileRemoteNativeHost.test.ts`                              | 同步单参事件断言                                                                   |
| `packages/android/app/build.gradle.kts`                                         | 删除 `-PmobileWebPnpm` 旧参数兼容，只保留 `-PmobileShellPnpm`                      |
| `scripts/dev-mobile-remote.mjs`                                                 | 开发入口改为 `mobile-shell.html`                                                   |
| `docs/mobile-remote-control-android.md`、`docs/web-remote-control/*`、`specs/*` | 同步轻 Shell、双 origin、versionCode 2、CORS、桌面离线限制与发布规则               |

未修改的无关工作区改动：`.gitignore`、`config/provider/zcode-builtin*.json`、`docs/fork/upstream-review-ledger.md`、`docs/plans/zody-full-divergence-rename-survey.md`、`packages/provider-node/test/*`、`packages/ui/test/providerTemplatePicker.test.ts`、未跟踪的上游计划文件。

### 2.3 M4-T5 后续驱动修复（工作区，未提交）

M4-T5 首轮报告后，按用户批准只修改测试驱动与本证据文件，不修改产品代码或产品测试：

| 文件                                               | 修复                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `scripts/mobile-m4-t2/run-e2e.mjs:99`              | 新增 `waitForPending`：150ms 间隔、最多 10s 轮询 pending 槽，替代固定 1200ms sleep           |
| `scripts/mobile-m4-t2/run-e2e.mjs:244/280/294/315` | 动作、点击、冷启动 pending 读取全部改为轮询；非法 intent 保留 500ms 稳定窗口                 |
| `scripts/mobile-m4-t2/run-e2e.mjs:168`             | 通知卡片 `reveal` 从 5 次增至 12 次有界重试，修复一次通知栏未及时出现的 flake                |
| `scripts/mobile-m2-t6/run-e2e.mjs:78`              | `record` 改为 `{ ...details, status }`，业务 `status` 不再覆盖 pass/fail                     |
| `scripts/mobile-m2-t6/run-e2e.mjs:466/484`         | 通知 envelope 字段改名 `bridgeStatus`，避免与场景状态冲突                                    |
| `scripts/mobile-m2-t6/run-e2e.mjs:174`、`:709`     | `returnShellIfRemote` 每轮重取可见 target/session 并重试；旋转回正后等待新 target            |
| `scripts/mobile-m3-t5/run-e2e.mjs:263/286`         | 新增阻塞 dialog 关闭与场景级 `resetScenarioState`：前台、关 dialog、恢复 A/release、回 Shell |
| `scripts/mobile-m3-t5/run-e2e.mjs:1039`            | `background-no-refresh` 在 finally 中恢复前台并等待 Remote 可见，避免级联失败                |
| `scripts/mobile-m3-t5/run-e2e.mjs:628`             | 设置导航优先 TaskHome 触发器、支持直接进入 Settings section、超时输出 DOM 诊断               |
| `scripts/mobile-m3-t5/run-e2e.mjs:219`             | `returnShellIfRemote` 同样按可见 target/session 重试                                         |

## 3. 工程门禁与 focused 测试（真实结果）

| 命令                                                                                    | 真实结果                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run`（shared 3、ui 1、web 24、desktop 9 = 36 个移动 UI focused 文件） | exit 0；**36 files / 466 tests passed**                                                                                                                          |
| `pnpm test:mobile-web-release`                                                          | exit 0；**13 tests passed / 0 failed**                                                                                                                           |
| `packages/android/gradlew -p packages/android :app:testDebugUnitTest --rerun`           | exit 0；`BUILD SUCCESSFUL`；**24 XML / 165 tests，0 failures / 0 errors / 0 skipped**                                                                            |
| `pnpm typecheck`                                                                        | exit 0                                                                                                                                                           |
| `pnpm lint`（驱动修复后再次执行）                                                       | exit 0；**0 errors / 312 warnings**；未发现本分支新增错误                                                                                                        |
| `pnpm exec oxfmt --check`（三个修复驱动 + 本报告）                                      | exit 0；`All matched files use the correct format`                                                                                                               |
| `pnpm architecture:check --changed`                                                     | exit 0；`architecture: OK`；violations 0、baseline 0、new 0                                                                                                      |
| `pnpm fmt:check`                                                                        | exit 2；仅 `docs/electron/docs/fiddles/**` 4 个既有 HTML 语法错误；移动 UI 文件不在失败项中                                                                      |
| `pnpm knip`                                                                             | exit 1；3138 unused files、1121 unused exports、1094 unused exported types、48 unused deps 等既有规模；本分支新增内部使用导出也在列表中，但无旧路径/旧桥残留证据 |
| `pnpm --filter @zcode/web build` + `pnpm check:mobile-web-isolation`                    | exit 0；普通 Web 4723 个代码文件命中 0 处 gateway-client；Remote 入口存在                                                                                        |

## 4. 构建与制品检查

### 4.1 Remote 与 Shell 制品

| 命令                           | 真实结果                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build:mobile-web`        | exit 0；`releaseId=15e1b92e1ec4cdcbafe8f44b`、`desktopVersion=0.1.0`、`assetDigest=c8efc375806d1280b85af41c199e4b81666209e8dc0d0712baf1e44c136df3ba`；0 个 `.map`；`release.json` 与 HTML meta 一致 |
| 第二次 `pnpm build:mobile-web` | exit 0；releaseId、desktopVersion、assetDigest 与第一次完全相同，确认确定性构建                                                                                                                     |
| `pnpm build:mobile-shell`      | exit 0；`dist-mobile-shell` 仅 4 个文件（`index.html`、1 个 JS、1 个 CSS、`THIRD-PARTY-NOTICES.md`），无 `.map`、PDF.js 或 Remote 工作台标记                                                        |

- Remote 制品：`packages/web/dist-mobile-remote`，3887 个文件，`index.html`/`release.json` 齐全，`supportedBridgeVersions=[1]`，入口 `/assets/remote/index.html`。
- Shell 制品：`packages/web/dist-mobile-shell`，固定入口 `index.html`。

### 4.2 Android APK

| 检查                      | 真实结果                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `:app:assembleDebug`      | exit 0；`BUILD SUCCESSFUL`                                                                   |
| 制品                      | `packages/android/app/build/outputs/apk/debug/app-debug.apk`，14,332,849 字节                |
| APK 内容                  | `assets/shell/` 4 个文件；`assets/remote/` 0 个；`.map` 0 个；无 `mobile.html`/PDF.js 工作台 |
| applicationId             | `io.github.zclaudia.zody.mobile`                                                             |
| versionCode / versionName | `2` / `0.1.0`（大于旧版 1）                                                                  |
| `:app:assembleRelease`    | exit 1，`validateZodyReleaseSigning` 明确报缺少四个签名环境变量；**fail closed 符合预期**    |

### 4.3 桌面 macOS 制品

| 检查                                                                       | 真实结果                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @zcode/desktop build:no-runtime-assets`                     | exit 0，包含 `build:mobile-web` 前置步骤                                                                |
| `electron-builder --config electron-builder.config.js --mac --arm64 --dir` | exit 0（未签名，`CSC_IDENTITY_AUTO_DISCOVERY=false`）                                                   |
| 制品                                                                       | `packages/desktop/dist/mac-arm64/Zody Preview.app`                                                      |
| `Resources/mobile-web`                                                     | 存在；3888 个文件；`index.html`、`release.json` 齐全；`releaseId=15e1b92e1ec4cdcbafe8f44b`；0 个 `.map` |
| HTML meta                                                                  | `zody-mobile-ui-release=15e1b92e1ec4cdcbafe8f44b`，与 manifest 一致                                     |
| 签名                                                                       | 仅 ad-hoc/linker-signed，未做 Developer ID 签名或 notarization                                          |

注：直接执行 `electron-builder --dir`（不带 `--config`）会因 `packages/desktop/package.json` 无 `version` 而失败；正确入口是 `pnpm --filter @zcode/desktop run bundle` 或显式 `--config electron-builder.config.js`。

## 5. 真实 Gateway + Android WebView E2E

所有 E2E 均使用真实 Gateway、真实 Android WebView、真实 `RemoteGatewayBackend`/`MobileUiAssetProvider`。桌面 Host 业务面由 harness 的最小 `zcode-remote` hello/bootstrap 响应器提供，不包含完整 workspace bridge。

### 5.1 M4-T1 文件能力（`scripts/mobile-m4-t1/run-e2e.mjs`）

命令：

```bash
ZODY_E2E_ANDROID_SERIAL=emulator-5582 ZODY_E2E_NAMESPACE=zcode \
ZODY_E2E_PUBLIC_GATEWAY_URL=<本地 Gateway 的模拟器地址> \
  node --env-file=.env.gateway.local scripts/mobile-m4-t1/run-e2e.mjs
```

结果：**exit 0，7/7 场景 pass**。

| 场景                      | 结果 | 关键真实断言                                                               |
| ------------------------- | ---- | -------------------------------------------------------------------------- |
| `file-selection`          | pass | 系统选择器打开时 `prepareReload` 返回 `native-busy`；取消/选择后回 `ready` |
| `photo-capture`           | pass | 真实拍照完成并回到 Remote                                                  |
| `chunked-save-and-open`   | pass | 分块保存、落盘、打开文件                                                   |
| `save-failure-and-cancel` | pass | 保存失败与取消路径                                                         |
| `webview-download`        | pass | WebView 下载链路                                                           |
| `csp-source-origins`      | pass | Remote origin CSP 与允许来源                                               |
| `stale-session-switch`    | pass | 切换后旧 session 保存/打开被拒；无孤儿保存行                               |

### 5.2 M4-T2 通知深链与动作（`scripts/mobile-m4-t2/run-e2e.mjs`）

修复前：驱动在点击通知按钮后固定 `sleep(1200)` 再读 SharedPreferences，本机实测 `apply()` 首次可见为 **1.0–1.25s**，连续 3 次报 `system action did not persist expected pending action: null`。

修复后（`waitForPending` 轮询 + `reveal` 12 次有界重试）运行记录：

| 运行 | exit | 结果                                                                                          |
| ---- | ---- | --------------------------------------------------------------------------------------------- |
| run1 | 1    | 通知栏发现阶段一次 flake（`notification UI text not found: Allow once`），未进入 pending 断言 |
| run2 | 0    | **4/4 pass**                                                                                  |
| run3 | 0    | **4/4 pass**                                                                                  |
| run4 | 0    | **4/4 pass**                                                                                  |
| run5 | 0    | **4/4 pass**（扩大 `reveal` 重试后）                                                          |
| run6 | 0    | **4/4 pass**（扩大 `reveal` 重试后）                                                          |

最终以 run5/run6 两次连续通过为准。

| 场景                               | 结果 | 真实断言                                           |
| ---------------------------------- | ---- | -------------------------------------------------- |
| `real-system-card-action`          | pass | 系统通知按钮动作写入独立 pending action 槽         |
| `real-system-card-click`           | pass | 点击系统卡片写入 pending click，且不覆盖 action 槽 |
| `cold-start-pending-without-ack`   | pass | 冷启动后 Remote 未 ready 时 pending 保留、不被 ack |
| `invalid-intent-preserves-pending` | pass | 非法/超长/缺参 intent 不覆盖已有 pending           |

未覆盖：Remote ready 后按正确 backend 派发到目标页面、跨 backend 返回 Shell、Web 队列 at-most-once 的端到端执行；这些由 focused 测试覆盖，且 harness 无法独立占用第二个 backend identity。

### 5.3 M3 发布升级/回滚与安全刷新（`scripts/mobile-m3-t5/run-e2e.mjs`）

修复前：完整运行 4 pass / 5 fail；`background-no-refresh` 失败后应用停留后台，后续场景级联超时；另有未确认通知失败留下的 `<dialog>` 覆盖页面点击目标（`elementFromPoint` 命中 DIALOG）。

修复后连续两次完整运行：

| 运行 | exit | 结果         |
| ---- | ---- | ------------ |
| run1 | 0    | **9/9 pass** |
| run2 | 0    | **9/9 pass** |

| 场景                                     | run1 | run2 |
| ---------------------------------------- | ---- | ---- |
| `release-upgrade-throttle-rollback`      | pass | pass |
| `failure-keeps-document`                 | pass | pass |
| `bridge-incompatible`                    | pass | pass |
| `background-no-refresh`                  | pass | pass |
| `guard-active-overlay`                   | pass | pass |
| `guard-unsaved-settings`                 | pass | pass |
| `native-busy-guards`                     | pass | pass |
| `native-notification-permission-veto`    | pass | pass |
| `activity-recreate-not-permanently-busy` | pass | pass |

修复点：

- `runBackgroundNoRefresh` 在 finally 中恢复前台、复位 A/release 并等待 Remote 可见，消除后台失败级联。
- `resetScenarioState()` 在场景间显式关闭页面 dialog、恢复前台和 Shell。
- `returnShellIfRemote()` 每轮重取可见 target/session，避免 Activity 重建后的 stale-session 超时。
- 设置入口兼容 TaskHome 下拉和直接 Settings section，并在超时时输出 DOM 诊断。

`background-no-refresh` 若再次出现“后台多一次 release 请求”，对照 spec 第 9.3 节：spec 禁止的是后台自动刷新/请求风暴；一次在途请求或 visibilitychange 竞态不构成产品缺陷。本轮修复后未再复现。

### 5.4 M2 冷启动/切换回归（`scripts/mobile-m2-t6/run-e2e.mjs`）

修复后完整运行两次：

| 运行 | exit | 结果         |
| ---- | ---- | ------------ |
| run1 | 0    | **8/8 pass** |
| run2 | 0    | **8/8 pass** |

| 场景                         | 结果 | 说明                                                                                    |
| ---------------------------- | ---- | --------------------------------------------------------------------------------------- |
| `device-bootstrap`           | pass | Shell 读取配置、discovery、openRemote、session context、hello/bootstrap                 |
| `contracts`                  | pass | RemoteUiProxy GET/HEAD、CSP、405 Allow、旧 hash/穿越/API 404、无凭证泄漏、stale session |
| `file-notification-contract` | pass | begin/append/finish、保存内容匹配、pending click/action、bridgeStatus 均 ok             |
| `reopen-session-rotation`    | pass | sessionId 轮换、clientInstanceId 复用                                                   |
| `old-desktop-shell`          | pass | 无 UI capability 时停留 Shell 并提示升级桌面                                            |
| `offline-desktop-shell`      | pass | 桌面离线回 Shell，保留配置/重试                                                         |
| `notification-ready-gate`    | pass | ready 前 0 次派发，ready 后 1 次                                                        |
| `activity-recreate`          | pass | 旋转后重新获取当前 target，session 轮换、clientInstanceId 稳定、回 Shell 成功           |

## 6. 集成检查清单逐项结论

| 检查项                   | 结论与证据                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 越权状态所有者           | 未发现。`MobileShellController` 只持有 source/generation/session（`packages/android/.../MobileShellController.kt` 的 `start`/`openRemoteFromShell`/`intercept`）；配置唯一持久所有者是 `MobileShellConfigStore`；provider 只读静态文件；Main 只装配 provider 和 backend。 |
| 长期双栈                 | 未发现。旧 `ZcodeMobileBridge.kt` 与其测试已删除；Gradle 只同步 Shell，并在 `preBuild` 执行 `clearLegacyRemoteAssets`；APK 实测 `assets/remote/` 为 0。                                                                                                                   |
| 旧兼容分支残留           | 工作区 M4-T4 已删除旧事件 `sessionId` 首参格式和旧 secureStore 桥发现；`MobileShellConfigStore.parseLegacyBackendId` 只用于“检测旧 schema 并在用户确认后清理”，不是第二条读写路径。`ZcodeMobileBridgeHost` 是宿主→页面事件对象名，不是旧注入桥。                          |
| 第二条配置写入路径       | 未发现。Remote `bootstrap.tsx`/`main.tsx`/开发桥不引用 `MobileRemoteConfigStore` 写路径；Remote 只读 `ZodyRemoteBridge.getSessionContext()`。开发模式配置写入仅存在于 Shell 的 `MobileShellConfigClient`。                                                                |
| Remote 失败的 Shell 出口 | 存在。`MobileShellController.onRemoteLoadFailure()`、`bootstrap.tsx` 的 `requestReturnShell`，以及 M2 `offline-desktop-shell` / `old-desktop-shell` 实测通过。                                                                                                            |
| 旧 generation 写新文档   | 存在防护。`RemoteUiProxy.execute` 返回创建时 generation；`MobileShellController.intercept` 在网络等待后重新校验 generation，旧代次返回 `Stale` 并丢弃。M2 `contracts` 与 M4-T1 `stale-session-switch` 通过。                                                              |
| 测试是否只验证 mock      | 未发现。M4-T1/M3/M2 均通过真实 Gateway、真实 `RemoteGatewayBackend`、真实 Android WebView；focused 测试另有 provider 真实制品测试。                                                                                                                                       |
| 凭据与日志               | 未发现新增凭证日志。Release 日志使用 `@zcode/ui/logger`；`mobileRemoteSessionContext.ts` 不记录凭证；输出与证据未包含凭证、管理令牌或内部服务地址。                                                                                                                       |

## 7. 驱动问题与处置

以下问题均属于测试驱动/环境问题，已在获批范围内修复；**未发现需要修改产品代码的已确认缺陷**。

1. **M4-T2 pending 读取竞态 — 已修复**
   - 文件/行：`scripts/mobile-m4-t2/run-e2e.mjs:99` 新增 `waitForPending`；`:244/:280/:294/:315` 改为轮询。
   - 原因：点击通知后 `SharedPreferences.apply()` 异步落盘，实测 1.0–1.25s；旧固定 1200ms 稳定读到 `null`。
   - 结果：run5/run6 连续 **4/4 pass**。

2. **M4-T2 通知栏发现 flake — 已修复**
   - 文件/行：`scripts/mobile-m4-t2/run-e2e.mjs:168`，`reveal` 从 5 次增至 12 次有界重试。
   - 原因：Service 异步发布通知，一次运行在 `Allow once` 出现前超时；不是 pending 断言失败。
   - 结果：run5/run6 连续通过。

3. **M2 `record` 状态被覆盖 — 已修复**
   - 文件/行：`scripts/mobile-m2-t6/run-e2e.mjs:78` 改为 `{ ...details, status }`；`:466/:484` 把 envelope 字段改名 `bridgeStatus`。
   - 原因：`details.status` 覆盖了 pass/fail，失败时可能被 runner 漏掉。
   - 结果：M2 连续两次 **8/8 pass**，`file-notification-contract` 正确记录为 `pass`。

4. **M2 Activity 重建后持有旧页面 — 已修复**
   - 文件/行：`scripts/mobile-m2-t6/run-e2e.mjs:174`（每轮重取可见 target/session 并重试）、`:709`（旋转回正后等待新 target）。
   - 结果：`activity-recreate` 两次均 pass。

5. **M3 场景级联、阻塞 dialog 与设置入口 — 已修复**
   - 文件/行：`scripts/mobile-m3-t5/run-e2e.mjs:263`（关闭未确认通知失败 dialog，不 ack pending）、`:286`（场景级复位）、`:1039`（background finally 恢复前台）、`:628`（设置入口兼容 TaskHome 下拉与直接 Settings section）、`:219`（returnShell 重试）。
   - 现象：`background-no-refresh` 失败后应用停留后台；未确认通知失败留下的 `<dialog>` 覆盖页面点击目标（`elementFromPoint` 命中 DIALOG）；设置 tab 可能直接停在某个 section。
   - 结果：M3 连续两次 **9/9 pass**。

6. **既有工程噪声（未修复，不阻塞）**
   - `pnpm fmt:check`：仅 `docs/electron/docs/fiddles/**` 4 个既有 HTML 语法错误；本分支文件未导致失败。
   - `pnpm knip`：3138 unused files / 1121 unused exports / 1094 unused exported types 等既有规模；本分支新增文件中部分仅内部使用的导出也被列出，但不构成旧路径残留。
   - `pnpm --filter @zcode/desktop exec electron-builder --dir` 不带 `--config` 会失败；应使用 documented bundle 入口。

若未来再次出现“后台多一次 release 请求”，对照 spec 第 9.3 节：spec 禁止的是后台自动刷新、循环刷新和请求风暴；一次在途请求或 visibilitychange 竞态不构成产品缺陷。本轮修复后未再复现。

## 8. 未验证项

- Windows、Linux 桌面真实打包；本次只构建 macOS arm64 `--dir`。
- 真实 macOS Developer ID 签名/notarization；本次桌面包未签名。
- Release 签名 APK：缺少四个签名材料，仅验证了 fail closed。
- 真实 HTTPS Gateway 与 release 环境；本次为本地明文开发 Gateway。
- Doze、OEM WebView、Shizuku、厂商通知抽屉差异。
- 旧 APK（versionCode 1）加密配置的重新配对确认/取消真实路径；无法可靠注入旧 EncryptedSharedPreferences。
- 两个 backend identity 同时在线时的快速切换与在途响应丢弃矩阵。
- 真实桌面 Host 完整 workspace hydration、composer 未发送草稿、pending optimistic overlay、页面侧文件预览 guard 在真实 WebView 中的阻塞/解除；harness 不提供完整 workspace bridge，仅 focused 测试覆盖。
- 拍照后的第三方应用分享目标、外部 App 打开文件的真实行为。
- M4-T2 Remote ready 后按 backend 派发与跨 backend 返回 Shell 的端到端矩阵（focused 测试覆盖）。
- 分支中 `upstream-v3.17.1: F01–F07` 提交的功能验收；本任务未单独执行其 focused E2E。

## 9. 已知限制

- 桌面离线时没有完整主 UI、持久化最近可用 UI 或离线业务缓存；只能停留在 Shell。
- 没有中心即时发布/CDN；手机前台 60s 轮询，同一标签页一分钟最多自动刷新一次，切换 release 需至少 5s 二次确认。
- v1 Remote 页面仍可读取当前设备凭证；不得宣称凭证完全不进入页面。
- 只有进程内有界 LRU immutable 缓存；不实现持久化 UI 或 Service Worker。
- 手机刷新只释放手机 transport，不新建 Agent/Local Host/远程会话；桌面 runtime 与 owner/lease 仍由桌面持有。

## 10. 发布注意事项

1. 发布顺序：先发布包含 Remote 制品的桌面版本，再发布 versionCode 2 的 APK；旧 APK 不在兼容验收范围。
2. `versionCode=2` 是破坏性升级：首次启动提示重新配对，用户确认后才清理旧配置；不要静默删除凭证。
3. Android Release 构建必须提供四个签名环境变量；缺材料会直接失败，不能回退 debug 签名。
4. Gateway 配置 `GATEWAY_ALLOWED_ORIGINS` 时必须同时包含 Shell origin 与 Remote origin，否则 discovery 或 WSS/fetch 被拦截。
5. 桌面打包必须先执行 `build:mobile-web`（或使用 `bundle` 入口），并确认 `resources/mobile-web` 无 `.map`、`release.json` 与 HTML meta 一致。
6. Gateway 只透传 allowlist 响应头；CSP/`X-Frame-Options`/`nosniff`/`Referrer-Policy` 由 Android `RemoteUiProxy` 补齐，不能依赖 provider 响应头透传。
7. 发布后检查 `/mobile-ui/release` 与旧 hash 404 行为；不要让旧 hash 回填新文件。

## 11. 回滚方式

- **桌面 UI 回滚**：安装上一版桌面。手机下一次 release 检查看到不同的 `releaseId`，经 guard、二次确认和原生 veto 后安全刷新回旧 UI；若旧桌面没有 `zcode-remote-ui-v1`，手机停留 Shell 并提示升级桌面。
- **APK 回滚**：Android 不允许安装更低 versionCode。需要先卸载（会清除配置）再安装旧包并重新配对；不建议作为常规回滚。保留上一版已签名 APK 与签名材料。
- **Remote 制品异常**：保持当前手机文档；修复桌面制品后重新检测。无效 manifest、429/5xx、断网都不会触发循环刷新。
- **Gateway**：Gateway 不保存任务队列/快照，回滚不涉及业务数据迁移；桌面与手机会按既有协议自动重连。
- **本任务未提交、未推送、未发布**；回滚以上述制品替换为准。

## 12. Gate M4 结论

**Gate M4：通过（在已验证范围；平台未覆盖项见第 8 节）。**

证据覆盖：

- 文件能力真实 E2E **7/7 pass**（选择、拍照、分块保存/打开、失败/取消、下载、CSP、stale session）。
- 通知动作/点击/冷启动 pending/非法 intent **4/4 pass**；修复后 run5/run6 连续两次通过。
- M2 冷启动/切换/旧桌面/离线/通知 ready/Activity 重建 **8/8 pass**，连续两次。
- M3 发布升级/回滚、异常保留文档、bridge 不兼容、后台不刷新、active overlay、未保存设置、原生文件/通知 veto、Activity 重建 **9/9 pass**，连续两次。
- 旧完整 Remote assets、旧桥、旧配置写入路径已清理；APK 只含 Shell。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`pnpm exec oxfmt --check` 真实通过；focused 466 tests、Android JVM 165 tests、release 13 tests 通过。
- macOS 桌面 `Resources/mobile-web` 与 Android APK 内容符合制品规则；Release 签名 fail closed。

未纳入本次通过条件、必须继续列为未验证：Windows/Linux 打包、Release 签名 APK、真实 HTTPS Gateway、Doze/OEM、旧 APK 配置迁移、双 backend 同时在线、完整桌面 Host workspace hydration 与 composer/pending overlay 真实验收。详见第 8 节。
