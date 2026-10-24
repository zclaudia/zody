# 插件页面首开连接屏障

## 背景与缺口

会话启动时 MCP server 的 `initialize` 可能在用户已打开插件页面卡片之后才完成。当前 `openMcpUiInstance` 只读取同步连接快照；快照为 `null` 时立即返回 `-32001`，services 桥把错误交给 UI，卡片进入 error 并只提供手动 Retry。用户看到的是首开失败，而不是等待既有连接完成。

连接任务与连接代际已经由 adapter/pool 持有：pool 的 acquire 在 entry 已存在时 `await entry.connecting`，只有状态为 `connected` 时才由 `appConnectionSnapshot` 返回 `{ identity, generation }`。缺口只在协议层的等待与放行后重验，不新增第二套连接状态。

## 目标与非目标

目标：

- 首开和冷恢复遇到同一 server 的进行中 `initialize` 时等待既有连接任务，不重复建连、不轮询。
- 连接成功后自动创建页面，无需用户点 Retry；连接失败有终态错误。
- 等待结束（放行）后重新确认会话、连接代际与实例凭证，旧快照不能签发页面。
- 同一逻辑页面的并发 open 只产生一个实例。

非目标：

- 不改变 pool/adapter 的连接重建、OAuth 自动恢复、工具重放或 initialize 超时语义。
- 不要求 Renderer 轮询、不新增 Renderer 已接受输入队列。
- 不改变 desktop `continuous` 与手机/远程 `replayable` 的协议语义，不新增 SQLite 表或持久化状态。

## 状态所有者与顺序

```text
UI 卡片/侧栏（不轮询）
  → services pluginUiBridge.prepareSandbox
    → agent mcp/uiOpenInstance
      → 快照存在？ —— 是 ——→ 直接签发
      → 否：等待该 server 既有连接任务（adapter 的真实 initialize 任务）
            → 连接 settle
              → 重新解析 session（失效 → -32004）
              → 重新读取 connection snapshot
                   → null → -32001（终态，不签发）
                   → 有值 → 以新 identity/generation 创建 lease
      → mcpUiInstances 签发唯一实例（并发 open 幂等）
    → resources/read
    → validateInstance（登记沙箱前重验；失败关闭实例、不登记）
    → registerSandbox
  → UI 既有 validateInstance 作为最终校验
```

- 连接任务与代际的唯一 owner 是 adapter/pool；协议层只等待结果并读取快照，不自己维护连接状态。
- 页面凭证的唯一 owner 仍是 `McpUiInstances`；等待与重验只决定“何时允许签发”，不产生第二个凭证来源。
- services 只在实例通过重验后登记沙箱；UI 已有的 prepare 后 `validateInstance` 保留为最终校验，不合并成第二套状态。

## 等待合同

1. **触发**：`mcp/uiOpenInstance` 读取 `getMcpAppConnectionSnapshot(serverName)` 为 `null` 时进入等待；快照已存在时保持现有直接签发路径。
2. **等待对象**：等待该会话、该 server 既有的连接任务——本会话已租用 entry 对应的 adapter `record.connecting`（完整的 `openServerConnection`：initialize、listTools 与交互授权）。不能只等 pool 的 `entry.connecting`：session 传入的 `oauthAuthorizationTimeoutMs`（15s）只是 caller 的等待预算，到点会以仍为 `connecting` 的状态 resolve，真实 initialize 仍在继续（默认 `config.timeoutMs` 30s / OAuth 事务 TTL 内收敛）。等待入口只读既有租约，不重新推导 connectionKey（workspace 隔离的 key 由 `workspaceIdentity`/`workingDirectory` 派生，换一个 connect 入口可能创建第二个 entry）；等待期间若租约换源，跟随新 entry 的真实连接任务继续等待。不得新建连接、不得并行发起第二次 `initialize`、不得触发 OAuth 自动恢复或工具重放。server 未配置、未被本会话租用或已停用时属于立即终态，不进入等待。
3. **时限**：等待生命周期等同于既有真实连接任务的生命周期，由 adapter 的协议超时（`config.timeoutMs`）与 OAuth 事务 TTL 负责收敛；caller 的 `oauthAuthorizationTimeoutMs` 预算不截断等待。协议层不新增轮询、sleep 循环或第二份超时；UI 不轮询。
4. **失败终态**：连接任务 reject、返回非 `connected` 状态、等待期间连接失效或会话释放，都必须落到明确错误：连接不可用 `-32001`，会话已不可用 `-32004`。失败时不得签发 lease、不得注册 `onMcpAppConnectionInvalidated` watcher、不得登记沙箱；UI 保留 error + Retry 作为终态失败入口。不允许无限等待。
5. **放行后重验**：连接 settle 后按顺序（a）重新解析会话，会话不存在 → `-32004`；（b）重新读取 connection snapshot，缺失 → `-32001`；（c）用重新读到的 `identity`/`generation` 创建 lease。禁止使用进入等待前捕获的旧快照签发。
6. **并发**：同一逻辑页面（workspace + session + plugin + server + scope + resource + ownerWebContents）且同一连接代际的并发 open 共享同一既有连接任务，并最终返回同一个 lease（同 token、同 generation）；只注册一个连接失效 watcher。不同 server、资源、工作区或连接代际互不合并。
7. **旧快照保护**：`McpUiInstances` 对同一逻辑页面、同一 `identity` 且 `generation` 低于当前记录的 open 必须拒绝，且不得关闭或替换当前有效实例。不同 `identity` 视为合法换源：`open` 直接关闭旧实例并按新来源签发；连接失效通知同时撤销旧实例的 watcher 与进行中调用。
8. **prepare 重验**：services 在 `resources/read` 完成之后、`registerSandbox` 之前调用 `validateInstance`；失败时 `closeInstance` 撤销已签发 lease 并向上抛错，不登记沙箱。并发相同的 prepare 继续只合并资源读取，每个调用方各自取得登记结果（既有 H15-a 规则不变）。

