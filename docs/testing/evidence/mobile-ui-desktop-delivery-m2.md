# 移动端 UI 随桌面交付：M2 集成与阶段门禁证据

日期：2026-11-03

工作区：`.claude/worktrees/agent-afe96c2de87433c87`

分支：`m2-t6-e2e`

基线：`814694e1`（`feat(mobile): Remote 改为只读原生会话上下文`，包含完整 M2：Shell/Remote、双 bridge、controller、RemoteUiProxy、config store 与 Remote Web）。

本记录只描述本 agent 实际执行的检查。M3/M4 行为未实现、未验收。

## 环境与边界

| 项目          | 事实                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主机          | macOS arm64                                                                                                                                                                                       |
| Node          | `v24.14.0`（fnm；仓库 `mise.toml` 固定 24.14.0）；pnpm `10.33.2`                                                                                                                                  |
| Android       | `emulator-5582`，sdk_gphone64_arm64，Android 14（API 34），arm64-v8a                                                                                                                              |
| WebView       | Chrome/113.0.5672.136（`webview_devtools_remote_<pid>` + `adb forward`）                                                                                                                          |
| Gateway       | 现有共享本地实例 `http://127.0.0.1:3200`，`/health` 200；未重启、未改写配置                                                                                                                       |
| 凭证          | 复用主检出 `.env.gateway.local` 中既有 device/backend 凭证；namespace `zcode`；全文不记录凭证、管理令牌或真实地址                                                                                 |
| 桌面 provider | 真实 `RemoteGatewayBackend` + `MobileUiAssetProvider`（`scripts/mobile-m2-t6/desktop-provider-harness.mjs`）；仅用最小 `zcode-remote` hello/bootstrap 响应器模拟桌面 Host 业务面，workspaces 为空 |
| APK           | `versionCode=2`、`versionName=0.1.0`、Debug 签名；SHA-256 `0bc9e7aa0084d19f9188044cafedc7104886a5efd997dfeb195a1511ae126a2a`                                                                      |

桌面 Host 业务面的深度（任务列表、工作区 hydration、RPC bridge）不在本任务范围；Remote 页在空工作区时进入 StartPage 并发出 `markRemoteReady`，这已足以验证 ready 时序。

## 构建与制品

| 命令                                                                 | 真实结果                                                                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/android/gradlew -p packages/android testDebugUnitTest`     | BUILD SUCCESSFUL；`testDebugUnitTest` 通过                                                                                                           |
| `packages/android/gradlew -p packages/android assembleDebug`         | BUILD SUCCESSFUL；APK 13 MB                                                                                                                          |
| `pnpm run build:mobile-web`                                          | exit 0；`releaseId=e2aaf04d584a53a7de8ed477`、`assetDigest=df06a47e55478f6d5ccb98af38acdc82e9222bfbc1f1505ca3efdb7fa7a8bd5f`、`desktopVersion=0.1.0` |
| `pnpm test:mobile-web-release`                                       | 13 tests passed，0 failed                                                                                                                            |
| `pnpm --filter @zcode/web build` + `pnpm check:mobile-web-isolation` | OK；普通 Web 4723 个代码文件命中 0 处 gateway-client；Remote 入口存在，允许包含 gateway-client                                                       |

APK 内容：

- `assets/shell/` 仅 4 个文件：`index.html`、`assets/index-*.js`、`assets/index-*.css`、`THIRD-PARTY-NOTICES.md`。
- 无 `assets/remote/`、`mobile.html`、PDF.js 工作台或 sourcemap。
- `dist-mobile-remote` 60 MB、0 个 `.map`；`release.json` 与 HTML meta 一致。
- 以上是目录/压缩前体积，不把目录大小等同于 APK 压缩收益。

## 自动化端到端结果

复现：

```bash
# 终端 1
ZODY_E2E_NAMESPACE=zcode \
ZODY_E2E_PUBLIC_GATEWAY_URL=http://10.0.2.2:3200 \
  node --import tsx --env-file=.env.gateway.local \
  scripts/mobile-m2-t6/desktop-provider-harness.mjs

