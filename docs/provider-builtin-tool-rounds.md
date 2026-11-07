# Provider 内置工具兼容与切轮（GLM analyze_image / webReader）

Status: L0 Spec（F20 两步链：① adapters 流兼容层 ② core 切轮；来源上游 a60ba6a7）。
实施进度：Step ① 已实现（2026-11-07，adapters provider-builtin-tool-compat + anthropic-stream-compat 接线，
回归见 `apps/zody-cli/packages/adapters/tests/provider-builtin-tool-compat/contract.test.ts` 与
`apps/zody-cli/packages/adapters/tests/model-execution.test.ts`）；Step ② 未实施。

上游对应：`apps/zcode-cli/packages/adapters/src/model/provider-builtin-tool-compat/`（GLM 服务端工具流改写）与
`apps/zcode-cli/packages/core/src/runtime/provider-tool-rounds/`（轮次切分/卡片/回放/compact 分组/tokens），
规格原文见上游 `docs/design/v2/model/anthropic-stream-compat.md`「Provider 内置工具多轮回放」。本文是本仓移植 spec。

## 背景

GLM 服务端会在请求开头往工具表里追加内置工具（`analyze_image`、`webReader` 等），客户端不感知。模型调用这类工具时，
服务端自己执行、把结果拼进下一轮再请求模型，最后把**多轮结果合成一个 assistant message** 下发（一组
`message_start`/`message_stop`，block index 连续，usage 是多轮合计）。真实流块顺序（见下文样本）：

```text
thinking → text → text(「**🌐 …」调用头 markdown) → server_tool_use(analyze_image，SDK 不认识的名字)
  → text(「**Output:** …」结果 markdown) → 裸 tool_result → 下一轮 thinking/text/tool_use → …
```

`@ai-sdk/anthropic` 丢弃未知名的 `server_tool_use`，也不接受 assistant 流里的裸 `tool_result`。旧管线里只剩
markdown 进入正文与下一次请求：模型看不到结构化的调用和结果，却能看到「调用工具」的文字样例，随后在正文/思考里
模仿这段文字假装调用、编造结果（样本②即此形态）。

## 本仓现状（2026-11-07 核验）

- `apps/zody-cli/packages/adapters/src/model/anthropic-stream-compat.ts:302`：所有裸 `tool_result` 按 index 一律
  抑制（无配对概念，配对的也一起丢）；`server_tool_use` 未改名未处理；markdown 副本留在正文。
- `apps/zody-cli/packages/adapters/src/model/runner-normalization.ts`：没有 `tool-result` / `tool-error` case，
  provider 执行的工具结果事件（`provider_tool_result`）不存在。
- 本仓已有 `providerExecuted` 词汇与过滤（「仅 providerExecuted 过滤」的现状）：
  - adapters `streaming-tool-call-assembler.ts` 在 tool call 上携带 `providerExecuted`；
  - core `methods/model.ts`（tool_input_start/tool_call 流事件透传 `providerExecuted`）、
    `methods/streaming-tool-coordinator.ts:105,346`（跳过本地调度与流中执行）、
    `methods/turn-model-step.ts:691`（executableToolCalls 过滤）、`helpers/model-tool-call-validation.ts`
    （providerExecuted 不做可关闭 id 校验）；
  - contracts `events/session.events.ts` 的 `ModelStreamingPayload.providerExecuted` 与
    `ToolCallScheduled/Started/Result` 的 `display` 字段已就绪（卡片可用 `mcp_tool` 展示）。
- core 无切轮：`methods/model.ts` 流循环把全部 text/reasoning 累积为一条 assistant；
  `agent/message-history.ts` 无 `compactGroupKey`；`agent/session-history-hydrator.ts` 无按
  providerExecuted tool part 重切轮的逻辑；`runtime/helpers/compact-selection.ts` 的
  `groupByAssistantStartedRounds` 已支持 `assistantIdOf` 参数但无人传分组键。

