# V4 冷恢复：Runtime 激活与 Legacy Snapshot 解耦

> 状态：2026-07-24 accepted；2026-08-13 增补单次物化与单一 READY 水位合同；
> 2026-10-24 I19 修订（C4 已决）：不变量收窄为「runtime 先于**实时事件** hydration」，
> 冷历史投影与初始化状态可先于 runtime activation 发布。
> 范围：V4 conversation 首次冷订阅；不删除 legacy `session/resume` 协议，也不迁移 Bot 实时订阅。

## 1. 问题

改动前，CLI 冷启动后首次打开持久会话，V4 订阅间接复用 legacy `resumeSession`：

```text
v4/conversation/subscribe
  -> legacy cold-resume adapter
  -> legacy resumeSession
       ├─ 创建 record / runtime
       ├─ 恢复 workspace、模型、thought、mode、restoreWarning
       ├─ app.resume() 与事件接线
       └─ 构建完整 ZCodeSessionStateSnapshot  ──> 返回值被 V4 丢弃
  -> V4 durable transcript hydration
  -> getSessionUsageSeed
       └─ legacy readSession/full snapshot   ──> 只读取 runtime.contextUsage
  -> V4 initial snapshot
```

这里混合了两种职责：

1. **runtime 激活**：V4 后续命令和 config seed 必须依赖；
2. **legacy 表示层物化**：只为旧 `session/resume` 响应服务。

V4 已由 durable transcript、session entry、memory event 和 `ProductProjection` 生成自己的权威
snapshot。继续构建 legacy snapshot 不增加恢复能力，只会让耗时随历史 messages/parts 规模重复增长。

## 2. 目标边界

```text
                         ┌─ legacy session/resume
persisted session        │    -> activateSessionForResume
        │                │    -> build legacy snapshot -> legacy caller
        v                │
activateSessionForResume ┤
  ├─ persisted metadata  │
  ├─ workspace identity  └─ V4 cold subscribe
  ├─ record + event sink      -> activateSessionForResume
  ├─ model/thought/mode       -> V4 durable hydration
  ├─ restoreWarning           -> narrow context-usage seed
  └─ app.resume()             -> V4 initial snapshot
```

`activateSessionForResume` 是 profile 无关的 lifecycle primitive：

- record 已存在时不重复 `app.resume()` 或事件接线；显式 `runtimeModel` 仍按旧语义刷新；
- record 不存在时完整保留原 `resumeSession` 在 `snapshot(...)` 之前的全部行为；
- store 无 session、模型不可用、runtime resume 失败等错误与旧路径一致；
- 不根据 `desktop-continuous` / `web-remote-replayable` 分支。两者只在激活完成后的 V4
  publisher delivery profile 分流。

legacy `resumeSession` 继续作为兼容包装层：

```text
resumeSession = activateSessionForResume + snapshot
```

因此旧协议调用者、Bot 尚未迁移的 legacy 状态读取和测试语义不变；本次只让 V4 冷订阅调用
activation-only primitive。

## 3. 不得损失的功能

