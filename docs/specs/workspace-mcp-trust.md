# Workspace MCP 信任门（F23）spec

> 状态：spec 已裁决待实施（tier2 P0 裁决 2 已落定 `new-state`）。上游来源：ZCode v3.17.1
> （`a60ba6a7`）workspace MCP 信任门；上游参考仅供语义，本 spec 按本仓架构与命名重写。
> 同族先例：[`workspace-hook-trust.md`](./workspace-hook-trust.md)（用户域精确摘要信任、
> default-deny、软门禁提示的产品形态）。

## 1. 背景与问题

本仓现状（fork 决策，本 spec 将其推翻为信任门）：

- `apps/zody-cli/packages/bootstrap/src/app/runtime-config.ts:110` 与
  `apps/zody-cli/packages/bootstrap/src/zody-protocol/mcp.ts:74`：「产品决定 workspace MCP
  开箱即用：project 作用域 MCP 默认 trusted，并自动连接」，`untrustedProjectMcpServers`
  恒为空集。
- `packages/shared/src/zody-protocol/index.ts:773` 的状态枚举保留 `"untrusted"` 值，其历史
  语义属于官方 MCP 可信 origin 校验（该链路随 fork F4.6 删除，枚举值与 UI 映射仍保留槽位，
  当前无生产者）。

安全问题：项目作用域 MCP 声明（仓库内配置文件）是**随代码分发的不可信输入**。默认连接
等于默认执行任意 stdio 命令、携带任意凭据发起任意 HTTP 请求。与 workspace hook 同理，
需要一道用户域信任门：未显式信任的 workspace 声明一律拒绝连接，授权绑定声明精确摘要，
摘要变更需重信任。

## 2. 信任状态模型（P0 裁决 2 结论，先于协议与 UI）

### 2.1 裁决结论：new-state（args 预置）

- **new-state**：本特性新增独立状态名 **`pending_trust`**，不复用、也不改名现有
  `"untrusted"` 枚举值。理由：`untrusted` 的语义槽位已被官方 origin 信任校验的历史语义
  占用（其 failureKind `official_origin_untrusted` 虽随 F4.6 删除，但状态值、UI 映射与
  `mcp-config.ts` 的显式连接文案仍按该语义保留），扩展 origin 语义会让两种「不可信」
  来源（origin 校验残留 vs workspace 声明待审）在协议与 UI 状态机上不可区分。
- **args 预置**：信任记录的 `declarationDigest` **预置（绑定）启动执行身份**——摘要输入
  不是原始配置，而是规范化后的执行配置：

  | transport | 摘要预置的执行字段（任一变更 ⇒ digest 变更 ⇒ 原授权失配）                                                                          |
  | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
  | stdio     | 规范化 `command`（PATH 解析后）、`args` 全量、`env` 全量键值、`cwd`（相对路径按 workingDirectory 绝对化，缺省为 workingDirectory） |
  | http/sse  | `url` 全量、`headers` 全量键值、`oauth.type`、其余执行字段                                                                         |

  `enabled` 与 `source` 不进入摘要（启停与来源标记不是执行身份；enabled 语义见 §7）。
  上游依据：`a60ba6a7` `workspace-mcp-trust/index.ts` 的 `executionConfig()` +
  `normalizeMcpStdioCommand` 同构。

### 2.2 状态与唯一所有者

- **授权唯一 owner**：Host 用户域信任存储中的精确记录
  `{ workspaceIdentity, serverName, declarationDigest, grantedAt }`（store 文件 schema 单源
  放 `packages/shared/src/`，仿 `workspace-hook-trust-store-file.ts` 先例；落盘位置为
  `~/.zody/security/workspace-mcp-trust-v1.json`，与 hook 信任 store 同目录、同
  `storage.dir` 解析规则——**工作区内的任何文件不能自授信任**）。
- **状态唯一写入路径**：`decide()`（文件锁内重读声明 → 摘要精确匹配 → 原子写）。UI、
  协议层、runtime 都只能读投影或调用 `decide()`，不存在第二条写路径。
- 身份键遵循仓库统一规则 `workspaceIdentity?.trim() || workspacePath`（AGENTS.md）；
  记录按 `workspaceIdentity` 匹配，**跨 workspace 不继承授权**（同路径不同身份、同身份
  不同路径都视为不同目标）。

### 2.3 投影状态字汇

