# 上游 v3.16.2 移植实施计划（I01–I21 执行编排）

状态：执行计划，2026-10-23。范围、owner 边界、验收标准与场景锚点以 [docs/plans/upstream-v3.16.2-port-plan.md](upstream-v3.16.2-port-plan.md)（下称 port-plan）为唯一来源，本文不重复定义，只补充执行所需的三件事：单项工作流与批次推进、**已按当前工作区核实的代码落点**、每项的验证入口与风险修正。编号沿用 I01–I21。

2026-10-24 更新：B1 批次已执行（7 项提交、I08 复审受阻转 B2 续作，见 §5/§6 台账）；port-plan §6 待决规则除 I12 外已全部落定（见 §3 决策记录）。§4 各卡行号为 2026-10-23 工作区快照，逐项开工时按当时 HEAD 重核（port-plan §1 同一纪律）。

## 1. 单项工作流（每个候选统一执行）

```text
planned → recheck（按当时 HEAD 重核缺口与本文落点）
        → spec（先更新/新建领域文档，语义反转向的项在 PR 中显著标出）
        → red（反例测试先行，确认在当前实现上失败或缺失）
        → implement（最小适配，不做无关重构）
        → verify（真实入口验证 + pnpm typecheck / lint / architecture:check --changed）
        → ledger（同步台账：来源 SHA/路径、适配理由、实际命令与结果、平台缺口、回滚方式）
        → PR（一项一个可回滚 PR；改持久数据的项先补迁移与降级合同）
```

任一环节反证不成立（当前已覆盖 / 复现不成立）→ `closed`，在台账记录反证依据，不为凑数写代码。完成判定引用 port-plan §7 的 5 条，不在本文复述。

E2E 相关项一律走当前 `e2e-case-lifecycle` 工作流：先在领域 catalog 取得 accepted 场景，再写测试。port-plan §5 的 `UP316-*` 场景 ID 全部是 planned 锚点，实施时映射为正式 case。

## 2. 本次核实对计划的修正（开工前必读）

以下 8 条是对照当前代码后发现与 port-plan 表述或现状有出入的事实，影响执行方式：

| #   | 修正                                                                                                                                                                                                                                                                                                                                                        | 影响                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **I09 疑似当前已覆盖**：`apps/zcode-cli/packages/tui/src/tui.tsx:66` 已是单一 `createRoot`，`:138-143` StartupScreen→TuiApp 在同一 root 内 render 切换，`:127-136` DESTROY 时清理订阅并 unmount；热键经 `useKeyboard` 随卸载自动清理                                                                                                                        | I09 优先走「重跑测试 + 逐 hunk 比对上游补丁」的反证关闭路径，不预设要写实现                                                                       |
| C2  | **I21 的 `scripts/policy/` 目录不存在**：架构门禁实际在 `scripts/architecture/`（architecture-check.mjs / index.mjs / policy.mjs + `.architecture-baseline.json`），测试选择在 `scripts/run-affected-unit-tests.mjs`                                                                                                                                        | port-plan「scripts/policy 是门禁 owner」需在 B0 修正：或改写为现路径，或把「迁移到 scripts/policy」作为 I21 的显式子决策                          |
| C3  | **I03 的 spec 现文明确否定目标语义**：`docs/chat/send-prompt-model-resolution-chain.md` 写明「项目目前没有每条 queued prompt 固定入队时模型的产品语义」                                                                                                                                                                                                     | I03 是产品语义反转，不是补缺；spec 改写理由与 V4 先例（`zcode-protocol-v4/commands/input-admission.ts:117-159` 已在接收边界冻结）需在 PR 首屏说明 |
| C4  | **I19 与现行 spec 不变量需要先对齐**：`docs/v4-refactor/17-cold-resume-runtime-activation.md` §3 有 `runtimeReadyBeforeHydration` 不变量、§4.2 规定 READY 注册早于 activation；当前 `v4-gateway.ts:1419` activation→hydration 完成前不发布任何状态                                                                                                          | 「历史/初始化状态先发布」如何与该不变量表共存（投影发布 ≠ hydration）是 I19 第一个要写清的 spec 决策，开工前与用户对齐                            |
| C5  | **I20 与现行 suspend 策略直接冲突**：`packages/ui/src/plugin-ui/app/pluginUiPageManager.ts:110-113` 现在「settled 且不可见立即 suspend」（真撤 guest+lease）                                                                                                                                                                                                | I20 是生命周期语义变更（后台执行表面），不是纯增量；须连带重审 30/64 容量、离屏 5min 定时器与 Main 侧 sandbox TTL 6h                              |
| C6  | **I05 现有测试断言了要改掉的行为**：`bootstrap/tests/workflow-concurrency-governor.test.ts:342` 断言 `retryable:false` 的 rate_limited → throttled（配额进冷却）                                                                                                                                                                                            | 实施时改写该用例意图为 Stop 分流断言，并保留 retryable 429 对照组；不得静默删除断言                                                               |
| C7  | **I17 回归目录现状**：`docs/model-provider-regression-case-catalog.md` 无任何 mimo 条目，且该文件当前有未提交改动（手机远控线）；`config/provider/zcode-builtin.json` 干净                                                                                                                                                                                  | I17 开工前先与该未提交改动协调基线；模板 revision 当前为 32                                                                                       |
| C8  | **工作区交集**（全部保持原样，不并入本轮）：I12 依赖的 Android 保存桥（MobileFileSaver/DownloadsFileWriter/ZcodeMobileBridge、`packages/ui/src/mobileFileBrowserSave.ts`）与 I14 的 `webRemoteControlManager.ts`、I08 相邻的 `PreviewPane.tsx`/`previewPane.test.ts`、I21 的 `architecture-policy.yaml`（+13 行 mobile-notifications 登记）都在未提交改动中 | 这些项的开工前置是其依赖线先合入或明确基线；I21 在 `architecture-policy.yaml` 改动合入前不动该文件                                                |

本轮基线检查（真实结果）：`check-workspace-freshness` 通过（main 相对 origin/main ahead 11 / behind 0）；`pnpm lint` exit 0（0 errors / 312 warnings，未清理无关告警）；**`pnpm typecheck` 当前 exit 2**——7 个错误全部位于未提交的手机远控文件（`packages/services/src/mobile-notifications/adapters/service-ttl.test.ts` ×4 TS2532、`packages/ui/src/MobileWorkspaceFileBrowser.tsx` ×3 TS2304），属该工作线自身待修，不属本计划范围。**B0 出口要求这批错误由手机远控线修复或隔离后，基线恢复 typecheck 通过。**

## 3. 批次推进与并行建议

批次、依赖图与出口条件见 port-plan §2（mermaid 图与硬依赖不变）。本文补充执行口径：

| 批次 | 入口条件（本批第一项开工前）                                                                                                               | 并行建议                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| B0   | §2 修正 C1–C8 落定：I09 反证结论、I21 owner 决策、typecheck 基线恢复                                                                       | 与任一批次无冲突，可边做边放行小修                                                                                             |
| B1   | 各项 recheck 完成即可独立开工                                                                                                              | 按包分线索并行：services（I01/I18）、adapters+server-cli（I02/I11）、core（I04）、bootstrap（I05）、ui（I08）、tui（I09 反证） |
| B2   | I03 与 I19 都碰 admission：**I03 先合入**，I19 开工时重跑 I03 回归                                                                         | I16（adapters）与 I17（config/provider）可并行；I16/I17 各自的 §6 待决规则先落定                                               |
| B3   | I06/I07 在不同层（bootstrap storage 锁 vs bootstrap mcp-ui protocol），可并行但都在 bootstrap 包，注意 rebase 顺序；I10 独立（ui + patch） | I10 的 patch 与锁文件改动单独 PR                                                                                               |
| B4   | I12 依赖 C8 的 Android 桥合入 + §6 待决「手机复制能力范围」落定；I12/I13/I15 共享预览入口，**顺序合入**（建议 I15 → I13 → I12，先轻后重）  | I14 独立（desktop），可与上三项并行                                                                                            |
| B5   | I20 复用 I07 已合入的连接等待/lease 合同；I19 的 C4 spec 决策已对齐                                                                        | I19 与 I20 不同包（bootstrap vs ui/desktop），可并行，各自验收                                                                 |
| B6   | I21 的算法调查可早做（B0 起随时）；**门禁切换**必须在本仓夹具全绿后                                                                        | 单线索                                                                                                                         |

