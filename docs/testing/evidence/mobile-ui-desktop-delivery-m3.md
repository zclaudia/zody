# 移动端 UI 随桌面交付：M3 升级/回滚与安全刷新证据

日期：2026-11-03

工作区：`.claude/worktrees/agent-af0526a6ce0fb3756`

分支：`m3-t5-safe-release-e2e`

基线：`c414c960`（`fix(mobile): Remote 发布日志改用 @zcode/ui/logger`，包含完整 M3-T1～T4、M2-T6 harness 与 M3-T4 replayable focused 测试）。

本记录只描述本 agent 在真实 Gateway + Android WebView 上实际执行的检查。M4 文件/通知深度矩阵与清理未实现、未验收。

## 环境与边界

| 项目          | 事实                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 主机          | macOS arm64                                                                                                                                |
| Node          | `v24.14.0`（fnm；仓库 `mise.toml` 固定 24.14.0）；pnpm `10.33.2`                                                                            |
| Android       | `emulator-5582`，`zoom_chat_magisk_api34`，Android 14（API 34），arm64-v8a                                                                  |
| WebView       | `webview_devtools_remote_<pid>` + `adb forward tcp:9222`；CDP `Runtime.evaluate`                                                           |
| Gateway       | 现有共享本地实例 `http://127.0.0.1:3200`，`/health` 200；未重启、未改写配置                                                                 |
| 凭证          | 复用主检出 `.env.gateway.local` 中既有 device/backend 凭证；未输出、未写入证据或提交                                                         |
| 桌面 provider | 真实 `RemoteGatewayBackend` + `MobileUiAssetProvider`（`scripts/mobile-m2-t6/desktop-provider-harness.mjs`）；最小 `zcode-remote` hello/bootstrap 响应器 |
| APK           | `versionCode=2`、`versionName=0.1.0`、Debug 签名；`assembleDebug` 产物 13,989,210 字节                                                       |

环境事件：第一次连接时 emulator 的 `system_server` 因 PackageManager 扫描触发 Watchdog 循环，`pm`/`activity` 服务不可用；冷重启同一 AVD 后恢复。未改动系统镜像或 AVD 配置。

## 真实发布夹具

`scripts/mobile-m3-t5/prepare-release-fixtures.mjs` 从 `pnpm build:mobile-web` 的 A 制品复制并在 `/tmp/zody-m3-releases` 生成四个可直接由真实 provider 提供的版本：

| 版本           | releaseId                  | 用途                                                       |
| -------------- | -------------------------- | ---------------------------------------------------------- |
| `a`            | `240f21d7879c8066254b84a6` | 基线（与当前 `dist-mobile-remote` 一致）                   |
| `b`            | `f21a2f51bc4eecf7a34519fc` | 升级/回滚目标；CSS 字节与文件名都变化                       |
| `incompatible` | `2574bb0c607602d6ffcb6953` | `supportedBridgeVersions=[2]`，当前 App bridgeVersion=1     |
| `invalid`      | —                          | `release.json` 为无效 schema，用于验证保留当前文档           |

每个夹具都经 `finalizeMobileWebRelease` + `verifyMobileWebRelease` 复核，HTML meta、`release.json`、`assetDigest` 与 `releaseId` 自洽。

provider harness 增加三个仅 E2E 使用的控制端点（不改变 M2 默认行为）：

- `/root?value=<dir>`：只替换制品根目录并重建资产 provider，**不重建 Gateway backend**，因此 backendId/session 不变；
- `/release-status?value=<http>`：对 `/mobile-ui/release` 强制返回 429/5xx；
- `/workspaces?value=none|disconnected`：控制 bootstrap/list 返回的 workspace，用于挂载真实 Root UI。

## 自动化端到端结果

复现：

```bash
# 终端 1
ZODY_E2E_NAMESPACE=zcode \
ZODY_E2E_PUBLIC_GATEWAY_URL=http://10.0.2.2:3200 \
ZODY_E2E_REMOTE_ROOT=/tmp/zody-m3-releases/a \
  node --import tsx --env-file=.env.gateway.local \
  scripts/mobile-m2-t6/desktop-provider-harness.mjs

# 终端 2（APK 已安装；先运行 prepare-release-fixtures）
ZODY_E2E_M3_FIXTURES=/tmp/zody-m3-releases \
  node --env-file=.env.gateway.local scripts/mobile-m3-t5/run-e2e.mjs
```