对每个已发现的 workspace 声明，投影层按唯一 owner 计算状态：

| 条件（按序求值）                                                       | 投影状态                                                      | 工具数 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| `enabled === false`                                                    | `disabled`                                                    | 0      |
| store 无记录 / 摘要失配（陈旧） / store 损坏 / 声明读取失败 / 未知来源 | **`pending_trust`**（default-deny）                           | 0      |
| 存在 `(workspaceIdentity, serverName, declarationDigest)` 精确匹配记录 | `trusted`（连接后由运行态接管：connecting/connected/failed…） | 实测   |

- `"untrusted"` 枚举值本特性**不读不写**：保持现状（无生产者），其 UI 映射与文案槽位
  原样保留；`pending_trust` 是新增的独立枚举值（协议 `.strict()` schema 的 additive 扩展）。
- 「撤销」没有独立投影态：撤销即删除精确记录，声明立即回到 `pending_trust`
  （撤销的生效边界见 §3.2 与 §8.3）。

## 3. 产品规则

### 3.1 默认拒绝与最小暴露

1. 未信任的 workspace 声明**绝不连接**：零进程 spawn、零 HTTP 请求、零握手、零工具；
   `mcp/list` 返回 `pending_trust` + `toolCount: 0`。
2. `inspect()`（读声明与授权投影）**不连接**任何 MCP；审核动作本身不产生网络/进程副作用。
3. UI 只接收**脱敏摘要**：`display` 文本不含 env 值、header 值、URL userinfo/query/fragment
   与 oauth 凭据；stdio 只展示 command+args 拼接、cwd 与 env **键名**。
4. 用户作用域、插件、内建 MCP 不属于本审核范围（来源判定见 §5.1），不得被误拦截。

### 3.2 授权作用于未来，不劫持当下

5. 信任/撤销**在新建/重启会话或下一次连接准入时生效**：不中断进行中的连接、不回滚已提交
   副作用；显式断开、port 关闭、guard 失效（AbortSignal）则立即阻断后续使用。
6. 会话内工具调用、状态查询、底层自动重连**复用本次准入的内存结果**，不逐请求同步重读
   配置与 store（授权变化允许延迟到下一次连接准入）。
7. 与 hook 软门禁同理由（consent fatigue 反模式）：对话永不停等审核；会话内以常驻提示条
   呈现待审摘要，用户带外去设置页决策。

### 3.3 幂等与重试边界

8. `decide()` 幂等：对同一 `(serverName, declarationDigest)` 重复信任 = 覆盖同一条记录
   （`grantedAt` 刷新）；重复撤销 = 无记录时仍成功返回（写盘结果收敛为「无该记录」）。
9. `decide()` 携带的摘要与锁内重读结果不符 ⇒ 拒绝（`workspace_mcp_declaration_changed`），
   防止「审核 A 落盘 B」。
10. 并发进程写 store：文件锁 + 锁内重读 + 原子写，不同 workspace 的并发批准互不丢失。

## 4. 接口与依赖方向

```
packages/shared/src                （协议 schema、store 文件 schema、摘要算法单源）
   ↑                ↑
apps/zody-cli/packages/core/src/mcp/     packages/ui/src
（纯域：记录匹配、准入评估、guard Proxy；IO 全注入）   （双横幅、store 状态映射）
   ↑                ↑
apps/zody-cli/packages/contracts/src     packages/services → desktop（转发，本卡落点外）
（McpPort 守卫面类型、WorkspaceMcpAdmissionUpdated 事件 payload）
   ↑
apps/zody-cli/packages/bootstrap（wiring：发现声明注入、guard 安装、协议 handler 注册——本卡落点外，见 §11）
```

- core 模块**不 import adapters**、不做 fs：声明发现、store 读写、锁均通过构造注入的
  port 函数（同 core `workspace-hook-trust-*` 系列的纯域定位）。
- 摘要算法（`executionConfig` 规范化 + sha256 + 键排序稳定序列化）单源——**落位修订
  （F23② 实施时登记）**：原计划放 shared，但 shared 根导出图必须保持 renderer-safe
  （当前无 node 内建依赖，`node:crypto`/`node:path` 不可进入），而新增 subpath 导出需改
  `packages/shared/package.json`（超出本卡落点）；故摘要算法单源落 core 的
  `mcp/workspace-mcp-trust.ts`，bootstrap wiring 侧经 `@zody/core` 复用同一实现，单源
  目标不变。store 文件 schema（纯 zod，renderer-safe）仍单源放 shared
  （`workspace-mcp-trust-store-file.ts`，经 shared 根导出）。
