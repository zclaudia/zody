# Composer 草稿事务与 IME 安全（F28 基线）

日期：2026-11-07（upstream v3.17.1 F28 基线步，来源 SHA `a60ba6a7`）；2026-11-08 步①落地。
承接
[tier2 阶段计划](../plans/upstream-v3.17.1-tier2-phased-plan.md) P3 F28：本仓 composer 已与
上游分叉，按四步串行移植（①staged 暂存热路径 → ②scope incarnation token →
③claim/restore/finalize 提交事务 + createSession 信封 `sess_` UUID 幂等 → ④IME composition
抑制发布与 compositionend 前切任务不丢草稿）。**基线步产出**：草稿丢失类 bug 清单、
可执行复现用例、验收场景与 E2E 场景清单；四步移植每步独立可合入，且「草稿丢失复现基线
不回退」才允许继续（护栏用例必须持续通过，复现用例由对应移植步翻转为通过）。

## 背景与上游参考（a60ba6a7，只读）

上游 `packages/ui/src/v4/composer/useDraftConfigControl.ts` 相对本仓多出的机制：

| 机制                        | 上游锚点                                                                                                                                                                                   | 本仓现状                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| staged 暂存热路径           | `stageComposerContent`（输入热路径只写 ref，不触发父级 render/localStorage）                                                                                                               | **步①已落地（2026-11-08）**：`stageComposerContent`/`persistComposerContent`/`captureComposerContentLifecycleCommit`；击键热路径 0 父级 render、0 草稿键写盘（见「步①设计」）       |
| scope incarnation token     | `scopeKey` 含 `draftFocusVersion` + root scope；`incarnation: Symbol(scopeKey)`；`isCurrentScope` 同时校验 mounted + incarnation                                                           | **步②已落地（2026-11-08）**：`incarnation: Symbol(scopeKey)` 随 scopeKey 重载换代；`isCurrentScope` 三重校验（mounted + scopeKey + incarnation）门禁全部写路径（见「步②设计」）     |
| claim/restore/finalize 事务 | `captureComposerSubmissionDraftTransaction`（事务绑定捕获时 scope + contentRevision；claim 置空、失败 restore、成功 finalize；restore/finalize 不写入后来切换的 scope）                    | 手写 `claimSubmittedDraft`/`restoreSubmittedDraft`/`finalizeSubmittedDraft` 闭包（ConversationComposer submit 内），restore 走旧闭包 `updateComposerContent`，切 scope 后被守卫拒绝 |
| IME composition 抑制        | TextContentPlugin `resolveTextContentPublication`：composing 期间 `publish=null`，compositionend 后最终 update 才发布；`snapshotDraftOfEditor` 改读 `inputApi.getMarkdown()`（编辑器事实） | `createTextContentSyncController` 组合期间照常发布（`composingRef` 只用于卡顿统计短路）；`snapshotDraftOfEditor` 读 `textRef`                                                       |
| createSession 信封幂等      | `createCommandEnvelope`：`payload.sessionId ?? sess_${crypto.randomUUID()}`（首次构造分配，重试沿用）；schema `createSession.sessionId`（上游 shared command.ts）                          | 信封不带会话 ID；本仓 `packages/shared/src/zody-protocol-v4/command.ts` 的 `createSession` payload schema 无 `sessionId` 字段                                                       |

上游配套（本卡范围外或部分参考）：`composerSubmissionSettlement.ts`（R3A-B-07 模块级结算账本）、
`composerDraftStore.ts` 的 project/taskGroup 草稿与 pendingTaskDraft（属上游任务分组体系，
本仓未承接，不在 F28 四步内）。

## 范围

- 本基线步：bug 清单 + 可执行复现用例（单元 + 浏览器组件 E2E）+ 本 spec；**不改产品代码**。
- 后续四步的落点（卡内）：`packages/ui/src`、`packages/ui/test`、`docs`。
- 涉及模块：`packages/ui/src/v4/composer/useDraftConfigControl.ts`、
  `packages/ui/src/v4/composer/composerDraftStore.ts`（仅事务/staged 所需部分）、
  `packages/ui/src/v4/ConversationComposer.tsx`（persist/submit/切 scope effect）、
  `packages/ui/src/LexicalChatInput.tsx`（TextContentPlugin 发布门禁）、
  `packages/ui/src/v4/commandFactory.ts`（createSession 信封）。

