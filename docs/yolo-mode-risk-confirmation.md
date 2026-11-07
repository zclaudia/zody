# YOLO（完全访问）模式风险确认

## 背景

完全访问模式（菜单 id `yolo`，显示「完全访问 / Full access」）允许任务免逐次确认地执行文件、命令与网络操作（权限语义见 [PA158 审批框完全访问](conversation-session-case-catalog.md)、[危险命令 V1](dangerous-command-approval-v1-plan.md)）。进入该模式的用户体验成本高：一次误开启即放开整类高危操作。

上游 v3.17.1（commit `a60ba6a7`，只读参考）为进入该模式增加了纯 UI 层的风险确认门槛，并接入三个模式切换入口。本 spec 定义本仓的同等语义：**所有用户主动从非 yolo 切换到 yolo 的入口，都必须先通过一次风险确认弹窗；确认前不开启，取消不开启，已处于 yolo 时不再重复弹。**

本特性不改变 runtime 的 yolo 权限判定、投影与 PA158 完全访问授权链路，只是进入该模式的 UI 门槛。

## 产品规则

1. 门槛对象是「用户主动发起的非 yolo → yolo 切换」。三个入口全部接入：
   - **菜单**：Composer 模式菜单（`V4ComposerModeSwitch` 的 `DropdownMenuRadioGroup`）选中 `yolo` 项；
   - **快捷键**：`cycleSessionMode` 命令（默认 Ctrl+Shift+M，可在设置改绑）循环到 `yolo`；
   - **权限对话框**：`PermissionDialog` 中的完全访问选项（`optionId === PERMISSION_FULL_ACCESS_OPTION_ID`，即 `"fullAccess"`）。
2. 弹窗内容（固定信息架构，i18n key 前缀 `mode.yoloConfirmation.`）：
   - 标题「要启用完全访问吗？」与引导说明（启用后无需逐次确认）；
   - 三类风险各一行（图标 + 标题 + 说明）：**文件和文件夹**（读取、创建、修改和删除）、**终端命令**（运行命令、安装软件或修改系统配置）、**网络和应用**（访问网络、发送数据、调用已连接应用）；
   - 风险提示小字（可能造成数据丢失或泄露，仅信任任务时启用，可随时切回）；
   - 勾选框「我已了解风险，并对自己的数据安全负责。」；
   - 「确认启用」按钮在勾选前保持 disabled；取消按钮始终可用。
3. 取消/Escape/遮罩关闭 = 不开启：
   - 菜单/快捷键路径：模式草稿保持原值，`onSwitchMode("yolo")` 不被调用；
   - 权限对话框路径：不发送 fullAccess 应答，原权限请求继续等待用户选择（可改选其他选项）。
4. **不重复弹以「当前模式事实」为准，不持久化「已确认」标记**：
   - 菜单/快捷键入口：当前草稿 mode 已是 `yolo` 时，再次选择 `yolo` 直接放行，不弹窗；
   - 权限对话框入口：会话权威模式（snapshot `config.mode`）已是 `yolo` 时，选完全访问直接应答，不弹窗；
   - 从 `yolo` 切回其他模式后再次进入，必须重新确认；不同 session/workspace 互不继承。
5. 非用户主动进入 yolo 不触发弹窗：会话恢复、快照同步、既有 PA158 授权链路（`SessionModeChanged`）、projection 回放等外部路径不经过本门槛。
6. **弹窗期间不抢输入框焦点**：弹窗打开时接管键盘焦点并默认落在「取消」按钮（安全默认，destructive 确认惯例），不得停留在或回落到 Composer 输入框——否则 Enter/Space 等击键会继续写入输入框或触发发送。弹窗关闭后焦点交回宿主既有路径（菜单路径的 `onCloseAutoFocus` 回输入框等），弹窗自身不额外改写。
7. 弹窗 pending 期间，工具条热键（`cycleSessionMode` / `cycleThoughtLevel` / `openModelMenu`）不触发动作，避免键盘用户在确认未决时继续改状态或触发第二弹窗。
8. 布局遵循 `DESIGN.md` 与既有弹窗响应式规范：桌面紧凑操作区（36px 按钮、8px 间距）；手机（触屏/窄视口）双列等宽触控按钮（≥44px、12px 间距），说明文字遵守手机正文/桌面辅助字号。