- 禁止：UI 直接读 trust store 文件；services 引用 core 具体实现（走 shared/contracts 类型）。

## 5. 声明发现与摘要

### 5.1 发现范围（workspace 声明的判定）

一个 MCP server 属于本审核范围，当且仅当其声明来源是**工作区可达的文件**：

1. CLI `createConfig()` 解析出的 project 作用域声明（`sources.mcp.serverSources[name]
=== "project"`，即 `zcode.json` / `.zody/config.json` / `.zcode/config.json` 项目配置
   文件发现的 `mcp.servers` 条目）；
2. 桌面侧 mcp-sync 解析的 workspace 目录声明（workspace `.agents/mcp.json`、workspace
   `.zody/cli/config.json`），经 session create/resume 与 `mcp/list` 的 `params.mcpServers`
   显式下发。

与上游差异（登记，不照抄）：上游在 CLI 信任模块内直接读 workspace `.agents/mcp.json`
fallback；本仓该 fallback 由桌面 mcp-sync 链路解析后随 `params.mcpServers` 下发
（`docs/runtime-tools/mcp-status-list-control-plane.md` §协议语义）。语义等价：两条路
径产生的声明都进入同一摘要与同一 store 判定，**不因下发通道不同而豁免审核**。

豁免（不属于 workspace 声明）：用户作用域（`serverSources[name] === "user"`）、插件提供
（`source.kind === "plugin"`）、内建（`source.kind === "builtin"`）、CUA broker 注入。

### 5.2 摘要输入

```
declarationDigest = sha256(stableJson({
  version: 1,
  workspaceIdentity,          // §2.2 身份键
  workingDirectory,           // 绝对路径
  serverName,
  sourcePaths,                // 声明来源文件绝对路径列表（参与摘要：改文件=改声明）
  config: executionConfig(config, workingDirectory),   // §2.1 args 预置
}))
```

`stableJson` 对对象键排序后序列化，保证同语义配置摘要稳定。`executionConfig` 剔除
`enabled`/`source`，只保留执行身份字段。

## 6. 协议面（packages/shared/src/zody-protocol/index.ts）

全部为 additive 扩展（`.strict()` schema 新增可选字段/新枚举值；桌面 Host 与 UI 同版本
捆绑，旧 CLI + 新 shared 不受影响，新 CLI 的可选字段对旧 shared 按 strict 拒绝——发布
口径为同版本升级，不单独承诺跨版本兼容）。

1. 方法注册：`zodyProtocolMethods.workspaceMcpTrust = "workspace/mcp/trust"`（wire 名与
   上游一致）。
2. `zodyWorkspaceMcpTrustParamsSchema`：
   `{ workspace: zodyWorkspaceRefSchema, serverName: nonEmptyString, declarationDigest: /^[a-f0-9]{64}$/, trusted: boolean }`。
3. `zodyWorkspaceMcpTrustResultSchema`：
   `{ accepted: boolean, reasonCode?: "workspace_mcp_declaration_changed" | "workspace_mcp_trust_unavailable" }`。
4. `workspaceMcpTrustReviewSchema`（审核摘要，随 `mcp/list` snapshot 下发）：
   `{ declarationDigest, sourcePaths: string[], display: string, trusted: boolean, configuredEnabled: boolean, transport: "stdio"|"http"|"sse" }`。
5. `zodyMcpServerStatusKindSchema` 新增值 `"pending_trust"`（`"untrusted"` 保留不动）；
   `zodyMcpServerStatusSnapshotSchema` 新增可选字段 `workspaceTrust`。
6. v4 `conversationSnapshotSchema` 新增 `workspaceMcpAdmission:
{ pendingCount: int≥0, bundleDigest: /^[a-f0-9]{64}$/, workspaceIdentity?: string } |
null`，**必须带 `default(null)`**（snapshot 冻结规则，仿 `workspaceHookAdmission`，
   `packages/shared/src/zody-protocol-v4/snapshot.ts:506`）；delta 同步新增可选同构字段。
