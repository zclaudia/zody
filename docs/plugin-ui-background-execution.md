# MCP 后台页面生命周期

状态：领域 spec，2026-10-24。对应上游 v3.16.2 移植 I20；决策口径见 `docs/plans/upstream-v3.16.2-implementation-plan.md` §3「待决规则决策记录」（C5）。本文只定义页面生命周期与锚点关系的差异规则，通用能力边界仍以 `packages/ui/src/plugin-ui/CONTRACT.md`、`packages/desktop/src/main/pluginSandbox/CONTRACT.md` 和 `docs/plugin-ui-connection-readiness.md` 为准。

> **2026-11-07 F18 增补（上游 v3.17.1 a60ba6a7）**：§12 定义「后台页面保留策略」并**修订取代** §2/§4/§6.1/§7/§8 中与之冲突的条目（逐条见 §12.1）；冲突处以 §12 为准，未列条目继续有效。§11 为其 Agent 端 busy 通道（已实现）。

## 1. 背景与缺口

窗口级页面 owner 现在把「不可见」当成可回收信号：

- `pluginUiPageManager.ts:101-108`：`visibility(page, false)` 启动 5 分钟定时器，到点且非忙即 `page.suspend()`。
- `pluginUiPageManager.ts:110-113`：`settled(page)` 在页面不可见且非忙时立即 `page.suspend()`。
- `pluginUiManagedPage.ts:352-382`：`suspend()` 不是暂停渲染，而是 `tryRecycle()`（Agent 原子确认空闲后关闭实例）→ `controller.dispose()` → 撤 feed/租约 → `unmount` guest。收起卡片、滚出视口或回合结束都会销毁页面和 guest。
- 容量路径也以 suspend 为淘汰手段：30 task 的 LRU 淘汰（`pluginUiPageManager.ts:33-55`）与 64 allocated 的候选回收（`:66-88`）。

这与「后台执行表面」冲突：卡片、侧栏 tab 和工具结果只是页面锚点；收起/切换位置/回合结束不代表页面没有工作。MCP App 在无锚点时仍可能执行页面工具调用、采样、资源订阅或等待后续通知。

## 2. 已决口径（2026-10-24，用户确认）

1. 废除「settled 且不可见立即 suspend」。
2. 页面/guest 销毁仅由显式删除、显式重载、来源失效驱动。
3. 容量沿用 30 task / 64 allocated；超限拒绝新页面并提示，不再因容量淘汰或回收现有页面。
4. 离屏 5 分钟定时器与 Main sandbox TTL 6h 随语义重审，结论见 §6。

## 3. 状态所有者

| 状态                           | 唯一 owner                                                    | 其他层职责                                                                      |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 页面、controller、guest 与锚点 | Renderer 窗口级 `PluginUiPageManager` + `pluginUiManagedPage` | 卡片/侧栏只登记可见性，不创建、不销毁页面                                       |
| MCP 连接任务、代际与 lease     | 既有 adapter/pool 与 `McpUiInstances`                         | 页面只在 lease 有效时存活；等待/重验见 `docs/plugin-ui-connection-readiness.md` |
| 沙箱登记、端口与原生执行       | Main `pluginSandbox` registry/guestPolicy                     | 只执行受控原生活动；不做业务回收                                                |
| widgetState                    | 宿主内存 store                                                | 手动重试、任务淘汰、来源撤销清除；应用重启为空                                  |

同一逻辑页面键（`buildPluginUiSurfaceKey`：workspace identity/session/plugin/server/resource/逻辑视图）在窗口内只有一个 page owner。卡片、侧栏和后台结果经 `usePluginUiHost` 落到同一 owner，创建去重由 `pluginUiPageRegistry.ts:60-84` 的单一 `creating` promise 与页面管理器的串行 admission 共同保证。

## 4. 生命周期规则