# 终端 2（APK 已安装）
node --env-file=.env.gateway.local scripts/mobile-m2-t6/run-e2e.mjs
```

`run-e2e.mjs` 最近一次完整运行：exit 0，8/8 场景 pass。

| 场景                         | 断言                                                                                                                                                                                                                                                                                                                                                                                         | 结果 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `device-bootstrap`           | Shell 读取既有配置；discovery 列出新桌面；`openRemote` 后进入 `https://remote.zody.local/assets/remote/index.html`；`getSessionContext` 返回 backendId、sessionId、clientInstanceId、bridgeCapabilities；provider 收到 hello（appProtocol 1..4）与 bootstrap                                                                                                                                 | pass |
| `contracts`                  | 真实 WebView 内同源 `fetch` 命中 RemoteUiProxy：index GET/HEAD 200；CSP、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy` 存在；405 带 `Allow: GET, HEAD`；旧 hash、路径穿越、任意 API 路径均 404 且空流；URL/localStorage/sessionStorage/cookie/resource/DOM 均无凭证；外部主框架不替换当前文档；第三方 iframe 不接管主框架；所有状态变更调用带 stale sessionId 均返回 `stale-session` | pass |
| `file-notification-contract` | `saveFileBegin/Append/Finish` 成功，设备上 `/sdcard/Download/m2-t6-e2e.txt` 内容为 `m2-t6-e2e-file-content`；pending click/action 与 notification status 返回合法 envelope                                                                                                                                                                                                                   | pass |
| `reopen-session-rotation`    | 同一 backend 重新打开：sessionId 变化、clientInstanceId 复用、旧 sessionId 的 `markRemoteReady` 返回 `stale-session`                                                                                                                                                                                                                                                                         | pass |
| `old-desktop-shell`          | provider 不注册 `mobileUiHandler` 时 registry 缺 UI capability；Shell 列表项 `data-supported=false`、Connect 禁用，并显示升级桌面提示                                                                                                                                                                                                                                                        | pass |
| `offline-desktop-shell`      | 桌面离线时列表仍显示 Offline、Connect 可用；点击后 Remote 加载失败回 Shell，ShellBridge/config/picker 保留，无白屏                                                                                                                                                                                                                                                                           | pass |
| `notification-ready-gate`    | bootstrap 延迟 1500ms，加载中派发 `zody://notification/v1?...`；ready 前采样全部 0 次派发，约 4.8s 后收到 1 次点击                                                                                                                                                                                                                                                                           | pass |
| `activity-recreate`          | 旋转触发 Activity 重建：backend 不变、sessionId 变化、clientInstanceId 稳定，Remote 自动恢复                                                                                                                                                                                                                                                                                                 | pass |

关键真实值：

- `backendId=bcbea760-a7ac-4d27-a662-40f93bb47e31`
- 一次冷启动 sessionId：`a8d982d7-7366-4762-a18e-5484d5614aae`
- `clientInstanceId=792a3aae-4a28-4933-84c7-6869185109de`
- bridge capabilities：`session-context`、`file-save`、`file-open`、`notifications`、`lifecycle`、Debug 追加 `insecure-gateway-transport`
- CSP：`default-src 'none'; script-src 'self'; ...; connect-src 'self' http://10.0.2.2:3200 ws://10.0.2.2:3200; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`

## 手工补充验证

| 项目                | 结果                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 远端失败回 Shell    | 停止 provider 后在 Remote 页面 `location.reload()`：主框架错误触发 `onRemoteLoadFailure`，URL 回到 Shell，ShellBridge 存在、RemoteBridge 移除、配置仍可读                                                                    | pass                                |
| 系统浏览器分流      | `target=_top` 外部链接由 `openExternalUrl` 交给系统浏览器，WebView 文档 URL 不变；logcat 记录 Chrome 前台                                                                                                                    | pass                                |
| 冷启动通知槽        | 先以 `zody://notification/v1?...` 冷启动（ampersand 必须按 remote shell 规则转义）；`shared_prefs/mobile_notification_bridge.xml` 出现 pending click；Remote ready 后页面消费并提示“无法打开通知”，失败时保留 pending 不 ack | pass（打开目标本身的深度矩阵留 M4） |
| 进程死亡            | `run-as kill -9` 后重新 `am start` 为 COLD，Shell 从原生配置恢复并显示在线桌面；未验证系统保存实例状态恢复路径                                                                                                               | partial                             |
| 旧配置重配对        | 需要 versionCode 1 的 EncryptedSharedPreferences 旧 `config`；当前无旧 APK，无法可靠注入                                                                                                                                     | not verified                        |
| 双 backend 快速切换 | 临时签发第二张 backend 凭证仍落到同一桌面 backend identity，未形成两个同时在线 backend                                                                                                                                       | blocked                             |