7. contracts 会话事件 `WorkspaceMcpAdmissionUpdated`（payload 同上，与
   `WorkspaceHookAdmissionUpdatedPayload` 同族）；投影规则：`pendingCount === 0` → snapshot
   字段置 `null`（提示条消失）。`bundleDigest` 为启用且未信任声明的有序集合摘要，仅用于
   提示去重与 dismiss 幂等键；逐条授权仍以各自 `declarationDigest` 为准。

## 7. CLI guard 状态机（core 模块）

### 7.1 合同接口（core 导出，contracts 放守卫所需的类型补充）

```ts
interface WorkspaceMcpTrustContract {
  /** 只读当前声明及持久授权投影；不连接 MCP。读取失败返回空投影（fail-closed 但不中断列表）。 */
  inspect(): Promise<Record<string, WorkspaceMcpTrustReview>>;
  /** 锁内重读当前声明；摘要精确匹配才落盘。持久写成功即返回，不启用、不连接。 */
  decide(serverName: string, declarationDigest: string, trusted: boolean): Promise<void>;
  /** 连接准入时重验：声明移除、变更、损坏、撤销后拒绝新连接。 */
  allows(serverName: string, config: McpServerConfig): Promise<boolean>;
  /** 包住整个 MCP lease 的守卫代理；signal 只使本 gate 失效，不关闭共享 raw port。 */
  guard(port: McpPort, signal?: AbortSignal): McpPort;
}
```

### 7.2 guard Proxy 语义（准入包住整个 lease，不只是 UI 入口）

| 面                                                                                                          | 语义                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connectServer`                                                                                             | 冻结配置副本（深拷贝）→ 串行 mutation 队列 → workspace 声明默认 pending 拒连（未过 `allows` 即 `disconnectServer` 回滚并返回 `pending_trust` 状态）→ 通过才透传 raw port |
| `connectConfiguredServers`                                                                                  | 先以只读方式跑完全部准入，过审集合与 workspace 集合分开连接；慢握手不提前放行（每个实际连接前再验一次）；返回 status 合并 blocked、tools 过滤 blocked                    |
| `status`                                                                                                    | raw status 合并 blocked 投影（`pending_trust`，toolCount 0）                                                                                                             |
| `listTools`                                                                                                 | 过滤掉未准入 server 的工具（**未信任 server 工具数 0** 的运行态保障）                                                                                                    |
| `callTool`/`readResource`/`listResources`/`listResourceTemplates`/`subscribeResource`/`unsubscribeResource` | 等待在飞 mutation 排空后校验内存准入结果；未准入抛 `workspace_mcp_pending_trust`；准入后不重复读 store（§3.2 规则 6）                                                    |
| `pingServer`                                                                                                | 未准入返回 false（不产生真实 ping）                                                                                                                                      |
| `appConnectionSnapshot`/`waitForAppConnection`                                                              | blocked 的 server 返回 null（MCP App 生命周期收尾不被授权失败卡死）                                                                                                      |
| `disconnectServer`/`close`                                                                                  | 串行清理映射后透传；`close` 同时失效本 gate                                                                                                                              |
| `unsubscribeResourcesBySubscriber` 等订阅释放                                                               | 直接透传（执行授权失败不能阻止订阅清理）                                                                                                                                 |
| `refreshWorkspaceTrustAdmission`（新增可选面）                                                              | 串行重读 `inspect()` 并发布 admission 事件（§6 条目 7）；只更新会话提示，不连接、不授予权限                                                                              |

### 7.3 并发与失效

- 连接替换（同 server 再 connect / connectConfiguredServers 全量替换）走单一 mutation
  串行队列：配置 A 的迟到握手不能覆盖配置 B 的执行映射。
- admission 发布走独立串行尾队列：授权后的清零事件不被较早的 pending 读取覆盖。
- AbortSignal 失效：只令本 gate 停止后续操作与发布，**不关闭共享 raw lease**（进程级
  连接池 lease 由 owner 串行清理后交给下一工作区，防止旧 OAuth/握手迟到写入新目标）。

### 7.4 事件顺序（所有者与顺序图）

```
UI                       Host CLI(协议 handler)              core trust 域            用户域 store
 │ mcp/list(mode=status)    │                                   │                        │
 ├─────────────────────────>│ inspect()（不连接）                │                        │
 │                          ├──────────────────────────────────>│ 读声明+记录(注入port)   │
 │<── statuses{pending_trust,toolCount:0,workspaceTrust} ───────┤                        │
 │                          │                                   │                        │
 │ [横幅A: N 个待信任]       │                                   │                        │
 │ workspace/mcp/trust      │                                   │                        │
 ├─ trusted:true,digest ───>│ decide()                          │                        │
 │                          ├──────────────────────────────────>│ 锁内重读→匹配→原子写 ───>│
 │<── {accepted:true} ──────┤ 通知同 workspace 活跃会话           │                        │
 │                          │  reloadWorkspaceMcpTrust()         │                        │
 │                          ├──────────────────────────────────>│ refreshAdmission       │
 │<── 事件 WorkspaceMcpAdmissionUpdated{pendingCount:0} ────────┤ 发布(串行尾队列)        │
 │ [横幅A 消失]              │                                   │                        │
 │                          │                                   │                        │
 │ 新建/重启会话 session create                                  │                        │
 ├─────────────────────────>│ guard(port).connectConfiguredServers                        │
 │                          ├────── allows() 重验（digest 精确匹配）──> store 记录          │
 │<── statuses{connected,toolCount:N}（仅过审集合连接）──────────┤                        │
