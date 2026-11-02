# M3：发布检测与安全刷新

目标：在 M2 可运行的双源链路上增加发布检测、二次确认、刷新阻塞、原生 veto 和桌面升级/回滚后的 replayable 恢复。不能通过刷新重建 Agent、Host 或业务会话。

前置：Gate M2 已通过；spec 第 9.3、10、11 M3、12“更新与数据保护”节。M3-T1 冻结控制器和 guard 契约后再并行下游。

## M3-T1：实现 MobileUiReleaseController 与 refresh guard 契约

前置：Gate M2。

独占写文件：

- `packages/web/src/mobile-remote/mobileUiReleaseController.ts`。
- 新增 `mobileUiRefreshGuards.ts`、发布 DTO 适配和 focused 测试。
- `packages/shared/src/mobile-ui-bridge.ts` 中 `prepareReload` 契约及 shared 测试；不改 Android 实现。
- 不修改 `bootstrap.tsx`、UI 组件或桌面 provider。

实施：

1. 控制器读取当前 HTML release meta，使用 M1 严格 manifest schema；无有效基线时只记录诊断，不自动刷新。
2. 注入 clock、scheduler、fetch、reload、native prepareReload 和 logger，测试不依赖真实计时器。
3. 前台 60 秒轮询；回前台、网络恢复、业务重连立即检查；后台、pagehide 和 disposed 状态停止。
4. 同一新 releaseId 间隔至少 5 秒二次确认；刷新前重新请求 release，当前文档和待刷新目标不可混淆。
5. 断网、429、5xx、登录失效、无效 manifest 保留当前文档；一分钟最多自动 reload 一次，防止升级/回滚循环。
6. guard 注册接口返回稳定 reason；未知状态默认阻塞。后台任务是否可刷新只由 M3-T4 的恢复结论决定，不复制 task 状态。
7. 定义 `prepareReload(sessionId, releaseId)` 结果：ready、stale-session、native-busy、unsupported；Web 只有 ready 才执行 reload。
8. 手动“安全刷新”复用相同 guard、确认和 native veto，不提供绕过入口。

测试：

- 二次确认、迟到响应、dispose、后台、网络恢复、一分钟限频和滚动发布来回切换。
- guard 注册/释放、多个阻塞原因、未知阻塞、手动刷新不绕过。
- native busy/stale/unsupported 不 reload；reload 前 release 已变化时重新进入确认流程。

交接：控制器 API、guard 注册接口、prepareReload 契约、native/UI 集成时序和测试证据。

## M3-T2：把 Web 草稿、pending overlay、设置和文件操作接入 refresh guards

前置：M3-T1。

独占写文件：

- `packages/web/src/mobile-remote/bootstrap.tsx` 和相关 mobile-remote UI 状态模块。
- `packages/web/src/mobile-remote/mobileRemoteFileBridge.ts` 的 Web 文件操作 guard。
- `packages/web/src/webRemoteControlVersion.ts` 仅移动端调用调整所需范围；普通 Web 行为不变。
- `packages/ui/src/` 中确有未提交状态的移动组件 guard 适配及 focused 测试。
- 不修改 release controller、Android 或 desktop runtime。

实施：

1. 在 bootstrap 安装一个 controller，生命周期覆盖全部 disposable React roots；页面卸载时统一 dispose。
2. composer 未发送草稿、pending optimistic overlay、未保存设置、未确认操作、文件保存/下载和活动弹层分别注册 guard。
3. guard 查询既有状态所有者，不把草稿、任务或 pending 请求复制到 controller。
4. 弹层/输入状态解除、保存成功、操作取消后释放对应 guard；组件卸载必须释放，不能永久阻塞。
5. 用 release controller 替代移动端仅提示桌面版本变化的旧路径；`appProtocol` 协商和普通 Web version guard 保持。
6. 提供符合 DESIGN.md 的“新版已就绪”和阻塞原因提示；运行中刷新按钮仍走同一检查。

测试：

- 每类状态阻塞与解除、组件卸载释放、多个 roots、重复注册和 stale callback。
- beforeunload 只 dispose 手机 transport，不触发重复 admission 或配置写入。
- 普通桌面 Web 路由不安装移动 release controller。

交接：各 guard 的来源、刷新提示行为、仍由 native 负责的阻塞项和测试证据。