| 不变量                              | 约束                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtimeReadyBeforeRealtimeHydration | `app.resume()` 完成后才读取 V4 config/usage seed、接入实时事件并 hydrate 到 publisher；durable 历史投影（只含持久事实）可先发布（C4 收窄后的语义）                                                          |
| historyProjectionBeforeActivation   | 冷订阅先从 durable store（sessionStore/transcript，不依赖 active record）读取并发布历史快照；activation 可并行推进，但订阅 ACK/初始帧只等 history；快照不得伪造 runtime 在线事实                            |
| coldHistoryDurableSource            | history 读取不得以 `context.sessions`/active record 为前置；record-only 事实（artifact 文件摘要、usage/config 种子）留给 READY 的权威 hydration                                                             |
| coldReadyTerminalSingleOwner        | 冷恢复只有一个 owner 维护 `history → activation → realtime hydration` 两段水位；history 失败是订阅 RPC 终态，activation 失败是 READY 终态，不存在半 ready 状态                                              |
| coldWindowCommandGuard              | 等待窗口内先按 commandId 去重（settled/in-flight 重试直接回放终态），未命中命令等待 READY；分类/CAS/admission 只在 READY 成功后执行一次，READY 失败时命令不进入 inbox                                       |
| lateActivationResultDiscarded       | 断线、删除、取消（去激活/`dispose`）之后到达的 activation/hydration 结果在 gateway 侧必须丢弃：不重建 publisher、不接纳新订阅、不再发帧、不复活 gateway 内存态；Host 已开始的 activation 副作用不在本层回滚 |
| historicalConfigPreserved           | 历史 model、thought、mode 继续按 session-local durable selection 优先恢复                                                                                                                                   |
| restoreWarningPreserved             | 历史模型不可用时仍允许读历史，但后续 `sendText` 被同一 restore warning 闸门拒绝                                                                                                                             |
| workspaceIdentityPreserved          | 远端恢复继续使用持久化 `workspaceID`；identity key 不退化为 `workspacePath`                                                                                                                                 |
| eventWiringPreserved                | `createRecord` 建立的 event sink、persistence、MCP/runtime 接线不改变                                                                                                                                       |
| timestampsAndParentPreserved        | `createdAt`、`updatedAt`、`parentSessionId` 继续从持久会话回填                                                                                                                                              |
| v4HistoryAuthorityUnchanged         | rows、reasoning、tool、plan、goal、queue 和 interaction 仍由 V4 durable materialization + memory tail 恢复                                                                                                  |
| deliveryBoundaryUnchanged           | desktop 保持 continuous；mobile/Web remote 保持 replayable gap/snapshot 恢复                                                                                                                                |
| restartDiscardUnchanged             | 上一 runtime 未终态 input 仍按 delivery ledger discarded；不得因去掉 legacy snapshot 自动重放                                                                                                               |
| legacyResumeResponseUnchanged       | `session/resume` 仍返回完整、schema 等价的 legacy snapshot                                                                                                                                                  |
| v4ColdReadySingleOwner              | V4 gateway 只用一个 cold owner 维护 history/READY 两段水位；READY promise 只串联 activation 与 realtime hydration                                                                                           |
| hydrationBoundaryUnchanged          | `hydratePublisher` 仍只负责 projection hydration，不接管各入口既有的 runtime activation 前置条件                                                                                                            |
| registryIsNotV4Readiness            | `context.sessions` 只登记 record；V4 cold operation 完成前不能据此放行 query/command                                                                                                                        |

pending permission/elicitation 和当前 runtime queue 不是旧进程可无条件复活的 durable 事实。本次不增加、
删除或改写它们；新 runtime 的 V4 memory event tail 仍是在线权威。

## 4. Usage 窄投影

V4 冷恢复不能为了 `runtime.contextUsage` 再调用 `readSession`。窄投影必须复用 legacy snapshot
当前的同一计算口径：

```text
runtime projection contextUsed/contextWindow
  + active-branch persisted context usage/cache
  + latest matching main-turn ModelComplete breakdown
  -> ZCodeSessionContextUsage
  -> SessionUsageSeed
```

必须保留以下细节：

- runtime `contextUsed` 非零时优先；否则回落 active branch 最近的 assistant tokens 或
  compact boundary，具体口径见 `docs/context-window-usage-state.md`；
- cache 汇总只统计 active branch 的非 summary assistant messages；compact boundary seed
  不复活压缩前 cache；
- breakdown 只接受 main-turn、且 `used/contextWindow` 与 meter 对齐的最新 `ModelComplete`；
- 非正数 used/window 返回 `null`，保持“尚无一次模型往返”语义；
- 不读取/映射 legacy messages、settings、todos、goal、slash commands 或 model availability。

### 4.1 冷恢复物化来源与 M0→M1

大 session 的首次 V4 冷订阅中，durable 历史、runtime resume、权威 hydration、subagent manifest
和 usage seed 使用同一批持久 message/part，但读取来源分两段、各自复用同一段调用栈的结果：

```text
cold operation
  history phase: sessionStore/transcript ──> H
       └─ publish history snapshot(H)            （I19：先发布 durable 历史）
  activation: messages() ──> M0
       └─ activateSessionForResume({ persistedMessages: M0 })
              ├─ 未修改持久 message/part ───────────────> M0
              └─ 修补中断 compact timeline ─> messages() ─> M1
  READY authoritative hydration (M0 | M1)
       ├─ durable transcript / parent subagent manifest / usage seed
       └─ runtime seeds + resync（同一 subscription 收敛）
```

约束如下：

- materialization 只存在于本次 cold-resume promise 与紧随其后的 hydration 调用栈；不得挂到
  session record、不得建立 `sessionId -> messages` 长期缓存，也不增加 TTL、失效广播或数据库 schema；
- runtime 仍先取得持久 session，再消费注入的 messages；只有 V4 cold activation 显式选择
  复用本次 materialization，普通 core 与 legacy `session/resume` 不注入 messages，继续由 runtime
  自己读取，保持原入口语义；
