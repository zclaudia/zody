# R21 basename 图路径中间检查点

基线 `d49aecefa7d1c3571bfae69fe4817950654b9298` 与当前 R20.4 未提交 basename 候选；从 `r20-basename-migrations.json` 已完成 100 项和 `final-d49/candidate-files.json` 的 98 个 move 中匹配图文件，先输出 `output/zody-rename-r21/graph-basename-checkpoint/matches.json`，列出旧/新路径和修改前行号。共 23 处引用、13 个不同路径，目标均在当前工作树存在。只将这些精确引号路径值替换，未更改符号、节点、边或语义；旧文件和新文件的完整文本核对除这些替换外完全一致。

YAML 解析通过，节点 372、边 726；节点 ID 顺序及全部边对象未变。before SHA-256 `f07827f3bb41b373e3256370eda0eb5920b5f06892f056a14803d5e9648b17c7`，after `9515c3754c22813de4945725e65354f6b5d87d9429bb56fc583d1bb0933b99e7`。`git diff --check` 通过。

固定 Node 24.14.0 路径执行 `pnpm --dir apps/dev-docs exec vitest run --config vitest.config.ts test/featureBoundaryGraph.test.ts`：退出 0，1 文件、4 测试通过；完整日志 `output/zody-rename-r21/graph-basename-checkpoint/vitest.log`。首次调用的 shell 日志重定向错误导致命令未启动，修正路径后实际执行。此前列出的 9 个历史失效路径、符号验证及 graph 语义、inventory/lock 安装与最终干净集成门禁不在本检查点范围；不得据此声称完整 R21 通过。