1. **可见性不是销毁信号**：`visibility(page, visible)` 只记录锚点状态并影响展示/承载层位置；不得启动定时 suspend、不得 `removeTask`、不得触发容量回收。
2. **无锚点继续执行**：页面不可见时保持 controller、guest、lease 和资源订阅。页面工具调用/采样结束只更新 busy 观测，不销毁页面；`settled()` 不再触发 suspend。
3. **返回复用原 guest**：锚点在离屏后重新出现时，直接复用当前 owner 与 guest，不重新 `prepareSandbox`、不重读 `ui://` 资源、不重新握手。只有显式重载才重建 guest。
4. **显式撤销后不复活**：以下事件是唯一销毁入口。
   - 显式删除：任务删除（`workspace_task_list_changed`/`task_deleted`，`pluginUiManagedPage.ts:276-286`）、窗口销毁。
   - 显式重载：`reload()` → `suspend(true)` → `ensure()` 建新 controller；旧代际的迟到 prepare/端口/结果只作用于捕获的原实例。
   - 来源失效：实例/连接撤销（`onInstanceClosed`，`pluginUiManagedPage.ts:257-261`）、runtime 停止；进入 error 终态，不自动重建。
   - `removeTask` 先取消同任务的排队创建，再 destroy 页面；迟到的 `reserve`/定时器/可见性清理不得重新占用或改写替换页面。
5. **容量硬上限**：每个窗口最多 30 个 task、64 个已分配（allocated）页面。admission 仍串行；超限时拒绝新页面的准入并返回明确错误供 UI 提示，不 suspend/evict 现有页面。
6. **非本地端无副作用**：存在 `remoteSessionId` 或远端 workspace identity、或平台缺少 `pluginSandbox`/`pluginUiBridgeService` 时，`usePluginUiHost` 给出 `supported:false` 且不调用 `acquirePluginUiPage`（`usePluginUiHost.ts:21-30`、`:49-57`）。手机/Web/远端不创建本地 guest、不登记 Main 沙箱，回退普通 MCP 卡片。

## 5. 事件顺序

```text
卡片收起 / 滚出视口 / 回合结束
  → plane.visibility(false)（只记录 visible）
  → 页面保持 controller + guest + lease，后台通知/页面工具调用继续

锚点返回
  → plane.visibility(true)
  → 同一 page owner / snapshot / 原 guest；不 prepare、不重读资源

显式删除（task_deleted / 窗口销毁）
  → pageManager.removeTask
  → 取消同任务排队 add
  → page.destroy → suspend(true) → controller.dispose
  → 撤销 lease/端口/guest；changed(key) 通知锚点

显式重载
  → clear widgetState → suspend(true)（旧代际整体撤销）
  → ensure()：新 controller；旧 prepare/端口/结果丢弃

来源失效
  → onInstanceClosed → suspend(true) → phase=error（终态，不自动重建）

容量
  → add/reserve 串行准入
  → 已达 30 task / 64 allocated → reject("...capacity reached")
  → UI 提示；不 suspend/evict 现有页面
```

## 6. 定时器与 TTL 复核结论

### 6.1 离屏 5 分钟定时器（Renderer）

**结论：删除该定时器的销毁语义。** 「没有锚点」不等于「没有工作」；后台执行可能持续任意时长，5 分钟回收会把正常页面当成缓存淘汰。资源上界由 §4.5 的准入硬上限、显式撤销和调度器/窗口关闭保证。实现可以移除定时器，或保留为无副作用的观测，但不得再调用 `suspend()`。

### 6.2 Main sandbox TTL 6h（Desktop）

**结论：保留 6 小时 TTL，但收窄含义。** TTL 只清理「已 prepare、从未挂载/泄漏」的登记（`registry.ts:93-97` 只清 `pinned === 0`）。guest 挂载即 `pin`（`guestPolicy.ts:100-108`），后台页面的 webview 即使无锚点也停在隐藏承载层并保持挂载（`pluginUiPagePlane.ts:102-106`），因此活页面不会被 6h TTL 销毁。Main 不以 TTL 作为业务回收信号，Renderer 仍是页面业务回收 owner。

容量满时 Main 直接抛 `PluginSandboxQuotaError`（`contract.ts:76-81`，文案含「插件界面数量已达上限」，供 UI 提示），不淘汰活实例。

### 6.3 迟到挂载

「撤销后不复活」还要求：清理/撤销开始后到达的 guest attach 必须被停止，并纳入清理完成前的等待集合。2026-10-24 记录时 `host.ts` 只 fire-and-forget 停止、不进入 `clearBrowserData` 的等待集合；**2026-11-07（F18③ 定向验证步）已修复**：迟到停止进入 `lateStops` 等待集合，`clearBrowserData` 在 `clearStorageData` 前排空该集合（反例 `clearOrder.test.ts` 转绿；上游 a60ba6a7 同位置仍是 fire-and-forget，本修复为本仓 spec 驱动差异）。

