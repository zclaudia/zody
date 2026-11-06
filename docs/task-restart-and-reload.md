# 任务重启与 /reload（F27）

## 背景

共享进程架构下，Zody 的一个 workspace 只有一个 Agent 进程（按
`workspaceKey = workspaceIdentity?.trim() || workspacePath` 管理）。「重启任务」在进程维度
必然换代整个 workspace 进程：目标任务立即 cold-resume（进程内存态丢失，持久化会话与
task index 保留），同 workspace 兄弟任务不自动恢复、下次访问时按需 cold-resume。该
services 侧契约已由 [restartTask services 切片](../specs/task-restart-service-slice.md)
定义并实现（`IZodyTaskService.restartTask`，commit 45ae1981）。

本 spec 定义 F27 的 UI 主体产品规则：任务菜单「重启任务」、`/reload` 本地斜杠命令、
以及「重启 Agent 进程」恢复确认框。上游 v3.17.1（commit `a60ba6a7`，只读参考）的同名
能力走 CLI 侧 `sessionLifecycle.restart`（graceful，无进程换代）+ faulted 恢复升级确认；
本仓协议层无 `session/restart`，已裁决 slice-first 在 services 层组合实现（详见切片
spec），因此确认框的触发条件按本仓架构重新收敛（见产品规则 4）。

host 范围任务搜索与按未读视图属任务列表改版跟进项，本卡不实施。

## 产品规则

1. **任务菜单「重启任务」**：任务列表项上下文菜单（`TaskActionMenuContent`，经
   `TaskListItemContextMenu` 组合）新增「重启任务」项：
   - 仅对已存在任务提供（草稿态无任务可重启）；沿用 `disableTaskActions` 门禁；
     重启 pending 期间该项禁用并显示「正在重启任务…」。
   - 点击后按规则 4 判定是否需要确认，然后调用 `IZodyTaskService.restartTask`。
   - 成功：任务按 cold-resume 语义续跑，会话历史保留；失败：toast「重启失败，请查看
     任务状态后重试」，不重试、不自动回滚。
2. **/reload 是本地斜杠命令，不进入模型输入**（App 层命令，两个截获点缺一不可）：
   - **面板选中即执行**：`/` 命令面板里选中 `/reload`（App 层命令）时移除输入中的
     `/reload` token 后立即执行（不插入 mention、不进入草稿、不发送）。
   - **提交截获**：提交（Enter/发送按钮）时若文本匹配 `/^\/reload(?:\s|$)/`，在模型
     配置、队列与消息历史处理之前截获：恰好 `/reload` 且满足门禁 → 执行并清空输入；
     带参数（如 `/reload foo`）或不满足门禁（含附件/引用/分享上下文）→ 静默丢弃本次
     提交。任何形态的 `/reload` 文本都不会作为 prompt 发送给模型。
   - 门禁：仅已存在会话（非草稿）、非只读、无附件与各类引用上下文时可用；执行期间
     输入保持 pending。
   - **CLI 同名命令屏蔽**：`/reload` 标记为 recovery 类 App 命令，命令面板合并时
     屏蔽 CLI catalog 同名命令——`/reload` 必须始终本地截获，不得回落到 CLI/模型。
3. **入口统一**：任务菜单与 `/reload` 共用同一重启 hook 与确认判定，语义一致；两者
   都是对当前打开任务操作（`/reload` 作用于当前会话，菜单作用于被右键的任务）。
4. **「重启 Agent 进程」确认框只在资源无法安全释放时出现**（触发条件收敛为单一判定）：
   - 判定：本次重启会中断**目标之外**的进行中工作，即同 workspace 存在
     `status === "running"` 的兄弟任务（目标任务自身的运行轮次不算——中断它正是重启
     的目的）。判定只读 UI 已有的任务列表事实（tasks-index 投影），不为此拉起进程或
     新增服务接口。
   - 无兄弟任务在跑 → 不弹确认，直接重启（不打扰）。
   - 有 → 弹「重启 Agent 进程」确认（标题与描述沿用上游文案语义：任务资源未能安全
     释放，继续会中断所有共用此 Agent 进程的任务，会话历史会保留）；取消/Escape/遮罩
     关闭 = 完全不动作；确认后仍走同一 `restartTask` 单入口（不产生第二条重启写路径）。
   - 上游在「会话订阅 faulted 后的重试升级」路径复用同一确认框；该恢复路径接线不在
     本卡三入口内（见剪枝与非目标），但确认框组件与文案按共享设计，避免二次返工。
