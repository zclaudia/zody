# R20 launch 文档尾项：独立验收与清理

基线 `371acd17f4ffa49a3f6706668f177c10e8a4d60e`，仅 launch 文档和实施报告由 Terra 改写。DeepSeek Broker `deepseek-flash`（`magpie/group/deepseek`，agent `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a46c-fb33-7720-8cee-047c7ae90cb1`）只读审查结论为 scoped accept，无阻断文案或范围问题。

最终源清单 SHA-256 `d91114271b0424c0b8aae258a81644feaab85bd0c4897464f770230965dd79f0`，两路径匹配。固定基线 29 处旧名已逐项分类：24 处现行引用更正、五处实际持久 sentinel 保留；最终七处旧名为五处 sentinel 与两处明确的 legacy 项目读取/监听说明。更正包括源码路径、CLI bin、包名/服务名、产品 flavor、实际 UI 引文、新写目录及查找/监听语义。没有全篇重排、产品改动或对已验收 single-executable 段的改写。

freshness 与 diff check 实际退出 0。产品树与 371 保持一致，沿用该源码的 typecheck/lint/architecture 成功证据；本轮没有重新执行产品测试或构建，不把复用证据表述为新运行。保留 sentinel 是对当前 producer/parser 的真实描述，不是全量改名永久豁免；其后续值级策略另有预案。

本阶段清理只使用 `rmdir` 删除 `/tmp/zr20launch` 的六个空子目录与根，0 文件、0 逻辑字节；没有可清理的重复依赖或构建副本。主控独立后核两条源码与 17 项证据全部匹配、根已不存在，0 错误。可用空间观测减少 8,192 字节属于 APFS 并发变化，不能称为释放空间。执行与核验位于 `output/zody-rename-r20-launch-doc/controller/cleanup-empty-*` 和 `post-cleanup-verification.json`。必要 worktree、分支、既有依赖和有效产物未被操作。

本批完成这一现行文档尾项，不代表完整 R20、全量改名或发行验收完成。