## 非目标

- 不承接上游 project/taskGroup 草稿存储、pendingTaskDraft、workspace scope 记忆与 legacy
  认领（`composerDraftStore.ts` 上游新增段）；`composerSubmissionSettlement.ts` 账本是否随
  步③引入由该步按「ACK 丢失 + 卸载」复现需要单独评估，默认不引入。
- 不改 `packages/desktop` / `packages/web`；不新增 IPC / 平台服务；不改协议 wire 格式
  （步③的 `sess_` 若需 schema 扩展见「风险与缺口」）。
- 不做附件草稿持久化（沿用「v4 composer 不做附件草稿持久化」裁决）；claim/restore 只保证
  失败恢复时**内存中附件与输入不丢**（F15 `addAttachmentFiles` 路径），不把附件写入 localStorage。
- 手机远控 `web-remote-replayable` 语义不改；组合态 Enter 不提交的既有行为
  （`composerImeCompositionEnter.test.ts`）不回退。

## 草稿丢失 bug 清单（基线，2026-11-07 实测）

编号约定：B=确认缺陷（有可执行复现），S=可疑/未复现（如实登记）。复现用例见下文清单；
`vitest` 文件为 `packages/ui/test/composerDraftTransactionBaseline.test.ts`（`it.fails` =
基线真实失败、对应移植步翻转），E2E 为
`packages/ui/test/browser/manual-review/pending/composer-draft-transaction.test.mjs`（PA162）。

### F28-B1 热路径逐击键整页 re-render + localStorage 写盘（性能型，修复步①）

- 现象：`ConversationComposer.handleEditorChange` 每击键调用
  `updateComposerContent({text})` → hook `setStoredState`（SessionPane 级 re-render，上游
  注释：「350ms 自动保存走配置 setState，导致整页、Logo 和 Timeline 一起刷新」）+
  `persistV4ComposerDraft` 同步写 localStorage。
- 基线指标：E2E 实测输入 10 字符产生 **9 次草稿键写盘**（另有 350ms 防抖后的
  editorStateJson 补写）；vitest G1 实测 5 次正文更新 = **7 次 owner render + 5 次写盘**。
- 复现：E2E PA162-01 指标记录 + vitest F28-G1 刻画（现为护栏，步①改写为 staged 断言）。

### F28-B2 scope 复用无挂载身份：A₁→B→A₂ 旧闭包回调写入 A₂（修复步②，2026-11-08 已修复）

- 根因：`scopeKey = JSON.stringify([workspaceKey, scopeId])` 在 A₁→B→A₂ 后复用；旧挂载的
  迟到回调（编辑器生命周期/发布回调）闭包内 scopeKey 与新挂载相同，守卫
  （`stateRef.current.scopeKey !== scopeKey`）放行，旧内容覆盖 A₂ 新输入。
- 复现：vitest F28-B2 基线（`it.fails`）实测翻转后失败：`expected 'A₁ 旧回调' to be 'A₂ 新正文'`。
- 修复（步②）：`incarnation: Symbol(scopeKey)` 世代 token + `isCurrentScope` 三重门禁
  （见「步②设计」）；F28-B2 已翻转为普通 `it` 并补同世代正向断言（staged 暂存/冲刷不受
  影响），反例验证：临时移除世代校验后同一测试失败于同一断言。B2 当前仍无用户可直接触发
  的产品时序（发布走微任务、切换清定时器/取消 rAF），属上游 `isCurrentScope`（mounted +
  incarnation + draftFocusVersion）明确修复的防护缺口；步④引入 compositionend rAF
  延迟发布后将成为真实迟到回调来源。

### F28-B3 提交事务在等待期间切 scope 后无法恢复 → 草稿永久丢失（修复步③，E2E 稳定复现）