## M3-T3：实现 Android prepareReload 原生 veto

前置：M3-T1。

独占写文件：

- `MainActivity.kt`、`RemoteControlApp.kt`、M2 新增 shell controller/RemoteBridge 文件。
- Android 文件选择、拍照、权限和保存会话的 focused 测试。
- 不修改 Web、desktop provider 或 M2-T4 remoteui 纯模块。

实施：

1. 实现 M3-T1 `prepareReload(sessionId, releaseId)`，先校验当前 generation/session，再检查原生操作。
2. 文件选择器、拍照、通知权限请求、未完成原生保存会话进行中时返回 native-busy；无操作时 ready。
3. Activity 正在销毁、backend 已切换或页面不是当前 Remote 时返回 stale-session，不执行导航。
4. 原生侧只 veto，不主动 reload；实际 reload 由 Web controller 在全部 guard 通过后触发。
5. Activity 重建和系统取消必须清理 busy 状态；reload 后同一 backend 的 session 有效性规则与 M2 保持一致。
6. 不用延时等待代替状态同步，不新增“假设几秒后操作已结束”的分支。

测试：

- 每种原生操作阻塞/取消/完成、Activity 重建、stale session、重复 prepareReload。
- 系统弹窗期间自动和手动刷新均不执行；操作完成后可刷新。
- 现有文件保存孤儿回收和通知 pending 语义不回归。

交接：native busy 来源、返回码、生命周期处理和真实 E2E 场景。

## M3-T4：验证并收敛刷新后的 web-remote-replayable 恢复

前置：M3-T1。

独占写文件：

- `packages/desktop/src/main/remote-access/` 中恢复相关测试；确有必要时仅限该目录最小 bug 修复。
- `packages/desktop/src/main/webRemoteControl*.ts` 的恢复 focused 测试。
- 可新增 M3 恢复测试 fixture；不修改 Web/UI、Android、Gateway UI provider 或 runtime CommandInbox。

实施：

1. 建立“旧 Remote 页面有运行任务 → 手机 transport dispose → 同 backend 新页面重连 → snapshot/replay 恢复”的测试序列。
2. 验证桌面 task/session、Host attachment、owner/lease 和 CommandInbox admission 始终由原所有者持有，无重复任务和重复 Agent。
3. 验证未提交 optimistic 输入由 M3-T2 阻止，已进入 runtime 的运行任务可由新页面恢复；pending 用户交互按现有协议恢复。
4. 验证 stale run、旧 channel 关闭、session conflict 和 backend 切换不被 reload 绕过。
5. 若发现跨模块设计缺陷，停止并交主 agent 对齐，不通过延时、重复 admission 或新增队列兜底。

测试：

- 运行任务、完成事件在 reload 间隙到达、pending prompt、stale channel、重复 ready。
- Desktop continuous 不在本任务改语义，只验证共享状态未被手机恢复路径污染。

交接：是否允许“后台任务运行中刷新”的明确结论、证据和未覆盖场景；若不能证明，M3-T2 必须把活动任务注册为阻塞项。

## M3-T5：升级/回滚 E2E 与 Gate M3

前置：M3-T2、M3-T3、M3-T4 全部交接。

独占写文件：

- M3 集成/E2E 脚本和 `docs/testing/evidence/mobile-ui-desktop-delivery-m3.md`。
- 经主 agent 授权可修复 M3 集成缺陷，不再并行修改其它任务文件。

实施与验收：

1. 用两个不同 Remote release 依次运行桌面，验证二次确认、安全刷新、HTML meta/releaseId 同步和回滚同样可检测。
2. 草稿、pending optimistic overlay、未保存设置、文件操作、系统弹窗分别阻塞自动和手动刷新。
3. 按 M3-T4 结论验证后台任务刷新恢复或阻塞；无重复 admission、Agent、Host attachment。
4. 断网、429、5xx、无效 manifest、桌面中途离线保留当前文档；恢复后重新检查。
5. 验证后台不刷新、一分钟限频、旧 hash 404 不混新内容、bridge 不兼容不启动业务。
6. 执行 focused 测试、真实 Android E2E、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 并记录真实结果。

Gate 证据：release A→B→A 时序、各 guard 前后页面状态、replayable 恢复记录、测试命令和未验证项。