- I19 的 history 读取与 activation 各自有明确来源：history 从不依赖 active record 的
  sessionStore/transcript 读取一次；activation 自己读取 M0 一次；READY 的权威 hydration
  复用 activation 返回的 messages，不再重复读取。resume 修补中断 compact timeline 时
  （`messagesReloadRequired`），activation 刷新出 M1，READY 必须用 M1 强制重新水化；
- I19 历史快照先于 activation 完成发布：若 runtime resume 修补了中断 compact timeline（M0→M1），
  已发布快照允许短暂保留修补前事实；READY 完成后的权威 hydration 必须收敛到 M1，不得把 M0
  固化进 durable 水位；
- durable hydration 继续读取最新 session metadata、target、session entries 与 memory events；复用
  messages 不得冻结 rewind/target/event 水位；
- usage seed 继续在 hydration 补完 live buffer 后读取最新 session/events/runtime projection，只把
  已物化 messages 作为输入，保持“新 `ModelComplete` 高于冷种子”的既有顺序；
- subagent manifest 只复用 parent messages；child session 仍各自读取自己的持久事实，不能误把
  parent materialization 扩散成跨 session cache；
- 并发 desktop continuous / web remote replayable 首订阅共享同一个 cold owner（history + READY），
  但 delivery profile、gap/resync 与首帧终态语义不变。
- gateway 每个 cold session 只维护一个 cold owner，内含 `history → ready` 两段水位：
  `history` 从 durable store 读取并发布历史快照；`ready` 串联
  `activate runtime -> authoritative hydration`，并在 activation 开始时立即启动、
  只在 hydration 前等待 `history` 结束。`ready` 的注册必须早于 activation 开始；
  并发 cold 入口若已看到该 owner，必须等待同一个终态。改动前已有的
  `ColdSessionResumeCoordinator` 仍只负责 runtime activation 单飞与错误分型，不作为 command/query
  的 READY 水位。历史快照发布成功后才允许订阅 ACK/初始帧返回；`ready` 的完成不阻塞该返回。
- `hydratePublisher` 保持原有 projection-only 职责和独立 hydration singleflight；不得在其中根据
  `sessionExists`、detached publisher 或调用方 option 决定是否 activation。各入口继续显式保留原有
  前置条件：普通 conversation 读取按 `hasLiveConversation` 判断，file rewind/attachment read 按
  `host.sessionExists` 判断。只有确实需要 cold activation 时才进入 cold owner。
- command 先走 CommandInbox 的幂等/去重：settled/in-flight 命中的重试直接回放终态，不等待 READY，
  也不触发 session gate 准备。未命中的 command 与 query 只读取调用开始时已经存在的 READY promise；
  存在就先等待，随后只进入一次既有 CommandInbox query/admission 流程。该流程内部原有的锁后复核
  保持不变；不得在 READY 外再增加“先查一次、等待、再查一次”，也不得由每个 query 包装 `.finally()`。
  READY 注册早于 activation，因而恢复窗口不会创建旧 command index；READY owner 不再额外失效该索引。
- 孤立 command/query 不自动激活历史 session。legacy `session/resume` 与 `attachment/begin`
  保持原有入口，不并入本次 READY 协调，也不新增跨入口 singleflight。
- `fault.command.queryUnavailable` 只表示 transcript/timeline/child/discarded 持久事实读取失败。
  activation/hydration 的异常保留原始生命周期错误，禁止伪装成 command query 故障。
- READY 失败沿用原 activation/hydration 的既有错误与清理语义；gateway 只释放本次 map entry，
  避免永久复用已 rejected 的 promise，但不改变 `context.sessions` 的既有生命周期。只有 record 入册前
  失败时，后续请求才会重新进入 cold activation；本次不承诺 record 入册后的自动回滚或重试，也不新增
  补偿事务或失败缓存。

### 4.2 单一 cold owner：history 与 ready 两段水位

```text
gateway coldFlights[sessionId]
  absent
    -> HISTORYING(load durable store/transcript -> publish history snapshot)
         |- history failed -> subscription RPC terminal (subscribe error)
         `- history published -> subscription ACK + initial snapshot
    -> READYING(activate runtime -> authoritative hydration -> runtime seeds)
         (starts immediately in parallel; hydration waits for HISTORYING)
         |- ready  -> release owner, publisher serves live frames / resync
         `- failed -> release owner; waiting command/query get lifecycle error

incoming subscribe (cold)
  join/create the same cold owner
  await history milestone -> ACK + initial snapshot
  return without waiting for READY (the owner keeps advancing)
  if history already published, return the existing snapshot immediately

hydratePublisher(sessionId, persistedMessages?)
  -> 只复用 hydrationInFlight
  -> 不负责 runtime activation
```