port-plan §6 待决规则落定情况：I03（C3 语义反转）、I16（临时输出保留期）、I17（旧模型处理）、I19（C4 不变量口径）、I20（C5 生命周期与资源上限）已于 2026-10-24 由用户确认，见下节；I12（手机复制范围）仍开放，B4 开工前落定。

### 待决规则决策记录（2026-10-24，用户确认）

| 项  | 已决口径                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I03 | 采用入队冻结 ModelSelection（语义反转获批）：普通 CLI 提交边界捕获完整选择进 intent，执行读冻结值，对齐 V4 接收边界冻结语义；V4/automation/临时 modelExecution 等已有显式选择的入口不动。spec 改写按 C3 在 PR 首屏说明反转理由与 V4 先例。                                                                                                                       |
| I16 | 方案 a：保持持久输出根（`~/.zody/cli/exec`），改为 per-toolCall 隔离目录，30 天按龄清理；重启后查询/历史取回合同不缩水；临时根创建失败按 spec 定义的回落路径处理。                                                                                                                                                                                               |
| I17 | v2.5 与 v2.6 并存（初版口径）；实施时核验厂商状态后触发停服例外：厂商已于 2026-10-21 下线 v2.5（10-14 起自动转发），owner 裁决两个模板的 `builtinModelIds` / `templateModelRules` 收敛为 v2.6，保留 v2.5 规则供存量 Personal 解析；Personal 配置与历史选择不静默改写。回归 catalog 未提交改动协调前不动，MiMo 回归用例暂记在 `docs/provider-mimo-templates.md`。 |
| I19 | 不变量收窄获批：`runtimeReadyBeforeHydration` 改为「runtime 先于**实时事件 hydration**」；历史投影/初始化状态可先行发布。等待窗口内命令沿用逐命令分类 + ready/failed guard，不加 Renderer 已接受队列。                                                                                                                                                           |
| I20 | 生命周期语义变更获批：废除「settled 且不可见立即 suspend」，销毁仅由显式删除/重载/来源失效驱动；容量沿用 30 task/64 allocated，超限拒绝新页面并提示；离屏 5min 定时器与 sandbox TTL 6h 随语义一并重审。                                                                                                                                                          |

## 4. 每项实施卡

每张卡：已核实落点（含现状缺口）→ 实施步骤 → 验证入口 → 依赖/风险。验收与场景见 port-plan §3/§5 对应行，不重复。

### I01 · 凭据密文空值合法化（B1 · 小）

- **落点**：`packages/services/src/credential/providers/credentialCipherProvider.ts:77-80` —— decrypt 按 `.` split 三段后 `!cipherRaw` 把「第三段缺失」与「合法空串」同等拒绝，`encrypt("")` 的产物自家解不开。前缀/旧明文兼容 `:72-74`，key 派生 `:19-30`；key/文件锁在 `credentialKeyStore.ts`（不动）。
- **步骤**：① `specs/zody-credential-key.md` 补密文格式规则（空明文合法、段缺失非法）② `packages/services/test/credentialService.test.ts` 补反例：空值往返、非空往返、缺段/错 tag/错 key 拒绝，先红 ③ 改 decrypt 分段校验：结构完整（两个分隔符）时接受空 cipher 段 ④ 验证 store/key 不被重建。
- **验证**：`pnpm exec vitest run packages/services/test/credentialService.test.ts`（services 无独立 test 脚本，走根 vitest）。
- **风险**：小；无工作区交集。

### I02 · 编码探测采样补尾与短读（B1 · 小）

- **落点**：`apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts:163-176` `detectEncodingFromHead` 单次 `read` 无短读补齐循环，4096 边界截断 UTF-8 多字节尾部无处理；`text-metadata.ts:39-41` `isValidUtf8` 严格无尾部容忍 → 截断样本跌落 GBK 往返（`:131-144` 仅 GBK 侧容忍 3 字节）可能误判。探测用独立 fd（`:168-174`），不混入输出。
- **步骤**：① 新建 `docs/runtime-tools/read-encoding-sample-boundary.md` ② `tests/fs-context.test.ts` 补反例：多字节跨 4096 边界、连续短读、EOF、UTF-16/GBK 对照、abort、句柄关闭 ③ 实现 read 补齐循环 + UTF-8 尾部处理 ④ 回归既有 GBK/UTF-16/短二进制用例（`fs-context.test.ts:238/275/301+`）。
- **验证**：`pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/fs-context.test.ts`。
- **风险**：探测结论影响 >10MB 流式路径选择；adapters 包当前干净。

### I03 · 普通 CLI 入队冻结 ModelSelection（B2 · 中）

- **落点（现状=不冻结）**：`bootstrap/src/app/input-facade.ts:189-269` sendInput/submitPrompt 无快照；`core/src/runtime/methods/prompt-admission.ts:20-142` busy 分支走 `enqueueDeferredInput`；`steering.ts:247-253` 队列只存调用方 intent；执行时 `turn.ts:115` `intent?.modelSelection ?? getSessionModelSelection()` 回读当时 session 值。对照：V4 已冻结（`zcode-protocol-v4/commands/input-admission.ts:117-159`，注释明言接收边界固定）；automation `automation-port.ts:101`、临时 `model-execution.ts` 各自 owner 保持。
- **步骤**：① 更新 `docs/chat/send-prompt-model-resolution-chain.md`（语义反转已获批 2026-10-24，口径见 §3 决策记录；按 C3 在 PR 首屏说明反转理由）② 反例：A 运行时入队两条 → 切 B → 旧输入 A / 新输入 B；显式 intent 不被覆盖；取消/重试行为（core prompt-admission/steering + bootstrap queue-input-fidelity 定向补）③ 在 input facade 提交边界捕获完整 ModelSelection 进 intent（复用 V4 固定语义与构造工具，不手写第二份）④ 验证。
- **验证**：`pnpm --filter @zcode/core test`、`pnpm --filter @zcode/bootstrap test`（定向：prompt-admission、steering、queue-input-fidelity、command-inbox）。
- **风险**：与 I19 顺序合入（§3）；是本批唯一的语义反转项。

### I04 · workflow amend 新 provider 确认（B1 · 小）

- **落点**：`core/src/tool/handlers/amend-workflow-resolve.ts:64-172` 已丢弃模型伪造的 predecessor（`:145-155`）、绑定归一化在 `workflow-script-models.ts`（provider 可从规范化串派生，`:28`）；缺口：`permission/service.ts:393-430` `isOwnedWorkflowAmend` 只看归属，无 provider 变化分支。契约谓词 `contracts/src/tools/amend-workflow.ts:134`。
- **步骤**：① 更新 `docs/dynamic-workflow/launch.md`（现规则只有归属维度）② `tests/amend-workflow-permission.test.ts` 补：同 provider 修订免窗、新 provider Ask/Deny 且零执行、伪造 predecessor 无效 ③ amend resolver（`resolveInput`）从规范化绑定计算新旧 provider 并写入 `predecessor.introduces_providers`（事实来自 journal 快照 + modelCatalogPort），permission service 经契约谓词据该事实决策（owner 规则增加第三条件；见 port-plan「amend resolver 产生事实，permission service 决策」）④ 同步 `amend-workflow-retune.ts:159` 的同谓词调用。
- **验证**：`pnpm --filter @zcode/core exec vitest run tests/amend-workflow-permission.test.ts`。
- **风险**：测试已有约 1500 行覆盖，只加不减。

### I05 · governor Stop 与可重试 throttle 分流（B1 · 小）

- **落点**：`bootstrap/src/app/workflow-concurrency-governor.ts:241-288` publish 分类：不可重试的 rate_limited（含配额 Stop）仍进 `throttled`（`:277-282`）。策略表本体已存在：`adapters/src/model/workflow-model-failure-policy.ts:78`（quota 码表 `:36-55`、Stop kinds `:22-28`）；driver 收容 `workflow-driver-model-failure.ts:43-74`。
- **步骤**：① 更新 `docs/dynamic-workflow/concurrency.md` governor 事件映射段（失败策略表 `:615-650` 已在，缺 governor 分流）② 按新语义改写 `tests/workflow-concurrency-governor.test.ts:342` 用例意图（见 C6），补对照：quota Stop 长 Retry-After 不留冷却 vs retryable 429 保留冷却 ③ governor publish 接入 `resolveWorkflowModelFailurePolicy`，Stop 走 ended 不进冷却桶 ④ 验证 reset/resume 后继续运行。
- **验证**：`pnpm --filter @zcode/bootstrap exec vitest run tests/workflow-concurrency-governor.test.ts`。
- **风险**：governor 现只读 reason 字符串，接入策略表需核实错误形状（`AiSdkModelAdapterError`）在该事件路径可用。

