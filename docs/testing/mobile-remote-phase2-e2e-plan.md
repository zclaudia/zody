# 手机远控第二批端到端验证计划（MO / MN12+）

日期：2026-10-24。关联：[第二批 spec](../../specs/mobile-remote-phase2.md)、[用例矩阵](./mobile-remote-phase1-cases.md)（MO01–06、MN12–15）。本文只定义执行分层、环境事实与证据规则；用例断言以矩阵为准。

## 目标与分层

两个功能已过全部单测/架构/typecheck；本计划补「真实链路」证据，按可自动化程度分三层，每层只声称自己覆盖的断言：

| 层 | 链路 | 覆盖用例 | 不声称 |
| -- | ---- | -------- | ------ |
| E2E-P 协议层 | 真实隔离 Gateway + 本仓真实 desktop transport/manager 组件 + 手机侧真实 `GatewayTerminalTransport` | P-MO-01…04、P-MN-01 | Android 系统通知、真实 CLI runtime |
| E2E-U UI 层 | 真实 `mobile.html` 组件面（Vite + Playwright，case-local fake switcher/transport） | U-MO-01…04 | Gateway 协议、Android |
| E2E-A 设备层 | Android 模拟器 + 真实 Debug APK + 隔离 Gateway + fake-desktop 扮演脚本 | A-MN-01…03、A-MO-01 | 真实 CLI runtime 的 resolveInteraction 语义、ntfy→root bridge 真实推送（环境不具备时标 blocked） |

## 环境事实（已探测，2026-10-24）

- **Gateway 源码**：`/Users/zhvala/SourceCode/zclaudia-repositories/zclaudia-gateway`（`scripts/mobile-remote-p8-push-harness.mjs` 默认找 `../zclaudia-gateway`，必须显式 `ZODY_GATEWAY_REPO=/Users/zhvala/SourceCode/zclaudia-repositories/zclaudia-gateway`）。
- **现网 gateway 容器**：`zclaudia-gateway-gateway-1`（healthy，长期运行）。E2E 一律**新起隔离容器**（随机端口 + 独立 volume + 现签现删凭证），不触碰现网容器与其数据；管理 API 签发模式见 `scripts/run-mobile-host-identity-isolation-e2e.mjs` 的 `issueCredential`。
- **ntfy**：docker 镜像 `binwiederhier/ntfy:v2.14.0`（push-harness 的容器模式：health 检查 `/v1/health`）。
- **Android**：AVD `hermes_api34`；`ANDROID_HOME=$HOME/Library/Android/sdk` 必须显式导出；模拟器允许 input 注入（真机 58756a76 禁注入，不用）。设备驱动模式见 `scripts/mobile-remote-p8-owner-boundary-android-driver.mjs`（adb + playwright `_android`，默认 `emulator-5554`，backup/release 生命周期）。
- **Node**：fnm 有 22.20.0（Gateway 运行时）与 24.14.0（Zody E2E 约束）；当前 shell 22.23.2 可跑 vitest/gradle。
- **运行约束**（沿用 cases 文档）：`pnpm typecheck`/会写产物的 tsc 不得与 Desktop build 或进行中的 E2E 并行；新轮次结束恢复模拟器配置并清理本轮容器/卷/临时目录。

## E2E-P 用例（协议层）

Harness 参考 `packages/desktop/test/mobileRemoteGatewayIntegration.test.ts`（真实 SDK 双端 transport）与 manager 单测 harness（`packages/desktop/test/webRemoteControlManagerWorkspaceOpenPath.test.ts`）。驱动脚本放 `.tmp/mobile-remote-phase2-e2e/`，不进 git。

- **P-MO-01 协商与版本闸门**：双端 transport 经隔离 gateway 完成 hello/hello_ack，断言 `appProtocol === 4`；向桌面发送 appProtocol 5-only 类型被 `protocol_error{unsupported-version}` 拒（或被版本闸门丢弃且连接状态不变）。
- **P-MO-02 目录列表全链路**：手机端真实 `GatewayTerminalTransport` 发 `mobile-directory-list-request`（先无 path、后带 tmpdir 真实路径），桌面端真实 manager（注入真实 `listMobileDirectoryEntries`）经 gateway 回真实条目（含目录过滤、parentPath）；非法路径回 `path-invalid`。断言响应与本地 `fs` 事实一致。
- **P-MO-03 打开目录全链路**：桌面 manager 注入 fake `openWorkspacePath` + `syncAvailableWorkspaces` 完成判定；手机发 `workspace-open-path-request`（tmpdir 真实目录）→ 收 `success:true + workspaceKey`；开关置 false 重发 → `arbitrary-path-disabled` 且桌面未尝试开窗（断言 ensurePrimaryWindow 未调用）。
- **P-MO-04 strict 帧**：带 `recentProjectId` 夹带字段的 `workspace-open-path-request` 整帧被桌面入站丢弃（无响应、连接不断）。
- **P-MN-01 push envelope 脱敏**：真实 `createMobileNotificationDeliveryBridge` + 隔离 gateway（NTFY_ENABLED 指向隔离 ntfy 容器）投递一条带 actions 的 permission 通知；在 ntfy 容器订阅 topic 收原始 JSON，断言：`kind=permission`、`actions` 含 optionId/optionKind 三元组、**全文不含 label/命令/路径**；再投递 completed 通知断言无 `actions` 字段。