状态边界如下：

- `context.sessions` 继续只负责事件接线；V4 query/command 的等待依据只有 cold owner 的 READY promise；
- 只有从未在册持久 session 开始的 cold READY 阻塞 query/command；既有 live session 的首次
  projection hydration 保持原 command 调度语义，不扩大这次 M0 修复的等待范围；
- 历史快照只含 durable 事实，不得提前写入 pending permission/elicitation、runtime queue 等在线事实；
- host-dependent 读取继续在自己的入口保证 record 已恢复，不把更强前置条件编码进共享
  `hydratePublisher`；
- 改动前已有的 activation singleflight 保持原职责；CommandInbox 不维护或派生 readiness promise；
- cold owner 在 READY 成功或失败后释放 map entry；这只证明失败 promise 不会被永久缓存，不等价于整个
  activation 在任意失败点都可重试；历史已发布不构成“record 已入册”的替代判断；
- resident pool 继续独立覆盖 eviction close，显式 `session/close` 保持既有产品删除语义；
- delivery profile 在订阅 admission 时由可信 `clientMode` 选定（history initial frame 编码前）；
  live 之后的 gap/resync 与终态语义保持各自既有规则。

### 4.3 冷历史先展示的终态、取消与迟到结果

- **成功**：history milestone 发布 durable 历史快照（ACK 中 `sessionRuntimeState: "cold"`），
  ACK/初始帧不等待 READY。READY 的权威 hydration 若重建/修补了投影（生产走
  `loadColdHistory`，或 resume 返回 `messagesReloadRequired`），按既有 resync 语义向同一
  subscription 发 snapshot recovery 帧并补 runtime 种子；这不是回退到 history 之前的模式。
  若宿主没有独立 cold loader、READY 复用 history 投影，种子只改投影初值、不产 delta，
  客户端在下一次实时事件或显式 resync 时看到。
- **history 失败**：持久历史读取沿用 `performHydration` 既有防御口径（`loadPersistedEvents`
  异常记 `onError` 后按空事件继续）；入口显式判定无法建立 publisher 时以既有
  `fault.subscribe.*` 终态返回，且不发布半成品快照。
- **读取来源**：history 从不依赖 active record 的 durable store/transcript 读取一次；
  activation 自己读取 M0 一次；READY 复用 activation 返回的 messages。`messagesReloadRequired`
  时 activation 刷新出 M1，READY 强制重新水化并收敛到 M1。
- **无可先行历史**：history 阶段读不到任何 durable 事实（空事件且宿主未标记 `synthesized`）时，
  没有可先行展示的内容，也没有可交付的 `notFound`/`resumeFailed` 终态；订阅退回 READY 语义，
  由 `ready` 决定订阅 RPC 的终态，并在 activation 后按既有 hydration 重建投影。
- **activation 失败**：已发布的历史保持可读；等待中的 command/query 以原始 lifecycle error 终态收口，
  不进入 inbox、不产生 admission；owner 释放 READY entry，后续请求按 4.1 的既有规则决定是否重新进入
  cold activation。不新增错误帧，也不把失败伪装成 `proto.sessionNotFound`。没有 active record
  且没有订阅者认领时，history 建出的 publisher/raw seq 状态必须回收。
- **重复订阅**：同一 cold owner 的 history milestone 幂等；第二个订阅在 history 已发布时立即得到同一
  历史快照，并加入同一个 `ready`，不得重启 activation、不得产生第二个 runtime。即使 record 已入册
  （activation 已开始）但 READY 未完成，加入 cold owner 的重复订阅仍按 `cold` 记录
  `openTiming.sessionRuntimeState`。
- **command 去重**：settled/in-flight 的重试在 READY 等待之前回放终态；首次到达的命令仍等待 READY，
  READY 成功后才按逐命令分类/CAS/admission 处理。Renderer/Main/gateway 都不新增“已接受命令队列”。
- **断线**：`unsubscribe` 只移除该订阅者；已开始的 activation 可继续完成供其他订阅者/后续入口使用，
  但不得向已退订连接发帧。
