# R20.4 batch-03

状态：本批已实施，尚未提交；基线 `1b042046c373fa91c5ed80b1501bcf0677f2eb39`。不代表 R20.4 全部完成。

A0 ProcessManager 剩余 17 个声明，以及 services 合同中同名但独立的 lifecycle event、shared 的 agent runtime 与 background control/bash/notification 7 个类型，共 25 个声明；逐个旧/新名、声明文件、引用数量和改名前 SHA 见 `output/zody-rename-r20-symbols/batch-03/batch-manifest.json`。类型服务在同一根项目载入授权 root/CLI 文件，两条同名 lifecycle 类型分别解析；`identifier-audit.json` 中唯一未绑定标识是 `storagePreparationWorker.test.ts` 的模块 mock 导出键，已与实际 export 同步。三个字符串仅为测试描述，未机械替换；env、wire、telemetry、序列化字段和业务状态均未改。

额外按主控精确授权修复 `scripts/audit-zody-agent-remnants.mjs` 的 basename 分类：只将 `zcode-agent-policy` 改为 `zody-agent-policy`，保留尚未移动的 `zcode-agent-model-state`。`node scripts/audit-zody-agent-remnants.mjs --json` 退出 0，`remnants-audit.json` 中该路径为 `compat-type`；没有引入通配豁免。

产品差异共 28 个精确文件，逐路径当前 SHA 在 `candidate-file-list.json`；均在 substep4 授权集合或上述脚本精确追加范围。生成物方面，根 `pnpm typecheck` 从源码重建引用项目；`packages/server/dist` 的旧 HTTP bundle 曾仍带旧名字，已隔离备份至 batch-03 输出目录，并执行 `pnpm --dir packages/server build` 重建（最终 Node 24.14 日志 `server-build-node24-final.log`，exit 0）。最终 shared/services/server/CLI dist 的旧名扫描只有三条同一历史说明注释，见 `dist-residual-final.log`；无据此声称全部动态引用均已关闭。未手改声明、wire、锁文件或冻结输入。

验证 cwd 均为实施工作区根，除 CLI 命令显式 `--dir`。开始时实际 Node 24.16 的检查记录保留，但仓库要求 Node 24.14，因此完整目标检查在固定版本重跑：

- `target-tests-node24.log`：9 个精确测试文件、191 项通过，exit 0；命令包含 storagePreparationWorker、windowHostSessionsIndexObserver、stdioDesktopPresentationSurface、zcodeAgentConnectionScope、zcodeTaskIndexSyncer、zodyAgentProcessManager、taskActivityTracker、backgroundBashJobs、backgroundTaskNotifications。
- `typecheck-node24.log`：`pnpm typecheck` exit 0；`cli-typecheck-node24.log`：`pnpm --dir apps/zody-cli/packages/cli exec tsc --noEmit` exit 0，仅覆盖 CLI 包。
- `lint-node24-final.log`：`pnpm lint` exit 0，303 warnings；`architecture-node24-final.log`：`pnpm architecture:check --changed` exit 0，0 violations。
- `desktop-main-node24.log`：`pnpm exec tsc -b packages/desktop/tsconfig.main.json` exit 1，85 条诊断；与已独立核实的 854 基线按文件、行、列、TS 错误码比对无新增或消失，见 `desktop-main-comparison.log`。这不是 Desktop main 类型检查通过。

原 1,602 条剩余声明候选并未因本批完成而全关闭；A0 已处理并补齐第二个生命周期类型，本批 shared 类型仅是 B0 中的闭合集合。其余共享协议/任务、CLI、UI、Desktop、provider、内部对象属性、动态引用及 151 个 manualReviewPaths 仍须按精确 owner 和实际绑定逐批完成。无提交；构建输出和源码锁在报告交付后交还主控。