## E2E-U 用例（UI 层）

Harness 参考 `packages/desktop/test/e2e/mobile-remote/manual-review/pending/mobile-shell-routing.mjs`（Vite + playwright-core + case-local fixture，fake services 不作协议证据）。

- **U-MO-01 入口门控**：`canOpenArbitraryWorkspace()=false` 时最近项目区无「打开其他项目」行（含 StartPage 空列表分支）；`=true` 时出现（`data-mobile-remote-open-other-project`）。
- **U-MO-02 选择器浏览**：入口打开全屏选择器；fake `listMobileDirectory` 返回嵌套目录 → 进入子目录、返回上级（parentPath 驱动）、手动输入路径触发请求；加载与错误态（too-large）文案。
- **U-MO-03 确认打开**：点「打开此目录」→ fake `openWorkspacePath` 被以当前浏览目录调用 → `onOpened(workspaceKey)` 后 Shell 切到聊天页（断言 switchWorkspace 调用）。
- **U-MO-04 错误映射**：`openWorkspacePath` 抛 `arbitrary-path-disabled` → 选择器内出现含「允许手机打开任意本地目录」的错误条，入口可重试。

## E2E-A 用例（Android 模拟器）

前置：`assembleDebug`（gradle，ANDROID_HOME 显式）；启动 `hermes_api34`；隔离 gateway（E2E-P 同源）+ fake-desktop 扮演脚本（复用 P harness：真实 manager + fake openWorkspacePath/attachWorkspaceHost 抛错标记 bridge 不可用）。APK 内配置 gateway 地址与 `zgd_` 凭证（debug 构建允许 http）。

- **A-MN-01 按钮渲染**：经 `notificationShow`（或 ntfy 真实推送，若 root bridge 可安装）注入带 actions 的 permission envelope → `uiautomator dump` 断言系统通知含「允许一次/总是允许/拒绝」三个按钮、正文为泛化文案（不含命令）；畸形 actions envelope → 通知仍出现但无按钮（不整卡拒绝）。
- **A-MN-02 按钮 → 快速路径**：点「允许一次」→ App 拉起；`adb` 读 `mobile_notification_bridge` prefs 断言 pending action 槽已写入（backendId/notificationId/optionId/optionKind）；fake-desktop 侧断言收到 `mobile-view-state-update`/bootstrap 活动后槽被消费清除（acknowledge 成功路径）或保留（失败路径）。
- **A-MN-03 失败不崩溃**：断开 fake-desktop（无 bootstrap 响应）点按钮 → App 显示「暂时无法打开通知」类反馈，进程存活，pending 槽保留可重试；dismiss 后槽清除。
- **A-MO-01 入口与打开（设备级）**：连上 fake-desktop（bootstrap 响应含 workspaces）→ 任务首页出现「打开其他项目」→ 打开选择器 → fake 目录列表渲染 → 确认后 fake-desktop 收到 `workspace-open-path-request`（断言 payload 与临时目录一致）。
- **ntfy→root bridge 真实推送**：仅当模拟器内 root/su 可用且 ntfy-bridge（`/Users/zhvala/SourceCode/zclaudia-repositories/ntfy-bridge`）可部署时执行；否则以 `notificationShow` 注入路径为准并明确记录「root bridge 链路 blocked」。

## 证据与收尾规则

- 证据目录：`docs/testing/evidence/mobile-remote-phase2/`（JSON 摘要 + 截图/dump，全部脱敏：无凭证原文、无命令正文）。
- 每条用例记录：pass / blocked（含原因）/ fail（含最小复现与日志指针）；不以单测数量或代表路径冒充整组通过。
- 收尾：销毁本轮 docker 容器/卷、`.tmp/mobile-remote-phase2-e2e/` 保留摘要、模拟器恢复（driver restore 模式或 `-wipe-data` 关闭）、gradle/emulator 进程退出。
- 结果回填：`docs/testing/mobile-remote-phase1-cases.md` 中 MO01–06、MN12–15 的「证据/状态」列。