## 状态唯一所有者

- **pending 确认请求唯一所有者**：`confirmDialogStore.pendingRequest`（`presentation: "yolo-confirmation"`），由 `ConfirmDialogHost` 渲染；同一时刻至多一个 yolo 确认弹窗。
- **模式草稿所有者不变**：`useDraftConfigControl` / composer 草稿（`docs/plan-mode-independent-state.md`）。确认门只拦截 `onSwitchMode` 回调，确认通过前不写草稿，不产生第二条草稿写入路径。
- **审批应答所有者不变**：`V4InteractionDialogs` → `resolveInteraction`。确认门在 `PermissionDialog.respondWithOption` 内拦截 fullAccess 选项，取消时不发送应答、不清理请求。
- **会话权威模式所有者不变**：runtime 投影（snapshot `config.mode`，desktop continuous 与 mobile replayable 同源）。UI 只读，不用弹窗结果推断会话模式。
- **无新增持久化状态**：确认结果不落盘、不写 settings、不进协议、不写「已确认过」偏好。

## 接口与依赖方向

```text
V4ComposerModeSwitch（菜单 onValueChange / cycle 快捷键）─┐
PermissionDialog.respondWithOption（fullAccess 选项）─────┼─→ useYoloModeConfirmation(scope, currentMode)
                                                           │      → confirm(nextMode, apply)
                                                           │         nextMode !== "yolo" 或 currentMode === "yolo" → 直接 apply
                                                           ▼
                       confirmDialogStore.requestChoice({ presentation: "yolo-confirmation", title }, signal)
                                                           ▼
                       ConfirmDialogHost（yolo-confirmation 专用分支）→ settle confirm / cancel / dismiss
```

- 依赖方向单向：入口组件 → `useYoloModeConfirmation`（`packages/ui/src/hooks/useConfirmDialog.ts`）→ `confirmDialogStore` → `ConfirmDialogHost`。纯 renderer 层，不触 services、协议与 runtime。
- **store 扩展契约**（`packages/ui/src/store/confirmDialogStore.ts`）：
  - `ConfirmDialogRequest.presentation` 联合类型增加 `"yolo-confirmation"`；未声明的既有调用方不受影响。
  - `requestChoice` / `requestConfirmation` 增加可选 `AbortSignal`：目标失效（scope 换代、组件卸载）时 abort，该请求结算为 `dismiss`；abort 只能关闭自己发起的请求，不能结算后来打开的其他确认框。
- **scope 契约**（失效边界，随原状态 owner 的目标换代而变化）：
  - 菜单/快捷键入口：scope 为模式切换回调（目标草稿/任务换代即失效）+ 当前模式；
  - 权限对话框入口：scope 为 workspace/task/request 的应答身份（新权限请求到达即失效）。
  - scope 变化或组件卸载 → `useLayoutEffect` 中 abort pending 弹窗；确认结算与微任务 apply 之间发生的换代同样不应用（apply 前检查 abort）。
- **currentMode 来源**：菜单/快捷键入口 = 草稿 `draftConfig?.mode`；权限对话框入口 = 会话权威模式，由 `V4InteractionDialogs` 从当前 snapshot `config.mode` 传入（PermissionDialog 不自取 store，维持 store 耦合剥离）。
- **弹窗渲染**：`ConfirmDialogHost` 内 `yolo-confirmation` 专用分支渲染三类风险列表与本地勾选状态，复用既有 per-request checkbox 重置机制（勾选状态属于单次请求，关闭再开必须重新勾选）。E2E 稳定选择器：`yolo-confirmation-dialog` / `yolo-confirmation-risk` / `yolo-confirmation-cancel` / `yolo-confirmation-confirm`。
- **i18n**：`mode.yoloConfirmation.title / .description / .files(.description) / .commands(.description) / .network(.description) / .risk / .acknowledgement / .confirm`，zh-CN 与 en-US 同步补齐。

## 事件顺序

