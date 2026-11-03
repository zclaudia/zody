# R21 内部 domain reference 路径闭合

基线 `b867ad3d359d3219b0a111c8e9b2911ea172b096`。将 `.agents/skills/feature-boundary-planner/references/zcode-domain-cross-products.md` 原字节移动为同目录 `zody-domain-cross-products.md`，并将 `.agents/skills/feature-boundary-planner/SKILL.md:32` 的唯一现行读取引用同步。两个内容文件的 SHA-256：

| 文件                                | 修改前                                                             | 修改后                                                             |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| domain reference（旧路径 → 新路径） | `ebe9fc4d1f2d594d543a26d2a919e4a88b46d5644fa016efc3f691edd6b165e9` | `ebe9fc4d1f2d594d543a26d2a919e4a88b46d5644fa016efc3f691edd6b165e9` |
| `SKILL.md`                          | `86bdef89f1a5828f3eafa9f09b23590f545a6fdd8793f6cd348392ef67622428` | `f0d85bfe69e7ebaae83f2051b92a179d2473387945a19ad7787e52e92b58aa29` |

`manifest.json`、`r20-authorized-scope.json` 的独立 `r21DomainReferencePathClosure` 记录 old/new/消费者和授权；`file-assignments.json` 的 R21 当前 writeSet 将旧参考文件路径换成新路径。原 `r21GraphPathClosure.consumerPaths` 保留当时记录的旧路径并注明后续独立迁移，避免重写历史证据。没有修改 ledger。

预检目标不存在且同目录 casefold 碰撞为零；移动后旧路径不存在、新路径存在、唯一现行引用解析到新文件；`.agents/skills` 下不再有 basename 包含 `zcode` 的路径。前后记录见 `output/zody-rename-r21/domain-reference/{before,after}.json`。产品插件 `zcode-configuration-guide` 的公开技能名、manifest 和 seed 属 R54/R56 身份兼容范围，本次没有改动。

`pnpm exec oxfmt --check .agents/skills/feature-boundary-planner/SKILL.md` 退出 0；`git diff --check` 退出 0。三个元数据 JSON 的 `oxfmt --check` 退出 1；对 HEAD 原始三文件的同一检查也各报告格式问题（`metadata-format-check.log`、`metadata-baseline-format.log`），没有为此重排大型历史清单。可选的执行计划格式检查同样在 HEAD 基线失败，因而没有改该计划；两次日志保留。文档路径变更复用上一 graph 路径批次实际执行的根 typecheck/lint/changed architecture 退出 0 证据，见 [graph 实施报告](R21-graph-path-closure-implementation.md)；本次未重复构建或测试，也未安装。当前候选待主控核对和独立审查，不代表 R21/R22 已完成。