最终完整运行（2026-11-03）：exit 0，9/9 场景 pass。关键断言：

| 场景 | 真实断言与结果 |
| --- | --- |
| `release-upgrade-throttle-rollback` | A→B：切换后 0.5s/2s/4s 采样仍为 A 且 `beforeunload` 计数 0，5 秒二次确认后才自动刷新到 B（计数 1）；B→A 在自动刷新冷却内不自动刷新（文档仍 B、计数 1），手动安全刷新放行到 A（计数 2）；再等待 65 秒计数不变，无循环；全程 `backendId` 不变，reload 后 2.5 秒 `activeChannelCount=0`。 |
| `failure-keeps-document` | 429、500、无效 manifest 均只增加一次 release 请求，HTML 仍为 A、刷新计数 0；旧哈希命中手机侧 immutable 缓存时返回旧内容且 `hasNewContent=false`，从未构建的哈希返回 404 且 body 为 0。 |
| `bridge-incompatible` | 已打开文档收到 `supportedBridgeVersions=[2]` 时只显示“Update the Zody app”，不暴露安全刷新按钮、不 reload；强制冷启动后停在 Shell 的桌面选择页，`activeChannelCount=0`，未启动业务 Channel。 |
| `background-no-refresh` | HOME 后稳定期 release 请求增量为 0、文档不变、刷新计数 0；回前台后重新检查并安全刷新到 B（计数 1）。 |
| `guard-active-overlay` | 打开“Open another project”目录选择器后，自动路径显示 `active-overlay` 阻塞且不刷新；手动点击“安全刷新”同样不刷新；关闭选择器后手动刷新到 B。 |
| `guard-unsaved-settings` | 真实 Root Settings → Connection 修改 Gateway 地址后，自动路径显示 `unsaved-settings` 阻塞且不刷新；手动刷新同样被阻塞；Cancel 恢复表单后手动刷新到下一 release。 |
| `native-busy-guards` | 注入真实 `<input type=file>` 打开系统文件选择器：`prepareReload` 返回 `native-busy`，自动路径显示 native veto 且不刷新；BACK 取消后返回 `ready` 并刷新。未完成 `saveFileBegin` 会话同样 veto，`saveFileAbort` 后放行；完整 begin/append/finish 后 `ready`；旧 session 返回 `stale-session`。 |
| `native-notification-permission-veto` | 撤销 POST_NOTIFICATIONS 后冷启动弹出真实系统权限对话框，`prepareReload` 返回 `native-busy`，页面显示 native veto 且不刷新；点击“不允许”后返回 `ready`，手动刷新到 B。 |
| `activity-recreate-not-permanently-busy` | 横竖屏重建后同一 backend、session 轮换；旧 session `prepareReload` 返回 `stale-session`，新 session 返回 `ready`，没有永久 busy。 |

## replayable 与所有权证据

M3-T4 focused 测试（本轮实际执行，见下）覆盖：

- 同 `clientInstanceId` 新页面接管 channel，旧页面关闭不重启 transport session；
- 旧 channel 关闭后的迟到帧不进入业务层；
- 运行中的任务跨刷新由原 Host 恢复，不重复 `createSession`/Agent/prompt admission；
- 未进入 runtime 的未提交输入不会被刷新恢复或重复 admission；
- 移动页面刷新只轮换 replayable attachment，不影响 desktop-continuous attachment。

真实 WebView E2E 在每次刷新前后校验 `backendId` 稳定、`activeChannelCount` 回落到 0（旧 channel 已关闭），未新建 backend identity。真实桌面 Host 的业务 hydration、CommandInbox 与 owner/lease 仍由 M3-T4 focused 测试覆盖；本轮 harness 不实现完整 workspace bridge，因此没有把“手机刷新不重建 Agent”写成仅由真实 E2E 证明的结论。

