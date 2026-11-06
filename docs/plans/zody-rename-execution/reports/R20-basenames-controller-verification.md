# R20.4 basename 第二批：主控验证

基线 `e79eab7d35ba576140ff57698ca0fff122629366`。本批迁移 98 个 basename（25 个源码、73 个测试/helper），并修正路径消费者；实际当前产品文件共 134 个。候选提交由任务账本及 `r20-basename-migrations.json` 后续登记，本文不预写自身 commit SHA。

主控独立核对所有 134 个文件：均等于基线原文件内容加精确的引号内相对模块路径、services `#src` 路径调整；未发现其他内容差异。98 个旧路径均已消失，新路径存在，14 个已存在的受保护文件与基线一致。证据为 `output/zody-rename-validation/controller-basenames-content-audit.json`；路径清单为 `output/zody-rename-r20-basenames/candidate-product-files.json`。这些检查保留了前批符号修改，不用较早快照覆盖新源码。

主控实际运行：

- root 69 个迁移测试文件：575 项通过。
- CLI helper 相关 13 个文件：211 项通过。
- 恢复后复跑 11 个源码消费者及额外 client 测试：12 文件、103 项通过。
- `pnpm typecheck`：退出 0；`pnpm lint`：退出 0，303 warnings、0 errors。
- 冻结前对实际未提交源码运行 `pnpm architecture:check --changed`：退出 0，0 violations；不是在提交后的空 diff 上代验。

对应日志位于 `output/zody-rename-validation/controller-basenames-{root,cli,consumers-restored,types,lint}.log`。测试集合有交集，以上计数不汇总为独立用例总数。实际 cwd/argv 与测试收集清单见 `output/zody-rename-r20-basenames/{actual-test-argv,source-consumer-actual-argv,collection-summary}.json`。

测试收集期间误用 Vitest 可选 `--json` 输出参数，曾覆盖 client 的 topic-envelope 测试与 Desktop data-size 测试。两者已从本批基线恢复，仅重放批准的模块路径变更；主控复核全部 134 个文件，并在恢复后实际重跑覆盖两者的 12 文件/103 项测试。后续收集使用显式 `--json=/absolute/output/...`，不得将待测源码作为输出目标。该事件不涉及用户数据；未把恢复前结果单独作为恢复后文件的通过证据。

Terra 完成四包真实 clean 重建：先完整保全 shared/services/server/ui 的 dist 与 buildinfo（9520 文件逐项 hash 相同），从空输出执行 force tsc，随后实际 server build 重建 HTTP/remote bundle 与 notices，均退出 0；remote `--version` 输出 0.1.0。23 个涉及模块的 JS、声明及两类 map 共 92 组新文件存在、对应旧文件不存在。clean 后 11 消费者/101 测试和 CLI 13 文件/211 测试再次通过。报告和原始日志保留于 `output/zody-rename-r20-basenames/clean-rebuild-report.md` 及同目录；文件 URL 解析不被解释为逐模块运行成功。

Desktop `out/main` 未清理，两个源模块的旧/新 standalone 输出仍并存；Main 类型检查仍失败，实际 Desktop bundle 缺少活动 CUA 冻结 manifest。本批不能证明 Desktop 输出干净，也不能使用旧冻结资源冒充最终候选构建；由 R22/R60 闭合。Terra 将 Main 与真实旧基线的各 85 条诊断逐条比较，仅归一化 checkout 根、已登记文件移动及连续引号字面量联合类型顺序，实质差异为 0，见 `output/zody-rename-r20-basenames/final-audit.json`；不以根 typecheck 代替 Main 检查。

一个依赖 basename 派生 caseName 的 conversation-session E2E 文件暂未移动，需与 runner/fixture/case ID 一起闭合；它不是永久例外。本批未执行原生 E2E。feature graph 的三个路径候选交 R21；不在本批改 graph、lock、env/wire、插件外部契约、原生 pins 或历史来源标识。R20.4 剩余符号/文件名仍待执行，DeepSeek 只读候选审查及 R22 集成门禁尚未通过。