5. **重启后任务续跑语义明确**（对用户可感知）：重启成功后当前会话视图按
   `restartTask` 返回的最新 `meta`（`ZodyTaskRestartResult`）收敛，任务列表由既有
   sessions-index 帧驱动刷新；兄弟任务列表态不变、不被自动恢复，用户下次打开它们时
   按需 cold-resume（无需任何手动 reload）。
6. 布局遵循 `DESIGN.md` 与既有确认弹窗响应式规范；i18n zh-CN/en-US 同步补齐。

## 状态唯一所有者

- **重启执行（唯一写路径）**：`IZodyTaskService.restartTask`（services，切片已实现）。
  UI 不直接编排 `disposeWorkspace` / `restartWorkspaceProcess` 来重启任务；
  `restartWorkspaceProcess` 保留给模型/配置变更场景，与任务重启互不借用。
- **重启意图与 pending 所有者**：`useTaskRestart` hook 的 in-flight ref（单例 flight，
  key = `workspaceKey\0taskId`）。菜单 disabled、`/reload` pending、确认框期间重复触发
  共用该状态；不存在第二份 pending 副本。
- **兄弟任务运行态事实所有者**：tasks-index（services 持久化 + syncer 推送），UI 经
  task list 缓存只读判定；确认判定不写任何状态。
- **确认框所有者**：`confirmDialogStore.pendingRequest`
  （`presentation: "workspace-restart-confirmation"`），同一时刻至多一个；沿用
  `useConfirmDialog` / `ConfirmDialogHost` 既有模式（与 yolo-confirmation 同构）。
- **输入草稿所有者不变**：`/reload` 提交截获只读取与清空提交成功后的输入，不产生
  第二条草稿写入路径；面板选中路径只移除 token（既有 App 层命令行为）。
- **无新增持久化**：确认结果不落盘、不写 settings、不进协议。

## 接口与依赖方向

```text
TaskListItemContextMenu / TaskActionMenuContent（「重启任务」项）
ConversationComposer（/reload 面板选中 + 提交截获）──┬─→ useTaskRestart({ taskId, workspacePath, workspaceIdentity, provider? })
                                                     │     ├─ siblingRunning?（task list 缓存只读：同 workspace status==="running" 且 taskId≠目标）
                                                     │     │     ├─ 否 → restartTask
                                                     │     │     └─ 是 → confirmDialogStore.requestChoice("workspace-restart-confirmation")
                                                     │     │                 └─ confirm → restartTask / cancel → 不动作
                                                     │     └→ services.zodyTaskService.restartTask（切片①）→ 进程换代 + cold-resume
                                                     └─ （pending/单 flight/toast/结果收敛）
```

- 依赖方向单向：入口组件 → `useTaskRestart`（`packages/ui/src/hooks/`）→
  `IZodyTaskService.restartTask` + `confirmDialogStore`。纯 renderer 层编排，不触
  进程管理。
- **AppSlashCommand 扩展契约**（`packages/ui/src/slashCommandHelpers.ts`）：
  - 增加可选 `recovery?: boolean`：recovery 命令在 `SlashCommandPlugin` 合并时**屏蔽
    CLI 同名命令**（与既有「CLI 同名优先」规则相反方向，仅对 recovery 类生效），保证
    `/reload` 永远本地截获。
  - `run` 返回类型放宽为 `void | boolean | Promise<void | boolean>`：返回 `false`
    表示执行失败，typed 提交路径据此**不清空输入**（保留草稿供重试）。
- **提交截获契约**（`packages/ui/src/v4/ConversationComposer.tsx` submit 首段）：
  `trimmed` 匹配 `/^\/reload(?:\s|$)/` 时在一切模型配置/队列/历史处理之前分支处理，
  且该分支必须 `return`，绝不落入普通发送路径。
- **确认框 store 契约**（`packages/ui/src/store/confirmDialogStore.ts`）：
  `ConfirmDialogRequest.presentation` 联合类型增加 `"workspace-restart-confirmation"`；
  未声明的既有调用方不受影响。
- **i18n**：`taskList.restart` / `taskList.restarting` / `taskList.restartFailed` /
  `taskList.recoverWorkspace` / `taskList.recoverWorkspaceDescription` /
  `chat.slash.app.reload.description`，zh-CN 与 en-US 同步（语义对齐上游同 key）。
