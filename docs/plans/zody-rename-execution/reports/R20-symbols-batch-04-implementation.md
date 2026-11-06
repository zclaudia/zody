# R20.4 batch04 实施与验证

基线 `3cb3a0050fb47771305fe084852fc6aed994eb92`。独占产品源码及构建写锁下，先按 architecture-governance 执行 baseline（exit 0）和 services context（exit 0）。以固定提交重建 3,873 项输入，重新解析 600 条记录；相对 7c，五个 R10 测试变化未引入绑定、未解析引用或分类变化（`output/zody-rename-r20-symbols/batch-04/final-3cb/checker-delta.json`）。应用完整联合 patch：565 条可绑定记录及 27 条人工闭合记录，8 条此前已迁移；695 个产品文件。声明 old/new、位置和引用清单见同目录 `bc-bindings.json`；文件和最终 SHA 见 `final-candidate-audit.json`，超授权和 manual151 冲突均为零。

三个 DI interface/const 与动态函数注入键、动态 import 解构一并改名，保留原 ServiceChannels 和 channel 字符串；Desktop 缺失的类型重导出在 services 公共入口增加，仍只有原始类型定义。R10 同行核查后单独修正已授权 dev-docs 文件两个 source fragment，指向实际声明 `packages/shared/src/zody-protocol-legacy-types.ts:259,446`。原补丁该文件 SHA-256 `13a5a8996344865dc48332462350b26c3051d1001fa17fc1864308b0308bfd6b`，追加修正后 `74755b2c4cd06caaff81675724621b160a2cb1011277fadafb884b618599374a`；其余 694 个产品文件均与联合 patch 预期逐字节一致。

以下命令 cwd 均为工作区根，完整 argv、输出与退出码在 `output/zody-rename-r20-symbols/batch-04/final-3cb/` 对应日志：

- `pnpm typecheck` exit 0；`pnpm lint` exit 0，303 warnings。
- `pnpm --dir apps/zody-cli build --force` exit 0，23/23 tasks、0 cached；`pnpm --dir apps/zody-cli typecheck --force` exit 0，34/34 tasks、0 cached。services 和 shared 实际生成声明包含新类型与 DI export，bootstrap 生成声明引用新协议类型；未添加旧别名。
- 根 168 个受改测试文件通过 1,914 项，精确文件与完整命令为 `root-changed-tests.json` 和 `root-changed-tests.log`；DI、协议和注入专项另 7 文件 99 项通过（`target-root-tests.log`）。
- CLI bootstrap 6 文件 45 项通过（含 R10 修复的四个路径测试），CLI node:test 2 文件 176 项通过，dev-docs 7 文件 18 项通过；对应 `cli-bootstrap-tests.log`、`cli-node-tests.log`、`dev-docs-tests.log`。
- Desktop Main 单独 `pnpm exec tsc -b packages/desktop/tsconfig.main.json` exit 2，85 条诊断；与已独立复现的基线规范化比较一致：类型名按本批改名映射，字符串字面量联合类型与 ArrayBuffer 联合类型顺序归一，见 `main-tsc.log`、`main-comparison.json`。这是失败的独立检查，根 typecheck 不覆盖该 main 项目。
- `pnpm architecture:check --changed` exit 1：`packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts` 既有 404 行超过 400 限制。该文件在基线同为 404 行，按本批声明名归一后内容完全一致（`architecture-baseline-proof.json`）；本批保留原布局，不将该检查写为通过。

本批没有更新总账或迁移 ledger。其余运行时内部符号、后续阶段协议/环境值仍由后续批处理；上述范围与验证不声称整体改名已完成。