## 失败矩阵

| 场景                              | 结果                                | 是否签发             |
| --------------------------------- | ----------------------------------- | -------------------- |
| 快照已存在                        | 直接创建页面                        | 是                   |
| initialize 进行中，随后 connected | 等待后自动创建，无需 Retry          | 是，使用放行后的代际 |
| initialize 失败 / 非 connected    | `-32001` 终态                       | 否                   |
| 等待中会话释放                    | `-32004` 终态                       | 否                   |
| 等待中连接换源                    | 跟随新 entry 的真实连接任务；成功后用新 `identity`/`generation` 创建 | 是，旧快照不签发；新连接失败则 `-32001` |
| 等待中旧代际 open 迟到            | 实例 owner 拒绝                     | 否，当前实例保留     |
| 并发同一页面 open                 | 返回同一 lease                      | 是，单实例           |
| prepare 读资源期间实例失效        | `validateInstance` 失败，关闭实例   | 否，不登记沙箱       |

## 验收场景

- initialize 闸门阻塞时打开页面：闸门放行后自动成功，不调用重试、不重复初始化。
- 等待中释放会话或换源：旧 lease 不得签发；换源后绑定新 generation。
- 并发 open：只剩一个实例、一个 watcher。
- 连接失败：返回终态错误，UI 显示 error + Retry。
- services prepare：读资源期间实例被撤销时 `registerSandbox` 不被调用。

对应反例测试：`apps/zcode-cli/packages/bootstrap/tests/mcp-protocol.test.ts`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/instances.test.ts`、`apps/zcode-cli/packages/adapters/tests/mcp-connection-pool.test.ts`、`apps/zcode-cli/packages/adapters/tests/mcp.test.ts`、`packages/services/test/pluginUiBridgePrepareRaces.test.ts`。Electron 页面场景：`packages/desktop/scripts/mcp-apps-host-fixture/chain-main.ts` 与 `chain-initialize-barrier.ts`（gated initialize 检查）。

## 验证记录

2026-10-24 在本仓实际执行：

- `pnpm --dir apps/zcode-cli/packages/bootstrap test`：211 files / 2917 passed，11 skipped。包脚本已改为 `vitest run`，`src/zcode-protocol/mcp-ui/instances.test.ts` 等模块自带回归进入包门禁。
- `pnpm --dir apps/zcode-cli/packages/adapters test`：132 files / 1909 passed，4 skipped。覆盖首开并发、失败终态、等待中释放/换源，以及 caller 15s 预算之外继续等待真实 initialize。
- `pnpm exec vitest run packages/services/test/pluginUiBridgePrepareRaces.test.ts`：3/3。用例已移入根 vitest `unit` 的 `packages/*/test/**` include，处于统一门禁内。
- `node packages/desktop/scripts/mcp-apps-host-e2e.mjs --chain-only`（复跑加 `--reuse-agent-build`）：exit 0，21 项真实 Electron 检查全部 PASS，`remainingGuests=0`。其中 `first open waits for a gated initialize and mounts without a retry` 654.2ms：initialize 被服务端闸门阻塞时打开真实页面，断言未挂载、未读资源；放行后自动挂载，资源只读一次。
- 包级类型检查：`contracts` build、`adapters` typecheck、`bootstrap` typecheck、`tsc -b packages/services` 均通过。
- 环境注记：本机 Node v22.23.2（仓库 `mise.toml` 为 24.14.0）只产生 pnpm engine warning，上述构建与检查均通过。
- 未执行全仓 `pnpm typecheck`/`pnpm lint`，由统一门禁负责。

## 保持不变

- 实例凭证绑定、服务器归属、工具可见性、资源 MIME/大小、CSP、取消与审批路径不变。
- 连接重建只由既有 pool 规则触发；本项不在失败后自动重连或重放调用。
- 不修改 UI 轮询、CommandInbox、Host owner/lease、desktop continuous 或手机 replayable 的消息语义。