- **E2E 稳定选择器**：`task-restart`（菜单项，对齐上游 testid）、
  `workspace-restart-confirmation`（确认框）。

## 事件顺序

```text
用户动作（菜单「重启任务」 / 面板选中 /reload / typed "/reload" + Enter）
  ├─ 同 key flight 已在进行 ────────────→ 丢弃本次触发（单例，不排队）
  ├─ typed "/reload xxx" 或门禁不满足 ──→ 静默丢弃提交（不发送、不执行）
  ├─ siblingRunning = false ────────────→ restartTask
  └─ siblingRunning = true ─→ requestChoice("workspace-restart-confirmation")
        ├─ 取消 / Escape / 遮罩 ─→ 不动作（输入/菜单状态不变）
        └─ 确认 ─→ restartTask
  restartTask：
    ├─ ZODY_TASK_NOT_FOUND ─→ toast restartFailed（任务已不存在，列表由既有事件收敛）
    ├─ 失败 ─→ toast restartFailed；typed 路径保留草稿（run 返回 false，不清输入）
    └─ 成功 ─→ 结果 meta 收敛当前视图；typed 路径清空输入并持久化草稿；
               兄弟任务不自动恢复（下次访问按需 cold-resume）
```

- typed 截获的时序：文本匹配 → 门禁判定 → 执行 → 成功后**才**清输入（scope/revision
  未变时）；执行期间 composer 进入 pending，禁止重复提交。
- 面板选中的时序：面板项点击 → 移除 `/reload` token → `run()`（同 restartTask 链）；
  面板路径无输入清理问题（token 已被移除，剩余草稿保留）。

## 幂等与并发边界

- **单 flight**：同 `workspaceKey\0taskId` 的重复触发（含菜单连点、Enter 连按、面板
  与菜单混用）复用既有 promise，不重复调用 `restartTask`，不排队。
- **确认 pending 期间**重复触发直接丢弃（确认框单例，沿用 confirmDialogStore 语义）。
- **确认取消后可重试**：无残留状态，再次触发按同一判定重新走。
- **restartTask 本身不内置锁**（切片 spec 规则 8）；并发防护责任在本 hook 的单 flight，
  不新增第二层服务端去重。
- **typed 失败保留草稿**：`run` 返回 `false` 时输入不清空，用户可直接重试；成功清空
  输入与草稿持久化是同一事务（scope/revision 守卫，换代后不误清新 scope）。
- **换代防护**：确认框 pending 期间目标任务/工作区换代 → 确认结算不应用（沿用
  confirmDialog 既有 abort 语义）；flight 完成后的 toast 与结果收敛使用发起时上下文。

## 验收场景（组件级）

| #   | 场景                                                         | 预期                                                                                      |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| A1  | 会话空闲、同 workspace 无 running 兄弟任务，菜单「重启任务」 | 不弹确认；调用 restartTask；成功后视图按结果 meta 收敛，历史保留                          |
| A2  | 同 workspace 有 running 兄弟任务，菜单「重启任务」           | 先弹「重启 Agent 进程」确认（中断提示文案）；取消/Escape/遮罩不动作；确认后才 restartTask |
| A3  | `/` 面板选中 `/reload`                                       | token 被移除、立即执行；不插入 mention、不发送、不进模型输入                              |
| A4  | 输入恰好 `/reload` 后 Enter/发送                             | 提交前截获执行；成功后输入清空；不进入模型配置/队列                                       |
| A5  | 输入 `/reload foo`（带参数）或 `/reload` + 附件/引用         | 静默丢弃本次提交，不发送给模型；附件与草稿保留                                            |
| A6  | CLI catalog 存在同名 `/reload` 命令                          | 面板展示 App 层 `/reload`（recovery 屏蔽 CLI 同名）；仍本地截获                           |
| A7  | 重启 pending 期间重复触发（菜单连点/Enter 连按/两入口混用）  | 单 flight 合并，restartTask 只调用一次；菜单项禁用显示「正在重启任务…」                   |
| A8  | restartTask 失败（网络/进程错误）                            | toast「重启失败，请查看任务状态后重试」；typed 路径草稿保留可重试                         |
| A9  | 重启目标任务自身正在 streaming                               | 不弹确认（目标自身轮次不算），直接重启；重启后该轮次终止并 cold-resume                    |
| A10 | 重启成功后打开同 workspace 兄弟任务                          | 兄弟任务未被自动恢复，打开时按需 cold-resume，会话历史完整                                |
| A11 | 未知/已删除任务触发（含菜单残留、`/reload` 于已删除会话）    | restartTask 抛 ZODY_TASK_NOT_FOUND → toast restartFailed，不弹确认框                      |
| A12 | 手机 390 / 桌面 1200，深浅主题，中英文                       | 菜单项、确认框布局符合 DESIGN.md；无横向溢出、无 pageerror                                |

