# read-file-state 单条最新视图与 compact 文件补回（F19）spec

> 状态：spec 已完成，待两步链实施（tier2 P4，F19）。上游来源：ZCode v3.17.1（`a60ba6a7`）
> core read-file-state 单条最新视图重构与 compact 后文件补回；上游参考仅供语义，命名与落点
> 按本仓架构重写（本仓 CLI 包树为 `apps/zody-cli/packages/*`）。
> 关联文档：[`read-tool-model-visible-result.md`](../read-tool-model-visible-result.md)
> （Read 模型可见结果契约，含 file_unchanged 文案）、
> [`runtime-tools/bash-read-file-state.md`](../runtime-tools/bash-read-file-state.md)
> （Bash 回填写入方）、[`plan-mode-plan-file-compact-continuity.md`](../plan-mode-plan-file-compact-continuity.md)
> （plan 文件 compact 连续性——补回排除 plan 文件的既有规则）。

## 1. 背景与问题

`runtime.readFileState` 是「模型看过哪些文件视图」的唯一事实来源，供三条消费路径使用：

1. Read 工具去重：同视图且文件未变时返回 `file_unchanged`（Wasted call 存根）；
2. Write / Edit / 内联草稿的写前 stale 校验（mtime / size / revision 比对）；
3. compact 后文件补回（把摘要丢掉的近期文件内容重新注入上下文）。

本仓现状是「按 `path+offset+limit` 多键存储 + compact 补回投影状态表里的旧缓存内容」。与
live 行为相比有三类不一致，均为上游 `a60ba6a7` 已修复的问题：

- **重启前后不一致**：多键并存使冷恢复挑选「最新视图」的规则与 live 不同（见 §2.2 差距
  A/E）；并行工具下按 part 声明序重放会选错视图（差距 D）。
- **live 内误判**：Edit/Write 写入的完整视图与完整 Read 同键，随后完整 Read 命中旧键返回
  Wasted call，但模型没看过写入后的内容（差距 A，上游 `handlers/read.ts` `isSameReadView`
  注释）。
- **compact 补回错误内容**：投影读取状态里缓存的视图而非磁盘当前内容，补回的可能是旧内容
  或片段；且 compaction 后不回写读取状态（差距 G）。

## 2. 现状差距清单（对照上游 `a60ba6a7`，2026-11-07 于本仓 HEAD 核验）

本项定位是对照上游逐点核验并补齐差距；已一致处登记如下，不重复实现。

### 2.1 已一致（登记，不重复实现）

| #   | 条目                                                                                                                                                                                           | 本仓现状（上游同构）                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | 补回路径排除 `shouldSkipPostCompactReadStatePath`（`/.codex/memories/`、`/docs/superpowers/plans/`、`/.git/`）                                                                                 | `runtime/helpers/compact-post-reminders.ts:115`                                    |
| 2   | 补回预算数值：≤5 文件、每文件 5k token、总 50k                                                                                                                                                 | `runtime/helpers/compact-post-reminders.ts:20`（上游 `:27-29` 常量同名同值）       |
| 3   | 超限转引用提示文案（`Note: ${path} was read before ... Use Read tool ...`）                                                                                                                    | `runtime/helpers/compact-post-reminders.ts:57`                                     |
| 4   | freshness 策略 `isCachedReadFresh`（mtime 取整毫秒 + sizeBytes，缺 mtime 用 revisionId/size）                                                                                                  | `tool/handlers/read.ts:335`                                                        |
| 5   | 路径键平台归一化 `createReadFileStatePathKey`、`normalizeReadFileStateMtimeMs`                                                                                                                 | `tool/read-file-state.ts:11`、`:64`                                                |
| 6   | metadata 持久化 schemaVersion=1；缺 `revisionId/mtimeMs/sizeBytes` 的记录不冒充已读                                                                                                            | `tool/read-file-state-metadata.ts:64-68`                                           |
| 7   | resume 只认 tool part 上的结构化快照，不从 provider-visible cat-n 文本恢复                                                                                                                     | `agent/read-file-state-hydrator.ts:114-116` 注释                                   |
| 8   | hydrator 的 active 消息过滤（branchOptions + `includeCompactPreservedSegment: false`）、`dedupeParts`；rewind 按删除点过滤后重建（两侧 rewind 都把 branchOptions 传入 hydrator，只重放保留段） | `agent/read-file-state-hydrator.ts:39-45`；`runtime/methods/rewind-message.ts:699` |
| 9   | Bash 回填「该文件已有记录则不补」守卫                                                                                                                                                          | `tool/handlers/bash-read-file-state.ts:118`                                        |
| 10  | token 估算 `estimateTokens`（CJK 字符按 2 计）                                                                                                                                                 | `context/utils.ts:12`                                                              |