```

撤销路径：`decide(trusted:false)` → 记录删除 → admission 刷新 → **现有连接继续到自然结束
或显式断开；新建/重启会话与重连准入被 `allows()` 拒绝**，投影回 `pending_trust`。

## 8. UI 状态机（双横幅）

### 8.1 横幅 A：会话内待信任摘要（composer 常驻提示条）

- 组件：`packages/ui/src/v4/WorkspaceMcpPendingBanner.tsx`（新），置于
  `WorkspaceHookPendingBanner` 同级（conversationBottomDock，composer 之上）。
- 数据源：`snapshot.workspaceMcpAdmission`（v4 协议，桌面与 web-remote 同源；手机远控
  只读展示，不做授权写入）。
- 显示条件：`pendingCount > 0` 且未被 dismiss；dismiss 幂等键 = `sessionId +
bundleDigest`（bundle 变化后重现；不落盘）。
- 文案（i18n zh/en parity）：正文「N 个工作区 MCP server 待信任，本会话未连接」；主按钮
  「去设置」（`setPendingSettingsSectionIntent("mcp")` + 打开设置）；次按钮「忽略」。
- banner 不携带任何声明细节（脱敏摘要只在设置页展示）。

### 8.2 横幅 B：设置页 MCP 列表行级信任状态

- 数据源：`mcp/list` snapshot 的 `workspaceTrust` review（脱敏 `display`）。
- workspace 作用域行：状态 dot 与状态文案按 `pending_trust` → warning 色呈现；行内展示
  脱敏声明摘要（stdio 命令行 / 脱敏 URL）；操作按钮 `[信任]`（未信任时）→ 调用
  `workspace/mcp/trust`，成功后刷新列表与 admission；`[撤销]`（已信任时）→ 同方法
  `trusted:false`。
- **撤销提示文案必须写明生效边界**：「撤销在新建/重启会话后生效」，避免用户误以为已断
  在用连接（§3.2 规则 5）。
- 用户/插件 MCP 行不变；`pending_trust` 的 UI store 映射新增于
  `packages/ui/src/store/mcpStoreStatusList.ts`（呈现为带安全说明的非成功配置态，
  failureKind 用 `status_unavailable` 语义；`"untrusted"` 现有映射保留不动）。

**F23② 实施登记（2026-11-07）**：

- 横幅 A 已落地：组件 + SessionPane 挂载（hook 横幅同位之后）+ i18n
  `chat.workspaceMcpPending.*`；dismiss 幂等 store 与 hook 横幅同构。
- 横幅 B 已落地：`ZodyMcpServer.workspaceTrust`（shared mcp.ts）承载 review，
  `mcpStoreStatusList` 各状态分支原样投影（快照未携带时清空，不残留旧摘要）；
  行级摘要/`[信任]`/`[撤销]`/生效边界文案在 `McpServerList`；被拒（含
  `workspace_mcp_declaration_changed`）与成功都以 manual 刷新收尾，行摘要回到
  Host 当前事实。
- **动作接缝（落位登记）**：services 转发（mcp-sync `setWorkspaceMcpTrust`）属
  §11 wiring 卡，本步 UI 侧以结构化注入接缝
  `WorkspaceMcpTrustService`（`packages/ui/src/settings/workspaceMcpTrustActions.ts`）
  承接：`McpSettingsSection.workspaceMcpTrustService` 未注入时不渲染信任/撤销按钮
  （审核状态与脱敏摘要仍展示），wiring 落地后注入即启用，行级组件无需再改。
- 伴随改动：`userActionTraceCatalog` 新增
  `conversation.blocking.mcp_trust`（review/dismiss，横幅 A dismiss 遥测；
  hook 门禁同族先例），目录计数测试 24→25 feature、94→96 叶子同步更新。

### 8.3 生效边界（UI 侧状态机）

```
信任:   pending_trust --[workspace/mcp/trust trusted:true]--> trusted(投影)
        生效点 = 新建/重启会话、mcp/list connect 模式重探、下一次连接准入