- 序列：草稿输入 → 发送（`onSendText` 挂起）→ `claimSubmittedDraft` 置
  `suppressDraftPersistRef=true` 并 `updateComposerContent({text:""})`（root 草稿记录被删，
  因无 mode/modelSelection 时空正文即删 scope）→ 用户切到别的任务（SessionPane 固定 key
  复用 composer，scope 切换恢复目标任务草稿并清空编辑器）→ 发送失败（transport error）→
  `restoreSubmittedDraft` 经旧闭包 `updateComposerContent` 写回，被 hook 的 scopeKey 守卫
  拒绝（且 `contentRevisionRef` 已因切换 `updateText("")` 变化）→ 切回草稿：记录已删、
  正文丢失。
- 基线实测（三轮一致）：E2E PA162-02 期望 `"等待ACK期间切走的草稿"`，实际 `""`，
  `readPersistedDrafts()` 为 `{}`（证据：`f28e2-draft-lost.png`、`baseline-metrics.json`）。
- 修复方向（步③）：事务捕获时绑定 scope（上游 `captureComposerSubmissionDraftTransaction`
  的 `scopePersistenceTarget` + `matchesTarget(scopeToken)`）；restore/finalize 只写事务自己的
  target，不依赖挂载期闭包是否仍为当前 scope；成功结算与失败恢复各自唯一一次。

### F28-B4 createSession 信封不携带幂等 `sess_` 会话 ID（修复步③）

- 现象：本仓 `createCommandEnvelope` 对 `createSession` 不分配
  `payload.sessionId`（`sess_<uuid>`）；同一提交的重试/恢复无法沿用同一会话 ID，重试重新
  预留另一条任务（上游注释：「在信封首次构造时分配，避免重试重新生成并预留另一条任务」）。
- 复现：vitest F28-B4（`it.fails`）：`payload.sessionId` 为 undefined，不匹配
  `/^sess_[0-9a-f-]{36}$/i`。
- ⚠️ 落点风险：上游 `createSession` payload schema 含 `sessionId: z.string().min(1).optional()`
  （packages/shared）；本仓 schema 无该字段。**完整上游形态需要 packages/shared 的
  additive schema 扩展（落点外）**，步③立项时需 controller 裁决：扩落点或 UI-only 变体。

### F28-B5 IME composition 期间正文照常发布（修复步④）

- 现象：`createTextContentSyncController` 在 `getIsComposing()===true` 时仍发布 onChange，
  每个候选帧触发 B1 热路径（父级 re-render + 写盘）；上游为 `publish=null` + presence 布尔量。
- 复现：vitest F28-B5（`it.fails`）实测翻转后失败：`expected "vi.fn()" to not be called at
all, but actually been called 1 times`。
- 伴随约束：一旦抑制发布，`snapshotDraftOfEditor` 必须改读编辑器事实
  （`inputApi.getMarkdown()`，上游注释：「IME 候选阶段不向 React 发布正文，textRef 会暂时
  落后于 Lexical。生命周期 flush 必须直接读取编辑器事实，否则 compositionend 前切任务或
  关窗会丢草稿」）——F28E-4（PA162-04）护栏已就位防此回退。

### 可疑/未复现路径（如实登记，暂无复现用例）

- **F28-S1 切 scope 丢 350ms 防抖窗内的 editorStateJson/mention**：切 scope 会清掉防抖
  定时器，且清理冲刷走旧闭包被守卫拒绝；正文因每击键直写而不丢，但富文本/mention pill
  降级为纯文本。未写复现（需 mention 预填机器）。**2026-11-08 随步①收口**：切换/卸载改走
  生命周期提交，把编辑器快照（含 editorStateJson）写回旧 scope，往返恢复不再降级（E2E
  PA162-01/04 通过；mention pill 保真由 editorStateJson 随快照携带）。
- **F28-S2 首发等待期间切走 → `promoteComposerDraft` 被守卫跳过 → root 草稿残留已发送
  正文（幽灵草稿）**：未复现；步③事务化时验证 promotion 与事务结算的先后边界。
- **F28-S3 步④后 compositionend rAF 延迟发布成为新的迟到回调来源**：与 F28-B2 同源，
  步②incarnation 必须先于/随步④生效（顺序已在四步串行中保证）。

## 步①设计：staged 暂存热路径（2026-11-08 落地，先于代码写入本节）