### 2.2 差距（两步链要补齐的内容）

**差距 A —— 存储与查找模型：多键 vs 单条最新视图**
本仓键为 `path+offset+limit`（`tool/read-file-state.ts:18` `createReadFileStateKey`），同文件
多视图并存；「最新视图」靠全表扫描比较 `readAt`（`findLatestReadFileState` /
`findEditableReadFileState` / `findStrictFullReadFileState`，`tool/read-file-state.ts:31-62`）。
上游键为 `createReadFileStatePathKey(path)`，写入一律走 `setReadFileStateEntry`（先删再写，
每文件一条，Map 迭代序即最近写入序），查找退化为 O(1) `get`
（上游 `tool/read-file-state.ts:25-49`）。连带影响：Edit/Write 写入后完整 Read 命中同键旧
视图误报 Wasted call；中间读范围后再读完整文件命中更早的完整视图。

**差距 B —— `file_unchanged` 不存快照副本 + 存根常量位置**
本仓 file_unchanged 结果也记录 metadata 快照（`tool/read-file-state-metadata.ts:42` 接受
`file_unchanged`；`tool/handlers/read.ts:191-196` 记录后返回）。上游只有
`output.type === "text"` 才记录快照（上游 `read-file-state-metadata.ts:47-48`），Read 命中
file_unchanged 时不写 live 状态也不记录快照（上游 `handlers/read.ts:206-213`）——该快照只是
当时最新记录的副本，冷恢复按它重放会恢复出已不在 active history 里的视图。另：Wasted call
文案常量本仓内联在 `tool/handlers/read.ts:55`（`FILE_UNCHANGED_STUB`），上游为
`tool/handlers/read-text.ts:17` 导出的 `READ_FILE_UNCHANGED_STUB`（compact 补回识别保留段
里 file_unchanged 的 Read 需要复用）。

**差距 C —— Read 行号按视图实际起始行、空文件判定（`formatReadTextOutput`）**
本仓空内容结果只区分 `totalLines === 0`（空文件警告）与其余（「offset 太大」警告），
`tool/handlers/read-text.ts:66-72`。上游规则（上游 `read-text.ts:85-99`）：
`numLines >= 1 && totalLines > 1` 时返回**按 `output.startLine` 编号的空视图**（带
partialView 前缀）；`numLines >= 1 || totalLines === 0` 才报空文件警告；其余才报 offset
太大。空文件读取结果会被规范成 1 行，本仓把它误报成「offset 太大」。

**差距 D —— 快照落盘序 `snapshotIndex`**
本仓无此字段，metadata 按工具完成序记录，冷恢复按 part 声明序重放。上游 executor 在工具
写 live 状态的同一同步步骤里调用 `recordReadFileStateMetadata` 回调时取号
（`nextReadFileStateSnapshotIndex()`，上游 `executor/call-runner.ts:545-553`、
`executor/impl.ts:75`）；hydrator 在同一 assistant 内按 `snapshotIndex` 排序重放，任一快照
缺号（旧数据）退回 part 原序（上游 `read-file-state-hydrator.ts:171-182`）。part 在工具开始
前按声明顺序落盘、完成时原地更新，工具结果返回先后 ≠ 写入先后；并行工具下按 part 序重放
会选错视图，重启后同一次完整 Read 返回 file_unchanged 而非正文。

**差距 E —— hydrator 恢复范围与标记、`requestedPath` 回填**
本仓（`agent/read-file-state-hydrator.ts`）：真正的 range Read 跨 resume 不恢复
（`:102-105`，`skippedRangeReadCount`）；整表 `clear()`（`:38`）；无 resume/rewind 标记；无
`requestedPath`。上游：range Read 与 live 一致按最新水位恢复（「完整 → 范围 → 重启 → 完整」
与 live 同结果，上游 `:81-105`）；resume 传 `markRestoredFromSession`（补回排序按读取时间，
`:36-40`）；`requestedPath` 从 tool part 输入回填（新旧记录一致，`:190-195`）。类型缺口：
`ReadFileStateEntry`（`tool/types.ts:214`）缺 `requestedPath` / `seededFromContext` /
`restoredFromSession` 三个可选字段（上游 `tool/types.ts:225-248`）。

