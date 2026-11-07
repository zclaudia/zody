# Chat Virtual Scroll

> **V4 当前事实**：滚动视口、虚拟化、底部跟随与 renderer-local 滚动记忆由
> `packages/ui/src/v4/ConversationTimeline.tsx` 持有；消息事实仍来自
> `packages/shared/src/zcode-protocol-v4/` 与 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`。

## 目标

长对话只渲染当前视口附近的消息轮次，降低 renderer 在长会话中的 DOM 数量和 React 更新成本。

## 渲染策略

- `ConversationTimeline` 以 `ConversationTurnRenderUnit` 为虚拟滚动单位，而不是单条 projection row。
- 每个虚拟 row 对应一轮 user + assistant/tool 输出，避免 retry、fork、文件变更摘要和当前轮 loading 被拆散。
- 使用项目已有的 `@tanstack/react-virtual`，动态高度通过 `measureElement` 回写。
- 对话搜索先按 projection rows 建索引，再通过 virtualizer 定位并在已挂载 DOM 中高亮。

## resize 中的底部跟随

`ConversationTimeline` 是唯一滚动 owner，沿用 `followingRef` 和已有用户意图裁决。用户上滚立即解除跟随；滚回底部或点击回底恢复跟随；搜索、轮次定位、会话滚动记忆及历史前插继续保持原契约，不提供强制吸底开关。

- 跟随状态下，视口或内容列宽度变化引起的重排采用绘制前批处理：读取行高 → 更新 virtualizer 缓存 → 同步提交 React 占位高度和位置 → 再确认跟随权 → 吸底。不等待宽度稳定计时器，不将旧占位高度下的中间落点留到下一帧。
- 库的 observer 可能已更新缓存但仍排队等待 React 提交，因此批处理必须明确触发布局提交；不能依赖无差量的重复测量触发 render。同步提交仅在 ResizeObserver 回调内执行，批处理期间其他内容 effect 不抢先吸底。
- 离底时保持原宽度变化保护：resize 期间暂停逐行滚动补偿，不强制吸底；稳定后恢复正常测高补偿。本文不新增按句子保持屏幕坐标的阅读锚定。
- 每次批处理前后检查最新用户意图，resize 中上滚、搜索或会话切换不能被后续测高抢回滚动权。观察器监听视口和内容列，在同步提交前暂时取消内容列及父消息层蒙层的尺寸观察，下一帧恢复订阅，避免自身高度写入触发循环通知，同时持续覆盖 CSS 宽度过渡；测高与吸底本身不延后，不重复订阅虚拟行。消息内容变高继续走原有测高与内容提交逻辑。批处理只测已挂载行，不轮询或全量渲染历史。
- 桌面和手机 Web 共用此逻辑；空草稿保留顶部安全布局，不修改消息协议及 continuous/replayable 边界。

```text
尺寸变化 → ConversationTimeline 检查跟随权
  跟随 → 批量测高 → 同步提交布局 → 再检查跟随权 → 吸底
  离底 → 原有宽度变化与阅读位置保护