## 工程门禁（真实输出）

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run`（M3 focused 7 个文件：web 4、ui 1、desktop 2） | 7 files / 49 tests passed |
| `packages/android/gradlew -p packages/android testDebugUnitTest assembleDebug` | BUILD SUCCESSFUL；JVM 测试通过；APK 生成 |
| `pnpm build:mobile-web` | exit 0；`releaseId=240f21d7879c8066254b84a6`、`assetDigest=b249387ccde7e669ac10e5b550c9e717a5efa4d1bad1485753748b2fc21b9579` |
| `node scripts/mobile-m2-t6/run-e2e.mjs`（M2 回归） | 7/8 pass；`activity-recreate` 在轮换后调用 `returnShell` 时，脚本仍持有旧页面并等待新 Shell 超时，属 M2 脚本时序失败；同轮其余 M2 断言全部通过 |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0；0 errors，307 warnings（均为既有告警） |
| `pnpm architecture:check --changed` | `architecture: OK`；violations 0、baseline 0、new 0 |

## 集成过程中发现与处理

1. **旧 hash 断言修正（非产品缺陷）**：Android `RemoteUiProxy` 按 immutable URL 缓存旧内容哈希资源。切换 release 后读取旧 CSS 哈希会命中手机侧缓存并返回旧字节；这满足“旧 hash 不混新内容”。E2E 改为断言旧哈希不含新 release 标记，并用从未构建的哈希验证 provider 404 + 空 body。
2. **测试驱动问题**：provider `/root` 切换必须保持 backend 不重建；HOME/回前台需要显式唤醒并等待在途检查结束；Activity 重建前需先处理通知权限弹窗，否则新 Activity 会再次请求权限而表现为 native-busy。以上均只修改 E2E 脚本与夹具，未修改 `packages/android`、`packages/web`、`packages/desktop` 产品代码。
3. **Gateway peer 风险（M2 遗留）**：本轮未重启共享 Gateway。完整运行结束时 `/health` 为 `backends=1, peers=2`，provider 仅保留当前 Remote 的 1 个 active channel。退出 provider 后 `backends=0`、`peers=1`；force-stop Android 应用后 `peers=0`，说明余下 peer 是手机自身 device channel，不是 desktop provider 泄漏。未观察到 backendId 漂移或 reload 后 active channel 累积；但高频 reload/重连下的 peer 释放延迟仍需 M4 继续观察，未写成“已解决”。

## 未验证项

- composer 未发送文本/附件 guard、pending optimistic overlay guard、页面侧文件保存/下载 guard 在真实 WebView 中的独立阻塞/解除：本轮 harness 没有真实 workspace bridge / 文件预览，无法挂载对应 UI 状态；仅有 focused 测试覆盖，不能宣称真实 E2E 通过。
- 拍照完成的完整矩阵（文件选择器的取消与权限弹窗已真实验证，未实际拍摄并完成上传）。
- 真实 Release APK 签名、真实 HTTPS Gateway、特定 OEM WebView 行为。
- 真实桌面 Host 的任务 hydration、CommandInbox、owner/lease 在手机刷新期间的端到端断言（由 M3-T4 focused 测试覆盖）。
- Windows/Linux 桌面打包与真实 Electron 桌面窗口；本轮使用 provider harness。
- 两个 backend identity 同时在线时的快速切换与在途响应丢弃矩阵。

## Gate M3 建议

**建议有条件通过 Gate M3**：桌面 A→B→A、二次确认、一分钟限频、回滚检测、断网/429/5xx/无效 manifest 保留文档、后台不刷新、旧 hash 不混新内容、bridge 不兼容不启动业务、active overlay 与 unsaved settings 的自动/手动阻塞、原生文件选择/保存会话/通知权限 veto、stale session 与 Activity 重建不永久 busy，均已在真实 Gateway + Android WebView 上通过；focused 测试与 replayable 恢复测试通过，工程门禁真实通过。

条件：composer/pending optimistic overlay/页面侧文件操作三个 guard 仍需在具备真实 Host workspace bridge 与文件预览的环境中补真实验收；拍照完成、Release 签名/HTTPS/OEM 与 M2 遗留的 Gateway peer 累积风险继续跟踪。