**差距 F —— rewind 保留 context seed**
本仓 rewind 整表清空（`rewind-message.ts:701` 无 `retainContextSeeds`），丢掉会话开始由
context 写入的 MEMORY.md 记录，而 rewind 不重新加载 context，之后 Write MEMORY.md 误报
未读。上游 rewind 传 `retainContextSeeds: true`（上游 `rewind-message.ts:703-704`；
hydrator 内按 `entry.seededFromContext` 条件保留，上游 `read-file-state-hydrator.ts:50-54`）；
被回退部分读写过它的记录已被工具覆盖，照常清掉。resume 不传（由 context 初始化重新写入）。

**差距 G —— compact 补回整体语义（第二步核心差距）**
本仓 `buildPostCompactReadStateReminderEntries`（`runtime/helpers/compact-post-reminders.ts:8`）
为同步纯投影，与上游 `buildPostCompactFileRestore` / `restorePostCompactFiles` /
`replaceReadFileStateAfterCompact`（上游 `compact-post-reminders.ts:44-142`）逐点差异：

| 维度       | 本仓现状                                                                                    | 上游语义                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 内容来源   | readFileState 缓存的旧视图（可能是旧内容/片段）                                             | 重读磁盘当前内容（按 Read 整文件语义，不带 offset/limit；上游 `handlers/read.ts` `readFileForCompactRestore`）                                                                                         |
| 来源工具   | 仅 Read（`:70-72`）                                                                         | Read / Write / Edit（上游 `:30`、`:69`）                                                                                                                                                               |
| 保留段排除 | Read 工具调用按原始字符串归一化比较（`:30`）；不排除 file_unchanged 的 Read；相对路径不解析 | Read 的路径按 workingDirectory 解析成绝对路径再比键；file_unchanged 的 Read 不算（其结果只指向已被摘要的旧结果）；上游 `:259-282`                                                                      |
| 排除目标   | 仅 §2.1#1 三条路径                                                                          | 另加：plan 文件（`resolveApprovedPlanFilePath`）、上下文前缀指令文件（`normalizedInstructionSources`）、MEMORY.md（memoryRoot + 索引文件名）；上游 `:103-130`                                          |
| 权限       | 无判定                                                                                      | deny 规则跳过（不弹 ask 确认）；规范化路径与原始写法各判一次，任一命中即跳过；规则加载失败时全部跳过；上游 `:144-176`                                                                                  |
| 排序       | `readAt` 降序（`:31`）                                                                      | `restoreRecency`：本进程写入按文件 mtime（缺省 readAt），冷恢复记录按 readAt；上游 `:249-253`                                                                                                          |
| 超限行为   | 单文件超限与总量超限都转引用提示（`:36-44`）                                                | 单文件超限（too_large / token 截断 / 超 5k 估算）→ 引用提示，且 read-state 记录标记 `isPartialView: true`；总量超限 → 直接丢弃（无提示、不写记录），后面更小的文件仍可入选；上游 `:81-99`、`:225-247`  |
| 名额语义   | 逐个累加到满 5 个                                                                           | 先选再读：读取失败或被跳过的文件照占名额；一次性批量读取（权限规则只加载一次）                                                                                                                         |
| 状态回写   | 无                                                                                          | compaction 持久化成功后 `replaceReadFileStateAfterCompact` 原地清空执行器共享的同一 Map，再从最旧写到最新写入补回记录（保留 `requestedPath` 原始写法供下次 deny 判定）；上游 `:136-142`                |
| 集成点     | `compact-active.ts:505` 串行追加附件，无状态替换                                            | summary 生成后与 plan 文件引用并行读取（`Promise.all`）；`CompactCompleted` 持久化 + `replaceMessages` 成功后才替换 read-state 并 `resetProjectMemoryRecall`；上游 `compact-active.ts:522-533`、`:716` |
| token 估算 | 裸 `content.length / 3`（`:36`）                                                            | `estimateTokens`（CJK 加权，与全仓一致）                                                                                                                                                               |