## 7. 失败矩阵

| 场景                                    | 结果                       | 页面/guest         |
| --------------------------------------- | -------------------------- | ------------------ |
| 卡片收起、回合结束、滚出视口            | 保持运行，后台结果继续投递 | 保留               |
| 离屏超过 5 分钟                         | 保持运行                   | 保留               |
| 锚点返回                                | 复用原 owner/guest         | 保留，不重建       |
| 页面工具调用 settle（无锚点）           | 只更新 busy，不回收        | 保留               |
| 第 31 个 task / 第 65 个 allocated 页面 | 拒绝新页面并提示           | 现有页面全部保留   |
| 任务删除                                | 取消排队创建、撤销页面     | 销毁，迟到结果丢弃 |
| 显式重载                                | 旧代际撤销，新代际建立     | 新 guest           |
| 来源失效                                | error 终态                 | 销毁，不自动重建   |
| 手机/Web/远端或缺少沙箱平台             | 普通 MCP 卡回退            | 无本地 guest       |
| 清理开始后迟到 guest attach             | 停止并等待后清理           | 不复活             |

## 8. 验收场景（反例）

- 卡片与后台结果并发：同一逻辑键只允许一个 owner；容量超限拒绝新任务，不销毁现有页面。
- 无锚点继续执行：`settled` 与 5 分钟离屏都不 suspend。
- 返回复用原 guest：离屏 15 分钟后重新可见，仍是同一 page owner，未 suspend/重建。
- 删除/重载/失效后撤销不复活：`removeTask` 取消排队准入；迟到的端口/结果不重新挂载。
- 手机/Web/远端无创建副作用：`supported:false` 且不进入 `acquirePluginUiPage`。
- 容量：64 allocated 满后第 65 次 reserve 拒绝且不回收活页面；Main 64 登记满后拒绝新登记且保留 pinned 页面。
- TTL：pinned 后台页面跨过 6h 仍存在；从未挂载的 prepare 登记按 6h 过期。
- 清理/撤销后的迟到 guest attach：`clearStorageData` 必须等待其停止。

对应测试：

- `packages/ui/src/plugin-ui/adapters/sandboxPageOwners.test.ts`：手机/Web/远端与远端 workspace identity 不进入页面创建（`createPage` 零调用）。
- `packages/ui/src/plugin-ui/app/pluginUiPageManager.test.ts`：无锚点/5 分钟/返回、并发准入、30/64 硬上限、删除后不复活。
- `packages/ui/src/plugin-ui/app/pluginUiHostController.test.ts`：显式撤销后迟到端口/结果不复活。
- `packages/desktop/src/main/pluginSandbox/hostLifecycle.test.ts`：pinned 后台页面跨 TTL、64 容量拒绝不淘汰。
- `packages/desktop/src/main/pluginSandbox/clearOrder.test.ts`：撤销/清理开始后的迟到 guest 必须停止并等待。

## 9. 验证记录

2026-10-24（实现前，反例先行）：

- 说明：仓库根 `pnpm exec vitest run <上述路径>` 当前不会命中测试文件——根 `vitest.config.ts` 的 include 仅覆盖 `packages/*/test/**` 与 `packages/*/src/**/contract.test.ts`，`packages/desktop` 的 vite config `root` 指向 `src/renderer`。两条根命令均返回 `No test files found, exiting with code 1`。因此定向执行使用包内配置/`--root`，未修改测试配置（根 `vitest.config.ts` 属手机远控工作线的未提交改动）。
- UI：`cd packages/ui && pnpm exec vitest run src/plugin-ui/app/pluginUiPageManager.test.ts src/plugin-ui/app/pluginUiHostController.test.ts` → 2 files / 15 tests，**5 failed / 10 passed**。失败全部是 I20 新语义反例：离屏 5 分钟仍 suspend、settle 后立即 suspend、第 31 个 task 通过淘汰被接纳、第 65 次 reserve 通过回收被接纳、并发下 30 task 超限仍接纳新任务。controller 的撤销后迟到端口/结果守卫已通过。
- 非本地端守卫：`cd packages/ui && pnpm exec vitest run src/plugin-ui/adapters/sandboxPageOwners.test.ts` → 1 file / 3 tests passed。手机/Web 缺平台、远端会话与远端 workspace identity 均 `supported:false` 且 `createPage` 零调用（现有结构已满足，无需红测）。
- Desktop：`cd packages/desktop && pnpm exec vitest run --root . src/main/pluginSandbox/clearOrder.test.ts src/main/pluginSandbox/hostLifecycle.test.ts` → 2 files / 14 tests，**1 failed / 13 passed**。失败为清理开始后迟到挂载 guest 未被等待（§6.3）；TTL 与 64 容量两条守卫已通过（现有 Main 边界已满足结论）。

