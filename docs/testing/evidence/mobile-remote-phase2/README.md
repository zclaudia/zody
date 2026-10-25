# mobile-remote-phase2 证据索引（2026-10-24）

执行层：E2E-P（真实隔离 Gateway + 本仓真实 desktop transport/manager 组件 + 手机侧真实
`GatewayTerminalTransport`）、E2E-A（Android 模拟器 + 真实 Debug APK + 隔离 Gateway +
fake-desktop）。环境与命令见 `docs/testing/mobile-remote-phase2-e2e-plan.md` §E2E-P/§E2E-A；
驱动脚本副本与可复用环境工具在 `.tmp/mobile-remote-phase2-e2e/`（不入 git）。

## E2E-A 用例结果（2026-10-24，emulator-5554 / hermes_api34 / Android 14）

| 用例 | 状态 | 证据 | 关键断言 |
| ---- | ---- | ---- | -------- |
| A-MN-01 按钮渲染 | pass | `A-MN-01.json`、`a-mn-01-shade-valid.png/.xml`、`a-mn-01-shade-malformed.png/.xml` | RenderService 注入合法 permission envelope → 系统通知含「允许一次/总是允许/拒绝」三按钮、正文泛化、envelope 数据 0 泄漏；畸形 actions → 卡仍渲染、按钮 0（丢按钮不拒卡） |
| A-MN-02 按钮→快速路径 | pass（失败路径：槽保留） | `A-MN-02.json`、`a-mn-02-app-notice.png`、`a-mn-02-notice.png` | 点「允许一次」→ MainActivity `topResumedActivity`、prefs `pending_notification_action_v1` 四字段完整、fake-desktop 见 channel attach+bootstrap、页面弹『暂时无法打开通知』、槽保留；acknowledge 成功路径需真实 bridge/feed（本层不声称，见 JSON deviations） |
| A-MN-03 失败不崩溃 | pass | `A-MN-03.json`、`a-mn-03-notice.png`、`a-mn-03-after-dismiss.png` | 停 fake-desktop 后点按钮 → 错误反馈、pid 17996 全程不变、槽保留可重试；dismiss → 槽清除=0 |
| A-MO-01 入口与打开 | **fail** | `A-MO-01.json`、`a-mo-01-startpage-crash.json`、`a-mo-01-blank-startpage.png/.xml` | StartPage 渲染崩溃：`useZCodeStore 必须在 StoreProvider 内使用`（ThemeMenu→useZCodeStore，StartPage 渲染树 bootstrap.tsx:1831 无 StoreProvider）→ `#root` 空、「打开其他项目」不可达；选择器与 open-path-request 断言未执行；协议层语义由 P-MO-02/03 覆盖 |
| ntfy→root bridge 真实推送 | pass | `root-bridge-push.json`、`a-push-real-test.png`、`a-push-real-permission.png/.xml` | adb root 可用 → 部署 ntfy-bridge 0.4.0（aarch64 静态二进制）→ App 经 gateway 代理流订阅 connected → gateway test 推送与 permission envelope 均真实渲染（后者带三按钮） |

E2E-A 环境与驱动：`packages/android assembleDebug`（exit 0）→ 模拟器（绝对路径 emulator，
`-no-snapshot-save`）→ `adb install` → `env.mjs start` 隔离 ntfy+gateway → `fake-desktop.mjs`
（本轮新增 `FAKE_DESKTOP_BOOTSTRAP_EMPTY=true`：runtime 挂 identity 无 remoteSessionId 使
bootstrap workspaces=[]，见脚本内注释）→ `phase2a-driver.mjs setup/pick-backend`（playwright
`_android` WebView 驱动）→ 通知注入用 `am start-foreground-service --es body`（RenderService
exported+DUMP 权限，Manifest:32-36）。fake-desktop 本轮改动副本 `fake-desktop.mjs.bak-phase2a`。

## 用例结果

