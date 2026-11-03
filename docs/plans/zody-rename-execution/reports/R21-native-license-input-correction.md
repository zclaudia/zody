# R21 native 许可输入指纹修正

冻结 8dfd3615 的首次完整根安装退出 0；notices 生成退出 1，拒绝过期 `scripts/native-search-tools-config.mjs` 输入指纹。主控重新核对 92 条本地链接、根锁 SHA 和 before/after notices/inventory，确认安装有效、生成未改写两文件；4 个指向 dist 的 workspace bin 仍待实际构建。证据在 `output/zody-rename-r21/final-validation-8dfd3615/controller-verification.json`。

主控独立比较祖先 033f 与当前配置：差异仅 `apps/zcode-cli/dependencies/native-search` → `apps/zody-cli/dependencies/native-search`。`third-party/native-search`、`third-party/upstream` 在该区间无差异；版本、URL、归档 hash 和许可原文未改变。授权只更新 `third-party/native-search/sources.json` 的 `inputs["scripts/native-search-tools-config.mjs"]`：`06e9d2b066a22f4bb731fb7356d786b52cf08e20dd6faf91e1a82b167d7462e8` → `2efb3f3aade0205b400b990b8a7dda3ce3437b568008d508e8c16465c5254078`。复原该值后整个 JSON 与基线完全一致；未放松生成器守卫。

主控在实现工作树根使用 Node24.14.0 实际运行 `node --test scripts/third-party-notices.test.mjs scripts/test/third-party-npm-platform.test.mjs`，11/11、退出 0，日志位于 `output/zody-rename-validation/native-license-input/tests.log`。这是输入收据修正，未改产品行为；根 typecheck/lint 由随后当前文字纠正批实际执行并记录，不在此重复声明新结果。

Terra 另对冻结 8df 只读核验其他生成输入守卫：另一 native input、371 native notices、2 Node licenses、4 embedded build evidence、34 embedded notices、11 copied licenses、148 modified-file markers、65 有文件的 npm overrides 均匹配；记录 `output/native-input-preflight.json`。该核验不替代新完整冻结候选上的实际生成、成对整合、check 和 strict；8df 失败原始证据保留。
