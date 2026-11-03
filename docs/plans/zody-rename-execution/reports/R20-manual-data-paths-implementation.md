# R20.5 手工数据工具默认路径修复

基线 `f28dfddcbd4e646d7fa93d2e593b91a62063b2b6`；按 `substep5ManualDataPaths` 在规格、隔离测试和七个授权文件内实现。先更新 `specs/zody-brand-residual-cleanup.md`，新增 `scripts/test/zody-manual-data-paths.test.mjs` 后在旧实现上执行：退出 1，2 项均失败，分别暴露 `.zcode` 默认目标与新库未写入（`output/zody-rename-r20-manual-audit/red-worktree.log`）。随后实现并复验，2 项通过（`green-worktree.log`）。

大型任务 fixture 的默认 DB、manifest 和备份根从 HOME 下 `.zcode` 改 `.zody`，现行技能说明列出路径和 `--workspace` 的作用；该脚本不读取自定义数据目录或 CLI DB 配置，也没有新增检测、选项或禁止机制。restore scan / restore 的当前目标 DB 默认 `.zody`，历史 snapshot 默认输入仍为 `.zcode/v2/sessions`；已有 `--legacy-dir`、`--snapshot`、`--task-index`、`--cli-db` 原语义未变。技能说明区分目标与历史来源、显式路径。两个 E2E case metadata 的 HOME 路径修正为 `.zody/cli`。已授权局部 `zcodeRoot` → `zodyRoot`、`ZCODE_PROVIDER` → `ZODY_PROVIDER`，provider 值 `glm`、历史 trace ID、序列化 agent 字段和外部契约保留。

隔离 Node 测试使用异步文件与进程 IO，在独立临时根下设置 HOME/USERPROFILE，覆盖默认生成/verify/delete、备份与 manifest、restore dry-run 和真实写入、scan、已有路径覆盖，检查旧库哈希与历史 snapshot 内容不变。测试数据均为临时 SQLite/JSON，不使用用户数据；测试使用简化 schema，非完整应用 schema 或原生 E2E 证明。两条 metadata 做静态核对，未运行 Desktop E2E；Windows/Linux 尚未实测，`sqlite3` 备份依赖由现有脚本保留。

固定 Node 24.14.0 / pnpm 10.33.2：`node --test scripts/test/zody-manual-data-paths.test.mjs` 退出 0，2/2；`pnpm typecheck` 退出 0；`pnpm lint` 退出 0（303 warnings）；`pnpm architecture:check --changed` 退出 0，基线和变更后均 0 违规；`git diff --check` 退出 0。日志依次位于 `output/zody-rename-r20-manual-audit/green-worktree.log`、`manual-check-{0,1,2}.log`、`architecture-baseline.log`。新测试经仓库 oxfmt 格式化。未安装、执行 WDIO、原生构建或发布。

逐文件 SHA-256 和完整补丁见 `output/zody-rename-r20-manual-audit/implementation-preflight/applied-files.json` 与 `applied.patch`；patch SHA-256 `0ac0e2e5f4820b9c2b4cc82645e445502ae761b2dcf3861a6e953965635c4b21`。本批未提交，等待主控复审与集成。