| 用例 | 状态 | 证据 | 关键断言 |
| ---- | ---- | ---- | -------- |
| P-MO-01 协商与版本闸门 | pass | `P-MO-01.json` | 手机侧 `onVersionNegotiated` appProtocol=4；desktop attached log appProtocol=4；协商=3 的旧客户端发 v4 类型收到 `protocol_error{unsupported-version, offendingType=mobile-directory-list-request}`，帧未进应用层，闸门后 bootstrap 仍往返、desktop 状态未离开 paired；纯函数证据：假设 `introducedIn=5` 的类型在协商=4 被同一闸门拒 |
| P-MO-02 目录列表全链路 | pass | `P-MO-02.json` | 无 path=homedir（91 条目逐条与 fs 核对）；mkdtemp 目录仅返回目录条目（文件过滤、symlink 跟随标记 `isSymbolicLink`、码点排序、parentPath）；相对路径回 `path-invalid` |
| P-MO-03 打开目录全链路 | pass | `P-MO-03.json` | 真实目录 → `openWorkspacePath(dir)` 被调 + `syncAvailableWorkspaces` 后回 `success:true + workspaceKey=目录`；开关关闭回 `arbitrary-path-disabled` 且 `ensurePrimaryWindow` 全程 0 次调用 |
| P-MO-04 strict 帧 | pass | `P-MO-04.json` | 夹带 `recentProjectId` 的 `workspace-open-path-request` 无响应（2.5s 负向等待）、`openWorkspacePath` 未调用、desktop 记录 `invalid gateway app payload dropped`，后续合法请求正常往返、transport 仍 ready |
| P-MN-01 push envelope 脱敏 | pass | `P-MN-01.json`、`P-MN-01-ntfy-received.json` | 真实 delivery bridge + 临时 SQLite service 经隔离 gateway 投递到隔离 ntfy（topic=`NTFY_TOPIC-<backendId>`）：permission 消息 `kind=permission`、actions 恰为 optionId/optionKind 三元组（allowOnce/allowAlways/deny）、全文（含 ntfy envelope）不含 label/命令/路径 canary、title 固定 "Zody"；completed 消息无 `actions` 字段 |

## 执行方式

```sh
# 1) 隔离环境（随机端口 ntfy 容器 + gateway，现签现删凭证）
node .tmp/mobile-remote-phase2-e2e/env.mjs start   # 输出 env.json（含凭证，0600）
# 2) P-MO-01…04（临时 vitest 驱动，跑完已删除，副本 .tmp/…/phase2-e2e-tmp.test.ts.bak）
PHASE2_E2E_ENV=.tmp/mobile-remote-phase2-e2e/env.json \
  pnpm exec vitest run packages/desktop/test/phase2-e2e-tmp.test.ts
# 3) P-MN-01（副本 .tmp/…/phase2-mn01-tmp.test.ts.bak）
PHASE2_E2E_ENV=.tmp/mobile-remote-phase2-e2e/env.json \
  pnpm exec vitest run packages/desktop/test/phase2-mn01-tmp.test.ts
# 4) 收尾
node .tmp/mobile-remote-phase2-e2e/env.mjs stop
```

## 备注

- 版本闸门的「5-only 类型」：`WEB_REMOTE_CONTROL_APP_PROTOCOL_MAX_VERSION=4`，当前协议不存在已登记
  的 v5 类型。E2E 用「协商=3 的旧客户端发送已登记的 v4 类型」触发真实闸门代码路径
  （`gatewayDeviceTransportInbound.ts` handleDataFrame → `gateWebRemoteControlAppPayloadVersion`），
  并用同一纯函数补「假设 introducedIn=5 在协商=4 被拒」的直接证据；两者均为真实共享代码，无 mock。
- 首轮执行曾 4/4 失败：根因是临时驱动给 manager 栈的 logger 缺 `debug`，hub `handleOffer` 抛错被
  SDK 映射为 `channel_reject{dial_failed}`；补齐后全部通过，与本仓被测代码无关。
- P-MN-01 两个环境事实：gateway 按 `${NTFY_TOPIC}-${backendId}` 每 backend 一个 topic 发布；
  ntfy 默认 visitor rate-limit 会拦高频轮询（隔离容器已调高 burst）。
- fake-desktop 扮演脚本：`.tmp/mobile-remote-phase2-e2e/fake-desktop.mjs`（真实
  RemoteGatewayBackend/GatewayDeviceTransport/manager + electron 桩），自测驱动
  `fake-desktop-selftest-phone.mjs`，自测 7/7 通过（见 `fake-desktop-selftest.log` 摘要与
  `fake-desktop-events.jsonl` 事件样例）。
