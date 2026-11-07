# Composer 草稿事务与 IME 安全（F28 基线）

日期：2026-11-07（upstream v3.17.1 F28 基线步，来源 SHA `a60ba6a7`）。承接
[tier2 阶段计划](../plans/upstream-v3.17.1-tier2-phased-plan.md) P3 F28：本仓 composer 已与
上游分叉，按四步串行移植（①staged 暂存热路径 → ②scope incarnation token →
③claim/restore/finalize 提交事务 + createSession 信封 `sess_` UUID 幂等 → ④IME composition
抑制发布与 compositionend 前切任务不丢草稿）。**本文是基线步产出**：草稿丢失类 bug 清单、
可执行复现用例、验收场景与 E2E 场景清单；四步移植每步独立可合入，且「草稿丢失复现基线
不回退」才允许继续（护栏用例必须持续通过，复现用例由对应移植步翻转为通过）。

## 背景与上游参考（a60ba6a7，只读）

上游 `packages/ui/src/v4/composer/useDraftConfigControl.ts` 相对本仓多出的机制：

| 机制                        | 上游锚点                                                                                                                                                                                   | 本仓现状                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| staged 暂存热路径           | `stageComposerContent`（输入热路径只写 ref，不触发父级 render/localStorage）                                                                                                               | 无：每击键 `updateComposerContent` → `setStoredState`（父级整页 re-render）+ 同步 `persistV4ComposerDraft` 写盘                                                                     |
| scope incarnation token     | `scopeKey` 含 `draftFocusVersion` + root scope；`incarnation: Symbol(scopeKey)`；`isCurrentScope` 同时校验 mounted + incarnation                                                           | 无：`scopeKey = JSON.stringify([workspaceKey, scopeId])`，无挂载身份；守卫只比对 scopeKey                                                                                           |
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

### F28-B2 scope 复用无挂载身份：A₁→B→A₂ 旧闭包回调写入 A₂（修复步②）

- 根因：`scopeKey = JSON.stringify([workspaceKey, scopeId])` 在 A₁→B→A₂ 后复用；旧挂载的
  迟到回调（编辑器生命周期/发布回调）闭包内 scopeKey 与新挂载相同，守卫
  （`stateRef.current.scopeKey !== scopeKey`）放行，旧内容覆盖 A₂ 新输入。
- 复现：vitest F28-B2（`it.fails`）实测翻转后失败：`expected 'A₁ 旧回调' to be 'A₂ 新正文'`。
- 可疑性登记：当前产品时序（发布走微任务、切换清定时器/取消 rAF）下能否被用户直接触发
  未证实；属上游 `isCurrentScope`（mounted + incarnation + draftFocusVersion）明确修复的
  防护缺口，且步④引入 compositionend rAF 延迟发布后将出现真实迟到回调来源。

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
  降级为纯文本。未写复现（需 mention 预填机器），步① staged 暂存落地时顺带收口验证。
- **F28-S2 首发等待期间切走 → `promoteComposerDraft` 被守卫跳过 → root 草稿残留已发送
  正文（幽灵草稿）**：未复现；步③事务化时验证 promotion 与事务结算的先后边界。
- **F28-S3 步④后 compositionend rAF 延迟发布成为新的迟到回调来源**：与 F28-B2 同源，
  步②incarnation 必须先于/随步④生效（顺序已在四步串行中保证）。

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
3. **事务不写已切换 scope**：claim/restore/finalize 均绑定捕获时 scope；A 等待期间用户在 B
   的新输入不被 A 的失败回包覆盖（vitest F28-B2 翻转 + PA162-02 断言 B 侧不被污染）。
4. **createSession 幂等**：信封携带 `sess_<uuid>`（vitest F28-B4 翻转）；同一提交重试不重复
   预留会话。
5. **IME 安全**：组合期间不发布（vitest F28-B5 翻转）；compositionend 前切任务/关窗不丢
   （PA162-04 持续通过）；组合态 Enter 不误提交（既有 `composerImeCompositionEnter.test.ts`
   不回退）。
6. **热路径**：staged 暂存后击键热路径 0 父级 re-render / 0 localStorage 写（步①改写 G1）；
   E2E 写盘指标较基线 9 写/10 字符显著下降（防抖窗口内 0～1 次）。
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

- **PA162-01 草稿输入切任务往返不丢（+热路径写盘指标）**＝F28E-1（基线通过）。
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

## 基线指标（2026-11-07 实测，后续各步以此判回退）

| 指标                    | 数值                                                                            | 用例                                       |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| vitest 基线用例         | 5：**2 通过**（G1 刻画、G2 护栏）+ **3 expected-fail**（B2/B4/B5 复现）         | `composerDraftTransactionBaseline.test.ts` |
| 复现用例反例验证        | it.fails 翻转为 it 后 3 个断言真实失败（见 B2/B4/B5 引文）                      | 同上（临时副本已删）                       |
| 浏览器 E2E              | 4：**3 通过**（PA162-01/03/04）+ **1 失败**（PA162-02 复现），三轮一致          | `composer-draft-transaction.test.mjs`      |
| 热路径写盘（E2E）       | 输入 10 字符 → 9 次草稿键 setItem（另有防抖补写）                               | PA162-01 指标                              |
| 热路径渲染（vitest G1） | 5 次正文更新 → 7 次 owner render（含 1 次无关 settle）+ 5 次写盘                | F28-G1                                     |
| 既有相关套件            | `useDraftConfigControl` / `composerDraftStore` / IME Enter 等全绿（见验证记录） | 基线前提                                   |

护栏通过数（vitest 2 + E2E 3 = **5/5**）为「草稿丢失复现基线不回退」的量化口径：任何一步
移植后护栏掉绿即基线回退，停止该步。

## 风险与缺口登记

1. **步③落点外依赖**：`sess_` 幂等的完整上游形态需要 `packages/shared` 的 createSession
   payload schema 增加 `sessionId`（additive、optional），且 CLI 侧行为（拒绝覆盖既有会话）
   未验证——本卡落点不含 packages/shared / CLI，步③立项时需 controller 裁决。
2. **步②的可疑性**：F28-B2 当前无用户可直接触发的复现路径（防护缺口），验收以单元翻转 +
   步④后真实迟到回调来源（compositionend rAF）解释；若步④实现方式不产生延迟发布回调，
   incarnation 仍按上游语义保留（防回归成本极低）。
3. **E2E 环境缺口**：浏览器组件级用真实 Chromium 合成事件模拟 composition；真实输入法与
   Desktop 全窗口链路缺口如上剪枝登记。运行环境 node v22.23.2（mise 不可用，engine 要求
   > =24，与 F15④ 同一环境限制登记）。
4. `composerSubmissionSettlement`（R3A-B-07）不在四步内；若步③实现中发现「ACK 丢失 + 卸载」
   在本仓同样可复现，按卡内默认规则先登记 blocked 上报，不自行扩范围。
