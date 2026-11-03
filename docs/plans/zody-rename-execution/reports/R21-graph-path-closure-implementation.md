# R21 feature graph 自身路径闭合

基线 `70366cdc774b5cb96fc2f7f6c57e17046d4a19a8`。先在执行方案、`manifest.json`、`file-assignments.json` R21 与 `r20-authorized-scope.json` 登记图路径及九个现行消费者；旧路径的 R20 保护和图语义禁改不解除。将 `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` 移至同目录 `zody-feature-graph.yaml`；移动前后 SHA-256 均 `9bafa947d1a360e7db93a0d6d32a431841c02ef082ed85b1bc333265e56d08c4`，逐字节一致，因此本次 move 未改变节点、边、ID 或其他内容。目标大小写折叠冲突为零。图与九个消费者共 10 个旧/新路径的 before/after SHA 和每文件替换数见 `output/zody-rename-r21/graph-path-closure/move-audit.json`；9 个消费者共改 16 处精确路径。

九个活跃消费者的旧路径均为 0、新路径均存在，Markdown 相对链接解析到新图；检查结果见 `consumer-check.json`。临时检查第一次使用过窄的正则导致诊断脚本自身 AssertionError，修正匹配裸相对文件名后检查通过；未以第一次失败证明产品有断链。全 tracked 旧名命中 26 行，逐行分类在 `remaining-old-classified.json`：执行合同/旧保护 scope 的旧→新记录、历史报告/调查、历史计划与冻结资料；带日期设计材料如重新启用须重新审查，不作为活跃读取者静默放过。图文件旧路径已不存在、新路径存在，历史记录不机械改写。

工作树根 cwd、pinned Node 24.14.0：

- `node scripts/check-workspace-freshness.mjs` 退出 0；修改前 `pnpm architecture:check --changed` 退出 0。
- `pnpm --dir apps/dev-docs exec vitest run --config vitest.config.ts test/featureBoundaryGraph.test.ts` 退出 0，4/4 测试通过（`graph-test.log`）。
- `pnpm --dir apps/dev-docs build` 退出 0（`devdocs-build.log`），验证 Vite 对新图路径的实际读取。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均退出 0；lint 有 303 warnings，日志分别为 `typecheck.log`、`lint.log`、`architecture-after.log`。架构结果仅为 changed-only，不是全量架构通过。

日志与审计均在 `output/zody-rename-r21/graph-path-closure/`。graph 既有 68 missing/18 symbol 等语义缺口仍属独立验收，本次不增删节点/边，也不宣称语义闭合；完整最终候选的安装及第三方生成另验。未 install、Docker、WDIO、提交或修改 task-ledger。