```text
用户动作（菜单选 yolo / 快捷键循环到 yolo / 审批框选完全访问）
  ├─ currentMode === "yolo" ────────────────→ 直接 apply（不弹窗：已在完全访问态）
  ├─ 已有 yolo 确认 pending ─────────────────→ 丢弃本次动作（单例守卫，不排队）
  └─ requestChoice(presentation="yolo-confirmation", signal)
        ├─ 未勾选：确认按钮 disabled（可反复勾选/取消勾选）
        ├─ 取消按钮 / Escape / 遮罩 ─→ settle cancel|dismiss ─→ 不 apply
        ├─ scope 换代 / 组件卸载 ────→ abort → settle dismiss ─→ 不 apply
        └─ 勾选 + 确认 ──→ settle confirm ─→ 微任务提交 apply（abort 已发生则跳过）
              ├─ 菜单/快捷键：onSwitchMode("yolo") → 写模式草稿（下一次 submission 生效，Plan 标记不被动）
              └─ 审批框：onRespond(requestId, fullAccess 选项) → runtime SessionModeChanged → 会话 yolo（PA158 链路）
```

- 菜单路径的时序：菜单项点击 → 菜单关闭（`onCloseAutoFocus` 试图回焦输入框）→ 确认弹窗打开（`onOpenAutoFocus` 覆盖，焦点落取消按钮）。弹窗焦点必须赢过菜单的回焦。
- 审批框路径的时序：fullAccess 选项点击 → 确认弹窗叠加在权限对话框之上 → 取消则回到权限对话框继续等待；确认则发送应答、权限对话框按既有链路清理。

## 幂等与并发边界

- **单例**：hook 内 pending ref + store `pendingRequest.presentation` 检查双重守卫；确认进行中重复触发（含快捷键连按）直接丢弃，不排队、不替换。
- **apply 至多一次**：`settleChoice("confirm")` 只结算一次；abort 之后即使 confirm 竞态到达也不应用。
- **勾选属单次请求**：按请求对象引用比对（既有 `checkboxSelection` 机制），关闭后再开不沿用上次勾选。
- **yolo 态内重复选择幂等**：已在 yolo 时再次选择 yolo 不弹窗、不重复写入。
- **热键静默**：yolo 确认 pending 期间工具条热键不触发任何动作（含思考深度与模型菜单，避免连锁弹窗）。
- **审批框取消后可重试**：同一权限请求仍在 pending，用户可再次选 fullAccess（重新弹确认）或改选其他选项；不悬挂、不重复应答。
- **不同入口互不干扰**：确认门是入口局部回调拦截，共享的只有单例弹窗 store；任何入口的确认不替其他入口写状态。

## 验收场景（组件级）

| #   | 场景                                                              | 预期                                                                                          |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A1  | 草稿为 build/guarded/edit 时菜单选择「完全访问」                  | 先弹 yolo 确认弹窗；草稿保持原值；勾选前「确认启用」disabled                                  |
| A2  | 弹窗打开时焦点                                                    | 焦点落「取消」按钮，不在 Composer 输入框；三类风险说明、风险小字、勾选文案齐全且 i18n 正确    |
| A3  | 未勾选点确认 / 勾选后取消勾选                                     | 确认按钮始终 disabled；勾选状态只影响按钮可用性                                               |
| A4  | Escape / 遮罩 / 取消按钮                                          | 弹窗关闭，模式不变（不开启）                                                                  |
| A5  | 勾选 + 「确认启用」                                               | 菜单路径：草稿切为 yolo 且 planEnabled 等其他草稿字段保持；审批框路径：发送 fullAccess 应答   |
| A6  | 草稿已是 yolo 时菜单再选 yolo                                     | 不弹窗（不重复弹）                                                                            |
| A7  | 从 yolo 切回其他模式再进 yolo                                     | 重新弹确认                                                                                    |
| A8  | 快捷键循环到 yolo（默认 Ctrl+Shift+M）                            | 与菜单同语义：先弹确认；取消不写入草稿                                                        |
| A9  | 确认 pending 期间按工具条热键（模式循环/思考深度）                | 不触发任何动作                                                                                |
| A10 | 审批框选完全访问：取消 → 改选「允许本次」；确认 → 发送 fullAccess | 取消后应答不发送、权限弹窗保持；确认后应答为 fullAccess；会话已 yolo 时选完全访问直接应答不弹 |
| A11 | 确认 pending 期间目标换代（任务/草稿回调/权限请求变化）           | 弹窗自动关闭且不应用（stale 防护）；新目标重新触发时再弹                                      |
| A12 | 手机 390 / 桌面 1200，深浅主题，中英文                            | 布局、字号、触控按钮尺寸符合产品规则 8；无横向溢出、无 pageerror                              |

