# Conversation Timeline 性能基线记录（F17）

> F17「会话时间线分区渲染与查找改进」（上游 v3.17.1，来源 commit `a60ba6a7`）的性能基线记录文件。
> 指标定义与分步移植验收规则见 [chat-virtual-scroll.md](./chat-virtual-scroll.md) 的
> 「分区渲染与查找改进（F17）」章节。本文件只追加带日期的测量记录，不覆写历史记录。

## 测量环境口径

| 项 | 值 |
| --- | --- |
| 机器 | Apple M2 Max，macOS 26.6.2（arm64） |
| Node | v24.14.0（`mise.toml` 指定版本，经 fnm 安装路径执行） |
| 浏览器 | Google Chrome 156.0.8078.80（playwright-core `channel: "chrome"`，headless） |
| 视口 | 1250×800（桌面默认，与 SRM10 resize harness 一致） |
| 命令 | `node --test packages/ui/test/browser/manual-review/pending/conversation-timeline-perf-baseline.test.mjs`（默认 120 帧、replace 模式） |

## 2026-11-07 基线（分区/overscan/测量 revision/查找四步移植前）

- 工作区：`main` @ `fc99cde5`（upstream-v3.17.1 第二梯队开工点），F17 未做任何实现改动。
- 3 轮（`final1`/`final2`/`final3`）连续运行，每轮 5/5 用例通过（含行为断言）；
  每轮产物 JSON 落在 `packages/desktop/.e2e-artifacts/conversation-timeline-perf-baseline/baseline-final*.json`（gitignored 运行时证据）。

### M1 流式每帧成本（replace 口径：尾轮等长替换，隔离历史规模变量）

| 历史规模 | p50（ms，三轮） | p50 中位数 | p95 中位数 | 增长比 p50(3003rows)/p50(153rows) |
| --- | --- | --- | --- | --- |
| 50 轮 / 153 行 | 9.4 / 9.2 / 9.4 | 9.4 | 29.9 | — |
| 500 轮 / 1503 行 | 17.3 / 17.1 / 17.0 | 17.1 | 43.0 | — |
| 1000 轮 / 3003 行 | 23.4 / 25.2 / 23.4 | 23.4 | 50.5 | 2.49（三轮 2.49/2.74/2.49） |

说明：固定项（尾轮 markdown 重渲染 + 框架调度）≈ 9.4ms，历史段每帧派生成本 ≈ 14.0ms @3003 行——
即 `buildConversationTurnRenderUnits` 全 rows 指纹扫描、`turnNavigatorQueryRowIds`/`hasRunningUnit`
全 units 扫描等 O(N) 派生的合计。F17 分区步合入后该增量应显著收敛（growth 向 1.x 收敛）。

### M2 初始挂载（1500 终态轮 / 4503 行，吸底挂载）

| 指标 | final1 | final2 | final3 |
| --- | --- | --- | --- |
| mountMs（goto→稳定整页墙钟，含 vite 首转，仅同机同 harness 前后对比用） | 3328 | 3536 | 3203 |
| historyTurnUnits（虚拟历史内已挂载 turn 单元） | 9 | 9 | 9 |
| mountedTurnUnits（含 live tail） | 10 | 10 | 10 |
| historyElements（虚拟历史 DOM 元素总数） | 486 | 486 | 486 |

### M3 定位跳转挂载量（500 轮，底部 → unit 250）

| 指标 | 三轮值 |
| --- | --- |
| historyTurnUnits | 18 / 18 / 18 |
| historyElements | 972 / 972 / 972 |
| mountedTurnUnits | 19 / 19 / 19 |

确定性计数（三轮零波动）。当前 `ROW_OVERSCAN = 8`（`ConversationTimeline.tsx:107`）；
overscan 步（8→2）后预期 historyTurnUnits 从 18 降到 ~10–12、historyElements 相应下降约 1/3。

### M4 查找激活时的流式成本（500 轮，query 命中全部历史轮，每轮 2 处命中 ≈ 1002 命中）

| 指标 | final1 | final2 | final3 |
| --- | --- | --- | --- |
| p50（ms） | 17.2 | 17.0 | 17.2 |
| p95（ms） | 44.2 | 41.5 | 42.1 |

