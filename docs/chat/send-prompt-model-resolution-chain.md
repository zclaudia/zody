# 发送消息时的当前模型判定链路

更新日期：2026-10-24

> **历史链路审计，已被 Provider Refactor 取代。** 本文中的 workspace Provider Registry 推送、
> `runtimeModel` fallback 和 App/CLI 双目录不再是当前实现。当前模型由目标 Environment 的
> Model Selection、Registry 与 ModelFactory 解析。当前设计见
> `docs/working-memory/provider-refactor/design/`。

> **2026-10-24 语义反转（已获批）。** 本文旧版本写明「项目目前没有每条 queued prompt 固定入队时
> 模型的产品语义」。该结论自本日起作废：**普通 CLI 提交边界冻结完整 ModelSelection，执行只读冻结
> 值**。反转理由：旧语义让「入队 → 切模型 → 队列消费」在用户无感知的情况下改用消费时的 Session
> 值；V4 已经在接收边界采用同一冻结语义（`zcode-protocol-v4/commands/input-admission.ts` 的
> `resolveSubmittedExecutionState` 注释即先例）：「旧发送端在 CLI 接收边界把当前 Session 值固定
> 进 canonical intent。固定完成后 Queue/Guide 不再读取可变 Session。」本次把普通 CLI 对齐到该
> 语义，不再保留两套队列解释。

V4 `sendText` 在第一方发送端显式携带本次提交的 `modelSelection`/`mode`/`planEnabled`
（`packages/shared/src/zcode-protocol-v4/command.ts` 的迁移期注释与 `SessionPane` 的
`...submission` payload 一致）。它不是与 Session 并行保存的第二份可变状态：toolbar 配置命令先经
`configCommandBarrier` 线性化，提交时以 payload 为准；CLI 的 `resolveSubmittedExecutionState`
优先采用显式值，只有旧发送端缺省时才在接收边界固定当时的 Session 值。因此 toolbar 与 runtime
不会分别保存互相覆盖的模型值。

## 总链路

```text
toolbar config action ─┐
                      ├─> configCommandBarrier（线性化用户操作）
composer sendText ─────┘
  -> 普通 CLI input facade：快照 Session ModelSelection，写入 canonical intent
  -> V4 command ACK/admission（显式 modelSelection 由 V4 自己的入口固定）
  -> 当前 session runtime config
  -> prompt turn / queue：只读 intent 里的冻结值
  -> ModelSelected/rows/snapshot 投影
```

## 提交边界冻结（唯一 owner）

普通 CLI 的一次用户提交在进入 admission 前，由 input facade 从 Session runtime 读取当时的完整
ModelSelection（`providerId`、`modelId`、`options`），复制进 canonical intent。intent 是本次提交
的冻结事实；Queue、Guide 和 Turn 只读取 intent，不回读 Session 或 Composer。

```text
用户提交（A 已选中）
  -> facade：intent.modelSelection = 复制(A)
  -> Core admission：busy → 入队（intent 原样入列）；空闲 → 立即开轮
  -> 用户切到 B（只改 Session，不改已接纳的 intent）
  -> 队列消费 / 开轮：model = intent.modelSelection（A）
  -> 新提交：intent.modelSelection = 复制(B)
```

- 写入者只有提交边界一次；Core admission、queue、turn 都不补写、不改写已有 intent。
- 复制语义：提交完成后，Session 的后续变化或调用方持有对象的变化不影响已接纳项。
- 持久化 intent 必须携带 `modelSelection`（`input-intent-persistence.ts`），使冷恢复、编辑重放与
  实时执行读到同一事实。

### A 与 B 的判定

- A 模型运行时连续入队两条输入：两条 intent 都冻结为 A。
- 切到 B 后新提交的输入：intent 为 B。
- 队列消费时旧输入用 A、新输入用 B；切 B 不反向改写已入队项。
- 如果 A 项先执行并把 Session 常驻选择应用回 A，随后 B 项仍按自己的冻结 intent 使用 B；不能
  因为执行顺序让「新输入」退回 A。

## 已有 session

已有 session 发送时：

1. `SessionPane.dispatchSendText` 把发送动作放进 `configCommandBarrier`。
2. 在它之前入队的模型、thought、mode 和 follow-up 命令必须先完成。
3. `sendText` payload 携带文本、已 ready 的附件引用、本次提交的 `modelSelection`/`mode`/
   `planEnabled`，以及 held queue 的显式 disposition；普通 CLI 提交边界另外固定当时的完整
   ModelSelection。