产品规则：**输入热路径（每击键）只允许写 renderer 内存 ref，不触发父级 re-render、不写
localStorage**；正文事实仍按既有时机落盘（350ms 防抖、配置变更、scope 切换、卸载/失焦），
任何落盘路径都必须合并 staged 正文，防丢稿。

接口（`useDraftConfigControl` 新增导出，ConversationComposer props 同名注入）：

- `stageComposerContent(content)`：热路径唯一入口。写入 `stagedContentRef`
  （`{scopeKey, content, baseDraft, persist}`，ref 持有、不 render）；守卫 `isCurrentScope`
  （本步 = mounted + scopeKey；incarnation 属步②）。
- `persistComposerContent(content)`：防抖/失焦冲刷。先 stage 再 `persist(merge(baseDraft,
staged))`——每个 350ms 空闲窗至多一次写盘，带 editorStateJson。
- `captureComposerContentLifecycleCommit()`：一次性生命周期提交闭包（effect setup 捕获、
  cleanup 消费一次）；把编辑器快照写进**捕获时 scope** 的 persistence target，并清同 scope
  staged。用于 scope 切换/卸载——即使无 staged 内容也要提交编辑器事实。
- `updateComposerContent(content)`：保留为全量写路径（claim/restore/撤回恢复等配置面），
  但 `updateComposerDraft` 的 `previous` 改为 `mergeStagedContent(stateRef.current.draft)`
  ——配置变更（mode/model）落盘时合并 staged 正文，等价旧的「正文先进入内存 Draft」。

状态所有者与合并规则：

- staged buffer 唯一所有者是 hook 内 `stagedContentRef`；每条目绑定捕获时的 scopeKey 与
  该 scope 的 persist 闭包（`draftPersistenceRef`）。`scopePersistenceTarget`（useMemo，
  per scopeKey）持有 `{scopeKey, baseDraft, persist}`，随 draft 变化由 effect 同步
  `baseDraft/persist`（staged 条目同样同步），保证生命周期提交不写陈旧配置。
- 合并方向恒为「配置事实 baseDraft + staged 正文覆盖 text/editorStateJson/mention」；
  staged 只携带正文字段，永不覆盖 mode/modelSelection/授权标记。
- 消费即清除：`updateComposerDraft`（全量写）与生命周期提交消费 staged 后置 null；
  `promoteComposerDraft` 提升 `mergeStagedContent` 的完整草稿并清 staged（首发 promotion
  不丢未落盘正文）。

事件顺序（步①后）：

```text
击键 → TextContentPlugin 发布 onChange → handleEditorChange
      → updateText（textRef + contentRevision++ + draftRevision++）
      → scheduleDraftPersist：stageComposerContent({text}) + 重置 350ms 防抖
防抖到期/窗口 blur/pagehide → persistDraftNow → persistComposerContent(编辑器快照)
      → stage + persist(merge)（每空闲窗 ≤1 次写盘，带 editorStateJson）
配置变更（mode/model）→ updateComposerDraft(previous = merge(baseDraft, staged))
      → setStoredState + persist（staged 被合并吸收后清除）
scope 切换/卸载（ConversationComposer persist effect cleanup，子组件先于父 hook 清理）
      → 非 suppress（提交 claim 窗口）时 commitLifecycleContent(编辑器快照)
      → 写旧 scope persistence target + 清 staged；hook 侧 scopeKey cleanup 兜底 staged flush
```

与上游差异（登记）：不引入 `contentRevision`/`scopeContentRevisionRef`（步③事务专属）、
不引入 incarnation（步②）、不引入 promotedSessionId 同步窗（本仓 promotion 语义不同，见
F28-S2）；persist 闭包不带上游 project placement（不在本卡）。`suppressDraftPersistRef`
（本仓 claim 抑制）继续同时门禁防抖冲刷与生命周期提交，直至步③以事务 matchesTarget 取代。

验收（步①，已写入测试）：热路径 0 父级 render、0 草稿键写盘（vitest G1 改写 + E2E PA162-01
断言）；staged 正文在配置变更/scope 切换/卸载三条路径均落盘不丢（新增单测）；基线护栏
（PA162-01/03/04、G2、既有 useDraftConfigControl/composerDraftStore 套件）不回退；
B2/B4/B5 复现仍为 expected-fail（分属步②③④），PA162-02 仍失败（步③）。