截图证据：

- `docs/testing/evidence/mobile-ui-desktop-delivery-m2/remote-start-page.png`
- `docs/testing/evidence/mobile-ui-desktop-delivery-m2/old-desktop-unsupported.png`
- `docs/testing/evidence/mobile-ui-desktop-delivery-m2/offline-shell.png`

## 工程门禁（真实输出）

| 命令                                                                                                                                                                       | 结果                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm exec vitest run`（shared/web/desktop 的 mobile UI focused 15 个文件）                                                                                                | 15 files / 191 tests passed                                     |
| `node --env-file=.env.gateway.local vitest run packages/desktop/test/mobileUiGatewayProxyIntegration.test.ts packages/desktop/test/mobileRemoteGatewayIntegration.test.ts` | 2 files / 8 passed、1 skipped（gateway 重启场景未设置重启命令） |
| `pnpm test:mobile-web-release`                                                                                                                                             | 13 passed                                                       |
| `pnpm typecheck`                                                                                                                                                           | exit 0                                                          |
| `pnpm lint`                                                                                                                                                                | 0 errors；304 warnings，均为既有告警                            |
| `pnpm architecture:check --changed`                                                                                                                                        | `architecture: OK`；violations 0、baseline 0、new 0             |
| `pnpm check:mobile-web-isolation`                                                                                                                                          | OK（先执行 `pnpm --filter @zcode/web build`）                   |
| `node --env-file=.env.gateway.local scripts/mobile-m2-t6/run-e2e.mjs`                                                                                                      | exit 0；8/8 pass                                                |

## 发现与风险

1. 未发现需要修改 M2 产品代码的集成缺陷；本轮未修改 `packages/android`、`packages/web`、`packages/desktop` 源码。
2. 高频 WebView reload 压测期间，Gateway `/health` 的 `peers` 累积到 10，新 backend 连接一度返回 `GATEWAY_UNREACHABLE`；强制停止 Android 应用后 `peers` 归零、provider 立即恢复。未重启共享 Gateway。该现象可能来自测试中反复 reload/重连导致的连接释放延迟，需在 M3/M4 的连接清理或压力场景复核，暂不确认产品缺陷。
3. 旧桌面提示文案为 “Remote control unsupported … Update it or choose another desktop”，语义满足“提示升级桌面”；未要求修改。
4. 临时签发第二张 backend 凭证的清理已完成（凭证吊销、backend identity 删除）；未把任何凭证写入日志、证据或提交。

## 未验证项

- 旧配置（versionCode 1）重配对确认/取消的真实加密存储路径。
- 系统保存实例状态下的进程死亡恢复（本轮仅验证 force-kill + 新 intent 冷启动）。
- 两个 backend identity 同时在线时的快速切换与在途 HTTP 响应丢弃矩阵。
- 真实 Release APK 签名、真实 HTTPS Gateway、特定 OEM WebView 行为。
- Windows/Linux 桌面打包；本轮只验证 Remote 制品与 APK 内容，未重新执行 electron-builder 三平台打包。
- 桌面 Host 的真实任务/工作区业务 hydration（本轮 bootstrap 返回空 workspaces）。
- M3 发布检测/安全刷新、M4 文件选择/拍照/通知深链深度矩阵。

## Gate M2 建议

**建议通过 Gate M2（有条件）**：新 APK + 新桌面的配对、discovery、openRemote、Remote 加载、hello/bootstrap 与 `markRemoteReady` 通知门控、旧桌面停留 Shell、离线回 Shell、原生 CSP/安全头、HEAD/错误空流、旧 hash 404、外部导航/iframe 拒绝、stale session、Activity 重建与 Remote 失败回 Shell 均已在真实 Gateway + 真实 Android WebView 上通过。

未验证项不影响 M3 依赖的 ready/reload/session 契约，但以下前置必须在 M3/M4 继续跟踪：旧配置重配对、系统保存实例状态恢复、双 backend 快速切换、Release 签名/HTTPS/OEM，以及上述 Gateway peer 累积风险。