对照同规模无查找流式 p50 中位数 17.1：查找索引每帧合并的实测增量 ≈ +0.1ms（噪声级）——现有
unit 级缓存（`useConversationTimelineFind.ts`，稳定 unit 命中 string-key Map）已把逐 unit 重建
成本吸收，剩余成本是逐 unit key 拼接 + matches 数组重建 O(matchCount)，1002 命中时 <1ms。
结论：M4 在本机 500 轮规模下对「查找分区缓存」的墙钟敏感度有限，⑤ 步的验收以代码级分区
缓存测试为主、M4 不回退为辅；更大命中规模（如多命中/行）未单独建档。

### 行为断言（随每轮基线一起执行，三轮全部通过）

- 1500 轮初始挂载后 `following=true` 且 gap ≤ 1px（吸底正确）。
- 三档规模流式 120 帧后 `following=true` 且 gap ≤ 2px（流式不丢吸底）。
- 定位跳转后 `following=false`、目标行 `[data-row-id]` 已挂载（定位型滚动离底 + 窗口覆盖目标）。
- 查找激活自动定位到首个命中（定位型滚动，符合 spec「搜索、轮次定位…都属于定位型滚动」）。
- 全程无页面错误（`pageerror` 与 `window.__timelineErrors` 均为空）。

### 已知噪声与口径限定

- mountMs 含 vite dev server 首次模块转换（首轮偏高），只用于同机同 harness 的前后对比，不跨机器比较。
- 墙钟中位数记录趋势用，不做 CI pass/fail 门禁（与 coverage matrix PERF03 口径一致）；harness 内
  仅保留远高于预期的 sanity 上限（p95 < 250ms）拦截环境损坏。
- append 模式（真实文本增长）作为可选交叉验证（`F17_BASELINE_STREAM_MODE=append`）：尾轮渲染成本
  随帧增长会稀释 growth 信号（120 帧时 growth ≈1.25），故 M1 主口径采用 replace。

## 2026-11-07 步骤②复测（冻结历史 + 尾轮分区合入后）

- 实现内容：`getConversationRowsPartition`/`memoizeByRows`/`advanceConversationRowsPartition`
  （含 store delta 路径登记）、render units 分区选择器、插件 UI 推导/目录 Set 分区缓存、
  timeline 接线（来源 a60ba6a7，适配见 spec「步骤②契约」）。
- 口径校准：fixture 流式驱动补上与生产一致的 `advanceConversationRowsPartition` 登记
  （基线步分区函数不存在，两阶段 fixture 行为分别对应当时生产的 rows 产出语义，对比口径一致）。
- 3 轮（`part1`/`part2`/`part3`）均 5/5 通过（含全部行为断言）。

### M1 流式每帧成本（replace 口径）

| 历史规模 | p50（ms，三轮） | p50 中位数 | 对比基线 | p95 中位数（基线） |
| --- | --- | --- | --- | --- |
| 50 轮 / 153 行 | 8.8 / 9.0 / 9.1 | 9.0 | ≈持平（9.4） | 29.3（29.9） |
| 500 轮 / 1503 行 | 12.5 / 12.6 / 12.3 | 12.5 | −27%（17.1） | 38.3（43.0） |
| 1000 轮 / 3003 行 | 14.8 / 13.9 / 13.5 | 13.9 | −41%（23.4） | 40.4（50.5） |

- growth = p50(3003)/p50(153)：三轮 1.68/1.54/1.48，中位数 **1.54**（基线 2.49）。
- 历史规模每帧增量：基线 ≈14.0ms @3003 行 → 本步 ≈4.9ms（−65%）。
- 残余 ~4.9ms 的历史规模项与步骤⑤对位：`useConversationTimelineFind` 仍按扁平 renderUnits
  每帧全 units 合并（查找分区缓存是⑤的目标）；另 renderUnits 扁平拼接为 O(N) memcpy（可忽略）。

### M2/M3/M4

- M2 mount：3094/3318/3812ms，中位数 3318（基线 3328）——持平，无回退；historyTurnUnits 9 不变。
- M3 跳转挂载：18 units / 972 elements / 19 mounted（三轮零波动）——与基线一致；该项归步骤③ overscan。
- M4 查找激活流式 p50：12.8/12.0/12.1，中位数 12.1（基线 17.2）——作为分区副产物改善，
  查找索引分区缓存（步骤⑤）合入后继续复测。

### 结论

- 基线无回退（M1 显著改善、M2/M3/M4 持平或改善）；按 spec 步骤表，growth 未完全到 1.x 的
  残余量已定位到步骤⑤的查找合并路径，不在本步扩大范围。