撤销:   trusted --[workspace/mcp/trust trusted:false]--> pending_trust(投影)
        现有连接: 继续到自然结束/显式断开; 横幅A重现(若仍有启用未信任声明)
摘要变更: trusted --[args/env/cwd/url/headers 任一变更]--> pending_trust(digest 失配)
```

## 9. 验收场景（含安全评审三条）

安全评审（F23 专属门禁，未过不得合入）：

- **S1 未信任 server 工具数 0**：workspace 声明未信任时，`mcp/list` 与运行态
  `listTools()` 均不含其工具、`toolCount: 0`、零进程/零请求（stdio 用真实子进程探针
  断言从未 spawn）。
- **S2 digest 变更需重信任**：args、env、cwd、command（stdio）与 url、headers、oauth.type
  （http/sse）逐项变更后，原记录失配、投影回 `pending_trust`、旧摘要的 `decide()` 被拒
  （`workspace_mcp_declaration_changed`）；`enabled` 开关不进入摘要（不扩大也不清除授权）。

功能验收：

- **A1 撤销生效路径**（安全评审③）：信任 → 连接使用中 → 撤销 → 现有会话连接不被中断、
  已提交副作用不回滚；新建会话/重连准入被拒并投影 `pending_trust`；显式断开后立即拒绝
  工具调用。
- **A2 inspect 不连接**：`inspect()` 期间无任何 MCP 进程/请求（真实 stdio 探针断言）。
- **A3 decide 原子性**：锁内重读 + 原子写；并发进程批准不同 workspace 记录互不丢失；
  陈旧摘要拒绝。
- **A4 default-deny**：store 损坏/记录未知/声明读取失败 ⇒ 一律 `pending_trust`，且不把
  已有声明显示为 trusted；项目 `storage.dir` 不改变用户域记录位置。
- **A5 跨身份隔离**：同 serverName 不同 `workspaceIdentity` 不继承授权（含连接池 lease
  复用路径）。
- **A6 来源豁免**：user/plugin/builtin 来源不被拦截；workspace 声明经 `params.mcpServers`
  下发同样必须审核（§5.1 通道差异不豁免）。
- **A7 竞态**：连接替换串行（新声明不得映射到旧连接）；admission 事件发布串行（授权后
  清零不被旧 pending 覆盖）；guard signal 失效后迟到操作全部拒绝且共享 lease 不被关闭。
- **A8 协议与投影**：trust params/result schema roundtrip；`pending_trust` 枚举解析；
  snapshot `workspaceMcpAdmission` default(null) 与 delta 增量；事件投影置 null 规则。
- **A9 UI**：横幅 A 显隐/dismiss 幂等键/去设置动作；横幅 B 信任/撤销动作与撤销生效边界
  文案；`pending_trust` 状态映射与 `untrusted` 映射互不影响；i18n zh/en parity。
- **A10 脱敏**：`display` 不含 env 值、header 值、URL 凭据；以命令参数传入的常见密钥
  不出现在审核展示中。

每项验收至少一个反例：先在修改前断言旧行为（默认信任自动连接 / `untrusted` 槽位不动）
失败，再断言新行为通过（测试落点见 §11）。

## 10. E2E 场景清单（按 e2e-case-lifecycle 现行规则）

F23 含 UI 交互（双横幅），E2E 场景登记入口为
`packages/desktop/test/e2e/conversation-session/manual-review/pending/`，经人工确认后由
`e2e:promote` 晋升并更新覆盖矩阵。候选场景（feature 语义即本 spec，按生命周期规则先
登记语义、再写测试）：

| #     | 场景                                  | 关键断言                                                                   |
| ----- | ------------------------------------- | -------------------------------------------------------------------------- |
| E2E-1 | 打开含未信任 workspace MCP 声明的仓库 | 横幅 A 出现（N=声明数）、设置页行级 `pending_trust`、行内零连接、工具数 0  |
| E2E-2 | 设置页信任后新建会话                  | 新会话连接成功、工具可见、横幅 A 消失；旧会话在信任前未连                  |
| E2E-3 | 修改声明 args 后（digest 变更）       | 横幅 A 重现、行级回 `pending_trust`、旧授权不可用（需重信任）              |
| E2E-4 | 撤销已信任 server                     | 撤销生效边界文案可见；新建会话拒连、投影 `pending_trust`；在用会话不被中断 |

**缺口登记**：`packages/desktop/`（E2E 目录）与 E2E 覆盖矩阵不在本卡落点（见 §11），本步
只登记场景清单；E2E 用例编写与晋升在落点扩展后执行，此前不得宣称 E2E 覆盖。

## 11. 落点与范围边界（本卡）

落点内（可改）：

| 层        | 落点                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared    | `packages/shared/src/`：协议 schema（§6）、store 文件 schema（`workspace-mcp-trust-store-file.ts`）；摘要算法因 renderer-safe 约束落 core（§4 落位修订） |
| core      | `apps/zody-cli/packages/core/src/mcp/`（信任域 + guard + 摘要算法单源）＋ `core/tests/`（S1/S2/A1–A7/A10 对应单测）                                      |
| contracts | `apps/zody-cli/packages/contracts/src/`：McpPort 守卫面类型、`WorkspaceMcpAdmissionUpdated` 事件 payload                                                 |
| ui        | `packages/ui/src/`（横幅 A/B、store 映射、i18n）＋ `packages/ui/test/`（A8/A9）                                                                          |
| docs      | 本 spec 与相关文档更新                                                                                                                                   |

**落点缺口（需 controller 裁决扩展或另立 wiring 卡，本卡不自行修改）**：实现上线需要
以下落点外 wiring——bootstrap（`zody-protocol/mcp.ts` 默认信任注释与空集、
`zody-protocol/server.ts` 方法注册、`app/create-app.ts` guard 安装与 admission 事件、
`app/types.ts` reload 面、`app/session-facade.ts`、`app/runtime-config.ts:110`）、
adapters（store 路径解析复用 hook store 同目录规则、声明发现 port 实现）、services
（mcp-sync `setWorkspaceMcpTrust` 转发、zcodeAgentService）、desktop host（手机远控
exposure policy 是否放开 trust 命令——建议**不放开**，信任是 Host 本机用户域决策）、
packages/desktop E2E。core 域模块与 shared schema 可先行开发并独立测试，wiring 缺口
不阻塞本卡落点内交付。

**F23④ 实施登记（2026-11-08，wiring 已落地）**：

- 五项接线全部完成：① `zody-protocol/server.ts` 注册
  `zodyProtocolMethods.workspaceMcpTrust` → `setWorkspaceMcpTrust` handler（锁内重读
  落盘 + 按 workspace 通知活跃会话）；② `app/create-app.ts` 在 cua wrapper 之外用
  `createWorkspaceMcpTrust(...).guard()` 包住整个 MCP lease，admission 变化经
  `runtime.appendEvent` 发 `WorkspaceMcpAdmissionUpdated`，resume 后 reannounce，
  `ZodyApp.reloadWorkspaceMcpTrust()` 为 server 通知面；③
  `zody-protocol-v4/product-projection.ts` 投影 `WorkspaceMcpAdmissionUpdated` →
  `snapshot.workspaceMcpAdmission`（pendingCount 0 → null）；④ services
  `IMcpSyncService.setWorkspaceMcpTrust` → `zodyAgentService.setWorkspaceMcpTrust` →
  协议转发（UI 注入接缝签名一致）；⑤ adapters `storage/workspace-mcp-trust-store.ts`
  （hook store 同目录 + `@zody/shared/node` withFileLock/atomicWrite 单源）与
  `config/workspace-mcp-trust-discovery.ts`（createConfig project 作用域 + `.agents/mcp.json`
  fallback）。
- 组装单点：`app/runtime-config.ts` 的 `createAppWorkspaceMcpTrust()`（core 纯域 + 两个
  adapters port 的唯一拼装处；上游内联在 bootstrap workspace-mcp-trust 模块，本仓按
  §4 依赖方向拆分）。`runtime-config.ts:110` 空集语义保留：拦截移交给 guard 连接准入
  （本仓无同步 workspace 来源标记；上游的同步 untrusted 集在本仓由 guarded port 的
  blocked 状态投影承载）。
- 手机远控：现状默认拒绝已核验——`packages/web/src/mobile-remote/homeOnlyServices.ts`
  将 `mcpSyncService` 整体替换为 unsupported home-only 桩，trust 写入面远端不可达，
  未新增任何放开逻辑（§11 建议照准执行）。
- **落位差异登记（提请 controller 确认）**：① 事件投影与「非活动事件」黑名单物理落位
  在 `zody-protocol-v4/product-projection.ts` 与 `zody-protocol/server-operations.ts`
  （卡面命名 `projection-state.ts` 只含初始快照工厂，F23① 已落伴随行；事件分派在
  product-projection.ts，同族 hook 投影先例同位）；② `contracts/src/interfaces/mcp.port.ts`
  的 `McpServerStatus.workspaceTrust?` 可选字段系 F23① 扩枚举时的漏陪字段（上游在位），
  wiring 的 withReviews 落地后补齐，additive；③ 测试注入面：`ZodyAppOptions.workspaceMcpTrustHomeDir`
  （hook homeDir 先例）与 `setWorkspaceMcpTrust` handler 的 dependencies 注入
  （grantWorkspaceHookTrustForProtocol 先例）。
- `.agents/mcp.json` 坏邻项处置：校验失败条目以 `enabled:false` 占位声明收口（allows
  一律拒绝、投影 disabled、不计入 admission pending）——语义等价上游 requiredNames
  拒连，且不把校验失败误当用户可信配置。

**编译伴随行（F23② 实施时发现；controller 2026-11-07 授权纳入本卡，已随 F23① 实现步落地）**：

1. `apps/zody-cli/packages/tui/src/app-sidebar-mcp.tsx:105`——`copy.sidebar.mcp.status`
   按 `McpServerStatusKind` 穷举索引；contracts 枚举新增 `pending_trust` 后需在 tui 文案
   record 补一个键，否则 tui 包 typecheck 失败（与枚举扩展不可分离，需随本卡授权）。
   **落位登记（F23① 实施时确认）**：TS7053 报错在 app-sidebar-mcp.tsx，但
   `copy.sidebar.mcp.status` 的 record 实际单源在 `@zody/i18n`
   （`apps/zody-cli/packages/i18n/src/types.ts` + `locales/en-US.ts`/`zh-CN.ts`，本地
   locale 按 TuiCopy 类型约束，三处不可分离、各一行）；已按授权意图（补
   `pending_trust` 文案键）落地，en `pending trust` / zh `待信任`。
2. `apps/zody-cli/packages/bootstrap/src/zody-protocol-v4/projection-state.ts`
   `createInitialConversationSnapshot`——v4 snapshot 新增 `workspaceMcpAdmission`
   （additive + default(null)）后，初始快照字面量需补 `workspaceMcpAdmission: null`
   （同文件 92 行 `workspaceHookAdmission: null` 先例）；已随本卡落地（授权伴随行）。

**随 F23① 落地的枚举完备映射**：`packages/ui/src/store/mcpStoreStatusList.ts` 的
`mapRuntimeStatusToUi` 对 `pending_trust` 的 switch 分支（呈带安全说明的非成功配置态，
`untrusted` 分支保持不动）——协议枚举扩展后 UI 映射必须完备才能编译，属枚举扩展的
必陪改动；横幅 A/B 与设置页行级 UI 仍属步骤 ③。

## 12. 明确不做（本期）

- 不迁移/不删除 `"untrusted"` 枚举及其 UI 槽位（保留历史语义，防误伤）。
- 不做批量信任/全部信任（consent fatigue）。
- 不为远端（web-remote/mobile）提供授权写入；远端只读展示 admission。
- 不做信任过期、签名校验或 TOFU 提示；记录无 TTL。
- 不改 `mcp/probe` 单 server 主动检查语义。
- 不与任何其他 tier2 项捆绑合入。