## E2E 场景清单（按 e2e-case-lifecycle 登记）

用例裁决登记于 [conversation-session case catalog](conversation-session-case-catalog.md) 的 **PA159** 组（accepted，产品合同，不代表已实现）。可用入口：

- **浏览器组件测试（本卡落点内，组件交互验收主入口）**：`packages/ui/test/browser/manual-review/pending/yolo-confirmation.test.mjs` + 同名 `.fixture.tsx`，矩阵 390/1200 × 深浅主题 × zh-CN/en-US，覆盖 A1–A12；沿用 `permission-full-access.test.mjs` 的 vite + playwright 入口模式。未转正前不计为正式 Desktop 通过。
- **桌面 conversation-session E2E（F26④ 落地，controller 放宽落点）**：controller 经 F26④前置（commit a550ed627 适配 `switchV4Mode` helper）将本步落点放宽至 `packages/desktop/test/e2e/`。F26④ 落地两处（均 manual-review/pending，人工评审与转正未完成，不计为正式 Desktop 通过）：
  - 新增 `conversation-session-yolo-confirmation.test.ts`（镜像上游 `YC01/02/07`，对应 PA159-01/02/03）：**菜单 + `cycleSessionMode` 快捷键**两入口——取消/Escape 后模式不变、勾选前确认按钮 disabled、快捷键 pending 期间热键静默、Space 反选后 Enter 不确认、确认后进入 yolo；配套 case manifest 与 provider fixture（`noProviderRequests`，纯 UI）。
  - PA158 既有 pending 用例补「先确认一次」步骤（**权限对话框入口**，对应 PA159-04）：fullAccess 点击先弹确认，取消/未确认期间断言审批仍 pending（应答未发送、会话模式与队列不变、目标文件未写出），确认后走 PA158 既有 fullAccess 授权链路；同段按上游正式版适配 `build` 起点与 `edit→guarded`（菜单已隐藏 edit，旧步骤在授权前超时）。
  - 执行证据（replay 模式，无真实 provider）：两个 spec 均真实运行通过；针对性反例（临时移除确认步骤）实证 fullAccess 点击后应答被确认门拦截、任务停在「Awaiting approval」直至超时。
- 手机远控（web-remote-replayable）真实链路、Windows 原生、真实 provider 的 E2E 不由组件测试冒充覆盖，维持 PA158 既有缺口口径。

## 剪枝与非目标

- automation / off-peak 设置表单的模式选择不在本卡三入口内（上游已接入该表面；本卡按任务卡范围剪枝，后续单独评估是否接入同一 hook）。
- 不改 runtime yolo 权限语义（危险命令、MCP、readonly 判定等），不改 PA158 投影与授权链路。
- 不新增「已确认过」持久化偏好或按 workspace 记忆；不做管理员策略开关。
- 不为旧版本会话回填确认状态。

## 上游来源

- 上游 commit `a60ba6a7`（只读参考，本仓按现有结构适配，不照抄上游文档结构）：
  - `packages/ui/src/hooks/useConfirmDialog.ts`（`useYoloModeConfirmation`：单例守卫、scope abort、apply 时机）；
  - `packages/ui/src/store/confirmDialogStore.ts`（`presentation` 联合类型 + `AbortSignal` 支持）；
  - `packages/ui/src/ConfirmDialog.tsx`（`yolo-confirmation` 分支：三类风险、勾选、焦点、响应式布局）；
  - `packages/ui/src/v4/composer/V4ComposerModeControls.tsx`、`v4/composer/toolbarShortcuts.ts`（菜单/快捷键入口与热键静默）、`PermissionDialog.tsx`（审批框入口）；
  - `packages/ui/test/browser/manual-review/pending/yolo-confirmation.test.mjs`（组件验收场景参照）。