## 真实 GLM 流量样本登记（验证手段，2026-11-07 本机核验）

手段齐备，**不 blocked**。样本与回放方法如下（后续步骤验证必须引用本表，不得另造流量）：

| #   | 样本                                                                                                                                                             | 来源                                                                                               | 内容与用途                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 会话 `sess_dwf-dwfrun-a13839cc-a12a-4013-9633-77d3ad8e4600-actor_1_11`（zcode CLI 0.17.1，2026-11-07，消息 `msg_mw64lpve_ceb76073-26fa-4b3f-a35a-65dae336059d`） | `~/.zcode/cli/db/db.sqlite`（sqlite `part` 表，按 `message_id` 查询）                              | 真实 `analyze_image` 两轮：part 序列 `reasoning → text(「**🌐 Z.ai Built-in Tool: analyze_image**」调用头) → tool(providerExecuted:true, error: MCP error 400) → reasoning → text(「**Output:**」结果副本) → tool(providerExecuted:true, completed) → …`；tool part `state.metadata.display = {kind:"mcp_tool", serverName:"server", toolName:"analyze_image"}`。用途：step② 落盘轮次形状与冷恢复回放的 ground truth。 |
| ②   | 会话 `sess_51318956-d460-43d5-a5b7-1ebc6fd5dbfa`（zcode CLI 0.14.8，2026-06-21）                                                                                 | 同上 db                                                                                            | 旧管线行为：`analyze_image` 只剩 text part 里的调用头/结果 markdown 副本（结构化块被丢弃）。用途：不修兼容层时的缺陷反例形态。                                                                                                                                                                                                                                                                                         |
| ③   | 会话 `sess_08e8b409-8db8-4941-aceb-69cc3ffe65ca`、`sess_subagent_agent_1d8324b4-8335-40d8-afd5-68a4a975710d`                                                     | 同上 db                                                                                            | 真实 `webReader` 调用头/结果 markdown 副本（input 形如 `{"url":…,"retain_images":false}`）。用途：webReader 流形状对照。                                                                                                                                                                                                                                                                                               |
| ④   | 脱敏真实流 fixture（上游测试资产，只读引用）                                                                                                                     | 上游 a60ba6a7 `apps/zcode-cli/packages/adapters/tests/fixtures/provider-builtin-analyze-image.sse` | 完整 SSE 帧：thinking → text → 调用头 text → `server_tool_use(analyze_image, id=call_93e9e7ad…)` → 结果 text → 裸 `tool_result(tool_use_id 配对)` → 尾轮 text → `message_delta`（usage 含 `server_tool_use.web_search_requests`）。用途：step① 流兼容层回放主样本（e2e fixture）。                                                                                                                                     |

回放方法：

- **step①（流兼容层）**：把样本④（及按样本①③形状派生的脱敏变体，如 webReader 名、error 结果、缺配对结果）作为
  fetch 响应体，经 `createAnthropicCompatFetch` → `@ai-sdk/anthropic` streamText 走完链路，断言改写后的块序列、
  markdown 副本去除与下一次请求内容（上游 `provider-builtin-tool-rounds.test.ts` 的做法）。
- **step②（切轮）**：以样本①的 part 序列作为冷恢复输入，断言重切轮后的回放 entries 与 live 提交一致；
  流中断/取消用 fixture 构造。真实抓包补充手段：`~/.zcode/cli/rollout/model-io-*.jsonl` 是原始 model-io 记录
  （当前三份只含 usage 统计中的 `server_tool_use.web_search_requests:0`，无内置工具调用；后续真实会话再触发时可对照核验）。

## 两步链设计

### Step ① adapters 流兼容层（provider-builtin-tool-compat）

