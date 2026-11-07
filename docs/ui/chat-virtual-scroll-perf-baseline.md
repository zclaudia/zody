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