## 10. 保持不变

- 连接等待、lease/generation、会话重验和并发 open 单实例：沿用 `docs/plugin-ui-connection-readiness.md`。
- 显式释放顺序（失效凭证 → 取消调用/登记 → resource-teardown → 关闭端口/guest → 释放 feed/lease）不变。
- Main 不执行 MCP 权限策略，不保存会话、队列或 widgetState；Renderer 不直接接触插件 HTML、数据库或连接凭据。
- `continuous` 与 `replayable` 的协议语义、CommandInbox/admission、Host owner/lease 边界不变。
- Gen UI 复用同一窗口管理器与准入上限；Gen UI 自己的「有锚点才建 guest」规则（`gen-ui/adapters/retainedPage.ts:72-83`）不变，本项的离屏不销毁规则同样适用于其已存在的 owner。

## 11. 沙箱执行忙闲通道 `mcp/uiSetExecutionActive`（F18 通道切片，2026-11-07）

上游 v3.17.1（a60ba6a7）`pluginUiBackgroundRetention` 要求「busy 不回收」参与 Agent 端回收裁决。本仓实例凭证与 `onlyIfIdle` 裁决的唯一 owner 在 Agent（`McpUiInstances.isBusy`），沙箱侧执行信号必须经协议会话方法到达该 owner。本节只定义通道契约；保留/回收策略本身（上限 4 页、闲置 30 分钟淘汰、最小化暂停计时、claim/finish 预占、可见且有锚点自动重建）由 F18 后续策略步骤另行扩写本 spec。

### 11.1 接口

- 方法：`mcp/uiSetExecutionActive`（`zodyProtocolMethods.mcpUiSetExecutionActive`），params/result 契约注册于 `zodyProtocolSessionMethodContracts`。
- params：实例 scope（`instance` + `workspace` + `sessionId` + `pluginId` + `serverName`，与 `mcp/uiCloseInstance` 同形）+ `active: boolean`（必填）。
- result：`{}`（空对象，与 `mcp/uiValidateInstance` 同形）。

### 11.2 状态所有者与裁决

- `executionActive` 布尔的唯一落点是 Agent 侧 `McpUiInstances` 实例登记（`apps/zody-cli/packages/bootstrap/src/zody-protocol/mcp-ui/instances.ts`）；UI / Main 不保存副本、不写第二份。
- `isBusy` = 工具调用 pins ∪ `executionActive`；`mcp/uiCloseInstance` 的 `onlyIfIdle` 裁决据此返回 `closed:false`，复用现有唯一裁决路径，不另建第二条回收裁决。
- 幂等与代际：重复同值上报为无变化；实例关闭或换代即随登记消失，不跨代继承、不跨实例串扰。

### 11.3 fail closed

- 凭证与 scope 校验同 `mcp/uiValidateInstance`：token/runtimeId/generation/appIdentity、workspace/session/plugin/server、当前连接 identity/generation 全部匹配才生效；不匹配抛错，且不得改写其他实例的 busy 状态。
- 实例未知（已关闭/已换代）时上、下置均抛错，不静默成功（与上游 sandbox `setExecutionActive` 的 fail closed 口径一致，来源 a60ba6a7 `packages/desktop/src/main/pluginSandbox/host.ts`）。

### 11.4 验收场景（反例）

- `active:true` 后 `mcp/uiCloseInstance{onlyIfIdle:true}` 返回 `{closed:false}` 且实例仍在；`active:false` 后同一调用返回 `{closed:true}`。
- 伪造 scope（错 server/session）或过期 token 的上报抛错，目标实例 busy 状态不变，随后 `onlyIfIdle` 回收不被该次上报阻塞。
- 仅工具 pins（未上报执行）时 busy 语义不变：pins>0 时 `onlyIfIdle` 同样拒绝。
- 协议契约：`active` 缺失或非布尔、未知键被 params schema 拒绝。