### I06 · 插件读写调度拆分（B3 · 中）

- **落点**：`bootstrap/src/lib/plugin-storage-lock.ts:6-28` 读写共用 per-storageRoot promise 链；读操作 validate/describe（`zcode-protocol/plugins.ts:473/499`）也排队在写后面；list/overview 不持锁，但其触发点内嵌 lazy 写：seed（`bundled-plugins.ts:230-258` → `seedBundledOfficialPlugins:94-214`）、manifest 重写（`official-plugin-runtime.ts:51-93`）、`ensureDefaultPluginMarketplaces`（`adapters/src/plugins/marketplace.ts:337-361`）——只有跨进程 seed 锁（`official-plugin-seed-lock.ts:15-53`），无 in-process 互斥。config 写者（configure/reset/setEnabled）无 storage 锁。
- **步骤**：① 更新 `docs/claude-code-marketplace-plugin-compat.md` + `docs/plugin-management-lifecycle-case-catalog.md`：操作读写分类表与锁语义 ② 反例：安装 A 被闸门挂住时 describe/list/overview 及时返回；缺 manifest 并发初始化不丢写（扩 `plugin-storage-lock.test.ts`、`plugins-protocol.test.ts`）③ 实现：读走快路径（缓存命中不持写锁），lazy seed/manifest 写纳入写锁且与跨进程 seed 锁兼容 ④ Desktop 插件 pending E2E（走 e2e-case-lifecycle）。
- **验证**：`pnpm --dir apps/zcode-cli/packages/bootstrap test`。
- **风险**：锁序防死锁（现测试 `:596` 已覆盖 locked install 内 restore）；seed 锁用 Atomics.wait 同步睡眠，勿扩大其持锁范围。

### I07 · MCP 首开连接屏障（B3 · 中）

- **落点**：pool 已有 connecting 等待能力（`adapters/src/mcp/pool.ts:51/258/313`，acquire 最终 `await entry.connecting`）与 generation（`adapters/src/mcp/index.ts:1865-1901`，仅 connected 返回快照）；缺口在协议层：`bootstrap/src/zcode-protocol/mcp-ui/protocol.ts:216-290` `openMcpUiInstance` 拿不到快照直接抛 `-32001`，不等待 → services `pluginUiBridgeService.ts:204-221` → UI 卡片 error + 手动 Retry。实例 lease/换代在 `mcp-ui/instances.ts:25-150`；会话侧二次验证先例 `session-facade.ts:496-503`。
- **步骤**：① 新建 `docs/plugin-ui-connection-readiness.md` + 更新 `mcp-ui/CONTRACT.md`：等待合同（等既有 connecting、失败终态、放行后重验 session/lease/generation）② 反例：initialize 闸门阻塞时打开页面 → 放行后自动成功无需重试；等待中释放/换源 → 旧 lease 不得签发；并发 open 单实例（扩 `instances.test.ts`、`mcp-connection-pool.test.ts`、`prepareRaces.test.ts`）③ 实现：openMcpUiInstance 改为等待 pool 连接结果后重验再创建页面；UI 不改轮询 ④ 真实 Electron 页面验证 + 实例计数。
- **验证**：`pnpm --dir apps/zcode-cli/packages/bootstrap test`；`pnpm --dir apps/zcode-cli/packages/adapters test`。
- **风险**：I20 复用本项合同，先合入。

### I08 · 内嵌图片失败收口（B1 · 小）

- **落点**：`packages/ui/src/ToolCallBlocks/ToolCallBody.tsx:135-158` `InlineImageContent`：`.then()` 无 `.catch()`（reject = unhandled rejection + 永久 loading）；null 结果同样永久 loading；state 不绑 path/身份（依赖仅 `[fileService, preview.path]`，切 A→B 闪旧图、迟到 A 回包覆盖）；`src` 缺 `data:${mediaType};base64,` 前缀。对照已闭环实现：`PreviewPane.tsx:960-1018`、`markdown-image.tsx:179-249`。
- **步骤**：① 更新 `docs/ui/tool-display-rendering.md` 补 reject/空结果/绑定规则 ② 反例：reject → 失败态、null → 非 loading、切源不闪旧图（扩 `packages/ui/test/agentToolCallBlock.test.ts`，现只 mock 成功）③ 实现：catch、空结果终态、结果绑定 (path+identity) 校验、data URL 前缀 ④ 回归 previewPane 既有测试。
- **验证**：`pnpm exec vitest run packages/ui/test/previewPaneImageContent.test.ts packages/ui/test/agentToolCallBlock.test.ts`。
- **风险**：`PreviewPane.tsx`/`previewPane.test.ts` 有未提交 mobile 改动（C8），本项改 ToolCallBody 为主，合入顺序协调。

### I09 · TUI 启动页生命周期（B1 · 疑似已覆盖，反证关闭优先）

- **落点（现状已基本满足目标）**：`tui/src/tui.tsx:66` 单一 `createRoot`；`:138-143` startup options 存在时先渲染 `TuiStartupScreen`，首帧后同 root `renderApp`（`:89-115`）；`:127-136` DESTROY 时 `off(FRAME)`、`off(THEME_MODE)`、清 listener、`root.unmount()`；Ctrl+C 在 `app-startup.tsx:21-23`（`onExit(130)`）与 `app-keyboard.ts:201-225`（二次确认）。
- **步骤（反证关闭路径）**：① 重跑 `cli/tests/tui-startup.test.ts`（覆盖启动页→首帧）与 `tui/tests/ctrl-c-exit-guard.test.ts`、`tui-app.test.ts` ② 对照上游 v3.16.2 对应补丁逐 hunk 比对（同 root、卸载清理、启动失败/取消可退出、终端恢复），全部成立则记「当前已覆盖」并按台账关闭 ③ 仅当发现具体缺口才开实现。
- **验证**：`pnpm --dir apps/zcode-cli/packages/tui test`（node:test）；cli 包侧以实际脚本跑 `tests/tui-startup.test.ts`。
- **风险**：上游变更可能含本文未见的细节（主题订阅时序等），关闭前必须逐 hunk 比对，不能只跑测试。

### I10 · Radix 隐藏折叠测量补丁（B3 · 中）

- **落点（立项时）**：当时**无任何 radix patch**（`patches/` 与 `patchedDependencies` 均无）；`radix-ui@1.4.3` 锁定（`@radix-ui/react-collapsible@1.1.12`），测量点在 `node_modules/@radix-ui/react-collapsible/dist/index.mjs:104-125`（`useLayoutEffect` 无条件 `getBoundingClientRect`，hidden 也读）；dist 双格式（index.js CJS + index.mjs ESM）。适配层 `ui/src/components/ui/collapsible.tsx:14-48`；使用方 `ToolLayout.tsx:304-358`（`:195-210` 注释记录 300ms 延迟卸载规避空高闪烁）。
- **步骤**：① 新建 `docs/performance/collapsible-hidden-measurement.md`（补丁内容、CJS/ESM 双格式、版本锁定原因）② 反例：批量 hidden ToolLayout 断言 hidden 不读几何（夹具记录 hidden 状态与返回几何）；展开/defaultOpen/forceMount、Accordion 继承行为与可见动画回归；CJS/ESM 安装产物各加 guard 守卫 ③ `pnpm patch @radix-ui/react-collapsible@1.1.12` 实现补丁（聚合包 `radix-ui` 只有 re-export，不能承载修改），登记 `patchedDependencies` ④ 锁文件可重复安装校验。
- **验证**：`pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts packages/ui/test/accordion.test.ts`；`pnpm install --frozen-lockfile` 验证 patch 生效；同步 `THIRD-PARTY-NOTICES.md` / `third-party/inventory.json`。
- **风险**：升级 radix 会静默丢补丁，文档必须注明锁定；几何断言夹具参考 port-plan §5 UP316-I10。
- **证据偏差（2026-10-24 复审记录）**：反例以 jsdom 夹具统计 hidden 节点 `getBoundingClientRect` 调用并校验 CJS/ESM 安装产物 guard，未执行真实浏览器 layout/性能指标；port-plan §5 UP316-I10 要求的 layout 指标待后续浏览器 E2E 补齐，本项不声称已交付该证据类型。

### I11 · launcher 物理路径匹配（B1 · 小）