**状态所有者**：`ProviderBuiltinToolStreamRewriter`，由 `anthropic-stream-compat.ts` 在 Anthropic provider fetch
边界（`createAnthropicCompatFetch`，仅 `provider.kind === "anthropic"`）创建，逐 SSE 帧驱动。状态按 message 维护：
`pendingResultIds`（已见服务端调用、等配对结果）、`held`（缓冲中的疑似渲染副本 text 块及其帧）、
`afterServerToolUseId`（上一个块是服务端调用时的 id）。`message_start` 清空全部状态；流结束 `finish()` 补发仍在
缓冲的帧，不吞内容。纯协议变换，不做 IO。

**帧级事件顺序**（rewriter 在现有 `decideFrame` 之前运行，输出仍走签名补全/裸 tool_result 抑制管线）：

```text
content_block_start(text) ─┬─ 前缀不符（调用头须「**🌐」、结果须「**」）→ 立即放行
                           └─ 前缀匹配 → 缓冲（不透传），等下一个块按结构确认
content_block_start(server_tool_use, SDK 不知名) → 丢弃已确认的调用头副本
    → 本帧改写为 mcp_tool_use(server_name="zcode-provider-builtin")，记 pendingResultIds
content_block_start(裸 tool_result) ─┬─ 与 pendingResultIds 配对 → 丢弃已确认的结果副本
                                     │   → 改写为 mcp_tool_result 透传
                                     └─ 未配对 → 原样放行（由 decideFrame 按现行规则抑制）
message_start → 清空状态；流结束 → 补发缓冲帧
```

- 副本确认按**结构**不只凭前缀：调用头副本必须以 `**🌐` 开头且下一个块就是服务端调用；结果副本必须加粗开头、
  紧跟服务端调用、且下一个块就是该调用的配对 `tool_result`。确认不了就原样放行——服务端缺少配对结果时，
  紧跟调用的加粗正文不被删。
- SDK 已认识的 `server_tool_use` 名单（web_search、code_execution 等 8 个）原样透传；thinking/text/typed result
  （如 `web_search_tool_result`）不受影响。
- 非流式 JSON 响应：`rewriteProviderBuiltinToolContent` 对 `content` 数组做同样的结构改写；这类调用不进入 core
  切轮（非流式入口正式链路不使用），提交时按既有过滤丢弃。
- 改写后的 `mcp_tool_use` 经 AI SDK 产生带 `providerExecuted` 的 tool chunk；`tool-result`/`tool-error`
  （providerExecuted）在 `runner-normalization.ts` 归一化为 `provider_tool_result` 事件（output/isError）。

### Step ② core 切轮（provider-tool-rounds）

**状态所有者**：

- 实时：`runModelTextRequest`（core/runtime/methods/model.ts）流循环内的 `providerToolRounds: ProviderToolRound[]`
  （每轮 `messageId` = 本响应落盘的持久化 assistant 消息 id、reasoning、text、toolCall、result?）与
  `providerToolStartedAt`。流快照（onStreamSnapshot）携带 providerToolRounds 供取消路径提交。
- 持久化事实：parts 序列（reasoning/text part + 带 `metadata.providerExecuted: true` 的 tool part）。冷恢复
  `session-history-hydrator.ts` 只依据 part 序列重切轮，不依赖任何内存状态——持久化顺序即流顺序。
- compact 分组：`RuntimeMessageEntry.compactGroupKey`（agent/message-history.ts），键 = 持久化 assistant 消息 id；
  实时取轮次 `messageId`，冷恢复取 `message.info.id`，两边同值。

**事件顺序**：