**依赖缺口**：executor 的 `areReadsDeniedWithoutPrompt`（上游
`tool/executor/permission-flow.ts:55`、`executor/types.ts:159`）本仓不存在，第二步实施时需
在 core 内补齐（只判 deny、不产生 ask 副作用的批量读权限预检）。

## 3. 产品规则

### 3.1 第一步：read-file-state 单条最新视图（差距 A–F）

- **R1 存储模型**：`ReadFileStateMap` 键为 `createReadFileStatePathKey(path)`（平台归一化），
  **每文件一条**。所有写入方一律经 `setReadFileStateEntry`（先删再写），因此 Map 的迭代顺序
  即最近写入顺序。禁止任何调用方直接 `readFileState.set(...)`。
- **R2 覆盖语义**：同文件新视图（Read / Write / Edit / 内联草稿）覆盖旧记录；Bash 回填与
  Recall 注入只在该文件还没有记录时补一条（Bash 守卫已存在，Recall 沿用现状覆盖注入——
  Recall 正文对模型等价于一次读取）。
- **R3 Read 去重**：只按该文件**最近一条**视图判重，且该视图必须来自 Read
  （`sourceTool === undefined || "Read"`）、offset/limit 与本次请求一致、freshness 通过，才返回
  `file_unchanged`；否则真实读取并覆盖为最新视图。file_unchanged **不写 live 状态、不记录
  metadata 快照**（幂等：重复的 Read 不改变任何状态）。partial view 视图不参与去重
  （`isPartialView` 恒不命中）。
- **R4 原始写法 `requestedPath`**：Read（及补回写回）记录保留工具输入 `file_path` 的原始
  写法，与解析后 `path` 相同时不记录。读权限规则按原始字符串匹配，compact 补回对 deny 的
  二次判定需要它（§3.2 R12）。
- **R5 快照序号 `snapshotIndex`**：executor 在工具写 live 状态的同一同步步骤取单调递增序号
  存入 metadata；hydrator 在同一 assistant 消息内按它重放。任一快照缺号（旧会话数据）时整段
  退回 part 声明序。
- **R6 冷恢复（resume）**：带 `markRestoredFromSession`；range Read 与 live 一致按最新水位
  恢复；Write / Edit / 内联草稿只恢复**成功时持久化的完整快照**（resume 不得读当前磁盘
  「补全」状态——外部手动保存不能被误认证为 agent 已读）；`requestedPath` 从 tool part 输入
  回填（旧记录没有该字段也能补上）；返回 file_unchanged 的 Read part 跳过，由之前那次真实
  读取恢复。缺 freshness 字段的快照继续拒绝恢复（现状 §2.1#6 不变）。
- **R7 rewind**：传 `retainContextSeeds`——保留 `seededFromContext` 记录（MEMORY.md 索引），
  其余按保留段 active history 重建（现状过滤规则不变，§2.1#8）。
- **R8 行号与空文件判定**（`formatReadTextOutput`）：
  - 有内容：按 `output.startLine` 编号（现状不变）；
  - 空内容且 `numLines >= 1 && totalLines > 1`：返回按实际 `startLine` 编号的空视图（不再
    误报 offset 太大）；
  - 空内容且 `numLines >= 1 || totalLines === 0`：空文件警告（现状文案不变）；
  - 其余：offset 太大警告（现状文案不变）。

### 3.2 第二步：compact 文件补回（差距 G；依赖第一步的单条视图）

- **R9 重读磁盘**：补回内容一律按 Read 整文件语义重读磁盘当前内容（不带 offset/limit），
  不使用读取状态里缓存的视图；读取不经过执行器、不写读取状态。
- **R10 候选与排序**：候选 = readFileState 中来源为 Read/Write/Edit 的记录；排除规则见
  R12；按 `restoreRecency` 从新到旧选择：本进程写入的记录按文件 mtime（缺省 readAt），
  冷恢复记录按 readAt。
- **R11 预算**（先选再读，读取失败/跳过的文件照占名额）：

  | 预算   | 值                                               | 超限行为                                                                                                                                             |
  | ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 文件数 | ≤ 5                                              | 不再选取更旧的候选                                                                                                                                   |
  | 单文件 | ≤ 5,000 估算 token（`estimateTokens`，CJK 加权） | 转引用提示（`Note: ... too large to include. Use Read tool ...`），写回记录标 `isPartialView: true`（之后 Read 返回正文，Edit/Write 要求先完整读取） |
  | 总量   | ≤ 50,000 估算 token                              | 该文件直接丢弃（无提示、不写记录），更小的后续文件仍可入选                                                                                           |

  文件本身超过 Read 的文件大小/token 上限（too_large）同样只放引用提示，不写记录。