- **落点**：`packages/zcode-server-cli/src/runtime/stableLauncher.ts:21-28` POSIX `pwd` 无 `-P`（逻辑路径）+ 字符串前缀 `case` 匹配 release 根；Windows `:42-55` `GetFullPath`（非物理）+ `StartsWith`。Node 侧 `releaseManager.ts:161-180` `assertReleaseDir` 已双侧 realpath（缺口仅在 launcher 脚本）。测试 `test/releaseInstaller.test.ts:33-35` 钉住 launcher 文本。
- **步骤**：① 更新 `docs/architecture/r2-server-cli-and-daemon.md`（§7.1/§11）补物理路径匹配规则 ② 反例：symlink HOME/安装根、空格路径可启动且命中同一物理根；非法 releaseDir 仍拒绝（扩 releaseInstaller/pathsAndRelease 测试）③ 实现：POSIX `pwd -P`（或 ROOT 与 RELEASE_DIR 双侧物理化后比对）；Windows 同步 ④ 更新文本断言。
- **验证**：`cd packages/zcode-server-cli && pnpm test`；补 Server 发行 smoke。
- **风险**：不动 current.json / 更新 owner / R3。

### I12 · 图片复制/下载/加引用（B4 · 中）

- **落点**：现有唯一图片操作在 `ui/src/components/ai-elements/image-preview-dialog.tsx:329-391`（HTTP source 强制 `.png`、blob 保留原格式、无 saveFile 时回退 `<a download>`）；**无平台 clipboard 写接口**（`shared/src/platform.ts:748` 只有 `saveFile`，renderer 仅 `navigator.clipboard.writeText`）；Composer 引用机制现成：`requestComposerTextInsert`（`store/zcodeSessionStoreWorkspaceSlice.ts:422-452` → `ConversationComposer.tsx:1063-1090` 只写草稿不发送）；Android 保存桥在未提交改动（C8）。
- **步骤**：① 先落定 §6 待决「手机复制能力范围」→ 新建 `docs/ui/preview-pane-image-actions.md`（三动作、各端能力矩阵、失败态；手机复用现有 Android 保存，不新造 clipboard 桥）② 反例：原 SVG bytes、PNG 像素尺寸、无焦点/忙态、同路径不同 identity、远端来源、下载失败字节校验 ③ 实现：按待决口径扩展 clipboard 写（Desktop Main + IPlatformService）或裁剪端展示；下载保留原格式；引用走 `requestComposerTextInsert`（files mention）④ Android 走真实 Downloads 证据口径。
- **验证**：packages/ui 新增测试（根 vitest）；`cd packages/android && ./gradlew test`。
- **风险**：前置 = C8 Android 桥合入 + 待决落定；三端能力差异大，按能力矩阵裁剪 UI。

### I13 · 按文件类型打开应用（B4 · 中）

- **落点**：`shared/src/platform.ts` 已有 `openExternal:877`、`openExternalFile?:903`、`getInstalledEditors:1223`、`openInEditor:1226-1230`；发现机制是固定清单 `desktop/src/main/editors.ts:28-35`（无按文件类型发现）；`openInEditor.ts` 已 `execFile` 参数化启动（无 shell 插值）。现有打开入口：`PreviewPane.tsx:1762-1791`、`ArtifactOpenAsFileButton.tsx:44-129`。
- **步骤**：① 更新 `docs/ui/windows-workspace-editor-menu.md` + 新建 `docs/file-preview-open-apps.md`（按格式发现规则、参数化启动、远端路径禁止本机打开）② 反例：PDF/Office/媒体、无匹配 app、中文/空格路径、参数注入、远端路径不误开 ③ 实现：Main 侧把 EditorDef 模式扩展为 per-format 应用发现（三平台各自 API），UI 经 hook/platform 接口 ④ 三平台实际打开证据（Windows 环境单列）。
- **验证**：packages/desktop 定向单测（根 vitest）+ 三平台人工证据。
- **风险**：平台发现 API 差异（LaunchServices/LR-Registry/xdg-mime）；不支持端按 port-plan 剪枝只测「不提供」。

### I14 · Windows 未读 overlay（B4 · 中）

- **落点**：数据流已符合目标（unreadAt owner：`services/src/session/taskIndexRepo.ts:909-936/1782-1795` CAS；Renderer 汇总 `ui/src/lib/unreadTaskCount.ts:19` + `useRootPlatformEffects.ts:370`；Main 投射 `desktopWindowLifecycle.ts:319-352`，窗口关闭归零 `:345-346`）。缺口：`desktop/src/main/unreadBadge.ts:21` `supportsAppUnreadBadge` 仅 darwin/linux，Windows 一期有意 no-op（`unreadBadge.test.ts:48` 有断言）；全仓无 `setOverlayIcon`。
- **步骤**：① 更新 `docs/desktop/unread-badge.md`：Windows overlay/归零/DPI/窗口销毁语义；先改 `unreadBadge.test.ts:48` 的 no-op 断言为 Windows 分支预期 ② 实现：Main 侧 Windows `setOverlayIcon`（DPI 缩放、全部窗口关闭清 overlay），仍由 per-window 汇总投射，不加第二份事实 ③ 反例：未读→显示、查看→归零、多窗口、关闭清理；macOS/Linux 回归；不与手机通知已读（`webRemoteControlTaskRead.ts:23-40` CAS）混流 ④ Win10/11 真实 OS 证据单列。
- **验证**：`pnpm exec vitest run packages/desktop/test/unreadBadge.test.ts`；Windows 手动证据。
- **风险**：需真实 Windows（不能用 DOM 冒充）；`webRemoteControlManager.ts` 有未提交改动（C8），本项不动该文件。

### I15 · 文件卡片整卡打开（B4 · 小）

- **落点**：`ui/src/AssistantPreviewCards.tsx:293-348` 卡片主体是普通 div（无 onClick/role/tabIndex）；`OpenSplitButton.tsx:48-304` 已有 `stopPropagation`/`hideOpenWithMenu` props 便于复用；同组件还被 `MessageChangeSummaryPanel.tsx`、`v4/ConversationFileSummaryPanel.tsx` 使用。
- **步骤**：① 更新 `docs/ui/assistant-preview-cards.md`（整卡可打开、键盘语义、单次触发）② 反例：整卡/按钮/菜单分别只触发一次、Enter/Space 键盘、菜单不冒泡开文件、website URL/文件来源分流与 localhost 路由保留 ③ 实现：卡片主体接打开动作 + role/tabIndex，键盘不重复触发 ④ Desktop/手机适用 UI 验证。
- **验证**：`pnpm exec vitest run packages/ui/test/assistantPreviewCards.test.ts packages/ui/test/v4AssistantPreviewCards.test.ts`。
- **风险**：与 I12/I13 共享预览入口，顺序合入（§3：I15 最先）。

### I16 · Bash 隔离临时输出根（B2 · 中）

- **落点**：`adapters/src/exec/bash-file-output.ts:32-47` prepare（O_APPEND/0600/Windows "w"）+ `:49-63` discard；路径 `node-execution-adapter-base.ts:86-117` `outputPathsForRequest`（rootDir = `outputRootDir ?? ~/.zody/cli/exec`；`sessionId/toolCallId` 文件级隔离，WeakMap 缓存）；取消/spawn 失败已 discard（`node-execution-adapter-run.ts:192-196/320-321`）；查询 `node-execution-adapter-lifecycle.ts:300-337` + `core/src/runtime/methods/background-bash-output.ts`。缺口：无每命令隔离目录、无临时根创建失败的回落、无统一清理时点。
- **步骤**：①（待决已决 2026-10-24：方案 a——per-toolCall 隔离目录 + 30 天按龄清理，查询/历史合同不缩水）更新 `docs/tmpdir-storage-paths-spec.md` + `docs/background-bash-output-details.md`：现行查询/历史/冷恢复合同先原文记录，再定义隔离目录与回落/清理 owner ② 反例：并发隔离、临时根不可写回落、取消/spawn/shutdown 清理、后台读输出、历史查询与重启后不退化 ③ 实现：prepare 前确定 per-toolCall 隔离目录（如 `exec/<sessionId>/<toolCallId>/`），创建失败按文档回落 ④ 发行 smoke。
- **验证**：`pnpm --dir apps/zcode-cli/packages/adapters test`；core 侧定向 `runtime-background-bash-output.test.ts`、`background-task-output.test.ts`。
- **风险**：路径合同变化影响冷恢复查询（`background-bash-output-details.md:109` 有 2026-09-11 回归记录），路径语义先行写入 spec。

### I17 · MiMo v2.6 / API-Token 模板（B2 · 中）

