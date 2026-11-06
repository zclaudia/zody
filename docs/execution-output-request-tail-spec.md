# 执行输出请求级尾部规范（F21，2026-11-07）

来源：上游 v3.17.1（commit `a60ba6a7`）OutputCollector `requestedTailBytes`/`ByteTail`、
`node-execution-adapter-base`、core bash handler 与 contracts 的增量移植；基于本仓已合入的
I16 输出目录基座（[TMPDIR 写入收口规范](tmpdir-storage-paths-spec.md#bash-执行输出隔离目录2026-10-24--i16)、
[后台 Bash 输出详情](background-bash-output-details.md#输出文件路径与保留i162026-10-24)）。
上游文档结构不照抄，本文按本仓规则撰写。

F21 覆盖三块互相独立的净增量能力：

1. 通用 collector 执行的请求级输出尾部：`outputLimit.tailBytes` 请求 →
   `ExecutionStreamResult.tail` 结算。
2. `OutputCollector` 内部按块分块保留尾部（摊还 O(总输出)），不复用进度尾部缓冲。
3. Bash 前台超时转后台（timeout auto-background）在 tool result 记录
   `timedOutAfterMs` 并在模型文案中可见。

## 背景

- 通用 argv/Hook 执行沿用双 pipe + `OutputCollector`（见
  [Bash Background Parity](bash-background-parity.md)「行为」一节）：inline 上限截断后，
  调用方只能拿到头部片段与 `truncated` 标志，无法以有界成本取得**尾部**——诊断信息
  （编译错误、测试摘要）通常在尾部。
- 调用方若为了取尾部而请求大 inline 预算，等于把无界输出搬进内存；若在收到结果后
  再读持久化文件，则依赖写盘路径且每次请求都全量读取。请求级尾部让调用方在发起执行时
  声明「只要最后 N 字节」，端口按块摊还保留，不缓冲整条流。
- Bash 前台超时转后台后，模型只看到「任务在后台运行」，分不清是显式 `run_in_background`
  还是超时被迫转后台；后者应告知超时秒数，模型才能决定加大 timeout、拆分工作或改用后台。

## 产品规则

### 请求级尾部（outputLimit.tailBytes / result.tail）

- `ExecutionOutputLimit.tailBytes?: number`：通用 collector 执行（双 pipe 分流）可请求
  每路（stdout、stderr 各自独立）额外保留最后 `tailBytes` 字节，结算时放入
  `ExecutionStreamResult.tail`。
- **缺席或 `<= 0` 即不保留**，`result.tail` 字段不在场（`undefined`）。
- **请求了（`> 0`）就必带 `tail`**（端口契约）：即使该路零输出，`tail` 也在场且为空串
  `""`。`tail === undefined` 只允许出现在未请求 `tailBytes` 的结果上；消费方把
  「请求了却没有 tail」视为接线错误（如端口实现不支持），不得当空输出处理。
- 尾部预算与 inline 上限**无关**：inline 截断照常计数、`truncated` 照常置位、执行照常
  读到退出；尾部不受总输出量影响——输出再大，`tail` 也恒为最后 `tailBytes` 字节以内。
- `tail` 按字节边界切：解码后首字符可能是 U+FFFD（replacement character）。消费方不得
  假设字符边界；按字节预算截断是合同而非缺陷。
- 尾部只是内存中的旁路缓冲：不写盘、不触发 `persistOutput`、不产生 artifact、不参与
  输出文件预算（`maxPersistedBytes` / `maxArtifactBytes` / 共享预算均不因 tail 扣减）。
- **Bash 合并文件输出不使用此字段**：Bash（merged output 直写）请求不下发
  `tailBytes`，其 BashOutput 也不从 `ExecutionStreamResult.tail` 取值；Bash 尾部读取
  继续走既有文件尾读（进度尾窗 4 KiB、终态头部 30000 bytes 摘要、后台详情 8 KiB 尾读）。
- 尾部解码复用 `decodeExecutionOutputBuffer` 与该路相同的 legacy 编码处理，不新增编码
  探测。

### 分块摊还（ByteTail 语义）

- 请求级尾部按**块**存、整块出队：每个 chunk 入队前先把自身截到不超过 `maxBytes`
  （单 chunk 超预算时只保留其末尾 `maxBytes` 字节）；当「总字节 − 队首整块」仍
  `>= maxBytes` 时队首整块出队丢弃（队首不可能再出现在尾部里）。
- 每字节总代价摊还 O(总输出)：append 不复制既有尾部；只在结算（`result()`）时拼接一次
  并截断到 `maxBytes`。
- **刻意不复用进度尾部（`maxTailBytes` / `appendTail`）**：进度尾部按适配器配置的
  `progressTailBytes` 定尺寸（默认很小），每个 chunk `Buffer.concat` 整个尾部、每个进度
  tick 整块解码一次；放大到请求级 MiB 量级会退化为「每 chunk 复制整个尾部、每 tick 解码
  整个尾部」。两块是**两个独立预算、两条独立路径**：`maxTailBytes` 服务进度事件的
  `stdoutTail`/`stderrTail`，`requestedTailBytes` 服务结算 `tail`，互不扣减、互不影响尺寸。

### Bash 超时转后台记录 timedOutAfterMs

- 仅当前台命令**因超时**被 auto-background（`auto_on_timeout` 模式实际触发转后台）时，
  BashOutput 记录 `timedOutAfterMs`，取值为该次请求解析后的前台超时毫秒数
  （`request.timeoutMs`）。
- 写入条件：`!run_in_background && eligibleForAutoBackground` 且返回 backgrounded。
  以下情形**不写**：显式 `run_in_background: true`（没有前台超时语义）；assistant 模式
  blocking budget 自动转后台（是预算不是 timeout，走 `assistantAutoBackgrounded`）；
  `backgroundedByUser` 的手动转后台路径。
- 只有 `> 0` 才写（缺省/非法 timeout 解析为 0 时不写字段，避免「0ms 超时」噪声）。
- schema 为 `z.number().positive().optional()`，**不带 `.int()`**：Bash 输入 `timeout`
  允许小数，转后台时原样记录；校验为整数会把小数 timeout 的超时转后台结果判为工具失败。
- 该字段对调用方（模型）可见：背景化文案分支在 `assistantAutoBackgrounded`、
  `backgroundedByUser` 之后优先消费 `timedOutAfterMs`，生成
  「Command did not complete within its Ns timeout and was moved to the background (ID: …)」，
  其中 `N = max(1, round(timedOutAfterMs / 1000))`（不足 1 秒按 1 秒展示，不显示 0s）。
- 字段是转后台那一次 tool result 的**单次事实**：后续后台任务完成通知、详情查询不携带
  也不修改它；它不参与任何调度决策。

## 状态唯一所有者

- **请求级尾部**：每路输出一个 `OutputCollector` 实例，各自独占自己的 `ByteTail`
  （stdout/stderr 互不可见）。`tailBytes` 在 `ExecutionRequest` 创建时冻结，执行期不可变；
  不存在运行中修改尾部预算的路径。
- **进度尾部**：同一 collector 实例内由 `appendTail` 独立维护，所有者不变。
- **timedOutAfterMs**：core bash handler 在返回 backgrounded tool result 的结算点一次性
  写入；adapter、runtime、后台任务记录均不持有、不复制、不更新该字段。唯一写路径即
  `toBackgroundedBashOutput` 的结算点。

## 接口与依赖方向

```text
contracts (ExecutionOutputLimit.tailBytes, ExecutionStreamResult.tail, BashOutput.timedOutAfterMs)
   ^                          ^
   | consumes / produces      | consumes
adapters                     core
  OutputCollector(ByteTail)    bash handler (写 timedOutAfterMs)
  node-execution-adapter-base  bash-model-content (模型文案)
                               bash tool result wire
```

- 方向保持 `adapters → contracts`、`core → contracts`，不新增反向依赖或循环。
- `node-execution-adapter-base.createOutputCollector` 是唯一把
  `request.outputLimit?.tailBytes` 接入 collector 的接线点；其他构造 `OutputCollector`
  的测试/内部路径不请求尾部时不传该参数。
- core 不感知 `ByteTail`；模型文案只依赖 `BashOutput.timedOutAfterMs` 字段本身。

## 事件顺序

请求级尾部（单次执行）：

```text
ExecutionRequest(outputLimit.tailBytes=N)
  -> createOutputCollector (requestedTailBytes=N, N>0 才建 ByteTail)
  -> append(chunk) × n   每块: totalBytes 计数 -> appendTail(进度尾部) -> ByteTail.append(请求级尾部)
  -> inline 截断 / persistOutput 写盘照常，与尾部互不阻塞
  -> close()             仅结束写盘流；尾部为纯内存，无收尾动作
  -> result()            ByteTail 一次性 concat + 截断到 N + 解码 -> ExecutionStreamResult.tail
```

超时转后台（Bash 前台）：

```text
resolveBashTimeoutMs -> request.timeoutMs
  -> 前台运行，timeout 计时器到点且 eligibleForAutoBackground
  -> backgroundLifecyclePort.runBashWithBackgroundLifecycle(mode: "auto_on_timeout")
  -> 返回 backgrounded
  -> toBackgroundedBashOutput(task, input, timedOutAfterMs=request.timeoutMs)   单次写入
  -> BashOutput{status:"backgrounded", backgroundTaskId, timedOutAfterMs, ...}
  -> formatBackgroundInfoForModel: assistantAutoBackgrounded > backgroundedByUser > timedOutAfterMs > 兜底
```

## 幂等边界

- `result()` 是纯读：可多次调用，返回等值结果；`ByteTail.buffer()` 不改变队列状态。
- `append` 在流结束后不得再调用（沿用 collector 既有生命周期）；越界追加属于调用方
  错误，不在本合同内定义行为。
- 同一 `ExecutionRequest` 重复请求尾部不存在（单次执行单次结算）；「多次请求摊还」指
  一次执行内**多个 chunk 反复 append** 的摊还代价，而非对同一 collector 反复取 tail。
- `timedOutAfterMs` 单次写入后无更新路径；重复结算 backgrounded（理论上不可能，由
  lifecycle 状态机保证单一 foreground result 或 background task）不产生第二份值。

## 与既有合同的关系（不回归项）

- I16 输出目录/清理行为不变：尾部不落盘，不影响 `{outputRoot}/<sessionId>/<toolCallId>/`
  路径形态、根回落、30 天清理、spawn 失败/取消清理与 `close()` 临时根删除语义。
- 未请求 `tailBytes` 时 collector 行为与现状逐字节一致：`result()` 不含 `tail` 字段，
  进度尾部、inline 截断、写盘预算、共享预算、`onPersistedLimit` 均不变。
- Bash merged 输出路径不请求尾部，Bash 直写文件、5 GiB 软阈值、watchdog、进度轮询、
  后台详情查询合同全部不变。
- 既有 backgrounded 文案优先级不变，仅在 `timedOutAfterMs` 在场且前两个分支未命中时
  使用新文案；旧结果（无该字段）继续命中兜底文案。
- `BashOutput` schema 新增字段为 optional，旧客户端/旧持久化结果缺字段仍可读，wire
  校验对缺省值不报错。

## 验收场景

请求级尾部（adapters 定向单测）：

| ID     | 场景                                                | 断言                                                                                               |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| F21-T1 | 请求 tailBytes，输出总量大于预算（多 chunk 超预算） | `tail` 为最后 tailBytes 字节；`bytes`/`truncated`/inline 行为与未请求时一致                        |
| F21-T2 | 单个 chunk 超过 tailBytes 预算                      | 只保留该 chunk 末尾 tailBytes 字节；后续小 chunk 追加时旧块按整块淘汰，尾部恒 ≤ 预算（超预算截断） |
| F21-T3 | 多次 append（同一输出的多个 chunk 反复请求级累积）  | 结算一次取值正确；多次 `result()` 等值；消费的复制量为摊还级别（不随 chunk 数复制整个尾部）        |
| F21-T4 | 请求 tailBytes 但零输出 / 只有空 chunk              | `tail === ""`（在场且为空串），不是 `undefined`                                                    |
| F21-T5 | 未请求 tailBytes（缺省 / 0 / 负值）                 | `tail` 字段不在场；`result()` 其余字段与现状一致（净增量不回归）                                   |
| F21-T6 | stdout 与 stderr 各自独立请求                       | 两路各自持有尾部，互不串；各路 `tail` ≤ 各路预算                                                   |
| F21-T7 | 尾部按字节边界切                                    | 多字节 UTF-8 字符被切在中间时解码以 U+FFFD 开头，不抛错、不丢字节预算                              |
| F21-T8 | I16 回归：请求尾部 + persistOutput 写盘并存         | 输出目录路径/清理/共享预算行为与 I16 合同一致；尾部不产生额外文件、不扣盘预算                      |

超时转后台（core 定向单测）：

| ID     | 场景                                          | 断言                                                                                                                                                                                           |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F21-B1 | 前台超时转后台（auto_on_timeout 触发）        | BashOutput 含 `timedOutAfterMs === request.timeoutMs`；`status: "backgrounded"`、`backgroundTaskId` 照旧                                                                                       |
| F21-B2 | 显式 run_in_background / assistant 自动转后台 | 均不写 `timedOutAfterMs`；`assistantAutoBackgrounded` 文案分支照旧                                                                                                                             |
| F21-B3 | 模型文案                                      | 含 timedOutAfterMs 时输出「did not complete within its Ns timeout and was moved to the background」；N 按 `max(1, round(ms/1000))`；优先级低于 assistant/user 分支；无该字段的旧结果走兜底文案 |
| F21-B4 | schema 校验                                   | 小数（如 1500.5）timeout 转后台结果通过 `BashOutputSchema` 校验；`0`/缺省不写字段                                                                                                              |

反例要求（实现步执行）：每个行为改动至少一个反例——修改前（未实现时）断言
`tail === undefined` / 无 `timedOutAfterMs` 字段 / 兜底文案的用例必须先失败（红灯），
实现后同用例按新合同通过（绿灯）；T5/B2 兼容场景同时作为「净增量不回归」的反向钉子。

## E2E 说明

F21 非交互项（不在 tier2 交互项清单内）：无 UI 交互、协议投影与渲染改动。
`timedOutAfterMs` 只影响 provider-visible 文案与 tool result 字段，由 core/adapters
定向单测覆盖；不新增 E2E 用例、不登记 E2E 场景清单。既有超时转后台 Desktop E2E
（见 [Bash Background Parity](bash-background-parity.md)）在实现步作为回归基线复跑，
若其断言与新增字段冲突以本 spec 为准更新断言（不得删除用例）。

## 非目标

- 不为 Bash merged 输出增加请求级尾部（Bash 尾部继续走文件尾读合同）。
- 不改 inline 上限、写盘预算、进度尾窗尺寸与任何 I16 目录/清理语义。
- 不把 `timedOutAfterMs` 写入后台任务记录、通知或 UI；不新增「手动前台转后台」能力。
- 不引入运行期可变的尾部预算或多次结算协议。