- **R12 排除规则**（满足任一即不补回）：
  1. 路径排除：`/.codex/memories/`、`/docs/superpowers/plans/`、`/.git/`（现状不变）；
  2. plan 文件（已批准 plan 的会话文件路径）；
  3. 上下文前缀里加载过的指令文件（用户/项目指令源）；
  4. MEMORY.md 索引文件（memoryRoot 存在时）；
  5. 保留段里 Read 过的文件（其内容已在上下文中）——路径按 workingDirectory 解析后比较；
     返回 file_unchanged 的 Read 不算（它只指向已被摘要的旧结果）；
  6. 读权限 **deny** 的文件：规范化路径与工具输入原始写法各判定一次，任一命中即跳过并记
     `compact.file_restore.denied` 日志；只跳过 deny，ask 规则照常读取、不弹确认；规则加载
     失败时本轮一个都不读（每个候选记 skipped 日志）。
- **R13 状态回写**：仅当 compaction 持久化成功（`CompactCompleted` 事件落盘 +
  `replaceMessages` 完成）后，`replaceReadFileStateAfterCompact` **原地清空执行器共享的同一
  Map** 再写入补回记录（从最旧写到最新，保持 Map 顺序与其他写入方一致；写回记录保留
  `requestedPath`）。不得替换 Map 实例——executor 持有同一引用。
- **R14 读取失败与取消**：单个文件读取失败只跳过该文件（仍占名额），记
  `compact.file_restore.skipped` warn 日志（取 `error.code` 时容忍非对象错误值）；abort 取消
  时异常向上传播，整个 compact 取消。`fileSystemPort` 缺席时全部按 skipped 处理。
- **R15 日志**：沿用 runtime logger（服务侧现有 logger 通道），事件名
  `compact.file_restore.denied` / `compact.file_restore.skipped`，模块标记 `core.runtime`。

## 4. 状态唯一所有者与写入方

所有者：`AgentRuntimeInternal.readFileState`（与 executor 共享同一 Map 实例）。写入方全表
（迁移后全部经 `setReadFileStateEntry`）：

| 写入方                                                                         | 触发时机                    | 覆盖 / 仅补空                  | 附加标记                                                          |
| ------------------------------------------------------------------------------ | --------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `tool/handlers/read.ts` `updateReadFileState`                                  | Read 成功读到内容           | 覆盖                           | `sourceTool: "Read"`、`requestedPath`；file_unchanged 不写        |
| `tool/handlers/write.ts` / `edit.ts`                                           | Write / Edit 成功           | 覆盖                           | `sourceTool: "Write"/"Edit"`                                      |
| `tool/handlers/workflow-draft-read-state.ts`                                   | 内联草稿落盘                | 覆盖                           | `sourceTool: "CreateWorkflow"/"AmendWorkflow"/"FillWorkflowHole"` |
| `tool/handlers/bash-read-file-state.ts`                                        | Bash cat/grep 整文件回填    | 仅补空（已有记录则跳过）       | 无 sourceTool                                                     |
| `runtime/methods/context.ts`                                                   | 会话开始注入 MEMORY.md 索引 | 覆盖                           | `seededFromContext: true`                                         |
| `runtime/helpers/project-memory-recall.ts`                                     | Recall 正文注入             | 覆盖                           | 无 sourceTool、带 limit                                           |
| `agent/read-file-state-hydrator.ts`                                            | resume / rewind 重建        | 先清后重放（rewind 保留 seed） | resume 标 `restoredFromSession`                                   |
| `runtime/helpers/compact-post-reminders.ts` `replaceReadFileStateAfterCompact` | compaction 持久化成功       | 整表替换                       | 补回记录（含 isPartialView/requestedPath）                        |

读取状态本身不落盘；持久化形态是 tool part metadata（`readFileState` 快照，schemaVersion=1），
恢复唯一入口是 `hydrateReadFileStateFromSession`。不存在第二条恢复路径。

## 5. 接口与依赖方向

