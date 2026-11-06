**结论：scoped PASS**（native single-input + evidence；不是完整 generation/install/strict 通过）

**固定对象**
- `8dfd3615410d763631b5646056ed83fc02aca2bf` → `ff395c6b3a9b317d52273a52a991db83948ba180`，父提交精确匹配，候选 tree `55bd59db7f1f5e0dd22fdaf2c100fa9773ac2fd3`。
- 11 文件：唯一产品输入为 `third-party/native-search/sources.json`；其余 10 个为 ledger/report/metadata。没有产品代码、配置、归档或许可文件的其他变更。
- 仅使用固定 git objects、现有日志/JSON；未执行 build/install/UI/写操作，也未使用当前 4fac 工作树作为候选。

**Native input**
- `third-party/native-search/sources.json:10` 只把 `scripts/native-search-tools-config.mjs` 的指纹从 `06e9d2...` 改为 `2efb3f...`；`scripts/native-search-tools-config.mjs` 在 8df 和 ff 的实际 SHA-256 都是 `2efb3f...`，新值匹配；反向替换后 sources JSON 与 8df 完全一致。
- `033f→8df` 的 native 配置变化仅为 `scripts/native-search-tools-config.mjs:11` 的本地目录 `apps/zcode-cli/dependencies/native-search` → `apps/zody-cli/dependencies/native-search`。18 个 archive 的 SHA-256 全部匹配 `sources.json`，旧/新路径字节逐项一致；`third-party/native-search`、`third-party/upstream` 在该区间无 diff，版本、来源、归档 pin 和许可原文未变。
- `output/native-input-preflight.json` 的 637 个 guard 检查中只有该 native input 为 mismatch，其余 636 个匹配；ff 修正后 expected SHA 已等于实际脚本 SHA。
- `output/zody-rename-validation/native-license-input/tests.log` 显示 Node 许可测试 11/11 通过、0 失败。这里与 `license-check-independent.exit=1` 是两个不同检查：后者是 `apps/dev-docs/package.json` 的旧 inventory input 失败，不是这 11 个测试失败。
- `output/zody-rename-r21/final-validation-8dfd3615` 证据：install exit 0，50 members/92 links，`links-and-bins.json` errors 为空，lock SHA `12e11b...` 与 7c 基线一致；notices generation exit 1 停在 native guard，before/after notices 与 inventory 哈希均未变；4 个 workspace bin 仍 pending。该报告明确没有声称 generation/check/strict 通过。

**图计数更正**
- `R21-graph-path-closure-implementation.md:16-18` 已把固定 b867 的旧路径计数更正为 27；`references-b867.txt` 为 27 行，`remaining-old-classified-b867.json` 为 27 行且与实际 `git grep` 集合完全一致；旧的 `file-assignments.json:15180` 误行已移除，保留真实 `:15189`，两个 R21 评审引文归类为 `review-doc-quote`。
- 原始 26 行 `remaining-old-classified.json`、`remaining-old-references.txt` 和原始评审收据均保留；新的 26→27 更正没有覆盖历史快照。

**未完成边界**
- 8df 的 notices generation 和独立 basic check 仍 exit 1，不能写成许可生成通过；新的完整 frozen candidate 的 generation/check/strict 尚未执行。
- 4 个 dist bin 仍 pending；完整 R21/R22、最终安装与发行门禁未验证。本次没有新的 native input 阻断项。