- **落点**：`config/provider/zcode-builtin.json` templateRules[9]（约 `:299-320`）`xiaomi-mimo` 仅 `mimo-v2.5-pro/mimo-v2.5`（`api.xiaomimimo.com/anthropic`）；无 v2.6、无 token-plan 端点；Personal 覆盖机制就位（`packages/provider/src/resolver.ts:199-209` `templatePersonalProviders` overlay）；完整性测试 `provider-node/test/zcode-builtin-integrity.test.ts:218-231` 钉住现端点。
- **步骤**：①（待决已决 2026-10-24：v2.5/v2.6 并存，厂商停服则先回报；实施时触发停服例外，按 §3 I17 裁决执行）新建 `docs/provider-mimo-templates.md`；`docs/model-provider-regression-case-catalog.md` 未提交改动协调前不动，MiMo 回归用例暂记在 provider-mimo-templates.md（见 C7）② 反例：旧 v2.5 Personal 不被静默改写、两新模板端点分开、模型规则不串命中、个人名称/Key/URL/禁用态保留 ③ 实现：zcode-builtin.json 增量模板规则+模型规则（revision 32→33），同步 integrity 测试 ④ 设置 UI 回归；真实厂商请求不跑则单列 ⑤ 复审续作（2026-10-24）：v2.6 `modelMatch` 支持裸名、`/` 前缀与 `[1m]` 标记并排除 `-ultraspeed`，补生产/测试 MiMo 子集 parity 与 UI 测试路径修复。
- **验证**：`cd packages/provider-node && pnpm test`；`cd packages/provider && pnpm test`。
- **风险**：只迁模板差异，不迁整份模型目录、不引入新 Provider 类型。

### I18 · 旧配置导入 maxOutputTokens（B1 · 小）

- **落点**：`services/src/model-provider/legacyZCodeConfigProviderReader.ts:221` schema `z.number().positive()` 无 `.int()`（对照写回结构 `legacyModelProviderSerialized.ts:221` 是 `int().positive()`，存在宽松差）；优先级链 `:448-459`（limit.output > options.max_tokens > 顶层）与幂等（`node.ts:1159-1162` Personal 已存在不导入）已实现。
- **步骤**：① 核对 `docs/model-provider-opencode-config.md` 覆盖该入口（`:119-121` 已写 fallback 语义），一致则只补整数约束说明，不新建文档 ② 反例：0/负数/小数/字符串、多字段冲突优先级、已导入重跑幂等、已有 Personal 不覆盖（`legacyZCodeConfigProviderReader.test.ts` 目前未直接命中该字段，需补）③ schema 收紧为正整数并明确拒绝路径 ④ 验证。
- **验证**：`pnpm exec vitest run packages/services/test/legacyZCodeConfigProviderReader.test.ts packages/services/test/providerConfigRuntime.test.ts`。
- **风险**：小；不迁移 schema 外行为。

### I19 · 冷历史先展示后激活（B5 · 大）

- **落点（两处顺序待翻转）**：`bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1397-1424` `subscribeReserved` cold 时 `:1419` 先 `await ensureColdReadyPublisher`（`:2924-2947`：READY 登记 `:2940` → activation `coldResume.ensureResumed` `:2933` → hydration `:2938`），完成前不发布任何状态；`handleCommand:2401-2423` READY 等待（`:2415-2421`）在 `inbox.handle` 去重/admission（`:2423`）**之前**。activation 单飞 `cold-session-resume.ts:43-113`；CommandInbox gate `command-inbox.ts:117-215`。
- **步骤**：① spec 先行：更新 `docs/v4-refactor/17-cold-resume-runtime-activation.md`（含协议声明与会话目录/矩阵）——C4 已决 2026-10-24：不变量收窄为「runtime 先于实时事件 hydration」，历史投影可先行发布；重复 command/subscribe 加入同一 flight 的规则先补反例 ② 反例：冷历史先可见、初始化慢/失败有终态、重复订阅同一 flight、断线/删除/取消/迟到结果不重启旧 runtime、ready guard 下命令处理 ③ 实现：subscribeReserved 先发布历史/初始化投影，activation 异步推进，READY/failed 终态仍单一 owner；handleCommand 先 dedup 再 session gate 准备冷会话 ④ Desktop continuous + 手机 replayable 双链路 E2E。
- **验证**：bootstrap 定向（`v4-cold-resume.test.ts`、`command-inbox.test.ts`、`v4-gateway.test.ts`、`session-selection-cold-resume.test.ts`）+ Desktop E2E `conversation-session-context-window-cold-resume.test.ts` 等冷恢复组。
- **风险**：本计划最大项；Main/gateway/Renderer 不加业务队列的边界必须保持；与 I03 互跑回归。

### I20 · MCP 后台页面生命周期（B5 · 大）

- **落点**：页面复用已具备（`usePluginUiToolCallModel.ts:183-206` 与 `usePluginUiSidePaneModel.tsx:167-179` 同经 `usePluginUiHost` → 同一 `buildPluginUiSurfaceKey` → 同一 page owner）；冲突点：`pluginUiPageManager.ts:110-113` settled 且不可见**立即 suspend**，`pluginUiManagedPage.ts:352-382` suspend 真撤 controller+guest+lease——与「离屏/停回合不销毁」相反（C5）。容量 30 task/64 allocated（`:33/:71`）、离屏 5min 定时器（`:102-108`）；Main sandbox `registry.ts:42-227` TTL 6h/64 entries；撤销路径已齐（task 删除 `:276-286`、runtime restart `:136-139`、连接失效 `mcp-ui/protocol.ts:258-260`）。
- **步骤**：①（待决已决 2026-10-24：废除 settled 即 suspend、显式撤销驱动；容量沿用 30/64 超限拒绝并提示；5min/6h 定时器一并重审）新建 `docs/plugin-ui-background-execution.md` + 补 managed-page/bridge CONTRACT ② 反例：卡片与后台结果并发仅建一个 guest、无锚点继续执行、返回复用原 guest、删除/重载/失效后撤销不复活、手机/Web/远端无创建副作用 ③ 实现：pageManager 增加后台表面状态，准入 promise 单一；Main 仍只执行受控原生活动 ④ 真实 Electron guest 实例/资源计数验证（不能 DOM 模拟）。
- **验证**：`pnpm exec vitest run packages/ui/src/plugin-ui/app/pluginUiPageManager.test.ts`（及 pluginUiHostController、pluginSandbox 定向）+ 真页面 E2E。
- **风险**：依赖 I07 合同；5min/6h TTL 与容量预算一起重审；语义变更需用户对齐（C5）。

### I21 · 治理与测试选择算法（B6 · 中，调查可早做）

- **落点（按 C2 修正）**：实际门禁 = `scripts/architecture/`（`architecture-check.mjs` 子命令 check/report/baseline:update/context；`index.mjs:81/318/325/333`；`policy.mjs` 解析根 `architecture-policy.yaml`；baseline `.architecture-baseline.json`）+ `scripts/run-affected-unit-tests.mjs:285-343`（base 选择链 `:198-216`、删除文件→全量 `:324-329`、文件级二分 `:331-335` → lint-staged + vitest related 依赖图选择）。pre-push 组成见根 `package.json:38`（`verify:pre-push`）。
- **步骤**：① 算法调查（B0 起可做）：评估「architecture-policy.yaml 模块登记 + import graph 闭包」替代纯 vitest related 的漏测面，产出对比结论 ② 更新 `docs/architecture/architecture-governance.md` + `docs/testing/pre-push-hook.md` ③ 反例夹具：隔离 Git 仓库模拟首推/重推/显式 base/rename/脏工作区/失败工具，断言选中应测范围、不吞退出失败 ④ 实现选择器（保持 `verify:pre-push` 组成与 official-refs 基线）⑤ 门禁切换在本仓夹具全绿后进行。
- **验证**：`node --test scripts/test/run-affected-unit-tests.test.mjs`；`pnpm test:architecture`；`pnpm test:unit:affected` 实跑一次对照。
- **风险**：不放宽现行规则、不复活旧能力；`architecture-policy.yaml` 有未提交改动（C8），该文件改动排在其合入后。

## 5. 追踪表