## 12. 后台页面保留策略（F18，2026-11-07，上游 a60ba6a7）

上游 v3.17.1 以「资源显式声明 + 窗口级有界保留」取代「全部页面无限后台」的设想：未声明的页面沿用默认隐藏即停；声明的页面按 4 页/30 分钟有界保留。本节定义该策略的产品规则、状态所有者、接口、事件顺序、幂等边界与验收；上游参考仅取语义（`pluginUiBackgroundRetention.ts`、`pluginUiPageRegistry.ts`、`pluginUiManagedPage.ts`、`pluginUiPagePlane.ts`、`mcp-apps/CONTRACT.md`）。

### 12.1 口径变更记录（对 2026-10-24 的修订）

| 2026-10-24 条目                                                                        | F18（2026-11-07）口径                                                                                                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1 废除「settled 且不可见立即 suspend」                                              | **恢复默认隐藏即停**：未声明页面沿用离屏 5 分钟定时器与 settled 即停（`pluginUiPageManager.ts` 现行为）；已声明页由 §12.2 保留策略保护，claim 拒绝兜住同一路径 |
| §2.3 超限只拒绝新页面、不再因容量淘汰或回收现有页面                                    | **恢复上游容量路径**：30 task / 64 allocated 上限数值不变，超限时按既有路径回收「不可见且非忙」的空闲页面腾位（回收走 §12.5 原子裁决）；全部可见或忙才拒绝     |
| §4.1 可见性不是销毁信号                                                                | 限定为「已声明且处于 4/30 边界内的页面」；未声明页面的隐藏仍是回收信号（经 busy 检查与 Agent 裁决软化为 tryRecycle，不再是无条件销毁）                         |
| §6.1 删除离屏 5 分钟定时器的销毁语义                                                   | **撤销该结论**：5 分钟定时器保留为默认期限；已声明页不靠删除定时器、而靠 claim 拒绝获得保留                                                                    |
| §7/§8 中「离屏 5 分钟仍保留」「settled 不 suspend」「第 31/65 次准入只拒绝不回收」等行 | 被 §12.7 场景取代；`pluginUiPageManager.test.ts` 中按 2026-10-24 口径写入的 5 个未实现红测随实现步骤按 F18 口径改写断言（本仓自有反例，非上游测试，不删除）    |

其余条目（§4.2 无锚点继续执行对已声明页、§4.3 返回复用原 guest、§4.4 显式撤销后不复活、§4.6 非本地端无副作用、§6.2 Main TTL 6h、§6.3 迟到挂载、§10 保持不变）继续有效。

### 12.2 产品规则

1. **默认隐藏即停**：资源未声明 `backgroundRetention` 的页面沿用现状——离屏 5 分钟定时器、settled 且不可见且非忙即触发回收；回收是 tryRecycle（Agent 原子裁决），busy 时被拒绝并保留。
2. **显式声明才保留**：`ui://` 页面资源自己的 `_meta.ui.backgroundRetention: true`（仅布尔；工具 metadata 不授予；缺省即不保留）。
3. **上限 4 页**：同一窗口内处于后台（运行中、不可见或窗口最小化、未被回收裁决预占）的已声明页面超过 4 个时，才允许回收其中最旧闲置者；回收一个后回到 4。
4. **闲置 30 分钟**：候选页最近一次活动（可见性边沿、controller 建立、feed 工具输入/结果）距今 ≥30 分钟才可回收；窗口可见且页面可见期间不累计闲置。
5. **最小化暂停计时**：窗口最小化（`document.hidden`）时，可见页的闲置计时从最小化时刻重新起算；恢复可见即重置。
6. **busy 不回收**：页面本地 busy（工具调用/采样/app 工具进行中）在 claim 前拒绝；Agent 端 busy（工具 pins ∪ `mcp/uiSetExecutionActive` 上报，§11）在 `onlyIfIdle` 裁决时拒绝。两侧任一忙即保留。
7. **claim/finish 预占**：回收裁决前先在保留策略预占名额（pending），Agent 拒绝或裁决完成后释放；同一页面并发裁决合并为一次。
8. **可见且有锚点自动重建**：裁决期间或完成后页面窗口可见且存在可见锚点时，同一 page owner 立即 `ensure()` 重建（新 controller、新凭证；旧凭证已撤销不得复用）。
9. **后台执行表面**：已声明且运行中的页面隐藏时保留一个不可交互的执行表面（保持 rAF/定时器可执行，不接收输入）；恢复锚点后回到正常承载。
10. **声明链路唯一**：声明只经资源级 `_meta` 归一化 → 沙箱登记 → 句柄 `resourceMeta` 回 renderer，无第二写入路径。