## 步②设计：scope incarnation token（2026-11-08 落地，先于代码写入本节）

产品规则：**同名 scope 的不同世代（A₁→B→A₂、或重挂载）是不同的写入身份**；旧世代挂载期
捕获的回调（编辑器/生命周期迟到回调、staged 暂存、全量写）不得写入新世代草稿，新世代的
正常写入不受影响。

- **世代 token**：`loadedScope`（useMemo，deps `[scopeKey]`）生成 `incarnation:
Symbol(scopeKey)`；scopeKey 每次离开再返回都会重跑 memo → 新 Symbol；同一世代内所有
  状态更新用展开保留同一 Symbol。世代 token 随 `ComposerState` 存于 `stateRef.current`。
- **三重写入门禁**：`isCurrentScope() = mounted && stateRef.current.scopeKey === scopeKey &&
stateRef.current.incarnation === incarnation`（闭包捕获当前世代 Symbol，deps
  `[scopeKey, incarnation]`）。已覆盖：`updateComposerDraft`（全量写/claim/restore/撤回
  恢复）、`stageComposerContent`（热路径）、`persistComposerContent`（防抖/失焦冲刷）。
  `lastPersistedDraftRef` 配置落盘 effect 与 staged 切换 flush 只活在当前世代 render 闭包
  内（无跨世代定时器/rAF），维持 scopeKey 判定即可（与上游一致）。
- **正向不回归**：同世代内 staged/全量写/生命周期提交行为与步①完全一致（G1/G3/G4、
  PA162-01/03/04 护栏）；`captureAcceptedModelSelection` 维持上游形态的 scopeKey + 选择
  身份双重判定（世代间选择未变时旧 ACK 写回同值不构成用户意图丢失，上游同样未加
  incarnation）。
- 与上游差异（登记）：上游 scopeKey 另含 `draftFocusVersion` 与 root scope（项目草稿
  世界，不在本卡），本仓世代仅由 scopeKey 重载与重挂载触发；`composerDraftScopeToken`
  的对外暴露与消费（提交事务 `matchesTarget`）属步③，本步保持 hook 内部门禁（每步独立
  可合入）。
- 验收（已写入测试）：F28-B2 翻转为普通 `it`——A₁ 闭包 `updateComposerContent`/
  `stageComposerContent` 在 A₂ 被拒（持久 A₂ 保持新正文），同世代写入不受影响；护栏
  7/7 与既有套件不回退；E2E PA162-01/03/04 持续通过、PA162-02 仍为步③复现。

## 状态所有者与事件顺序

现状（基线，草稿 owner = SessionPane 挂载的 `useDraftConfigControl`；composer 只消费回调）：

```text
击键 → Lexical update → TextContentPlugin 微田发布 onChange（组合期间也发布）
  → ConversationComposer.handleEditorChange
      → updateText（textRef + contentRevision++ + draftRevision++）
      → updateComposerContent({text})              ← 每击键：父级 re-render + localStorage 写盘
      → scheduleDraftPersist（350ms 防抖补 editorStateJson）
切 scope（sessionId prop 变化）
  → 清防抖定时器；快照 previousDraft 仅用于 workspace 转移（同仓切换被丢弃 → F28-S1）
  → 旧闭包冲刷被 scopeKey 守卫拒绝；rAF 恢复新 scope 草稿
提交（submit）
  → claimSubmittedDraft：suppress=true + updateComposerContent({text:""})（root 记录可被删）
  → await onSendText
      → 失败：restoreSubmittedDraft（旧闭包；切 scope 后被拒 → F28-B3 丢失）
      → 成功：finalizeSubmittedDraft（仅复位标志）
```

目标（四步后；事务状态机 captured→claimed→restored/finalized，副作用唯一持有者）：

```text
击键 → stageComposerContent（ref 暂存，0 父级 render / 0 写盘）       ← 步①
     →（组合期间不发布；compositionend 后最终 update 发布）             ← 步④
任何写入前校验 isCurrentScope = mounted + incarnation + scopeKey       ← 步②
提交 → captureComposerSubmissionDraftTransaction(content)
  .claim()    仅当 scope/revision 未变：置空并落盘（绑定事务自己的 persistence target）
  .restore()  失败：只写事务 target（不写后来切换的 scope），revision 未变才回填正文
  .finalize() 成功：合并 staged 后清空一次；重复调用幂等返回 null
createSession → 信封首次构造分配 sess_<uuid>，重试沿用                   ← 步③
```

