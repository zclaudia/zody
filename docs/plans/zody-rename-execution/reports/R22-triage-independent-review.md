# Independent failure attribution review

DeepSeek A, route deepseek-flash. Raw scoped receipt below; review accepts the bounded attribution record, not full R22 completion. Its old missing-dist and parser rows refer to earlier snapshots. Later71e two-file7/7 evidence is in R22-four-target-build-smoke-71e.md; grouped-parser corrections and current eight single cases are in R22-watcher-single-case-diagnostics.md. None closes all root causes or the original full-suite failure.

**结论**
`scoped PASS`：R22 failure triage 的结论在现有证据范围内成立——它把 8 个有效单例、同错误基线、未归因项和全量失败明确分开，没有把定向绿测或“同错误”冒充 fullsuite/全部 baseline。R22 全量仍未通过，不能据此判 R22 完成。

**独立核验**
- `results-selected.json` 共 8 次（4 case × 7c/71e），每次 `1 failed | 27 skipped`、exit 1；rename/disable/enable 均为 ready 但 `profiles: []`，empty-root 为 ready/empty 而非 `built-in-fallback`。逐对提取 AssertionError、diff、测试栈后，4 对正文逐字一致（`subagentRuntimeConfigWatcher.test.ts:48`）。
- 首轮 `run.mjs` 使用 `^native subagent Host watchers > <case>$` 锚定选择器，8 次均 `28 skipped`、执行 0 test、exit 0；`results.json` 原样保留，未计通过。有效 `run-selected.mjs` 每次明确选中 1 个测试。
- `5bd→71e` 只有 docs/ledger/inventory 变化，`71e→1262e` 只有 docs/report；无代码差异。关键六文件中 `subagentConfigScope.ts`、`subagentRuntimeConfig.ts`、测试文件字节相同；`subagentStorage.ts`、`subagents.ts`、`subagentsService.ts` 仅差 `resolveZCodeStorageRoot→resolveZodyStorageRoot` 和 `ZCodeProvider→ZodyProvider`，独立归一化后逐字相同。该比较只覆盖六文件，不等于完整依赖链/时序等价。
- `grouped-comparison.json` 与原始 plain log 一致：candidate 的 disable/plugin 共用一段断言，ancestor 的 delete/disable/plugin 共用一段；delete、disable、plugin、shared recovery 的同断言成立。rename candidate timeout、ancestor 初始 researcher 缺失；enable 两侧状态不同；recreation/user-scan 不同。分组解析纠正了原 `case-comparison.json` 的共享块误解析，但只证明断言文本相同，不证明各 case 独立输出、同根因或已修复。
- `case-comparison.json` 计数可复核：42 行，30 条 fullDetailEqual，2 条同首错但详情不完整，3 条详情未成功提取，3 条首错不同，4 条祖先无同名 FAIL。示例 `providerModelMetadataDialog`、`remoteAccessSettingsSection`、`mobileRemoteGatewayTerminalTransport` 的完整失败详情与祖先一致。
- 临时诊断是 service-level 观察，不是 gate：`diagnostic.mjs` 实际创建两个 `createSubagentsService`（与原测试 pair 相同），写入 56 字节文件；当前约 514ms 写入、8525ms 仍空、9527ms 可见；7c 约 513ms 写入、10530ms 仍空。native `fs.watch` 旁观者会改变调度：当前无回调和空快照，7c 约 2135ms 回调、4519ms 可见。每侧仅一次、无内部 ready/revision 插桩，不能据此断根因。

**归因**
有合理既有表现证据、但仅限具体现象：
- 30 条 fullDetailEqual（含上述三个示例）可视为同一失败表现的重复观测；其中部分引用了已变更源码或测试文件，不能据此判“全部 baseline”或“无改名影响”。
- watcher 4 个单例的同断言失败，加上六文件有限等价，为这些单例现象提供合理基线证据；empty-root 仍随运行阶段波动，不能判稳定祖先通过。
- grouped delete/disable/plugin/shared recovery 同断言；`hookCreateButtonSize` 测试正则仍要求 `className="rounded-lg"`，实际源码为 `cn("rounded-lg", …)`，两侧同断言不符，不能扩大到按钮视觉语义。
- `stopDesktopStopVisualBuild` 两侧同在 `.../cua-macos-visual/native/CuaVisualCapture.swift` 因 ENOENT 失败，属冻结输入/R60 范围，未验证 native 行为。
- 缺 dist 的 `storagePreparationProtocol`/`macosCuaHelperRound11Authority` 在 edb 当前源码构建后 7/7 通过；这是构建前置证据，不代表 5bd/最终树 clean gate 已完成。

仍未归因：
- Gen UI `stateStorage` 原批量 30s timeout、7c 23.76s pass、独立 3/3 pass（2.38s）；`state-single.log` 的 RUN 路径是 `final-clean-4fac2fb0`，但该 worktree 实际 HEAD 是 `ad859…`，不是 5bd/71e。stateStorage 源码/测试 SHA 在 7c/ad859/5bd/71e/4fac 相同，但这不是 5bd/71e 树上的复跑，仍不能归因。
- watcher 的 rename/disable/enable timeout/状态差异、recreation、user-scan timeout、3 条详情未提取、2 条同首错不同详情（recreation、hook 的全文差异）、4 条祖先无同名 FAIL（stateStorage、storagePreparation、macosCuaHelper、empty-root）均未完成根因闭环。
- native 实际行为、UI 视觉语义、原始 34 文件/104 测试失败及全部 baseline 均未判定；R22 fullsuite 仍红。

**非阻断记录问题**
- `R22-remaining-triage-5bdc.md`/`cases.json` 仍写“原四项没有祖先同名 FAIL”和“5bd 定向 empty-root pass”；较新的单例报告显示 7c/71e 都 fail 并明确称其为波动。旧报告是其时点记录，若作为最终台账应补交叉引用，不能单独读成 ancestor stable pass。
- `state-single.log` 的目录名与实际 HEAD 不一致；报告应记录实际 tree/HEAD，避免“候选 3/3”被误读为 5bd/71e。
- 8 个单例在主树 71e 上串行执行，candidate 运行期间有 docs/ledger 状态变化；两侧使用既有依赖/dist，非完整 environment parity。同错误正文和六文件等价仍支持有限基线结论，但不是干净室证明。
- 后续 71e CLI23 重建及 2 文件 7/7、R10 四目标构建未纳入旧报告；它们只能补强缺 dist 的构建前置解释，不能关闭旧 R22/全量 gate。我未触碰 R10 验证树，也未重跑测试或构建。