### 12.3 状态所有者

| 状态                                         | 唯一 owner                                                                                                                          | 其他层职责                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 声明归一化（`backgroundRetention` 布尔）     | shared `normalizeMcpAppResourceMeta`（`packages/shared/src/mcp-apps/toolMeta.ts`）                                                  | services 桥只透传归一化结果；不自行解析布尔                                                                                                        |
| 沙箱登记与句柄 `resourceMeta`                | Desktop Main `pluginSandbox` registry                                                                                               | 登记输入存 `record.resourceMeta`，随 `PluginSandboxHandle` 回 renderer                                                                             |
| 沙箱后台执行表面                             | Renderer 窗口级 plane（隐藏承载：低透明不可交互表面，保持 rAF/定时器可执行）                                                        | 上游另有 Main 侧 guest 节流通道（依赖其 browserView activity 框架），本仓未移植该框架、不随本卡引入；若实测隐藏 guest 仍被 Electron 节流再单独立项 |
| 保留策略（4/30/最小化/claim 预占）           | Renderer 窗口级 `PluginUiBackgroundRetention`（单实例，随窗口）                                                                     | 页面/锚点只上报 activity/visibility，不做回收决策                                                                                                  |
| 页面生命周期与容量（30/64、5 分钟、settled） | Renderer 窗口级 `PluginUiPageManager`（不变）                                                                                       | 保留策略通过 claim 在同一路径上豁免已声明页                                                                                                        |
| Agent 端 busy（pins ∪ executionActive）      | Agent `McpUiInstances.isBusy`（§11）                                                                                                | `onlyIfIdle` 裁决唯一消费点                                                                                                                        |
| 页面本地 busy                                | `pluginUiHostController.isBusy`                                                                                                     | `tryRecycle` 前置检查                                                                                                                              |
| 回收裁决                                     | 唯一路径：`page.suspend()`（claim → `controller.tryRecycle()` → `bridge.recycleInstance` → `mcp/uiCloseInstance{onlyIfIdle:true}`） | 任何回收触发方（定时器/settled/容量/保留策略）都走该路径，不另建裁决                                                                               |

### 12.4 接口与依赖方向

```text
ui:// 资源 _meta.ui.backgroundRetention(布尔)
  → shared normalizeMcpAppResourceMeta（read 选中项 → list 同 uri 条目兜底；工具级不授予）
  → services plugin-ui-bridge prepareSandbox：registerSandbox payload 带归一化字段
  → desktop Main pluginSandbox registry：record.resourceMeta
  → PluginSandboxHandle.resourceMeta → renderer pluginUiManagedPage.setHandle
  → pluginUiPages.prepared(page, retain)：retention.register/release + 补一次 visibility 边沿
  → PluginUiBackgroundRetention（register/activity/setWindowVisible/claim/finish/changed）
  → page.suspend()（claim 预占）→ controller.tryRecycle → mcp/uiCloseInstance{onlyIfIdle}
```

- 依赖方向：renderer（UI 策略）→ host 桥（services）→ Main registry / Agent 协议；反向只有句柄与实例凭证回传。UI 不读 Main 登记表、Main 不做业务回收（§3 不变）。
- 【落点缺口登记（实现步前必须解决）】上述链路中 `packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts` 的 registerSandbox payload 需要一行 `backgroundRetention` 透传（与 `showInline` 等同形），该路径不在本卡落点（packages/services 未列入）；实现步骤需 controller 扩落点或单独授权，否则按 §3.2 停止上报。
- 沙箱执行忙闲上报（§11 `mcp/uiSetExecutionActive`）由 renderer 在页面声明保留且实际进入后台执行时调用，构成 Agent 端 busy 的第二来源。

### 12.5 事件顺序

