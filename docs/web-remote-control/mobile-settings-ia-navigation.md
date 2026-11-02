# 手机远控设置：信息架构、导航与连接分区

范围：`packages/web/mobile.html` 已连接手机首页、聊天页、共享应用设置 `SettingsPage`，以及 `SettingsPage` 内仅手机 Web Remote Control 可见的连接分区。首次配置、Root 外 StartPage、桌面设置和现有设置持久化不在重写范围内。

关联规格：[手机视口、输入与触控](mobile-viewport-input-and-touch.md)、[设置页侧栏布局](../ui/settings-sidebar-layout.md)。

## 1. 产品规则

### 1.1 单一设置入口，两个状态所有者

- 已连接首页和聊天页共用同一个齿轮菜单，菜单只保留一个“设置”入口，进入现有 `SettingsPage`；不再让用户在“应用设置/连接设置”两个动作之间选择。
- `SettingsPage` 在既有的常规分区之外，增加仅手机 Web Remote Control 可见的“连接”分区，包含 Gateway URL、namespace 与设备凭证。分区只在 `isWebRemoteControl && (max-width: 767px)` 且连接能力已注入时出现；桌面和普通 Web 不显示。
- **界面统一不合并状态所有者**：连接配置仍由 `MobileRemoteConfigStore` 唯一持久化；凭证仍走 `secureStore`、不回显，不进入普通 settings store、`tabStore`、history 或日志。保存继续走现有 `saveMobileRemoteSettingsDraft` 与 `scopeChanged` 判定，不新增第二写入路径。
- 桌面 `remoteAccess` 与手机连接配置仍是不同领域，不合并 store 或页面。
- 首次配置、不可恢复失败页、backend picker 和 Root 外 StartPage 继续使用现有独立连接设置页，不为了形式统一增加不可用的应用设置入口。

### 1.2 手机设置信息架构

```text
首页 / 聊天页齿轮菜单
  └─ 设置 → 设置首页 → 分区页 → 分区内部详情
                └─ “连接”分区（仅手机 Web Remote Control）
                     └─ Gateway URL / namespace / 设备凭证
```

- 手机模式只在 Web Remote Control 且 `(max-width: 767px)` 成立时启用；桌面和普通窄窗口保留现有图标/文本侧栏。
- 普通打开落在设置首页，不因最近访问分区跳过列表；显式 section/provider intent 直达目标分区，但第一次返回仍先回设置首页。
- 设置首页直接复用 `settingsSectionGroups`，使用完整文字、分组标题和 chevron，不复制分区配置，不使用 68px 图标侧栏。
- 分区页继续渲染现有业务 section。Provider 使用列表 → 详情；Shortcuts 使用纵向命令卡片；不得把桌面双栏和固定表格直接压缩到手机宽度。
- 手机外壳使用 `100dvh`、safe area、单一主滚动区和至少 44×44px 的触控命中区。普通设置行标签在上、控件在下；桌面密度不变。

## 2. 状态所有者

| 状态                        | 唯一所有者                                      | 约束                                                            |
| --------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| 应用设置是否覆盖 workspace  | `tabStore` / `RootWorkspaceContent`             | 底层 App 常驻、`inert`，不重建聊天、终端或草稿                  |
| 当前设置分区                | `SettingsPage.activeSection`                    | 不搬入 MobileShell、history 或新 store                          |
| 手机设置首页/分区投影       | `SettingsPage` 内手机导航 hook                  | history 只投影和恢复，不成为第二份业务状态                      |
| 一次性 intent、最近分区     | `settingsNavigation.ts`                         | 保留现有消费、清理和平台可见性回退                              |
| Provider 选中节点与表单草稿 | `ModelProviderSection` 及现有子组件             | 返回列表不清空选择、不重建业务状态                              |
| 各资源编辑器状态            | 各业务 section                                  | 继续通过 `SettingsBreadcrumbReporter` 投影返回动作              |
| 手机连接配置                | `MobileRemoteConfigStore`                       | 初始设置和设置页分区共用同一校验/保存 helper                   |
| 连接设置表单草稿            | `WebRemoteControlMobileConnectionSettingsSection` | 凭证不回显；取消只丢弃本次未保存输入                            |
| 连接能力注入                | mobile bootstrap → `Root` 的显式 props           | packages/ui 不 import packages/web；只经公开入口注入 save/reconnect |
| 连接变化后的会话重建        | mobile bootstrap `reopenSetup("auto")`           | 只有有效连接变化才调用，且恰好一次                              |

`packages/ui` 不得 import `packages/web`。连接分区的 Gateway/namespace/凭证数据、保存函数和重连动作都由 mobile bootstrap 通过 `Root` props 注入；UI 只负责表单、校验和分支顺序。

## 3. 应用设置 history 与返回

设置使用独立 history 类型，不复用 `featurePage`。条目可记录 `index`、`section` 和可稳定恢复的 detail key；不得记录表单草稿、凭证或 Provider 配置。

### 3.1 打开

```text
首页/聊天页“设置”
  → openSettingsTab()
  → 保留 home/chat 宿主条目
  → push 设置首页
  → 显式 intent 时再 push 目标分区
```

普通入口与 QuickPick、模型管理、Hook 审核等上下文入口共用同一挂载逻辑，不能只有菜单入口具有正确返回语义。

### 3.2 逐层返回