- **删除/取消**：`disposeSession`（产品删除）、`deactivateSession`（resident 去激活）与 gateway
  `dispose` 是取消信号，晚到的 activation/hydration 结果必须丢弃：不重建 publisher、不接纳订阅、
  不发帧、不复活 gateway 内存态。Host 已开始的 activation 副作用不在本层回滚；删除后新的冷入口
  按 store 事实重新裁决，不复用被取消 flight 的结果。

### 4.4 协议声明（I19）

- `v4/conversation/subscribe` 的 params、ACK、snapshot/delta 帧 schema 不新增字段；
  `packages/shared/src/zcode-protocol/index.ts` 的严格类型与运行时校验本轮不需要变更。
- 可观察变化只有顺序：冷订阅的 ACK 与 initial snapshot 可以在 runtime activation 完成前返回，
  `openTiming.sessionRuntimeState` 仍为 `cold`；history 只含持久事实。
- command/query 的 ACK 与错误词汇表不变；去重重试回到 `duplicate` 终态的时点提前到 READY 等待之前。
- 若后续需要新增“runtime 初始化失败”的独立帧，必须作为协议变更同步 schema、严格类型和运行时校验，
  并在会话目录登记；I19 不引入该帧。

## 5. 剪枝后的验证矩阵

不枚举所有客户端 × 所有会话状态。delivery profile 在订阅 admission 时由可信 clientMode 选定，
activation 在其后与 history 并行推进；按不变量选择代表样本：

| 代表样本                                | 验证重点                                                                                                           | 证据层                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| completed 本地历史 + desktop continuous | 历史 rows/tool/reasoning、续发、幂等、无 legacy snapshot 物化                                                      | bootstrap 集成                                  |
| completed 远端历史                      | workspace identity、provider registry、续发                                                                        | 既有 V4 cold-resume 集成                        |
| 历史模型/thought/mode                   | session-local 配置与 thought hint 优先级                                                                           | 既有 I63 / bootstrap 集成                       |
| 模型不可用                              | restoreWarning 读写边界                                                                                            | 既有 bootstrap 集成                             |
| completed child                         | child cold hydration、只读导航                                                                                     | SAT09 既有证据                                  |
| mobile replayable                       | 与 desktop 首个完整终态等价；gap/resync 语义不变                                                                   | PV4-06/25 既有协议证据                          |
| legacy `session/resume`                 | 完整 snapshot 和 context usage 保持                                                                                | legacy protocol 单测                            |
| 大会话 PERF03                           | activation 不构建 legacy snapshot；history 一次 durable 读取 + activation 一次 M0 读取，READY 复用 M0；记录趋势    | 性能 fixture                                    |
| 并发 V4 subscribe/query/command         | 历史快照先返回；并发订阅加入同一 cold owner；READY 前零 admission、零 runtime 事实查询（去重重试除外）             | bootstrap 单元/集成                             |
| READY 慢/失败                           | 历史保持可读；等待中的 command/query 以 lifecycle error 终态收口且不入 inbox；owner 释放 READY entry；无主投影回收 | gateway 单元                                    |
| 断线/删除/取消/迟到结果                 | 迟到 activation/hydration 不重建 publisher、不接纳订阅、不发帧、不复活 gateway 内存态                              | gateway 单元/集成                               |
| 冷历史先可见                            | ACK + initial snapshot 先于 activation 返回；rows/reasoning/tool/plan 来自 durable store；双 delivery profile      | bootstrap 单元 + 真实 bridge 集成（双 profile） |
| READY 后 M0→M1                          | resume 修补 compact 后强制重新水化，投影收敛到 M1                                                                  | bootstrap 单元 + 集成                           |

### 5.1 冷恢复会话目录（I19）

| 场景                    | 历史快照 | runtime 阶段 | 终态                                                                    | 入口                                               |
| ----------------------- | -------- | ------------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| 冷历史 + 慢激活         | 先发布   | 等待后成功   | 同一订阅先收 history，READY 后按 resync 收敛；command 在 READY 后执行   | `v4-cold-resume.test.ts`                           |
| 冷历史 + 激活失败       | 先发布   | 失败         | 历史可读；等待中的 command/query 得到 lifecycle error，零 admission     | `v4-cold-resume.test.ts`                           |
| 重复订阅                | 幂等     | 共享一次     | 第二个订阅立即拿同一历史快照，不重启 activation；record 已入册仍报 cold | `v4-cold-resume.test.ts`                           |
| 等待窗口内 settled 重试 | 可见     | 未完成       | 直接回放 `duplicate` 终态，不等待 READY、不重复执行                     | `v4-cold-resume.test.ts` / `command-inbox.test.ts` |
| 断线                    | 已发布   | 继续/完成    | 退订连接不再收帧                                                        | `v4-gateway.test.ts`                               |
| 删除/去激活/取消        | 已发布   | 取消         | 迟到结果丢弃：不重建 publisher、不复活 gateway 订阅                     | `v4-gateway.test.ts`                               |
| 持久化选择/thought/mode | 不伪造   | 恢复后生效   | 仍由 session-local durable selection 决定，重复冷恢复不降级             | `session-selection-cold-resume.test.ts`            |
| READY 修补 compact(M1)  | 先发布   | 强制重水化   | 投影收敛到 M1，M0 不固化                                                | `v4-cold-resume.test.ts`                           |