```text
声明页准备
  → prepareSandbox（资源 _meta 归一化，read 项 → list 兜底）
  → registerSandbox → Main registry 存 resourceMeta → handle 回 renderer
  → managedPage.setHandle（fresh：sandboxId+initId 变化）
  → pluginUiPages.prepared(page, retain=true)
      → retention.register(page)；并补 sandboxPages.visibility(page, page.visible)
        （冷后台页无可见性边沿，也要启动默认 5 分钟期限；已声明页由 claim 拒绝兜住）

页面隐藏（收起卡片 / 滚出视口 / 切走 tab）
  → plane 无可见锚点 → visibility(false) → 默认 5 分钟定时器；retention.activity 刷新闲置
  → 已声明页运行中 → 保留隐藏执行表面（§12.2.9）

回收触发（任一：5 分钟/settled/容量腾位/保留策略 changed）
  → page.suspend()（非 force）
      → recycling 重入检查 → claimRecycle(page)
          未注册（默认页）→ 直接进入裁决
          已注册 → 仅当 后台>4 ∧ 非可见 ∧ 非本地忙 ∧ 闲置≥30 分钟 才预占
      → controller.tryRecycle()
          本地忙 → false（保留）
          → mcp/uiCloseInstance{onlyIfIdle:true}
              Agent busy（pins ∪ executionActive）→ {closed:false} → finishRecycle → 保留，
                等待下一次状态事件（不得零延时重试）
              Agent 空闲 → {closed:true} → suspend(true) teardown（显式销毁语义）
      → finally finishRecycle（释放预占）
      → 裁决期间/完成后 窗口可见 ∧ plane.hasVisibleAnchor() → 同 owner ensure() 重建

窗口最小化 / 恢复
  → document.visibilitychange → retention.setWindowVisible(!hidden)
      最小化：可见页 lastActive=now（闲置自最小化起算）
      恢复：可见页 lastActive=now；managedPage.onWindowVisibility → 可见且有锚点 → ensure()
```

### 12.6 幂等边界

- `prepared` 以 `sandboxId+initId` 变化判定 fresh；重复同值 register/release 无变化。
- `claim/finish` 严格配对：recycling 期间重入返回同一 promise；`finish` 恒在 finally 执行；预占中的页面不计入后台配额、不参与候选。
- `changed()` 合并同一轮状态变化：评估中收到的新变化置脏后再评；回收前读取最终状态，不在事件回调中重入页面释放。
- Agent 拒绝后的候选不得零延时重试；定时器只在后台 >4 时调度，取非忙候选的最短剩余时间。
- `mcp/uiSetExecutionActive` 幂等且随实例代际消失（§11.2）。
- 显式删除/重载/来源失效走 `suspend(true)`（force），绕过 claim，不受保留策略保护（§4.4 不变）。

### 12.7 验收场景（反例）

1. 未声明页离屏 5 分钟 → 触发 tryRecycle；本地或 Agent busy → 保留。
2. 已声明页离屏 5 分钟 / settled / 回合结束 → 保留运行，后台结果继续投递。
3. 5 个已声明后台页：最旧闲置 ≥30 分钟被回收（Agent 空闲），后台数回到 4；≤4 时无论闲置多久不回收。
4. 已声明页 busy（页面工具调用进行中，或 `mcp/uiSetExecutionActive` active:true）→ `onlyIfIdle` 返回 `{closed:false}` → 保留，且被拒候选在下次状态事件前不重试。
5. 最小化 29 分钟 + 恢复可见 1 分钟 → 不回收（闲置被可见性重置）；持续隐藏 ≥30 分钟且后台 >4 → 回收。
6. 回收裁决期间锚点返回且窗口可见 → 裁决完成后同 owner 自动重建（新 controller/新凭证，不复活旧实例）。
7. 声明链路：资源 `_meta.ui.backgroundRetention:true` → `handle.resourceMeta.backgroundRetention:true` → `prepared` 注册；工具 metadata 声明不授予；非布尔值忽略（缺省不保留）；read 项缺 meta 时 list 条目兜底。
8. 容量：第 31 个 task / 第 65 个 allocated 且存在空闲后台页 → 回收腾位后接纳；全部可见或忙 → 拒绝并提示。
9. claim/finish：同一页并发触发（定时器 + settled + 容量）只产生一次 Agent 裁决。
10. 手机/Web/远端：`supported:false` 不创建本地 guest（§4.6 不变，不因保留策略改变）。

### 12.8 E2E 场景清单（按 e2e-case-lifecycle 现行规则）