## 幂等边界

- 事务（步③）：`claim` 仅在 `captured` 且 scope incarnation 与 contentRevision 未变时成功；
  `restore`/`finalize` 各自只结算一次；等待期间的新输入（revision 变化）属于下一次提交，
  旧失败回包不得覆盖。
- 信封（步③）：`commandId`（uuid v7）与 `sess_<uuid>` 都在首次构造分配；transport 重试沿用
  同一信封；用户确认的**新命令**重发（pendingCommandRegistry `consumeReplay`）才允许换
  `sess_` ID（上游：首发 admission 已持久化旧会话时，确认重发沿用旧 ID 会被 CLI 拒绝）。
- 暂存（步①）：staged buffer 只属于当前 scope incarnation；scope 切换 cleanup 时把 staged
  内容落盘到**旧 scope** 的 persistence target（收口 F28-S1 与切换窗口丢失）。
- 组合（步④）：composing 期间 `publish=null`；compositionend 后同帧/下一帧发布最终正文；
  发送键与 Enter 在 `isComposing` 时不提交（既有行为不回退）。

## 验收场景（四步移植后）

1. **草稿不丢（切任务）**：任意输入（含组合中、含防抖窗口内）切 task/草稿往返，正文与
   mention/editorState 完整恢复（PA162-01/04 持续通过；步①后 editorState 不再依赖 350ms 窗）。
2. **草稿不丢（发送失败）**：同 scope 失败恢复正文（PA162-03）；等待期间切 scope 后失败，
   原提交 scope 的草稿恢复（PA162-02 由失败翻转为通过——步③反例证据）。
3. **跨世代/跨 scope 不误写（步②世代门禁 2026-11-08 已落地）**：A₁→B→A₂ 后旧世代闭包
   回调（全量写/staged）被 incarnation token 拒绝（vitest F28-B2 已翻转 + 同世代正向
   断言）；提交事务 claim/restore/finalize 绑定捕获时 scope、A 等待期间 B 的新输入不被
   失败回包覆盖（步③，PA162-02 断言 B 侧不被污染）。
4. **createSession 幂等**：信封携带 `sess_<uuid>`（vitest F28-B4 翻转）；同一提交重试不重复
   预留会话。
5. **IME 安全**：组合期间不发布（vitest F28-B5 翻转）；compositionend 前切任务/关窗不丢
   （PA162-04 持续通过）；组合态 Enter 不误提交（既有 `composerImeCompositionEnter.test.ts`
   不回退）。
6. **热路径（步①，2026-11-08 已落地）**：击键热路径 0 父级 re-render / 0 草稿键写盘
   （F28-G1 改写为 staged 断言、E2E PA162-01 断言 typing 窗口写盘 ≤1——正常 0，负载
   卡顿>350ms 时防抖合法落盘 1 次；旧热路径 ≥9）；防抖空闲窗 1 次合并落盘（带
   editorStateJson）。
7. **附件（F15 路径）**：claim/restore 测试含附件插入路径——图片标注保存（`addAttachmentFiles`
   入队）后发送失败，附件 chip 与正文一并恢复、零重发（PA162-05，随步③落地）。
8. **防回退**：`useDraftConfigControl.test.ts`、`composerDraftStore.test.ts`、
   `v4SessionPaneComposerContinuity.test.ts` 等既有套件全绿；G1/G2、PA162-01/03/04 持续通过。

## E2E 场景清单（按 e2e-case-lifecycle 现行规则登记）

组件交互验收入口：`packages/ui/test/browser/manual-review/pending/composer-draft-transaction.test.mjs`
（含 `.fixture.tsx`；真实 ConversationComposer + 真实 useDraftConfigControl，fake
Platform/Services 最小注入，与 F15④ 同款手法）。manual-review/pending 未转正不计为正式
Desktop 通过。场景登记于
[conversation-session-case-catalog.md](../conversation-session-case-catalog.md) **PA162**
（2026-11-07 accepted，先于四步实现写入，符合覆盖规划规则）：