## 6. 非目标与后续

本次不处理以下相邻 over-fetch，避免扩大回归面：

- V4 `createSession` / fork registration 为取得少量字段构建 legacy snapshot；
- Bot 的 legacy continuous subscribe、附件发送与状态查询；
- 删除 legacy `session/resume`、`readSession` 或 snapshot schema；
- 修改 publisher batch hydration、wire fragment、rows window 或 React 渲染。

这些路径应单独按调用者迁移并留下自己的功能矩阵，不能借本次 cold-resume 优化一并删除。

## 7. 2026-07-24 实测

环境：Apple Silicon、本地 production `app-server`、每个样本启动全新 CLI 进程；同一 workspace、
同一 session、同一 `desktop-continuous` subscribe。对照组从改动前 HEAD
`e3efe9006ad7489b83d1efca917b3c0df32add69` 的 detached worktree 独立构建，避免用旧安装包或
不同源码比较。文件缓存预热后各跑三次。

fixture `sess_perf_large_20260724034221_af2e36b8`：

- 2,000 messages / 6,671 parts（约 1,000 turns）
- 2,000 tool parts、334 reasoning、200 patch、60 todos
- 两组 initial V4 physical frame 均为 143,690 bytes

| 实现                                                               | 三次 cold process → initial frame |    中位数 |
| ------------------------------------------------------------------ | --------------------------------- | --------: |
| 改动前：V4 activation 构建 legacy snapshot，usage 再 `readSession` | 3352.1 / 3169.5 / 3070.2 ms       | 3169.5 ms |
| 改动后：activation-only + usage 窄投影                             | 2704.8 / 2701.5 / 2607.6 ms       | 2701.5 ms |

同机中位数减少 **468.0 ms（14.8%）**。此前该 fixture 的单次 legacy `readSession` 日志为
281–288 ms；两次 full snapshot 被移除后的端到端差值与该量级一致。这个数字仅作为本机回归证据，
不构成跨机器 SLA。

最终 production bundle 重建后，又以 Agent ready 作为起点跑了三次：

| 边界                               | 三次耗时                    |    中位数 |
| ---------------------------------- | --------------------------- | --------: |
| ready 后 subscribe → initial frame | 2040.1 / 1998.0 / 1936.5 ms | 1998.0 ms |

完整 `v4/conversation/frame` NDJSON notification（含换行）均为 143,691 bytes，stderr 为空。此前
process → initial frame 的约 2.7 秒还包含约 0.69 秒的进程启动/ready 阶段，因此两种口径一致，
不能把全部等待时间都算给 runtime activation 或 legacy snapshot。

同一 fixture 的单次阶段探针显示：持久 messages 读取/解码约 56.8 ms，transcript synth 约
49.9 ms，`ProductProjection` hydrate 约 679.9 ms，当前 usage 窄读取再次读取 active-branch
messages 约 60.0 ms。探针来自诊断 run，不与上表逐项强行求和；它只代表该 2,000-message
fixture，不能外推到 10,000-message 以上的工单形状。

2026-08-12 使用 PERF03-E 的 10,622 messages / 35,811 parts fixture 重新计数后，production
正常冷订阅会完整物化父 messages 5 次；单读中位数为 385.1ms，4 次重复读取的直接成本上界约
1540.6ms。落实本节 4.1 的 operation-scoped 复用后，fresh-process subscribe → initial frame
中位数从 3991.9ms 降到 2681.6ms，减少 1310.3ms（32.8%）。两组保持 158038-byte frame、
29950 rows、60-row window、`toSeq=74164` 与 0 running subagents。完整测量与环境见
[`v4-conversation-cold-hydration.md`](../performance/v4-conversation-cold-hydration.md#perf03-h-单次冷恢复物化2026-08-12)。
