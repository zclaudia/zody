# R20.5 默认数据路径完整隔离候选

固定提交 `d49aecefa7d1c3571bfae69fe4817950654b9298`。本次仅在 `output/zody-rename-r20-manual-audit/implementation-preflight/` 制作和运行候选副本，未改工作树产品、安装或构建。正式工作树写锁仍归 R10；主控分配锁后，应先应用 `spec.patch`，再应用 `test.patch` 并在产品修复前复现失败，最后应用 `candidate.patch` 并运行测试。实际候选应先与最新源码对齐，不把固定快照视作最终提交验收。

三个分离补丁：`spec.patch` 更新 `specs/zody-brand-residual-cleanup.md` 的工具默认路径与验收；`test.patch` 新增 `scripts/test/zody-manual-data-paths.test.mjs`；`candidate.patch` 修改 `files.json` 所列七个文件：大型 fixture 的默认 `.zody` 根与说明、restore scan/restore 当前目标根与说明、两条 E2E HOME 路径 metadata。restore 的旧 `~/.zcode/v2/sessions` 来源、`--legacy-dir`、`--snapshot`、`--task-index`、`--cli-db` 保持；不自动迁移数据。大型 fixture 的 `--workspace` 只选择工作区，现无数据库路径覆盖参数；说明准确列出默认 DB/backup/manifest 位置，不增加自动检测、参数或拒绝机制。

Node 24.14.0 下从隔离测试文件分别指向旧 base 和 candidate 根运行：旧 base 2 项行为测试失败（大型 fixture 指向 `.zcode`、restore 没有写入 `.zody`）；candidate 2 项通过，日志分别 `base-test.log`、`candidate-test.log`。测试在同一新建临时根下构造专用 HOME、USERPROFILE、快照和 SQLite 测试库，预断言与进程真实 HOME 不同且子进程 HOME/USERPROFILE 均在该根内；调用的脚本为 output 隔离副本。覆盖 generate/verify/delete、备份/manifest 位置、原旧库 SHA 不变、restore dry-run 不写、默认旧来源/新目标、快照内容不变、scan 和 restore 现有全部显式路径覆盖。测试以 `node:fs/promises` 和异步 `execFile` 执行，SQLite 通过必要的内置 `DatabaseSync` 操作；已对单个候选测试文件运行仓库 oxfmt。测试使用简化 SQLite schema 验证路径/操作，不等同完整应用 schema 或桌面 E2E；未运行真实用户 fixture。

正式写范围：`specs/zody-brand-residual-cleanup.md`、`scripts/test/zody-manual-data-paths.test.mjs`、`files.json` 七个精确路径，以及主控指定实施报告。排除真实 HOME、其他产品/graph/lock/第三方数据、历史快照和未经授权文件。实际验证命令按仓库脚本现状采用 `node --test scripts/test/zody-manual-data-paths.test.mjs`（根 `test:unit` 是 Vitest，不能假设自动发现 Node 测试），并运行仓库要求的 typecheck、lint、架构检查；桌面交互 E2E 根据环境与授权运行并如实记录。本候选尚未运行这些工作树门禁。

静态 JSON 核对：trajectory 原 `.zcode/cli/debug/model-io-<runtime-task-id>.jsonl` 对应候选 `.zody/cli/debug/model-io-<runtime-task-id>.jsonl`；image-cache 原 `.zcode/cli/image-cache/<session>/image-*.png` 对应候选 `.zody/cli/image-cache/<session>/image-*.png`。未以固定字符串单测替代运行时验收；原生桌面 E2E 未运行，仍待正式环境验证。