```text
流中（runModelTextRequest）：
  tool_call(providerExecuted) → 收起当前 reasoning/text 为一轮
      → persistProviderToolRoundContent（reasoning/text part 按流顺序落盘）
      → startProviderToolCard（ToolCallScheduled → ToolCallStarted，display=mcp_tool，不设 unavailable）
      → 清空当前轮缓冲，继续收下一轮
  provider_tool_result → 找到该调用未结算的轮 → finishProviderToolCard
      （tool part 落盘 metadata.providerExecuted:true + ToolCallResult 事件）
  流结束/失败/取消仍有轮无结果 → settleUnfinishedProviderToolCards 按中断收口
      （卡片补 Result 终态；error tool part 落盘；结果 = PROVIDER_TOOL_INTERRUPTED_RESULT，isError）
提交：
  成功 → commitAssistantToTurnRequest：createProviderToolRoundEntries 生成每轮
      assistant(text, tool_use) + tool(result)，排在最后一轮 assistant 之前；withCompactGroupKey 打组
  取消 → turn-model-step 取消路径用 latestStreamSnapshot.providerToolRounds 生成同样 entries 并提交
冷恢复（session-history-hydrator）：
  splitProviderToolRoundParts 按 providerExecuted tool part 把 parts 重切轮 → 每轮
      assistant(text, tool_use) + tool(result)；StreamRecoveryDiscarded 消息剔除 text/reasoning/
      providerExecuted tool part（流中提前落盘、从未进 live history），保留退回前已结算的本地工具
compact（compact-selection）：groupRuntimeEntriesByCompactRound 传入 compactGroupKey，与
      selectPersistedCompactTail 按数据库消息算的保留边界组数一致
```

**不变量**（实现与评审对照清单）：

1. 服务端执行的调用只展示、落盘和回放，不进入本地工具调度（沿用现有 providerExecuted 过滤）。
2. 每轮正文与思考只属于该轮，不与其它轮拼接，也不挪到最前面。
3. 回放采用方案 A：每轮 `assistant(text, tool_use)` + `user(tool_result)`——服务端内部还原结果与自身拼接的多轮一致；
   同一条 assistant 内 `[server_tool_use, tool_result, tool_use]` 会被还原成并行调用、丢失先后关系，因此不做方案 B。
4. 已切成轮次的服务端调用不参与终态判断（续写、超窗、fileChanges 的完整 tool call 优先规则对其例外）；空结果判定
   仍算作有内容；未切轮的 provider 调用（web_search 等）仍按完整 tool call 处理。
5. 有轮次的响应 live 与冷恢复都不挂 `tokens`：服务端 usage 是内部多轮合计（真实抓包：单次输入约 18k，带一次
   analyze_image 的响应报约 37k），当估算锚点会高估约一倍；估算回落到上一个真实锚点加本地增量。持久化 usage 照常
   保存，用量展示与缓存统计不受影响。
6. compactGroupKey 用持久化 assistant 消息 id，不能用工具调用 id：调用 id 只保证单次响应内配对，相邻两次响应可能
   复用（有的实现每次从 call_1 编号）而被并成一组，导致冷恢复带回已进入摘要的轮次。
7. 只处理流式路径；非流式（modelStreaming=off，正式入口不使用）不切轮。
8. 兼容层不改写 SDK 已认识的 `server_tool_use`；未配对裸 `tool_result` 维持现行抑制语义；无法解析的 SSE 帧与
   `[DONE]` 原样透传；HTTP 错误与业务错误不被吞。
9. 卡片走 `mcp_tool` 展示（display.serverName="server"），不设置 `display.unavailable`。

## 落点（本卡可改范围）

- `apps/zody-cli/packages/adapters/src/model/provider-builtin-tool-compat/`（新增：compat.ts、contract.ts、
  module.ts，server_name 常量 `zcode-provider-builtin`）