入口：plugins 域 `packages/desktop/test/e2e/plugins/manual-review/pending/`；覆盖矩阵 `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md` + catalog `docs/plugin-management-lifecycle-case-catalog.md`；晋级后进 `pnpm run test:e2e:container:plugins` 预设。候选 case（实现步骤登记为 pending spec 并回填矩阵行）：

| 候选                        | 场景                                                        | 断言要点                                                      |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| `E2E-F18-01` 后台保留冒烟   | 声明页收起卡片/切走 tab 后页面继续执行                      | 后台工具调用/通知继续到达；返回锚点复用同 guest（不重新握手） |
| `E2E-F18-02` 忙时不回收     | 声明页执行长任务时触发回收条件                              | 页面保留、任务结果完整投递                                    |
| `E2E-F18-03` 闲置回收与重建 | 后台 >4 且最旧闲置到期 → 回收；锚点返回                     | 回收后同 owner 自动重建，widgetState 不串代                   |
| `E2E-F18-04` 声明两态对照   | 同一插件资源 `_meta.ui.backgroundRetention` true/false 两态 | true → 离屏保留；false → 默认隐藏即停                         |

环境缺口（如实登记）：

- 30 分钟/4 页常量在真实 Electron E2E 中不可等待；E2E-F18-03 需要保留策略提供可注入时钟/常量覆盖的测试通道（实现步骤的 UI 侧测试注入点），否则该 case 只能以单测覆盖、E2E 标 blocked。
- E2E 需要承载 `ui://` 资源 `_meta` 声明的插件 MCP server fixture（现有 `fixtures/plugin-mcp-skill` 可扩展）；E2E-F18-04 依赖同一 fixture 的两资源变体。

### 12.9 E2E 执行状态（2026-11-07，F18④ 定向验证步）

**结论：F18 的 4 个 E2E 候选均未创建、未执行，标 blocked。** 具体缺口与证据：

1. **无 `ui://` 插件 UI fixture**：`packages/desktop/test/e2e/fixtures/` 全树 grep 无任何 `ui://` 资源 fixture（`plugin-mcp-skill` 仅为 MCP ping 插件，无插件 UI 面）；现有 E2E 也从未覆盖 plugin-ui 沙箱面（grep `plugin-ui-webview`/`prepareSandbox` 于 `test/e2e` 无命中）。四个候选都依赖新建该类 fixture，而 fixture 与 pending spec 均位于 `packages/desktop/test/`，不在本卡落点。
2. **声明链路在 services 桥断链**：`packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts` 缺一行 `backgroundRetention` 透传（F18② 登记、落点外未决）。不补齐前，真实运行时 `handle.resourceMeta.backgroundRetention` 恒为 undefined，E2E-F18-01/02/04 会断言到错误的默认语义。
3. **app 级时钟通道缺失**：`PluginUiBackgroundRetention` 支持构造注入 timer/now（单测已用），但 `pluginUiPageRegistry` 以真实 `Date.now`/`setTimeout` 模块级实例化、无 E2E 覆盖通道；E2E-F18-03 的 30 分钟不可等待。
4. **wdio 生命周期 E2E 环境不可用**：本会话无桌面 E2E 运行通道（manual-review 运行 + 人工评审晋级链路不可达）。

**部分执行（非生命周期 E2E）**：仓内自带 Electron host-fixture harness（`packages/desktop/scripts/mcp-apps-host-e2e.mjs`，retention 模式驱动真实 `PluginUiPageManager`/plane/controller/pluginSandbox host，与上游 a60ba6a7 同款）在本步实际执行两次：`--retention-only` 与差分 `--storage-only` 均在首个 guest 的 app-bridge 握手 60s `SdkError: Request timed out` 后被 90s watchdog 杀死（两种场景同一超时特征）。判定为 harness 存量/环境问题、非 F18 差异所致（F18 改动不触及 guest↔renderer 端口握手路径；storage 模式不含保留策略且同样失败）。该 harness 修复属独立问题，不随本卡。

**解锁清单（后续步骤）**：① controller 授权 services 桥一行透传（见 §12.4 缺口）；② 扩落点至 `packages/desktop/test/e2e/`（fixture + pending spec + 矩阵登记）；③ 新建带 `_meta.ui.backgroundRetention` 两态资源的插件 fixture；④ 为保留常量提供 app 级测试覆盖通道（或 E2E-F18-03 降级为单测覆盖并注明）；⑤ 修复/复跑 host-fixture harness 的握手超时作为桌面级补充证据。