| ID  | 批次 | 规模 | 主落点包                     | 状态             | 备注                                                                                                                                                                                                                                                  |
| --- | ---- | ---- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | B1   | 小   | packages/services            | merged（待提交） | `44cfac34`                                                                                                                                                                                                                                            |
| I02 | B1   | 小   | zcode-cli/adapters           | merged（待提交） | `ffcf9b45`                                                                                                                                                                                                                                            |
| I03 | B2   | 中   | zcode-cli/bootstrap+core     | merged           | `ecdd847c`；C3 语义反转已落地（提交边界冻结 ModelSelection）；先于 I19，I19 开工时重跑本项回归                                                                                                                                                        |
| I04 | B1   | 小   | zcode-cli/core               | merged（待提交） | `5803e0c1`                                                                                                                                                                                                                                            |
| I05 | B1   | 小   | zcode-cli/bootstrap          | merged（待提交） | `88a945d7`；改写既有断言（C6）                                                                                                                                                                                                                        |
| I06 | B3   | 中   | zcode-cli/bootstrap          | merged           | `8538c080`；插件读写调度拆分（11 文件，+878/−63）：读快路径、lazy seed/manifest 写纳入写锁，spec 与 bootstrap 测试同步                                                                                                                                |
| I07 | B3   | 中   | zcode-cli/bootstrap+adapters | merged           | `99f62b30`；MCP 首开连接屏障（13 文件，+712/−71）；I20 前置                                                                                                                                                                                           |
| I08 | B2   | 小   | packages/ui                  | merged           | `3e1ccd00`；B2 续作已解决 identity 透传（`fileSummaryTypes.ts:204-214`）与图片失败收口（`ToolCallBody.tsx:146-230`），15 文件                                                                                                                         |
| I09 | B1   | 小   | zcode-cli/tui                | merged（待提交） | `14d34916`；原判「疑似已覆盖」反证不成立，已实现单树换页                                                                                                                                                                                              |
| I10 | B3   | 中   | packages/ui + patch          | blocked          | 与受保护未提交文件重叠，未提交：`packages/ui/test/accordion.test.ts`、`docs/fork/upstream-review-ledger.md`、`docs/plans/upstream-v3.16.2-implementation-plan.md`；上一轮 9 文件交付与复验证据（3 files / 21 tests、install exit 0）保留，详见 §6     |
| I11 | B1   | 小   | zcode-server-cli             | merged（待提交） | `842c9ff2`                                                                                                                                                                                                                                            |
| I12 | B4   | 中   | ui/desktop/android           | planned          | 前置：Android 桥合入 + 待决                                                                                                                                                                                                                           |
| I13 | B4   | 中   | desktop/shared/ui            | planned          | Windows 证据单列                                                                                                                                                                                                                                      |
| I14 | B4   | 中   | packages/desktop             | planned          | 需真实 Windows                                                                                                                                                                                                                                        |
| I15 | B4   | 小   | packages/ui                  | planned          | B4 内最先合入                                                                                                                                                                                                                                         |
| I16 | B2   | 中   | zcode-cli/adapters           | blocked          | 复审未通过（批次备注截断）：指向 `node-execution-adapter-lifecycle.ts:52-71/:183-193`、`node-execution-adapter-results.ts:62-88` 等；上一轮 10 项修复与 adapters 1911 passed 证据保留，详见 §6                                                        |
| I17 | B2   | 中   | config/provider              | merged           | `052589ac`；模板口径已决 2026-10-24；厂商确认 v2.5 停服后按 §3 例外裁决只保留 v2.6 模板成员；复审修复 v2.6 `modelMatch`（裸名/`/` 前缀/`[1m]`，排除 `-ultraspeed`）、UI 测试路径与 MiMo 子集 parity；已提交（5 文件，+770/−13）                       |
| I18 | B1   | 小   | packages/services            | merged（待提交） | `9a4a44fd`                                                                                                                                                                                                                                            |
| I19 | B5   | 大   | zcode-cli/bootstrap          | blocked          | 复审未通过（批次备注截断）：指向本文件 §4 I19 卡、port-plan §5 UP316-I19、台账 I19 行与 `docs/v4-refactor/17-cold-resume-runtime-activation.md`；已实现 cold owner/`loadColdHistory`/M1 收敛/command probe 与 bootstrap 2931 passed 证据保留，详见 §6 |
| I20 | B5   | 大   | ui/desktop                   | blocked          | 批次非阻断说明（备注截断）：任务点名的两条根命令在当前配置下无法命中测试文件（根 `vitest.config.ts:99-114`、`packages/desktop/vite.config.ts:183`）；依赖 I07，语义变更已获批（C5）                                                                   |
| I21 | B6   | 中   | scripts                      | planned          | owner 修正（C2）；调查可早做                                                                                                                                                                                                                          |

状态流转：`planned → recheck → spec → red → implement → verify → ledger → merged`，或 `→ closed`（记录反证）；`blocked` 表示复审或门禁受阻，退回对应环节，修复后重新复审。每项 PR 描述以 `UP316-Ixx` 作为关联键回填 port-plan 与台账。

## 6. 本轮执行记录

- `node scripts/check-workspace-freshness.mjs`：通过（main 相对 origin/main ahead 11 / behind 0）。
- 调查方式：6 路只读代码核实（services/adapters、CLI core、launcher/provider、plugin/MCP、UI、TUI/desktop/v4/scripts），本文所有 file:line 均来自当前工作区实测；`docs/plans/upstream-v3.16.2-port-plan.md` 当前为 untracked。
- `pnpm typecheck`：**失败，exit 2**——7 个错误全部在未提交的手机远控文件（`packages/services/src/mobile-notifications/adapters/service-ttl.test.ts` ×4、`packages/ui/src/MobileWorkspaceFileBrowser.tsx` ×3），属该工作线待修，不属本计划；B0 出口要求基线恢复通过。
- `pnpm lint`：exit 0，0 errors / 312 warnings（较 port-plan 记录的 313 少 1，工作区演进所致；不清理无关告警）。
- 未执行：任何单测/E2E/架构检查（本轮无代码改动）；功能图未改动（有他人未提交改动，proposed delta 仍按 port-plan §7 执行）。

### 2026-10-24 批次执行记录（I01/I02/I04/I05/I08/I09/I11/I18）

结果：7 项提交、1 项复审受阻。提交均在本地 `main`，当前 `main` 相对 `origin/main` ahead 18（本批 7 个提交未推送）。

| ID  | 结果             | 提交       | 备注                                                                                                                                                                                                                       |
| --- | ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | merged（待提交） | `44cfac34` | spec、cipher provider、credential service 测试                                                                                                                                                                             |
| I02 | merged（待提交） | `ffcf9b45` | 编码探测文档、text-range-reader/text-metadata、fs-context 测试                                                                                                                                                             |
| I04 | merged（待提交） | `5803e0c1` | amend resolver/retune、permission service、契约与测试                                                                                                                                                                      |
| I05 | merged（待提交） | `88a945d7` | governor 分流、并发文档、governor 测试                                                                                                                                                                                     |
| I08 | blocked（受阻）  | —          | 复审未通过：identity 只到顶层 `ToolCallBlock`，未透传进 `ToolCallBlockRenderContext`（`packages/ui/src/ToolCallBlocks.tsx:309-350`、`packages/ui/src/ToolCallBlocks/fileSummaryTypes.ts:204-207`），图片结果无法按身份绑定 |
| I09 | merged（待提交） | `14d34916` | 原判「疑似已覆盖」反证不成立，改为同一 React 树内换页并补生命周期测试；真实终端 smoke 仍为剩余缺口                                                                                                                         |
| I11 | merged（待提交） | `842c9ff2` | launcher 物理路径匹配、架构文档与 server-cli 测试                                                                                                                                                                          |
| I18 | merged（待提交） | `9a4a44fd` | 旧配置导入正整数约束、services 测试与 provider 文档                                                                                                                                                                        |

门禁（本会话在台账更新时实际执行，环境 Node v22.23.2 / pnpm 10.33.2；`mise.toml` 要求 Node 24.14.0，pnpm 启动时告警 unsupported engine）：

- `pnpm typecheck`：**失败，exit 2**——4 个 TS2532 全部位于未跟踪的手机远控文件 `packages/services/src/mobile-notifications/adapters/service-ttl.test.ts:219/220/223/224`，不属本批提交文件；上轮记录为同源 7 个错误，本轮剩 4 个，B0 出口仍未恢复。
- `pnpm lint`：exit 0，0 errors / 311 warnings（上轮 312；未清理无关告警）。
- `pnpm architecture:check --changed`：exit 0，violations 0 / baseline 0 / new 0。
- 定向测试（按各项「验证入口」复跑）：
  - I01/I18：`pnpm exec vitest run packages/services/test/credentialService.test.ts packages/services/test/legacyZCodeConfigProviderReader.test.ts packages/services/test/providerConfigRuntime.test.ts` → 3 files / 34 tests passed，exit 0。
  - I02：`pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/fs-context.test.ts` → 1 file / 42 tests passed，exit 0。
  - I04：`pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/amend-workflow-permission.test.ts` → 76 tests passed，exit 0。
  - I05：`pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/workflow-concurrency-governor.test.ts` → 38 tests passed，exit 0。
  - I09：`pnpm --dir apps/zcode-cli/packages/tui test` → 233/234；唯一失败为 `tui-app.test.ts:60`「starts without a runtime readiness system message」。该用例在本轮提交中仅新增 import、正文未改，I09 领域文档 `apps/zcode-cli/docs/tui-startup-lifecycle.md` §5 记录其为 Node 22 下的既有 flake（Node 24 下连续 3 次 234/234）；本环境无 Node 24，未能复跑验证。cli 包 `tests/tui-startup.test.ts` 7/7 passed，exit 0。
  - I11：`pnpm --dir packages/zcode-server-cli test` → 27 files / 156 tests passed，exit 0。