4. CLI 按当前 `inputRouting` 裁决立即开始、guide、enqueue 或要求 choice；被接纳的输入携带冻结
   selection，未携带显式选择的历史调用方由提交边界补齐后再 admission。
5. ACK 只证明 admission 结果；最终 UI 以 conversation projection 收口。

因此“切模型 → 发送”使用新模型；“发送 → 切模型”不能反向改写已经 admitted 的 turn。这里保证的是
同一 renderer 操作顺序，不把 desktop continuous 与 web remote replayable 合并成全局客户端 FIFO。

## 草稿首发

草稿没有正式 session，模型必须随创建建立：

- 预热 session 已存在：首发前再次把 `draftConfigRef` 对齐到预热 runtime，再 `sendText`。
- 无预热：`createSession.config` 携带 provider/model/thought/mode/followupMode；无附件时可与
  `firstInput` 原子提交。
- 首发成功后 draft pane 原地绑定返回的 sessionId；后续只读 snapshot config。

具体见 `docs/chat/new-task-model-resolution-chain.md`。

## 显式执行选择入口（保持各自 owner）

以下入口本来就携带显式执行选择，普通 CLI 冻结不得覆盖：

- **V4 新发送端**：payload 显式 `modelSelection` 由 `resolveSubmittedExecutionState` 优先采用；
  只有旧发送端缺省时才在接收边界固定 Session 值。固定完成后 Queue/Guide 不再读取可变 Session。
- **automation**：创建时继承会话稳定 Selection（`zcode-protocol/automation-port.ts`），运行时不
  重新解释，也不因轮内冻结改写任务配置。
- **临时 `modelExecution`**（`selectionScope=execution`）：只作用于本轮（如加速材料、subagent
  执行约束），不改写 Session Selection，也不进入常驻 intent 的冻结值。
- **edit/retry 重放**：使用 canonical intent 的冻结 `modelSelection`（`canonical-intent-replay.ts`）；
  期间切模型不改变重放选择。

## Busy 与队列

V4 queue 在 CLI command core 内裁决，不再存在旧 renderer-local conversation queue：

- `inputRouting.mode=enqueue` 时，accepted input 连同冻结 intent 进入 session 权威队列。
- `inputRouting.mode=choice` 时，普通输入必须携带 `heldQueueDisposition`，否则 UI 要求确认。
- queued input 真正执行时使用 intent 里冻结的 ModelSelection，不读取执行时的 session runtime config。
- stop/held/auto-drain 的产品语义由 snapshot 与 CLI queue handler 决定，relay/main 不保存队列。

### 无可用选择

提交边界读不到完整 Selection（Session runtime 没有可用绑定，或入口模型无法给出 provider-qualified
选择）时，普通 CLI 提交在 admission 前失败，并向调用方返回明确的模型错误。不得：

- 生成只有 `providerId`/`modelId` 的部分选择；
- 省略 `modelSelection`，让执行时回读 Session；
- 把失败提交留在队列里。

### 取消、编辑与重试

- 取消（remove/discard）只移除队列项，不产生新的模型事实；其他已接纳项保留各自冻结值。
- 取消后重新发送属于新提交，按重新提交时的 Session 值冻结，不继承被取消项。
- 编辑队列文本保留同项原 intent 的 `modelSelection`；投影不得读取当前 Session 补值。
- edit/retry 重放原输入使用 canonical intent 的冻结值，不因期间切模型而改用当前 Session。

## Provider 恢复和失败

模型配置命令如果返回 `provider.notInRegistry`，UI 先同步该 workspace 的 provider registry，再解析
`runtimeModel` 并只重试一次。恢复仍失败时不会继续发送一个看似使用新模型的 prompt；发送屏障会把失败
暴露给调用方。配置 noop 则可继续，因为 runtime 已经处于目标值。

提交边界保存的是完整选择；执行前模型不可用时按既有失败终态处理（TurnError/ModelError），不能静默
回退到执行时的 Session 值。

## 当前代码入口

- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/configCommandBarrier.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts`（普通 CLI 提交边界）
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/input-admission.ts`
  （V4 `resolveSubmittedExecutionState`，冻结语义先例）
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/prompt-admission.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/input-intent-persistence.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`（执行读 `intent.modelSelection`）