用户上滚 / 搜索定位 → 解除跟随（优先于布局回调）
回到底部 → 恢复跟随
```

验收：连续缩窄/放大时跟随落点与列表占位高度正确；resize 中上滚后保持离底；点击回底可重新跟随。原会话记忆、搜索定位和历史前插回归通过。运行时记录绘制前实际行底部与占位高度误差、离底距离，并检查可见画面，允许 1px 亚像素取整误差；不得以停止拖动后的落点代替过程验证。

浏览器回归：`node --test packages/ui/test/browser/manual-review/pending/conversation-timeline-resize.test.mjs`。覆盖真实 timeline、消息组件和虚拟列表的桌面/手机紧凑布局、深浅主题、内容列独立宽度过渡；数据为确定性 fixture，手机远控传输不属于该测试覆盖范围。桌面实际会话继续由 `conversation-session-v4-scroll.test.ts` 覆盖流式输出与滚动记忆。

## 滚动边界

- 旧的 `useChatAutoFollow` 多 flag 自动吸底状态机已删除；当前只保留一个小的 bottom-lock 状态和普通手动滚动容器。
- `ConversationTimeline` 使用一个小的 bottom-lock 状态：没有滚动记忆的新会话默认启用，消息追加、markdown/tool 详情撑高和 ResizeObserver 变化会继续写入最新底部 `scrollTop`。
- 右下角“滚动到底部”按钮只由当前滚动条位置控制：滚动容器不在底部时显示，到达底部时隐藏；用户手动滚回底部附近或点击按钮滚到底部都会重新启用 bottom-lock，避免生成中内容继续变高时错过锁底。按钮所在底部浮层使用 `background` token 的向上渐变遮罩，避免压住末尾消息时产生生硬边界。
- 当消息内容短到没有纵向滚动条时，视口没有可保留的历史阅读位置，ChatView 会把它视为 bottom-lock 可开启状态；这样后续流式内容撑出滚动条时仍能继续吸底。
- 正常对话态下，composer 通过 `bottomDock` 渲染在 timeline 的同一个滚动视口内，并使用 `sticky bottom-0` 吸附；“回到底部”按钮锚定在 dock 上方。
- 会话切换优先读取 renderer-local 的滚动记忆。记忆键由 `workspaceIdentity?.trim() || workspacePath`、`paneId` 与 session/task scope 组成；同一 renderer 的不同 pane 不共享阅读位置，不同桌面窗口或手机 Web renderer 也不共享内存。
- 若记忆保存时处于 bottom-lock，切回时滚动到**当前**最新底部并继续启用 bottom-lock；否则恢复保存的像素 `scrollTop`，按当前内容高度夹紧到合法范围并保持离底。如果没有记忆，则打开时定位底部并启用 bottom-lock。
- 恢复先在 layout 阶段写入一次，下一 animation frame 在 virtualizer 首轮测高后再校正一次；若用户已经滚动，第二次校正必须让出写入权。
- 搜索结果、高亮查找、fork 来源和 turn navigator 跳转都属于定位型滚动，定位后保持离底；该位置可被后续 task 切换记忆。
- 补全旧历史后继续按新增高度恢复滚动位置，避免视口跳到历史顶部。
- 对话内容宽度连续变化时，动态行会因文字换行分批重新测高。离底阅读状态必须保持当前 `scrollTop`，禁止 virtualizer 按每条视口上方行逐次补偿而造成上下抖动；吸底状态采用上面的同步测高批处理，每次视口 resize 都按已提交的新高度吸底。宽度稳定后恢复普通动态测高补偿，新消息与流式内容的正常 bottom-lock 不受影响。
- bottom-lock 不写入 localStorage、relay、main process、host process 或 task runtime；滚动记忆只在当前 renderer 生命周期存在，并由 200 项 LRU 回收。

## 历史详情懒渲染

- `AssistantMessage` 的历史区只在展开时调用 `renderHistoryParts`，默认闭合时只保留摘要行。
- `ToolLayout` 支持 `renderContent`，工具详情只在展开或强制展开时构造，避免闭合工具提前挂载大量 markdown、diff 和子工具 DOM。
- 历史区和工具区的展开状态按 message/tool key 保存在 renderer 内存中，虚拟滚动导致组件卸载再挂载时不会丢失用户刚展开的细节。
- 流式输出、被中断和 settling 状态仍会强制展开历史区，保证正在发生的内容不会被隐藏；流式结束后自动回到摘要态。

## 渲染缓存与 memo 边界

- 已完成 markdown 消息固定走 `Streamdown` static 模式；只有真实流式动画进入 streaming/block 路径，避免虚拟滚动和历史懒渲染反复重挂载完成态消息时触发 Streamdown 内部更新循环。
- `DiffViewer`、edit inline diff、`ToolLayout`、`ToolCallBlock`、`AssistantMessage`、`ChatMessage` 和 turn group 边界使用 `memo`，减少历史消息在父组件更新时的重复 commit。
- turn group 内传给单条消息的 retry、文件切换、feedback、fork 回调通过 `useCallback` 稳定，避免 memo 被 map 里的 inline function 抵消。
- diff 只稳定 options 和 viewer 输入，不缓存实际 DOM；主题、字号、换行和行号设置变化时仍会正常重渲染。

## 分区渲染与查找改进（F17）

> 上游 v3.17.1（来源 commit `a60ba6a7`，`packages/ui/src/v4/ConversationTimeline.tsx` 及
> `conversationProjectionStore.ts`）的时间线性能改进。本仓时间线已分叉，按本节分步移植；
> 每步独立可合入，且只有当前一步的基线不回退时才进入下一步。

### 现状：流式帧的每帧 O(N) 派生成本

本仓已有 perf-1/perf-2 指纹复用（`ConversationTimeline.tsx` 的
`buildConversationTurnRenderUnits` 以 `previousUnits` 比对输入、复用未变 turn 的引用），但流式帧
`rows` 每帧都是新数组引用，以下派生仍逐帧全窗扫描，成本随历史长度线性增长（行号为 2026-11-07 基线）：

- `buildConversationTurnRenderUnits(rows, …)`：每帧对全部 rows 做指纹比对（`ConversationTimeline.tsx:437-446`）；
- `turnNavigatorQueryRowIds` Set 重建、`hasRunningUnit` 全 units 扫描（`ConversationTimeline.tsx:451-465`）；
- `conversationFindIndex` 合并：unit 级缓存命中后仍要逐 unit 拼 key + Map 查找并重建 matches 数组
  （`useConversationTimelineFind.ts:87-118`）；
- `ROW_OVERSCAN = 8`（`ConversationTimeline.tsx:107`）：虚拟单元是一整轮长正文，搜索/目录跳转时
  前后各 8 轮同步挂载大量屏外 Markdown（上游注释原话：会把小行列表的 overscan 放大为数十屏布局工作）。

### 上游机制与移植顺序

上游把「冻结历史 + 尾轮」分区缓存为 rows 的纯派生（`conversationProjectionStore.ts` 的
`getConversationRowsPartition`，WeakMap 按 rows 数组引用缓存 `{history, tail}`；delta 应用后由
`advanceConversationRowsPartition` 在只改尾轮时沿用上一份 history 引用；`memoizeByRows` 收拢按行
数组引用缓存历史段派生的样板），render units、插件 UI 派生、highspeed 过期、查找索引等都改为
history 引用缓存 + 每帧只算尾段。`ROW_OVERSCAN` 收紧为 2；`measuredLayoutRevision` 让
`mountedRowsKey` 把「同批测高已提交」纳入失效条件，配合批量测高避免测高帧反复触发挂载键抖动。

移植顺序（每步先补 spec 与测试，基线复测不回退才继续）：

| 步骤 | 内容 | 主要指标 | 期望方向 |
| --- | --- | --- | --- |
| ① 基线 | 本节 + 基线记录文件 + 浏览器测量 harness | M1–M4 建档 | —（本步已完成） |
| ② 分区 | `getConversationRowsPartition`/`memoizeByRows`/`advanceConversationRowsPartition` 与消费方接入 | M1 growth | 2.49x → 向 1.x 收敛；p50@3003 行显著下降 |
| ③ overscan | `ROW_OVERSCAN` 8 → 2 + 未知长轮一屏估高 | M3 | historyTurnUnits 18 → 6、historyElements 972 → 324（实测 −67%，见基线记录） |
| ④ 测量 revision | `measuredLayoutRevision` 批量测高与 mountedRowsKey 失效 | M1/M2/M3 不回退 + SRM10 resize 回归 | 不回退（实测持平，见基线记录；收益为正确性与时序） |
| ⑤ 查找 | 查找索引按分区缓存（history 段按引用复用，每帧只算尾轮） | M4 + 代码级分区缓存测试 | M4 不回退（现有 unit 缓存已把墙钟增量压到噪声级，验收以代码级测试为主） |

### 步骤②契约：冻结历史 + 尾轮分区

- **状态所有者**：分区是 `rows.window` 的纯派生缓存（WeakMap 以 rows 数组引用为键），
  不是第二份消息状态；唯一登记点是 `ConversationProjectionStore` 的 delta 应用路径
  （`applyConversationDeltas` → `shareDeltaRows` → `advanceConversationRowsPartition` →
  `setState`），订阅方在同一次通知里读取新 rows 时分区已就绪。
- **分区语义**：`tail` = 最后一行所在轮的全部行（该轮在更早位置也出现过时起点前移，
  直到两段轮次不相交；消费方不能假设 tail 只有一轮）；`history ++ tail` 逐项等于 rows。
  流式帧只改尾轮时沿用上一份 `history` 数组引用，其余情况（新轮开始、旧行更新、rewind、
  前插历史）首次读取时整窗重建。
- **接口**（上游 a60ba6a7 移植，类型位置适配见下）：
  - `conversationProjectionStore.ts`：`ConversationRowsPartition`、`getConversationRowsPartition`、
    `advanceConversationRowsPartition`、`memoizeByRows`；
  - `conversationTurnRenderUnits.ts`：`createConversationTurnRenderUnitsSelector`（输出
    `{history, tail}`，与对全窗 `buildConversationTurnRenderUnits` 逐项相等；历史段结果按
    history 引用缓存，仅当历史含无 header 轮（依赖 sessionPhase）、运行中轮（依赖时钟）或
    可固定插件行（依赖 resolver）时缓存键追加对应输入）；扁平 `buildConversationTurnRenderUnits`
    保留不删；
  - `plugin-ui`：`createLogicalUiInstancesSelector`（history 引用 + 尾轮回合序列/插件行引用不变
    时复用上一份推导，否则整窗重算）；
  - `conversationTurnNavigatorHelpers.ts`：`createConversationTurnNavigatorQueryRowIdsSelector`
    （目录成员不变时保持同一 Set 身份，锚点登记不随流式帧全量重建）；
  - `conversationTimelineLiveTail.ts`：`splitConversationTimelineLiveTail` 接受分区入参
    （running 尾轮时 `virtualizedUnits` 直接复用 history 引用），保留扁平入参兼容既有调用。
- **类型位置偏离**：上游把 `ConversationRowsPartition` 放在 shared 协议包（让 plugin-ui domain
  只依赖协议类型）；本卡落点不含 packages/shared，故类型定义在 `conversationProjectionStore.ts`，
  plugin-ui 侧以结构兼容类型声明（`{ history, tail }`），不引入 plugin-ui → v4 store 的模块依赖。
  后续若 shared 开放可再上移对齐上游。
- **验收场景**：
  1. 等价性：对「历史 + running 尾轮」「尾轮 unit 全被过滤（timelineOnly 等）」「无 header 轮」
     「运行中历史轮（时钟推进）」「插件固定 resolver 变化」「新轮开始（turn 在两段间迁移）」等
     场景，selector 的 `history ++ tail` 与全量 `buildConversationTurnRenderUnits(rows)` 逐项相等。
  2. 引用稳定性：只改尾轮的流式帧后，`partition.history`、selector 历史段数组与其内 unit 引用、
     `virtualizedUnits`（running 尾轮时）、目录 Set 身份、插件 UI 推导结果引用均不变；
     历史行被 upsert / 新轮开始时相应引用更换。
  3. advance 沿用判定：`row.appended`（新轮/尾轮）、`row.upserted`（历史/尾轮）、`row.delta`、
     `row.removed`、state/pluginUi delta 的沿用与重建边界逐条覆盖。
  4. 既有回归：扁平 API 及其测试（`v4ConversationTurnRenderUnits*`、`v4ConversationTimelineLiveTail`
     等）不回退；M1 复测 growth 收敛、M2–M4 不回退（数值追加进基线记录文件）。

### 步骤③契约：ROW_OVERSCAN 收紧与未知长轮一屏估高

- **overscan 语义**（上游 a60ba6a7 移植）：`ROW_OVERSCAN` 由 8 收紧为 2。虚拟单元是一整轮长
  正文，前后各 8 轮会在搜索/目录跳转时同步挂载大量屏外 Markdown——把小行列表的 overscan
  放大为数十屏布局工作；保留两轮滚动缓冲即可。配合步骤②的分区缓存（跳转落点附近的轮次
  重挂载成本被 memo/引用复用摊薄），收紧不引入可见空白回归。
- **未知长轮一屏估高**（上游 a60ba6a7 移植）：`estimateSize` 对无测量缓存的轮次以滚动视口
  一屏高度（`scrollRef.current?.clientHeight`）作保守预算，代替 72px 小行估计——一个虚拟单元
  是一整轮，按 72px 估未知长轮会让首屏/跳转一次性挂载十几轮正文；实际尺寸仍由测高缓存与
  ResizeObserver 决定。视口高度不可得（0/undefined，如 jsdom）时回落 `DEFAULT_ROW_HEIGHT_ESTIMATE_PX`。
- **不变量**：`measureElement` 动态测高、测高缓存按 turnId 键控、滚动记忆与前插锚点契约不变；
  本步只改「未测量时的预算」与「窗口外缓冲轮数」。
- **钳制跟随权修复（本步必要配套，上游 a60ba6a7 同款估高下的隐患，由本仓 SRM10 回归暴露）**：
  一屏估高使测量修正收缩 totalSize 时，浏览器会把 scrollTop 钳到新底部；钳制产生的 scroll
  事件落在用户滚动意图 TTL 内会被归类为 user，旧逻辑「user 落底即重新跟随」会覆盖用户刚取得
  的离底状态（SRM10 desktop Grow 后上滚用例 3/3 复现）。修复不变量：**数值上向上移动
  （scrollTop 减小）的 user scroll 不可能新落到底部**——`resolveFollowingAfterScroll` 新增
  `previousScrollTop` 入参，未跟随态下向上移动的事件一律保持离底；真实「滚回底部重新跟随」
  只来自向下移动，行为不变。
- **验收场景**：
  1. 源级守卫（沿用 `v4ConversationTimelineScrollbarGutter.test.ts` 的源断言约定）：
     `ROW_OVERSCAN = 2` 与一屏估高 fallback 在源码中存在，防止后续误回退。
  2. 行为验证（浏览器 harness M3）：500 轮会话从底部 locate 到中段后，已挂载
     historyTurnUnits 由 18 降到 ~10–12、historyElements 同步下降约 1/3；定位目标行仍完整
     挂载、定位后离底。
  3. 钳制跟随权（单测）：未跟随态 + 向上移动 + 落底的事件保持离底；向下移动落底仍恢复跟随；
     已跟随态行为不变；layout/programmatic 来源不改变跟随权。
  4. SRM10 resize 回归：desktop 全组合通过（Grow 后上滚保持离底）；mobile 的既有
     ResizeObserver loop 失败与本步无关（步骤②已归因）。
  5. 基线复测：M1/M2/M4 不回退（M3 改善），三轮数据追加进基线记录文件。

### 步骤④契约：批量测高与 measuredLayoutRevision

- **批量测高（前插/冷恢复路径，上游 a60ba6a7 移植）**：`rowWindowKey`/`virtualRows` 变化的
  commit 上，layout 阶段批量读取已挂载 `[data-index]` 节点高度，差量 `virtualizer.resizeItem`
  并同步提交；本批存在差量时置 `contentMeasurementPendingRef = true`。pending 期间：
  - `shouldAdjustVirtualizerForItemSizeChange` 在「前插进行中（rows 首行 rowId < 锚点基线）」时
    抑制逐行滚动补偿（前插锚点 effect 统一补偿一次），item 坐标比较改用 virtualizer 同批
    `scrollOffset`，避免混用原生 scrollTop 与未重算坐标；
  - 滚动记忆恢复 effect、前插锚点 effect、底部锚定 effect 让位（跳过本 commit），
    由 revision 提交触发的下一轮以已提交高度重新对账。
- **measuredLayoutRevision（宽度校正后发布）**：revision 是「测高布局已提交」的代际。
  发布点：宽度 RO 批量测高 flushSync 提交（本仓已有）、宽度校正 settle 结束
  （`CONTENT_WIDTH_RESIZE_SETTME_MS` 定时器：发布既有生命周期结束，待定位搜索此时接管，
  避免过早居中后新挂载的上方缓冲行把命中推离视口）、前插批量测高提交。
  消费点：`mountedRowsKey` 纳入 revision（挂载 DOM 对账在测高提交后失效重查）；
  底部锚定 effect 与滚动记忆恢复 effect 依赖 revision。
- **不变量**：前插锚点「绘制前平移、无闪动」、滚动记忆恢复「先记忆后内容」、跟随权裁决
  （用户意图优先）契约不变；本步只改变测高提交的时机与锚定对账的顺序（先测高、后对账）。
- **验收场景**：
  1. 源级守卫（沿用源断言约定）：revision 被捕获并进入 mountedRowsKey/锚定 effect 依赖、
     批量测高 effect 与三个让位守卫、settle 发布、suppressAdjustment 前插条件在源码中存在。
  2. 行为回归：SRM10 resize desktop 全组合通过（宽度校正批量测高路径）；滚动记忆
     （SRM01-04 单测）、前插锚点（HLP 单测/正式 E2E 既有覆盖不回退）。
  3. 基线复测：M1–M4 不回退，三轮数据追加进基线记录文件。

### 性能指标定义与测量方法

测量入口：`node --test packages/ui/test/browser/manual-review/pending/conversation-timeline-perf-baseline.test.mjs`
（vite dev 编译真实 `ConversationTimeline` + TanStack virtualizer + Streamdown，Chromium headless，
确定性合成数据：每轮 turnHeader + userInput + assistantText 三行；运行环境与数值记录见
[chat-virtual-scroll-perf-baseline.md](./chat-virtual-scroll-perf-baseline.md)）。

| 指标 | 口径 | 敏感步骤 |
| --- | --- | --- |
| M1 流式每帧成本 | 尾轮等长替换（隔离尾轮渲染变量）× 120 帧的 flushSync render+commit p50/p95；三档历史 153/1503/3003 行；growth = p50(3003)/p50(153) | ② 分区 |
| M2 初始挂载 | 4503 行吸底挂载整页墙钟（同机前后对比）+ historyTurnUnits/historyElements 计数 | ③④ |
| M3 定位跳转挂载量 | 底部 locate 至中段后的 historyTurnUnits / historyElements（确定性计数） | ③ overscan |
| M4 查找激活流式成本 | `conversationFindQuery` 命中全部历史轮时的 M1 同口径 | ⑤ 查找 |

墙钟只记录趋势、不做 CI pass/fail 门禁（与 `docs/testing/conversation-session-e2e-coverage-matrix.md`
的 PERF03 口径一致）；harness 内仅保留远高于预期的 sanity 上限。每步合入前后各跑一轮并追加到
基线记录文件，无前后对比数据不得声称改进。

### 验收场景（每步通用）

- 行为回归（harness 内置断言，每轮随跑）：1500 轮初始挂载吸底（gap ≤ 1px）；三档规模流式 120 帧
  保持吸底（gap ≤ 2px）；定位跳转后离底且目标行已挂载；全程无页面错误。
- 既有回归不回退：SRM 滚动记忆（`conversation-session-v4-scroll.test.ts` 桌面 E2E + UI unit）、
  HLP01-HLP02 历史前插锚点（正式 E2E）、SRM10 resize 浏览器回归
  （`packages/ui/test/browser/manual-review/pending/conversation-timeline-resize.test.mjs`）。
- 单元级：分区/memoize 的纯函数测试（分区边界、delta 沿用 history 的判定、WeakMap 复用语义），
  每个行为改动含反例（见各步任务卡）。

### E2E 场景清单（按 e2e-case-lifecycle 规则）

| 场景 | 入口 | 状态（2026-11-07 基线步） |
| --- | --- | --- |
| F17-STREAM-01 长会话流式吸底与滚动记忆回归 | 既有 `conversation-session-v4-scroll.test.ts`（SRM01-SRM04 已 covered） | 复用，每步回归 |
| F17-PREPEND-02 历史前插锚点回归 | 既有 HLP01-HLP02 正式 E2E | 复用，②③ 步回归 |
| F17-RESIZE-03 resize/批量测高行为 | 既有 SRM10 浏览器回归 conversation-timeline-resize.test.mjs | 复用，④ 步回归 |
| F17-LOCATE-04 跳转定位完整显示与屏外挂载（overscan 收紧后目标轮完整、滚动边界不回退） | 浏览器 harness 本身断言（M3）+ 桌面草案 `packages/desktop/test/e2e/conversation-session/manual-review/pending/`（lifecycle pending 入口） | 待 ③ 步登记；桌面用例文件在本卡落点（packages/ui、docs）之外，登记时由 controller 扩卡或另行分配 |
| F17-FIND-05 长会话查找跳转高亮与运行中更新 | 桌面草案对齐 coverage matrix `session-find-highlight`（W01-W06，planned） | 待 ⑤ 步登记；同上受落点限制 |

本卡落点为 `packages/ui/src`、`packages/ui/test`、`docs`；桌面 E2E 用例的物理文件与 coverage
matrix 登记不在落点内，上表已列明对应入口与缺口，实际登记在对应步骤完成（见各步汇报）。

## 远控边界

本改动只影响 UI 层渲染，不改变 ZCode task 消息流、snapshot、queue 或恢复语义：

- 桌面端 `desktop-continuous` 仍保持 direct continuous 主链路。
- 手机远控 `web-remote-replayable` 仍通过 replayable snapshot/gap 恢复边界展示消息。
- 远控全量历史仍由显式加载控制，不因虚拟滚动重新触发隐式全量快照传输。
