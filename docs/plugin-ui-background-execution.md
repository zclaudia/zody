# MCP 后台页面生命周期

状态：领域 spec，2026-10-24。对应上游 v3.16.2 移植 I20；决策口径见 `docs/plans/upstream-v3.16.2-implementation-plan.md` §3「待决规则决策记录」（C5）。本文只定义页面生命周期与锚点关系的差异规则，通用能力边界仍以 `packages/ui/src/plugin-ui/CONTRACT.md`、`packages/desktop/src/main/pluginSandbox/CONTRACT.md` 和 `docs/plugin-ui-connection-readiness.md` 为准。

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

「撤销后不复活」还要求：清理/撤销开始后到达的 guest attach 必须被停止，并纳入清理完成前的等待集合。`host.ts:220-226` 现在只 fire-and-forget 停止，不进入 `clearBrowserData` 的等待集合；实现需在 `clearStorageData` 之前等待其停止（反例见 `clearOrder.test.ts`）。

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
