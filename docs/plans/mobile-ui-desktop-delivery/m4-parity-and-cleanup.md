# M4：文件、通知、回归与清理

目标：完成 Remote origin 下平台能力 parity，回归两种流式语义，删除旧内置主 UI/旧桥/旧配置残留，并形成最终发布验证记录。

前置：Gate M3 已通过；spec 第 9.4、10、11 M4、12 节。M4-T1/T2/T3 可并行，M4-T4 必须等三者完成。

## M4-T1：Remote origin 文件能力 parity

前置：Gate M3。

独占写文件：

- `packages/web/src/mobile-remote/mobileRemoteFileBridge.ts` 及 focused 测试。
- Android 文件保存/打开/下载相关实现与 focused 测试。
- 可新增 M4 文件 E2E fixture；不修改通知、business Channel 或清理文档。

实施与验收：

1. Remote origin 下选择文件、拍照、取消选择、分块保存、保存失败、取消、打开文件和 WebView download 全链路。
2. 所有操作携带有效 sessionId；切换 backend 后旧 session 不能完成保存或打开文件。
3. 保持 FileProvider/MediaStore URI allowlist、16 MiB 业务上限、块大小限制和孤儿会话回收。
4. 验证 `sourceUrl`、blob/data/既有下载来源与 CSP/connect-src 相容，不为图省事开放任意 origin。
5. prepareReload 与文件操作 guard 的先后无竞态：操作开始后不能刷新，取消/完成后可以刷新。

证据：Android JVM、Web focused 和真实 WebView 文件 E2E；未验证的真实外部应用打开行为单列。

## M4-T2：通知订阅、动作和冷启动深链 parity

前置：Gate M3。

独占写文件：

- `packages/web/src/mobile-remote/mobileRemoteNotifications.ts`、`mobileNotification*.ts*` 及 focused 测试。
- Android notifications、MainActivity intent 分发和相关 focused/E2E 测试。
- 不修改文件能力、runtime stream 或清理文档。

实施与验收：

1. Remote 下订阅同步、权限请求、前后台 activeTarget、通知展示、点击、option action 和取消。
2. 冷启动先持久化 pending click/action，经 Shell→正确 backend→Remote ready 后派发；失败、backend 不符或 stale generation 不 ack。
3. 同一 notificationId 的 click/action 槽继续分离；快速操作、Doze 恢复和重复 intent 不重复执行。
4. workspace 跳转贯穿 `workspaceIdentity`、`remoteSessionId` 和 backendId，不只按路径匹配。
5. 通知触发刷新或返回 Shell 时，未确认 pending 项保留，旧 sessionId 动作被拒绝。

证据：通知 JVM/Web focused、真实系统卡片点击和动作 E2E；Doze/OEM/Shizuku 等未覆盖环境明确列出。

## M4-T3：Desktop continuous 与手机 replayable 业务回归

前置：Gate M3。

独占写文件：

- Desktop Host attachment、webRemoteControl、remote-access 的回归测试；确有必要时最小 bug 修复仅限对应模块。
- `packages/web/src/mobile-remote/gatewayTerminalTransport.ts` 的 focused 测试；非必要不改实现。
- 可新增 M4 协议/流式测试 fixture；不修改 Android 文件/通知或清理文档。

实施与验收：

1. 验证 UI HTTP 请求与 `zcode-remote` Channel 完全分离，无 task/session/snapshot/queue 进入 UI provider 或 Gateway。
2. Desktop continuous：流式 chunk、工具更新、终态、断线、stale run 和 owner/lease 语义不变。
3. 手机 web-remote-replayable：snapshot、queue、重连、事件间隙、session conflict 和 backend 切换语义不变。
4. Remote reload 只释放手机 transport，不关闭桌面 runtime，不重复 CommandInbox admission。
5. 高频诊断、info/warn/error 日志级别正确，不记录原始凭证、用户数据或内部服务地址。

证据：两种语义的 focused/集成测试、实际事件顺序和发现的问题；未执行的真实设备恢复明确列出。

## M4-T4：删除旧实现并同步规范与发布文档

前置：M4-T1、M4-T2、M4-T3 全部交接。

独占写文件：

- Android 完整 `assets/remote`、旧桥/旧配置/旧 origin 的剩余实现与失效测试。
- 根命令、`scripts/`、`packages/web` 中已被替代的内置主 UI 构建和兼容残留。
- `AGENTS.md`、`DESIGN.md`（仅在规则确实变化时）、`.agents/skills/` 相关引用。
- `specs/mobile-remote-control-via-gateway.md`、`specs/mobile-remote-control-via-gateway-tasks.md`、`specs/zody-android-and-http-release.md` 和相关部署/发布文档。
- `specs/mobile-remote-ui-desktop-delivery.md` 的实施状态与最终规则校准。

实施：

1. 删除前检查目标和引用，保留用户无关改动；不恢复旧模块，不删除仍被普通 Web 使用的共享功能。
2. 清除完整 Remote assets、旧 `ZcodeMobileBridge`、旧配置迁移和“APK 内置主 UI”的现行描述。
3. 当前命令只保留实际存在的 Shell/Remote 构建、检查和测试入口；同步技能与架构文档引用。
4. 明确 UI 随桌面发布、桌面离线不能冷启动主 UI、破坏性重新配对和两种 origin 的 CORS 配置。
5. 保留 `appProtocol`、workspaceIdentity、owner/lease 和两种流式语义的规则，不误删为“同版后不需要”。
6. 用 `pnpm knip`、导出引用查询和文本搜索检查死导出/旧路径；发现真实问题再最小清理。

证据：删除清单、保留清单、引用搜索结果、文档与现行行为对照。

## M4-T5：最终发布验证与交接

前置：M4-T4。

独占写文件：

- `docs/testing/evidence/mobile-ui-desktop-delivery-final.md`。
- 最终验证所需的单一用途报告脚本；不新增产品功能。

实施与验收：

1. 审阅完整 diff 和各阶段证据，确认无越权状态所有者、无长期双栈、无旧兼容分支残留。
2. 执行目标包 focused 测试、Android JVM、真实 Gateway/Android WebView E2E、文件/通知/更新/恢复矩阵。
3. 执行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；按需执行 `pnpm fmt:check`、`pnpm knip` 和构建隔离检查。
4. 在当前可用平台构建桌面和 Android 制品，检查 Remote/Shell 资源、sourcemap、applicationId/versionCode 和签名 fail closed。
5. Windows/macOS/Linux、Release 签名、真实 HTTPS、Doze/OEM 等未实际覆盖项明确写入“未验证”，不得推断通过。
6. 汇总已知限制：无离线主 UI、无中心即时发布、v1 Remote 页面可读当前凭证、仅进程内 immutable 缓存。
7. 提供最终修改清单、测试命令和结果、制品、未验证项、发布注意事项及回滚方式；不自行提交、推送或发布。

Gate 证据：一份可审计的最终报告。只有实际完成且证据覆盖的项目才能标记 Gate M4 通过。