- **PA162-01 草稿输入切任务往返不丢（+热路径写盘指标）**＝F28E-1（基线通过；步①后加
  typing 窗口写盘 ≤1 断言与防抖合并落盘断言，持续通过）。
- **PA162-02 发送挂起中切任务后失败，草稿可恢复**＝F28E-2（基线**失败＝复现 F28-B3**，
  三轮一致；步③修复后必须通过）。
- **PA162-03 同 scope 发送失败恢复**＝F28E-3（基线通过）。
- **PA162-04 compositionend 前切任务不丢**＝F28E-4（基线通过；步④防回退护栏）。
- **PA162-05 claim/restore 含附件（F15 addAttachmentFiles 路径）**：accepted；可执行子测随
  步③落地（经 F15 捕获通道播种图片附件 → 发送失败 → 正文与附件 chip 恢复、零重发）。

剪枝登记：真实系统 IME（macOS/Windows 输入法差异）、真实 Desktop 全窗口切任务、手机远控
`web-remote-replayable` 链路不由浏览器组件测试冒充（Desktop conversation-session E2E 需
`packages/desktop`，不在本卡落点，缺口登记待协调，与 PA161 同口径）；Windows/Linux 原生
窗口行为待转正阶段人工评审。

2026-11-07 执行记录（基线步）：`node --test
packages/ui/test/browser/manual-review/pending/composer-draft-transaction.test.mjs`
连续三轮 `# tests 4 / # pass 3 / # fail 1`（F28E-2 稳定复现丢失，证据
`packages/desktop/.e2e-artifacts/composer-draft-transaction-browser/`：`f28e2-draft-lost.png`、
`baseline-metrics.json`）。已知非致命 console error：fake services 缺 subagents 服务导致
`workspace context load failed`（与 F15④ 同源，不影响断言，无 pageerror）。

2026-11-08 执行记录（步①落地）：同命令连续多轮 `# tests 4 / # pass 3 / # fail 1`
（PA162-01/03/04 通过——01 现另断言 typing 窗口草稿键写盘 ≤1 且防抖后合并落盘 1 次；
PA162-02 仍失败＝F28-B3 待步③，失败形态与基线一致：期望 `"等待ACK期间切走的草稿"` 实际
`""`、持久草稿 `{}`）。热路径指标 `hotPathDraftWrites=0`（基线 9/10 字符）。开发中曾出现
F28E-1 间歇失败（机器负载把某次击键间隔拖过 350ms，防抖合法落盘 1 次），断言已按
「正常 0、卡顿容忍 1、旧路径 ≥9 数量级区分」收敛后连续 4 轮全绿；根因与裁决如上。
F15④ 真实 Composer 夹具（`image-annotate-to-draft.fixture.tsx`）因步①三 props 挂载即
消费而崩溃，已补最小 no-op 注入并复测 `image-preview-editor.test.mjs` **16/16 通过**。

2026-11-08 执行记录（步②落地）：E2E 同命令连续三轮 `# tests 4 / # pass 3 / # fail 1`
（分布与失败形态不变；incarnation 为 hook 内部门禁，组件级行为无差异）。vitest 基线文件
F28-B2 由 `it.fails` 翻转为 `it` 并通过（含旧世代 staged 回调拒绝与同世代正向断言）；
反例：临时移除世代校验后同一测试失败 `expected 'A₁ 旧回调' to be 'A₂ 新正文'`。
20 个 composer/SessionPane 相关文件 252 用例全绿（250 通过 + 2 expected-fail）；
F15 E2E 复测 16/16。

## 基线指标（2026-11-07 基线 / 2026-11-08 步①②后，后续各步以此判回退）