- 未执行：E2E、`pnpm verify:pre-push`、`pnpm fmt:check`、真实终端 smoke、Windows/Android 真机证据（本批无对应项或需人工环境）。

### 2026-10-24 B2 批次执行记录（I03/I08 续作/I16/I17）

结果：2 项提交、1 项复审受阻；I17 复审问题已按续作修复，待重新复审/提交。I03 与 B2 续作的 I08 已提交到本地 `main`。

| ID  | 结果             | 提交       | 备注                                                                                                                                                                                                                                                           |
| --- | ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I03 | merged           | `ecdd847c` | 普通 CLI 提交边界冻结 ModelSelection（9 文件，+804/−45）：`input-facade.ts:80-126` 在提交边界捕获完整选择，`turn.ts:115` 读取冻结值；同步 spec 与 core/bootstrap 定向测试                                                                                      |
| I08 | merged           | `3e1ccd00` | B2 续作（15 文件，+827/−22）：identity/remoteSessionId 进入 `ToolCallBlockRenderContext`（`fileSummaryTypes.ts:204-214`），内嵌图片按 path+identity+remoteSessionId 绑定，补 reject/空结果终态与 data URL 前缀（`ToolCallBody.tsx:146-230`）；原复审阻塞已解除 |
| I16 | blocked（受阻）  | —          | 复审未通过：`apps/zcode-cli/packages/adapters/tests/bash-resource-lifecycle.test.ts:330` 新增「输出根不可写时回落」用例在 win32 上必然失败——`bashRequest` 使用 `shell=cmd`，与 `buildEmbe…`（复审备注截断）不匹配                                              |
| I17 | merged（待提交） | —          | 原复审未通过：v2.6 `modelMatch` 收敛为裸 ID，带前缀 ID 失配；续作已修复（裸名/`/` 前缀/`[1m]`，排除 `-ultraspeed`），详见下节                                                                                                                                  |

门禁（本次台账更新时在提交后工作区实际执行；环境 Node v22.23.2 / pnpm 10.33.2，`mise.toml` 要求 Node 24.14.0，pnpm 启动告警 unsupported engine）：

- `pnpm typecheck`：exit 0，通过（上轮记录的 4 个手机远控 TS2532 在当前工作区已不存在，B0 出口的 typecheck 基线在本轮恢复）。
- `pnpm lint`：exit 0，0 errors / 311 warnings（与上轮持平；未清理无关告警）。
- `pnpm architecture:check --changed`：exit 0，violations 0 / baseline 0 / new 0。
- 定向测试（按提交改动复跑）：
  - I03 core：`pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/prompt-admission.test.ts tests/input-intent-persistence.test.ts` → 2 files / 15 tests passed，exit 0。
  - I03 bootstrap：`pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/queue-input-fidelity.test.ts tests/v4-input-admission.test.ts tests/v4-native-commands.test.ts` → 3 files / 68 tests passed，exit 0。
  - I08：`pnpm exec vitest run packages/ui/test/previewPaneImageContent.test.ts packages/ui/test/agentToolCallBlock.test.ts` → 2 files / 36 tests passed，exit 0。
- 未执行：I16 的 adapters 测试（复审受阻、未提交）；E2E、`pnpm verify:pre-push`、`pnpm fmt:check`、全量包测试、Windows/Android 真机证据。

### 2026-10-24 I17 复审续作记录

- 结果：复审问题修复，待重新复审/提交；未执行 git 写操作。
- 配置：`config/provider/zcode-builtin.json` / `config/provider/zcode-builtin.test.json` 两条 v2.6 `modelMatch` 改为 `(?:.*/)?mimo-v2\.6-(?:pro|flash)(?:\[1m\])?`；`packages/provider-node/test/fixtures/reasoning-map-before-todo95.json` 同步；`zcode-builtin-integrity.test.ts` 补 `[1m]` 变体、无 `/` 边界近似名、`mimo-v2.5` contextWindow 与生产/测试 MiMo 子集 parity 断言；未改既有断言凑绿。
- UI：`packages/ui/test/providerTemplatePicker.test.ts` 改用 `import.meta.url` 定位仓库根（`pnpm --dir packages/ui` 与仓库根运行均通过）。
- 定向测试：`pnpm --dir packages/provider-node test` → 26 files / 257 tests passed；`pnpm --dir packages/provider test` → 22 files / 279 tests passed；`pnpm --dir packages/ui exec vitest run test/providerTemplatePicker.test.ts` → 3 tests passed。
- 全仓门禁（复审会话实跑，本续作按工作流边界未重跑）：`pnpm typecheck` exit 0；`pnpm lint` exit 0（0 errors / 311 warnings）。

### 2026-10-24 B3 与 B2 续作批次执行记录（I06/I07/I10/I16/I17）

结果：3 项提交（I06/I07/I17），2 项复审受阻（I10/I16）。提交均在本地 `main`；I10 由原「merged（待提交）」改为 blocked（交付文件仍未进入提交清单），I16 维持 blocked 并退回修复。

| ID  | 结果            | 提交       | 备注                                                                                                                                                                                                                       |
| --- | --------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I06 | merged          | `8538c080` | 插件读写调度拆分（11 文件，+878/−63）：adapters marketplace、bootstrap bundled-plugins/official-plugin-runtime/plugin-storage-lock/plugins 与 protocol、bootstrap 三项测试、两份插件领域文档                               |
| I07 | merged          | `99f62b30` | MCP 首开连接屏障（13 文件，+712/−71）：pool 连接等待、mcp-ui protocol/instances、session-facade、pluginUiBridgeService、CONTRACT 与连接就绪文档                                                                            |
| I10 | blocked（受阻） | —          | 复审未通过：修复新增/修改的三个 I10 交付文件（`THIRD-PARTY-NOTICES.md:2527`、`third-party/inventory.json:5`，noticesSha256/inputs/patches 已更新）仍未进入上一轮提交清单；批次备注截断                                     |
| I16 | blocked（受阻） | —          | 复审未通过：本轮新增的 I16-C 取消清理测试 `apps/zcode-cli/packages/adapters/tests/bash-output-cancel-cleanup.test.ts:1-94` 是 untracked 新文件，且未按 `docs/background-bash-output-details.md:102-110` 登记；批次备注截断 |
| I17 | merged          | `052589ac` | MiMo v2.6 模板（B2 续作，5 文件，+770/−13）：`config/provider/zcode-builtin.json`、`zcode-builtin.test.json`、provider-node integrity 测试与 reasoning-map fixture、`docs/provider-mimo-templates.md`                      |

门禁（本次台账更新时在提交后工作区实际执行；环境 Node v22.23.2 / pnpm 10.33.2，`mise.toml` 要求 Node 24.14.0，pnpm 启动告警 unsupported engine）：

- `pnpm typecheck`：exit 0，通过。
- `pnpm lint`：exit 0，0 errors / 311 warnings（与前两轮持平；未清理无关告警）。
- `pnpm architecture:check --changed`：exit 0，violations 0 / baseline 0 / new 0。
- 未执行：I06/I07 定向包测试（批次结果未提供，本轮台账更新未重跑）；I17 定向测试沿用上节记录（`pnpm --dir packages/provider-node test` 257 passed 等）；E2E、`pnpm verify:pre-push`、全仓 `pnpm fmt:check`、真实 Electron/真机证据。本文件已通过 `pnpm exec oxfmt --check docs/plans/upstream-v3.16.2-implementation-plan.md`。

### 2026-10-24 I10 复审续作记录

