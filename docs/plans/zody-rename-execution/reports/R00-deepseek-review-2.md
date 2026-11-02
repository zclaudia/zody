Reviewer: broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cc4-82c8-7cc2-a81c-fee2d8b18b67
Route: deepseek-flash; model: group/deepseek; access: read-only.

**结论：`PASS`**

R00 相对 `97fb3c96` 的有限返修已覆盖要求，R01/R02/R10 可继续；R02 仍仅为前置准备，不是完成。

**复验结果**
- **外部身份保留项**：`manifest.json:7053` 新增 `explicitRetentions` 9 项，覆盖市场 ID、`zcode-cua`、Android secure store、sandbox origin/partition、旧 hook 来源、插件桥/meta 与插件 env。所有 `files` 路径存在，`retentionUntil` 均非空；源码路径抽检命中对应常量，例如 `packages/desktop/src/main/pluginSandbox/contract.ts:11`、`:18`、`packages/shared/src/workspace-hook-config.ts:27`。
- **bootstrap protocol 两目录**：新增 70 文件与 59 文件两条独立映射（`manifest.json:5489`、`:5568`），`directoryMoves` 计数为 13（`:5779`），并明确父子目录原子映射、避免重复移动（`:7203`）；两个目标目录当前不存在。
- **R10 冲突裁决**：旧 runner 测试映射为 `scripts/zody-distribution-runner.test.mjs`，状态已改为 `planned`（`manifest.json:5667`）；现有 `scripts/zody-distribution.test.mjs` 保留，`file-assignments.json:227` 明确只改 import、workflow 继续执行两者、禁止覆盖。R10 的 read/write/planned 均包含新 runner，旧测试、现有测试和新 runner 三者一致；新 runner 目标当前不存在。
- **R21 lock 归属**：`manifest.json:7204` 明确根 `pnpm-lock.yaml`、`apps/zcode-cli/pnpm-lock.yaml`、`apps/zcode-cli/skills-lock.json` 均由 R21 审计；CLI 两文件映射到 `apps/zody-cli/*`，外部来源不机械改名。`file-assignments.json` 的 R21 read/write 与 plannedPaths 已同步。
- **R00 报告**：`reports/R00.md:5` 更新为 13 个目录及 bootstrap 子目录说明；`:9` 记录 R10 裁决；`:17` 记录 R21 lock 与外部来源策略。
- **基础校验**：manifest/file-assignments JSON 可解析，`node --check scan-inventory.mjs` 退出 0；未运行生成扫描、测试或构建。

**非阻断备注**
1. 实际字段名是 `explicitRetentions`，不是 `externalIdentities`。内容满足语义；若后续派发工具依赖固定键名，需统一。
2. R02 的绝对目录 `output/zody-rename-r02/` 和 tar/manifest/snapshot 白名单不在这三份 R00 文件的 diff 中，仍由主控派发包承载；R02 preflight/restore 不可记为完成。
3. `lockfileOwnership` 未列根 `skills-lock.json`；若“skills-lock 审计”包含根文件，需补一条保留/审计说明，否则按当前 CLI 文件范围可接受。

