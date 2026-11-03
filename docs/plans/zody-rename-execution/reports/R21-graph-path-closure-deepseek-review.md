**结论：scoped PASS**（仅 R21 graph resource basename move；附 1 项非阻断证据修正）

**固定对象与范围**
- 基 `70366cdc774b5cb96fc2f7f6c57e17046d4a19a8` → 候选 `b867ad3d359d3219b0a111c8e9b2911ea172b096`，父提交精确匹配，tree `2e655820bc9767103e8709baec5d2ef831b15bf2`。
- 18 文件：1 个 `R100` 图移动、9 个活跃消费者、8 个 ledger/report/plan 文件。仅读取固定 git objects、日志和 JSON；未执行 build/install/UI/写操作。

**已验证**
- 图文件为 `R100` 重命名，旧路径已不存在、新路径存在；移动前后 SHA-256 均为 `9bafa947d1a360e7db93a0d6d32a431841c02ef082ed85b1bc333265e56d08c4`，无大小写折叠碰撞，节点、边、ID 及 `graphId` 未变。
- 9 个消费者共 16 处精确替换。对每个文件把新路径还原为旧路径后，候选内容与基提交逐字节相同；旧路径出现 0 次，新路径计数为 `3/3/3/1/2/1/1/1/1`。
- `move-audit.json` 的 10 个 before/after SHA 已逐项用固定 git 对象复算，20/20 一致；`consumer-check.json` 的 `allPass`、旧文件缺失、新文件存在均成立。
- `manifest.json`、`file-assignments.json`、`r20-authorized-scope.json` 的 `consumerPaths` 完全一致，均为上述 9 个消费者；R21 `readSet` 使用新路径，old/new 映射保留删除来源；三份 JSON 均可解析。
- 候选中的旧路径共 27 处，但全部位于 ledger、历史计划/调查、历史评审、冻结 native 证据或本次评审报告引文中；没有活跃 code/test/config/current-doc 消费者。`virtual:zcode-feature-boundary-graph` 和 `graphId: "zcode-feature-relationships"` 不属于本次 YAML basename 移动，且后者保持原值符合“无语义变化”要求。
- `R20-runtime-closure-preflight.md` 为固定 a8 的历史归档，未描述当前产品 patch 或 graph 路径；`task-ledger.md` 已刷新当前候选和 R21 状态，未宣称完整 R21/P2 通过。
- 记录证据：graph 测试 4/4 exit 0，dev-docs build exit 0，typecheck/lint/exit 0（303 warnings、0 errors），changed architecture exit 0；我未重跑这些命令，且没有全量 architecture 或最终安装结论。

**非阻断证据修正**
- `remaining-old-classified.json` 声称 26 行，但候选实际 `git grep` 为 27 行；其中 `docs/plans/zody-rename-execution/file-assignments.json:15180` 在当前候选已指向新路径，真实旧路径位置是 `:15189`，该行是基提交行号的误用。
- 本次新增的 `R21-graph-path-closure-implementation.md:3` 与 `R21-graph-path-closure-controller-verification.md:3` 各有一处旧路径引文，未计入该分类文件。
- 最小修正：从固定 `b867ad3d...` 重新生成分类，移除或改指 `file-assignments.json:15180`，并把上述两处评审引文标为 `review-doc-quote`（或明确排除）；同步把 implementation report 的“26 行”改为实际统计。该问题只影响证据计数，不影响活跃路径闭合，也不改变本次 scoped PASS。

**未覆盖**
完整 R21/R22、最终 clean install、paired notices、全量 architecture 仍未验证；本结论只覆盖本次图路径 move 和 9 个精确消费者。
