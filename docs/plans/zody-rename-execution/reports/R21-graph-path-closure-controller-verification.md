# R21 graph 路径主控复核

基线 `70366cdc774b5cb96fc2f7f6c57e17046d4a19a8`。主控独立核对10个 before/after SHA，图原字节完全一致，九个消费者与基线仅有精确 `zcode-feature-graph.yaml` → `zody-feature-graph.yaml` 替换。授权 manifest、scope 和 R21 assignment 的 diff 已审查；readSet 使用新活跃路径，old/new 映射保留删除来源。主控根 cwd 使用 Node24.14.0，实际执行 `pnpm --dir apps/dev-docs exec vitest run --config vitest.config.ts test/featureBoundaryGraph.test.ts`，4/4、退出0。证据在 `output/zody-rename-validation/graph-path/`。

本批根 typecheck/lint、changed架构及devdocs build实际执行者是Terra，均退出0，lint303warnings；主控未重复这些检查，不声明全量架构通过。当前图语义缺口、完整候选安装、paired notices和R22另验。本次仅路径收口，待固定SHA独立复审。