- `apps/zody-cli/packages/adapters/src/model/anthropic-stream-compat.ts`（接入 rewriter：帧管线前置 + JSON 路径）
- `apps/zody-cli/packages/adapters/src/model/runner-normalization.ts`（`tool-result`/`tool-error` → `provider_tool_result`）
- `apps/zody-cli/packages/core/src/runtime/provider-tool-rounds/`（新增：rounds.ts、cards.ts、contract.ts、module.ts）
- `apps/zody-cli/packages/core/src/runtime/methods/model.ts`（流循环切轮 + provider_tool_result case + 快照）
- `apps/zody-cli/packages/core/src/runtime/methods/turn-model-step.ts`（取消路径提交；终态判断例外）
- `apps/zody-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts`（成功提交 entries + tokens 策略）
- `apps/zody-cli/packages/core/src/agent/message-history.ts`（`RuntimeMessageEntry.compactGroupKey`）
- `apps/zody-cli/packages/core/src/agent/session-history-hydrator.ts`（冷恢复重切轮 + StreamRecoveryDiscarded 剔除 + 不挂 tokens）
- `apps/zody-cli/packages/core/src/runtime/helpers/compact-selection.ts`（分组键传入）
- 测试：`apps/zody-cli/packages/adapters/tests/provider-builtin-tool-compat/contract.test.ts`、
  `apps/zody-cli/packages/adapters/tests/provider-builtin-tool-rounds.test.ts`（fixture e2e）、
  `apps/zody-cli/packages/core/tests/provider-tool-rounds/{contract,hydration}.test.ts`

## 验收场景

每个行为改动至少一个反例：先在修改前断言旧输出（失败），再确认修改后通过。

### Step ①（流兼容层）

1. 【正例·fixture④】server_tool_use(analyze_image) 与配对裸 tool_result 改写为 mcp_tool_use/mcp_tool_result
   （server_name=zcode-provider-builtin）；调用头与结果 markdown 副本被去掉；经 AI SDK 产生 providerExecuted 的
   tool call 与结果。
2. 【反例·修改前】现状管线：裸 tool_result 被抑制、server_tool_use 丢弃 → 流结果无 providerExecuted tool call，
   正文含「\*\*🌐」样例文本（对当前 anthropic-stream-compat/runner-normalization 行为断言，证明缺陷存在）。
3. 未配对裸 tool_result 仍被抑制（不改写、不伪造 typed result）；普通加粗文本与服务端缺配对结果时的加粗正文保留。
4. SDK 已知 server_tool_use（如 web_search）与 typed result 原样透传；非 JSON SSE 帧与 [DONE] 透传。
5. message_start 清空跨 message 状态；流结束补发缓冲帧（不吞内容）；非流式 JSON 做同样结构改写。

### Step ②（切轮）

1. 【正例·fixture④ e2e】compat → AI SDK → Runtime 全链：落盘顺序（每轮 reasoning/text part → providerExecuted
   tool part）、卡片事件 Scheduled → Started → Result、下一次请求 entries（每轮 assistant(text,tool_use) +
   tool(result)，排在最后一轮之前）、冷恢复回放与 live 一致。
2. 【反例·修改前】现状：同 fixture 走当前 core，下一次请求只有拼接的单一 text（无轮次 entries）——断言失败后实现。
3. 中断收口：结果未到的轮（流结束/失败/取消）live 与冷恢复都回放 tool_use + 错误结果
   （PROVIDER_TOOL_INTERRUPTED_RESULT），不留悬空卡片。
4. StreamRecoveryDiscarded：作废 attempt 的正文/思考/服务端轮次不进 live 与冷恢复 history；退回前已结算的本地
   工具保留。
5. compact：一条持久化 assistant 拆出的 entries 共组（键=消息 id）；相邻两次响应复用同一 tool call id 不并组；
   保留组数与 selectPersistedCompactTail 一致。
6. tokens：有轮次的响应 live/冷恢复都不挂 tokens（上下文估算回落上一锚点）；持久化 usage 不变。
7. 终态判断：已切轮调用不计入续写/超窗/fileChanges 的完整调用；空结果判定仍算有内容。

## E2E 与验证边界

- F20 为非交互项（tier2 交互 E2E 强制清单不含 F20），不新增桌面 E2E case；行为回归以样本登记节的回放方法执行
  （fixture e2e + 会话样本形状派生用例）。
- 真实 GLM 平台复验：需要真实 analyze_image/webReader 会话时，依据样本①③所在 db 记录形状对照；本机 rollout
  model-io 记录当前无内置工具调用样本，真实流量再出现时可补充核验（登记于样本节）。
