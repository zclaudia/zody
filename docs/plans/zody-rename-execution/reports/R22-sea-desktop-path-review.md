**结论：scoped PASS**

在固定范围内，R22 中 SEA TUI 加载路径与 Desktop workspace 包排除范围的修正，没有发现会造成实质回归的问题；该结论不表示 R22、SEA 真实打包或 Desktop 发行构建通过。

**核查范围与证据**
- 固定的 base 与 candidate 及其 tree 均一致：候选 `f0b8db60…` 的 tree 为 `fddf8738…`；diff 为 10 个文件，其中产品/测试/spec 6 个，报告/账本 4 个，没有越界。
- 按 `output/zody-rename-r22/sea-rename-fix/file-hashes.json` 对 6 个文件在 base 与 candidate 上的 SHA-256 审核，结果为 6/6 一致；`git diff --check` 通过。
- SEA 加载器改为 `node_modules/@zody/tui/dist/index.js`（`apps/zody-cli/packages/cli/src/tui-runtime-loader.ts:33`），与收集器的 workspace 查找及默认放置路径一致（`apps/zody-cli/packages/cli/scripts/sea-tui-assets.mjs:128`、`:160`）。由于 `placeRuntimePackage` 的根资产路径始终是 `node_modules/<packageName>`，旧加载器确实会报 `ERR_MODULE_NOT_FOUND`；`red.log`/`green.log` 记录了这个实际失败与修复后通过。
- 新行为测试实际调用 `placeRuntimePackage` 和 `loadTuiRuntime`，并在隔离子进程内模拟 SEA host API（`apps/zody-cli/packages/cli/tests/build-sea.test.mjs:1299` 起）；它验证的是 resolver 与 loader 的路径联动，并不等价于真实构建出的 SEA。
- Desktop 仅把 `!node_modules/@zcode/**` 改为 `!node_modules/@zody/**`（`packages/desktop/electron-builder.config.js:642`），保留原有排除范围；测试读取实际 builder config 与当前 manifest，校验 10 个 `workspace:` 依赖均被排除（`packages/desktop/test/electronBuilderLinuxPackageTargets.test.ts:70` 起）。红测为旧 glob 漏掉 10 个包，绿测 8/8。
- `desktop-scope-comparison.json` 显示旧/新 10 个依赖逐项映射、无缺失/新增；controller `results.json` 记录六哈希及 loader、Desktop、typecheck、lint、changed architecture 均 exit 0。
- edb 前置证据真实存在：typecheck exit 0 生成 shared dist；collector 5316 项资产/1377 项 shared；manifest `src→dist` 重写；25/25 export 解析目标存在（`output/zody-rename-r22/edb-shared-prerequisite/`）。报告明确未修改 shared 设计，也未声称完整 SEA 构建通过。

**未验证边界**
- 未执行真实 SEA 二进制构建/启动，未执行真实 Desktop 打包；Desktop 测试只覆盖配置与 manifest 的排除关系。
- `strict 19`、最终发行、R60/R61 及全 R22 验收不在本批结论内；report 与 ledger 也没有把本批写成整体通过。

**非阻断观察**
- 个别旧品牌注释仍留在相关文件中：`sea-tui-assets.mjs:121`、`electron-builder.config.js:959`、`packages/desktop/tsup.config.ts:340`；均为注释/历史说明，不影响本次行为。
- 新测试的 `sea.getAsset` 忽略 key（`build-sea.test.mjs:1340`），说明它验证 loader 的资产布局而非 SEA API 的 key 路由；报告已限定该测试性质。