```text
分区页 UI 返回 / Android 返回
  → 只执行一次 history.back()
  → popstate(settings index)
  → SettingsPage 投影为设置首页
  → MobileShell 忽略 settings 条目，不修改 home/chat/featurePage

设置首页 UI 返回 / Android 返回
  → 只执行一次 history.back()
  → popstate(home/chat)
  → 关闭 settings tab，恢复原 workspace tab
  → 原 Root、草稿、滚动位置和后台订阅保持
```

- `popstate` 只回写状态，绝不再调用 `pushState`、`replaceState` 或 `history.back()`。
- 仅实际发生 `chat → home` 时刷新任务首页；从聊天打开设置再返回聊天不触发无意义刷新。
- 分区内部详情先返回其父级，再返回设置首页。刷新或前进不得复活已失去业务状态的临时编辑器；只能回落到可恢复父级。
- 离开设置打开插件商店等其他主视图时，必须回收设置 history，不能留下后续返回复活旧设置的废条目。
- 设置覆盖期间，后台 permission、task 和 replayable 投影继续更新，不强制切回会话。

## 4. 设置页连接分区

### 4.1 生命周期

```text
打开“连接”分区
  → 仍挂载在同一 SettingsPage / Root
  → transport、requester、bridge、lifecycle 继续存活

取消 / 分区返回
  → 只回设置首页
  → 不 disposeSession、不 reopenSetup、不重新解析连接

保存失败
  → 留在连接分区，保留本次草稿，错误在提交动作附近可见

无有效变化保存成功
  → 回收设置 history 并返回设置首页，不重连

有效连接变化保存成功
  → 先按真实返回语义回退设置条目（分区 go(-2) / 首页 go(-1)）到宿主条目
  → 等 popstate 落回宿主后，再执行一次现有 reopenSetup("auto")
```

- 顶部返回、浏览器/Android 返回与 Cancel 等价：离开连接分区回到设置首页时必须丢弃本次未保存输入。分区在 index 下只隐藏不卸载，因此由 `SettingsPage` 的返回投影递增 reset token 触发清理，不能只在 Cancel 按钮里处理。
- 只有保存有效 Gateway/namespace/credential 等连接变更时才允许销毁并重建当前 session。
- 初始设置与设置页分区共用 draft 校验、scopeChanged 判定和 `store.save` helper；不得增加第二写入路径。
- 凭证不回显：表单只根据 `credentialConfigured` 提示“已保存”，草稿里的新凭证仅在本次提交内使用；错误、日志和 history 均不得包含凭证。
- 首次配置、不可恢复失败页、backend picker 和 Root 外 StartPage 继续走现有独立 setup 流程。
- 不改变 `MobileRemoteConfigStore` 存储格式、secureStore、backend discovery、owner/lease 或 relay 协议。

## 5. 验收场景

| 编号 | 场景                     | 通过标准                                                                                       |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| M1   | 已连接首页/聊天页入口    | 齿轮菜单只有一个“设置”动作；进入共享 SettingsPage，不再出现独立连接设置菜单项                   |
| M2   | StartPage                | 只有连接设置，无应用设置入口                                                                   |
| M3   | 普通打开与最近分区       | 手机普通打开落在设置首页；桌面仍直接进入现有分区                                               |
| M4   | 显式深链                 | section/provider intent 直达目标；第一次返回先回设置首页                                       |
| M5   | 逐层返回                 | detail → section → 设置首页 → 原 home/chat；浏览器和 Android 返回无回环、无双重导航            |
| M6   | 工作区保持               | 设置打开和返回不重建 Root；聊天草稿、滚动、后台 task/permission 投影保持                       |
| M7   | 手机布局                 | 320/360/390/767px 无横向挤压；设置首页无图标侧栏，普通行单列，Provider 与 Shortcuts 有专门布局 |
| M8   | 触控与桌面回归           | coarse-pointer 可点击命中区 ≥44×44px；768px 与桌面现有密度、侧栏不变                           |
| M9   | 主题与 i18n              | Zai Light/Zai Dark、中英文长文案不遮挡，焦点与读屏语义完整                                     |
| M10  | 键盘与安全区             | `100dvh` 不裁切；输入、错误和提交动作可见；safe area 与 keyboard inset 不重复补偿              |
| M11  | 连接分区平台可见性       | 仅手机 Web Remote Control 出现“连接”分区；桌面和普通 Web 的分区列表与既有行为不变               |
| M12  | 凭证安全                 | 已保存凭证不回显；取消后草稿不保留；表单、错误、history 和日志不含凭证原文                     |
| M13  | 连接分区取消/保存失败    | Cancel、顶部返回、浏览器/Android 返回都丢弃草稿且不 dispose/不重连；保存失败留在分区并保留草稿 |
| M14  | 无有效变化保存           | 保存成功只回设置首页，不重建 session                                                           |
| M15  | 有效连接变化             | 先回退设置条目到宿主，popstate 落回后只重连一次；不留下可复活旧分区的废条目                     |
| M16  | 业务回归                 | Provider 保存/删除/测试、Shortcuts 录制/冲突/清除和各资源设置仍走原 handler 与持久化           |

jsdom 结构断言不能替代 M5、M8、M10 的真实浏览器/设备验证。当前环境无法覆盖的 iOS Safari 或 Android WebView 项目必须明确记录，不能写成已通过。