```
tool/read-file-state.ts        setReadFileStateEntry / requestedPathField / findLatestReadFileState
        ↑                                    (O(1) get；partial view 拒绝归消费者)
所有写入方（§4 表） + hydrator + compact 补回
tool/read-file-state-metadata.ts   +snapshotIndex 字段；createReadFileStateMetadata 只认 text
        ↑
tool/executor/call-runner.ts（recordReadFileStateMetadata 同步取号）
agent/read-file-state-hydrator.ts  markRestoredFromSession / retainContextSeeds / inSnapshotOrder
        ↑
runtime/methods/resume.ts、rewind-message.ts
runtime/helpers/compact-post-reminders.ts  buildPostCompactFileRestore（纯函数，readFiles 注入）
                                           restorePostCompactFiles（runtime 绑定）
                                           replaceReadFileStateAfterCompact
        ↑
runtime/methods/compact-active.ts（summary 后并行读取；持久化成功后替换）
tool/handlers/read.ts  readFileForCompactRestore / PostCompactFileRead（Read 整文件语义复用）
tool/executor/permission-flow.ts  areReadsDeniedWithoutPrompt（新增；只判 deny、无 ask 副作用）
```

- `createReadFileStateKey`（多键）随差距 A 退役；`findEditableReadFileState` /
  `findStrictFullReadFileState` 合并进 `findLatestReadFileState`（edit/write 的 partial view
  拒绝逻辑留在消费方）。调用方迁移清单：`read.ts`、`write.ts`、`edit.ts`、
  `workflow-draft-read-state.ts`、`bash-read-file-state.ts`、`context.ts`、
  `project-memory-recall.ts`、hydrator（均为 core 内，属本卡落点）。
- 依赖方向不变：handlers → read-file-state；hydrator → metadata/read-file-state；compact
  helpers → read handler 导出的读取函数与 executor 权限预检。禁止 read handler 反向依赖
  runtime helpers。
- 协议层（`@zody/contracts`）无改动：metadata 结构仅新增可选字段，旧会话数据可解析。

## 6. 事件顺序

**compact（成功路径）**：

```
runtime.readFileState（owner，executor 共享同一实例）
  │
 summary 生成成功
  ├─ Promise.all[ readApprovedPlanFileReferenceEntry, restorePostCompactFiles ]
  │     └─ 选候选 → 批量 deny 预检 → 批量重读磁盘 → 按预算产出 entries + readFileStateEntries
  ├─ 组装 postCompactEntries（公告 → summary → 补回附件）
  ├─ appendEvent(ModelComplete) → selectPersistedCompactTail → persist CompactCompleted
  ├─ messageHistory.replaceMessages(...)
  ├─ replaceReadFileStateAfterCompact(readFileState, fileRestore.readFileStateEntries)   ← 只有这里写表
  └─ resetProjectMemoryRecall
失败/取消路径：不替换 read-state，表保持 compaction 前内容；auto compact 重试时重新执行补回。
```

**resume（冷恢复）**：

```
context 初始化（写 MEMORY.md seed，seededFromContext）
  → hydrateReadFileStateFromSession（markRestoredFromSession: true；先清（含 seed，随后由 context 重写）
     → active 消息内按 snapshotIndex 序重放快照（跳过 file_unchanged），每文件留最近一次视图）
```

**rewind（同进程）**：

```
hydrateReadFileStateFromSession（retainContextSeeds: true；保留 seed，其余按保留段
active history 重放，不带 restoredFromSession —— 与 live 记录一样按 mtime 参与补回排序）
```

## 7. 幂等边界

- `replaceReadFileStateAfterCompact` 只在持久化成功后调用一次；重复调用结果一致（清空重写）。
- `hydrateReadFileStateFromSession` 幂等：先清后重放，输入相同结果相同。
- file_unchanged 的 Read 不写任何状态（重复调用无副作用）。
- `readFileForCompactRestore` 不写读取状态；补回写表只发生在 R13 的单一时点。
- deny 预检只读规则、不产生 ask 队列副作用；规则加载失败按「全部跳过」收敛，不重试。
- 补回附件（`resume_referenced_session_context`）只进 compaction 产出的新历史，不重复注入
  旧消息。

## 8. 验收场景（供第二步实现；每个行为改动至少一个先失败后通过的反例）

非交互项说明：本特性全部位于 CLI core 运行时，无 UI 表面；模型可见行为由 core 单元/契约测试
覆盖，按 e2e-case-lifecycle 规则不登记桌面 E2E 用例。