| 指标                    | 2026-11-07 基线                                                         | 2026-11-08 步①后                                                                                                   | 2026-11-08 步②后                                                             | 用例                                       |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------ |
| vitest 基线用例         | 5：**2 通过**（G1 刻画、G2 护栏）+ **3 expected-fail**（B2/B4/B5 复现） | 7：**4 通过**（G1 改写 staged、G2、G3 staged 合并、G4 切换 flush）+ **3 expected-fail**（不变，分属步②③④）         | 7：**5 通过**（+B2 翻转并扩同世代断言）+ **2 expected-fail**（B4/B5 属步③④） | `composerDraftTransactionBaseline.test.ts` |
| 复现用例反例验证        | it.fails 翻转为 it 后 3 个断言真实失败（见 B2/B4/B5 引文）              | 步①新增反例：G3 去 staged 合并→`expected {text:'旧正文'} to match {text:'未落盘的新正文'}`；E2E 旧热路径→`1 !== 0` | 步②反例：去世代校验→`expected 'A₁ 旧回调' to be 'A₂ 新正文'`（还原后通过）   | 同上 + E2E                                 |
| 浏览器 E2E              | 4：**3 通过** + **1 失败**（PA162-02 复现），三轮一致                   | 同分布（3 通过 + PA162-02 失败，失败形态不变），连续四轮稳定                                                       | 同分布，连续三轮稳定（步②为 hook 内部门禁，组件级无差异）                    | `composer-draft-transaction.test.mjs`      |
| 热路径写盘（E2E）       | 输入 10 字符 → 9 次草稿键 setItem（另有防抖补写）                       | typing 窗口 **0** 次（负载卡顿容忍 ≤1）；防抖空闲窗 1 次合并落盘                                                   | 不变                                                                         | PA162-01 指标                              |
| 热路径渲染（vitest G1） | 5 次正文更新 → 7 次 owner render（含 1 次无关 settle）+ 5 次写盘        | 5 次 staged 暂存 → **0** render / **0** 写盘；冲刷 1 写                                                            | 不变                                                                         | F28-G1                                     |
| 既有相关套件            | `useDraftConfigControl` / `composerDraftStore` / IME Enter 等全绿       | 20 个 composer/SessionPane 相关文件 252 用例全绿（249 通过 + 3 expected-fail）；F15 E2E 16/16                      | 252 用例全绿（250 通过 + 2 expected-fail）；F15 E2E 16/16                    | 回归验证                                   |

护栏通过数（步②后 vitest G1/G2/G3/G4/B2 + E2E PA162-01/03/04 = **8/8**）为「草稿丢失复现
基线不回退」的量化口径：任何一步移植后护栏掉绿即基线回退，停止该步。

## 风险与缺口登记

1. **步①遗留窗口（步③收口）**：发送等待期间（suppress 窗口）的新击键只进 staged ref 与
   编辑器内存——suppress 期间防抖冲刷被门禁，若命令长时间 pending 且 renderer 崩溃，
   该段正文可能未落盘。上游由步③事务的 `finalize`（合并 staged 落盘一次）收口；本步以
   生命周期提交兜底（卸载/切换即落盘），不新增等待超时。`v4ConversationComposerPromptHistory`
   的「迟到的发送成功」用例已按新确定性落盘点（卸载后断言）适配。
2. **步③落点外依赖**：`sess_` 幂等的完整上游形态需要 `packages/shared` 的 createSession
   payload schema 增加 `sessionId`（additive、optional），且 CLI 侧行为（拒绝覆盖既有会话）
   未验证——本卡落点不含 packages/shared / CLI，步③立项时需 controller 裁决。
3. **步②可疑性（2026-11-08 已落地）**：F28-B2 修复时点仍无用户可直接触发的复现路径
   （防护缺口），验收以单元翻转 + 反例（去世代校验失败）落地；步④引入 compositionend
   rAF 延迟发布后将成为真实迟到回调来源；若步④实现方式不产生延迟发布回调，incarnation
   仍按上游语义保留（防回归成本极低）。
4. **E2E 环境缺口**：浏览器组件级用真实 Chromium 合成事件模拟 composition；真实输入法与
   Desktop 全窗口链路缺口如上剪枝登记。运行环境 node v22.23.2（mise 不可用，engine 要求
   > =24，与 F15④ 同一环境限制登记）。
5. `composerSubmissionSettlement`（R3A-B-07）不在四步内；若步③实现中发现「ACK 丢失 + 卸载」
   在本仓同样可复现，按卡内默认规则先登记 blocked 上报，不自行扩范围。