## E2E 场景清单（按 e2e-case-lifecycle 登记）

用例裁决登记于 [conversation-session case catalog](conversation-session-case-catalog.md)
的 **PA160** 组（accepted = 产品合同，不代表已实现）。可用入口：

- **浏览器组件测试（本卡落点内，组件交互验收主入口）**：
  `packages/ui/test/browser/manual-review/pending/task-restart.test.mjs` + 同名
  `.fixture.tsx`，覆盖 A1–A12（mock `restartTask`，断言调用顺序、确认框 gating 与
  typed 截获），沿用 `permission-full-access.test.mjs` 的 vite + playwright 入口模式。
  未转正前不计为正式 Desktop 通过。
- **services 契约**：`packages/services/test/zodyLegacyTaskCompatTaskIndex.test.ts` 的
  「F27 restartTask」组（切片①已实现）覆盖进程换代顺序、NOT_FOUND、legacy 回退与
  失败传播；UI 组件测试不重复断言 services 语义。
- **桌面 conversation-session E2E（本卡落点外，缺口登记）**：真实进程换代 +
  cold-resume 续跑需 `packages/desktop` E2E（`packages/desktop` 不在本卡落点，本卡仅
  `packages/ui`、`packages/services`、`docs`），由 controller 协调后续卡片或放宽落点
  后实施。
- 手机远控（web-remote-replayable）真实链路、Windows 原生、真实 provider 的 E2E 不由
  组件测试冒充覆盖。

## 剪枝与非目标

- host 范围任务搜索、按未读视图：任务列表改版跟进项，本卡不实施（任务卡明确）。
- 「会话订阅 faulted 后重试升级为 workspace 重启」的接线（上游
  `handleRetrySubscribe` 路径）：不在本卡三入口内；确认框组件与文案按共享设计，后续
  接线时直接复用。
- CUA 操作占用（`hasActiveCuaOperationTurn`）作为确认框触发条件：该信号目前是
  services 内部信号、未暴露 UI，扩展它超出本卡落点；登记为后续裁决项，不在本 spec
  私下扩大触发条件。
- `runtimeEpoch` 基线收敛机制不复活（切片①已裁决死参删除）。
- 不为 restartTask 增加服务端并发锁或队列（单 flight 在 UI hook 层，见幂等边界）。

## 上游来源

上游 commit `a60ba6a7`（只读参考，本仓按现有结构适配，不照抄上游文档结构）：

- `packages/ui/src/app-shell/useWorkspaceSessionReload.ts:188-240`
  （`useSessionRuntimeRestart`：单 flight merge + pending + toast 模式）；
- `packages/ui/src/TaskActionMenuContent.tsx:130-134`（`task-restart` 菜单项与
  disabled 门禁）；
- `packages/ui/src/v4/SessionPane.tsx:2892-2950`（`appSlashCommands` 注入 `reload`
  recovery 命令）；
- `packages/ui/src/SlashCommandPlugin.tsx:98-109`（recovery 命令屏蔽 CLI 同名）、
  `:286-287`（App 层命令选中即执行，移除 token 不发送）；
- `packages/ui/src/v4/ConversationComposer.tsx:785-788`、`:1405-1424`、`:1457-1487`
  （typed `/reload` 提交截获、发送按钮门禁、成功后清输入）；
- `packages/ui/src/v4/SessionPane.tsx:4695-4722` 与 `zh-CN.ts:2914-2920`
  （`recoverWorkspace` 确认框：faulted 恢复升级必须用户明确选择）；
- `packages/services/src/zcode-agent/zcodeAgentService.ts:7173-7182`
  （`restartSessionRuntime` → CLI `sessionLifecycle.restart`；本仓无对应协议，已裁决
  由 services 层 `restartTask` 组合实现，见切片 spec）。