第一步（差距 A–F）：

1. **单条覆盖**：同文件「完整 Read → range Read」后表内仅剩 range 视图；随后完整 Read 返回
   正文而非 file_unchanged（多键旧模型此反例失败：完整键仍存旧视图）。
2. **Edit 后 Read**：Edit 写入后完整 Read 返回写入后内容（旧模型命中同键返回 Wasted call）。
3. **file_unchanged 无快照**：命中 file_unchanged 的 Read part 不产生 metadata；冷恢复后由
   之前真实读取恢复，readAt 不被改成这次调用的时间。
4. **snapshotIndex 重放**：同一 assistant 内并行「完整 Read + range Read」，按序号重放后最终
   视图与 live 一致（旧模型按 part 序重放选错视图的反例）。
5. **range Read 跨 resume**：「完整 → 范围 → 重启 → 完整」与 live 同结果（旧 hydrator 跳过
   range 恢复的反例：`skippedRangeReadCount`）。
6. **rewind 保留 seed**：rewind 后 MEMORY.md 的 context 记录仍在，Write MEMORY.md 不误报
   未读（旧模型整表清空的反例）。
7. **行号/空文件**：多行文件 offset 越界返回按实际起始行编号的空视图；空文件（含规范成
   1 行的空读取）返回空文件警告（旧模型把两者都报成 offset 太大的反例）。
8. **旧数据兼容**：无 snapshotIndex 的 metadata 可恢复（退 part 序）；缺 freshness 字段的
   快照拒绝恢复（现状行为保持）。

第二步（差距 G，依赖第一步）：

9. **重读磁盘**：文件在读取后被外部修改，compact 补回的是磁盘当前内容（旧投影补回旧缓存
   的反例）；补回附件含 `Called the Read tool with the following input: {"file_path":...}` 头
   与按视图起始行编号的正文。
10. **来源与排除**：Read/Write/Edit 来源补回；Bash 回填、context seed、草稿记录不补；
    plan/指令/MEMORY.md/路径排除各一例；保留段 Read 过的文件不补，file_unchanged 的 Read
    不触发排除。
11. **deny**：`Read(.env)` 相对写法的 deny 规则拦住补回（原始写法与规范化路径双判定；旧实现
    无判定的反例）；ask 规则不拦截。
12. **预算**：第 6 新的文件不补；单文件超 5k 转引用提示且写回 `isPartialView: true`；总量超
    50k 时该文件静默丢弃、更小文件仍入选（旧实现总量超限也放提示的反例）；读取失败的文件
    占名额。
13. **整表替换**：compaction 成功后 read-state 只含补回记录（含 requestedPath 与顺序保持）；
    compaction 失败/取消时表不变。
14. **排序**：live 记录按 mtime、冷恢复记录按 readAt 从新到旧选取。

测试落点：`apps/zody-cli/packages/core/tests/`（更新 `read-file-state.test.ts`、
`read-file-state-hydrator.test.ts`、`runtime-compact.test.ts`、`token-estimation-regression.test.ts`；
新建补回专用测试，命名沿本仓惯例如 `post-compact-file-restore.test.ts`）。

## 9. 实施边界与风险

- **顺序**：两步链，第二步依赖第一步的单条视图（预算、排除键、状态回写都以每文件一条为前提）。
- **落点**：`apps/zody-cli/packages/core/src`、`apps/zody-cli/packages/core/tests`、`docs`。
  所有接口变更（含 executor 的 `areReadsDeniedWithoutPrompt`、类型新字段）都在 core 包内，
  无跨包改动。
- **不在本卡范围**：read-text 的 partial view 缩小策略 / `ToolBatchNotice` / 截断 banner 文案
  （上游同文件的其他演进，另行评估）；compact prompt 与 summary 收敛；Read 工具其他行为。
- **兼容性**：metadata 仅新增可选字段；`readFileState` 为内存态，旧会话数据兼容 =
  parse 兼容旧 metadata（snapshotIndex/requestedPath 缺省路径）。
- **风险**：`findEditableReadFileState`/`findStrictFullReadFileState` 的消费方语义合并需要
  逐一核对 edit/write 的 partial view 拒绝逻辑不回退；补回的 deny 预检依赖权限规则引擎的
  只读批量接口，需确认现有规则加载路径支持无副作用调用。