- 结果：复审问题修复，待重新复审/提交；未执行 git 写操作。
- 交付：9 文件清单补齐（patch、根 `package.json`、`pnpm-lock.yaml`、`THIRD-PARTY-NOTICES.md`、`third-party/inventory.json`、`docs/performance/collapsible-hidden-measurement.md`、3 个测试）；台账 `docs/fork/upstream-review-ledger.md` 与本追踪表随续作同步，I10 由 blocked 更新为 implemented（待提交）。
- 测试：`pnpm exec vitest run packages/ui/test/collapsible.test.ts packages/ui/test/toolLayout.test.ts packages/ui/test/accordion.test.ts` → 3 files / 21 tests passed；`pnpm --dir packages/ui exec vitest run test/collapsible.test.ts test/toolLayout.test.ts test/accordion.test.ts` → 3 files / 21 tests passed（CJS/ESM 产物守卫改为 `createRequire(import.meta.url)`，不依赖 cwd）；移除两份 dist guard 的变异 → 9 failed / 12 passed，恢复后 21/21；三个测试文件新增可见节点等价读取正对照。
- 安装：`pnpm install` 连续两次与 `pnpm install --frozen-lockfile` 均 exit 0；删除 `node_modules/@radix-ui/react-collapsible` 后 `pnpm install` 可恢复逐字节一致的 patched dist。
- 账目：`node scripts/licenses.mjs check` exit 1，3080 个输入中 2 个失配（未提交的 bootstrap/services `package.json`，非本项文件）；I10 自身 notices/inventory 登记一致；inventory 全量重算另刷新 15 个等于 HEAD 的陈旧输入哈希，已在 spec 说明。
- 缺口：真实浏览器 layout/性能指标未执行（jsdom 计数夹具替代，沿用本卡证据偏差口径）；未跑全仓 typecheck/lint。
- 台账：`docs/fork/upstream-review-ledger.md:38` 已同步上述证据。

### 2026-10-24 I16 复审续作记录

- 结果：复审 10 项问题逐条处理，待重新复审/提交；未执行 git 写操作。
- 清单：filesTouched 补齐 5 个消费者文件（`packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx`、`packages/ui/src/lib/backgroundBashOutputTitle.ts`、`packages/ui/test/backgroundBashOutputTitle.test.ts`、两个 Desktop E2E 用例），并新增 `apps/zcode-cli/e2e/compact-microcompact/case-background-bash.mjs` 的断言迁移；新测试 `bash-output-cancel-cleanup.test.ts` 已按 `docs/background-bash-output-details.md`「I16 新增反例测试」登记。
- 实现：`node-execution-adapter-run.ts` 在 spawn 失败或 spawn 前取消时删除通用 pipe 后台预创建且从未写入的空输出（只删除 `ensureBackgroundOutputFiles` 记录的新文件，既有输出不受影响）；`node-execution-adapter-base.ts` 在默认数据根被选中时同时执行 `cleanupStaleShellInitSnapshots`，并把回落 catch 收窄到 spec 列出的 6 个文件系统错误码。
- spec：`docs/tmpdir-storage-paths-spec.md` 明确默认根快照清理、不维护活动路径排除表（仅按 mtime）、精确回落错误码；`docs/background-bash-output-details.md` 拆分 I16-C/I16-C2 验收行，登记 E2E 断言迁移、通用 pipe 清理与临时根查询用例，并移除无证据的「先红后绿」表述。
- 验证：`pnpm --dir apps/zcode-cli/packages/adapters test` → 132 files / 1911 passed / 4 skipped，exit 0；定向 `pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/bash-file-output.test.ts tests/bash-resource-lifecycle.test.ts tests/bash-shutdown.test.ts tests/bash-output-cancel-cleanup.test.ts` → 4 files / 47 passed，exit 0；`pnpm --filter @zcode/core exec vitest run tests/runtime-background-bash-output.test.ts` → 1 file / 4 passed，exit 0；`pnpm --dir apps/zcode-cli/packages/adapters typecheck` → tsc --noEmit exit 0；`pnpm --dir apps/zcode-cli/packages/adapters lint` → 0 errors（19 既有 warnings，I16 文件无 warning）；I16 文件 `pnpm exec oxfmt --check` 通过。
- 未执行：卡片步骤④发行 smoke、Desktop E2E（`case-background-bash.mjs` 仅做静态断言迁移，未运行）、Windows 真实回落分支、全仓 typecheck/lint（由统一门禁负责）。复审记录的 `packages/ui/src/plugin-ui/adapters/sandboxPageOwners.test.ts:24` 类型错误属 I20/mobile-web 线，不是 I16 改动，本轮未处理。

### 2026-10-24 B5 收口批次执行记录（I10/I16/I19/I20）

结果：0 项提交、4 项 blocked。未满足「提交成功则改为 merged」的条件，I10/I16 维持 blocked，I19 由 verify 转 blocked，I20 由 planned 转 blocked。本轮仅更新本文件，未执行 git 操作。

| ID  | 结果            | 提交 | 备注（批次结果，含截断标记）                                                                                                                                                                                                                                                                               |
| --- | --------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I10 | blocked（受阻） | —    | 与受保护未提交文件重叠，未提交：`packages/ui/test/accordion.test.ts`、`docs/fork/upstream-review-ledger.md`、`docs/plans/upstream-v3.16.2-implementation-plan.md`                                                                                                                                          |
| I16 | blocked（受阻） | —    | 复审未通过：指向 `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts:52-71、:183-193`、`node-execution-adapter-results.ts:62-88`、`apps/zco…`（批次备注截断，未提供完整问题清单）                                                                                               |
| I19 | blocked（受阻） | —    | 复审未通过：指向 `docs/plans/upstream-v3.16.2-implementation-plan.md:197-201`、`docs/plans/upstream-v3.16.2-port-plan.md:145`、`docs/fork/upstream-review-ledger.md:47`、`docs/v4-refactor/17-cold-resume-runtime-…`（批次备注截断，未提供完整问题清单）                                                   |
| I20 | blocked（受阻） | —    | 非阻断说明（批次备注截断）：任务点名的两条根命令在当前配置下无法命中测试文件——根 `vitest.config.ts` 的 include 仅含 `packages/*/test/**` 与 `packages/*/src/**/contract.test.ts`；`packages/desktop` 的 vite config root 指向 `src/renderer`；根 `vitest.config.ts` 属手机远控线未提交改动（备注在此截断） |

门禁（本次台账更新在工作区实际执行；环境 Node v22.23.2 / pnpm 10.33.2，`mise.toml` 要求 Node 24.14.0，pnpm 启动告警 unsupported engine）：

- `node scripts/check-workspace-freshness.mjs`：通过，main 相对 origin/main ahead 26 / behind 0（阈值 50）。
- `pnpm typecheck`：**失败，exit 2**——1 个错误 `packages/ui/src/plugin-ui/adapters/sandboxPageOwners.test.ts(24,3): error TS2739`（输入缺少 `toolInput`/`toolResult`）。该文件此前已按 I20/手机远控线归属记录（见上节 I16 续作记录末条），不是本批 4 项交付文件；B0 出口的 typecheck 基线再次未通过。
- `pnpm lint`：exit 0，0 errors / 311 warnings（7693 files；未清理无关告警）。
- `pnpm architecture:check --changed`：exit 0，violations 0 / baseline 0 / new 0。

补充核实：

- I20 命中性：`pnpm exec vitest list packages/ui/src/plugin-ui/app/pluginUiPageManager.test.ts` 无输出（根配置未选中该文件）；根 `vitest.config.ts:99-114` 的 include 未覆盖 `packages/ui/src/plugin-ui/app/**`，`packages/desktop/vite.config.ts:183` 为 `root: "src/renderer"`。批次说明与当前配置一致。
- I16 复审指向的代码行已核对存在：`node-execution-adapter-lifecycle.ts:52-71` 为输出准备失败时结算 spawn_error 后台记录、`:183-193` 为前台准备失败与 `closePromise` 检查；`node-execution-adapter-results.ts:62-88` 为 `ensureBackgroundOutputFiles` 的按 created 记录。因批次备注截断，本轮不推断复审未通过的具体理由。
- I19 复审指向的文档/台账位置已核对存在（本文件 I19 卡、port-plan §5 UP316-I19、台账 I19 行、`docs/v4-refactor/17-cold-resume-runtime-activation.md`），具体不通过理由因备注截断未记录。
- 定向测试：批次结果未提供 I10/I16/I19/I20 本轮定向测试结果，本轮台账更新未重跑；I10/I16 上一轮证据保留在各自续作记录，未在本轮重新验证。
- 未执行：E2E（含 I19 Desktop continuous/手机 replayable 双链路、I20 真实 Electron guest 计数）、`pnpm verify:pre-push`、`pnpm fmt:check`、真实浏览器 layout 证据、Windows/Android 真机证据。
