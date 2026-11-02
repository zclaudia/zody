Reviewer: broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cc4-82c8-7cc2-a81c-fee2d8b18b67
Route: deepseek-flash; model: group/deepseek; access: read-only.
Scope: R00 review candidate 97fb3c96. This is a review result, not product validation.

**结论：`CHANGES_REQUIRED`**

R00 已可提交审查，但还不能放行 R10；R01/R02 可继续，前提是先补两项 manifest 边界。当前 HEAD 为 `97fb3c96f639360070b5b70f328fb8e7f45b142b`，父提交 `06ad2270…`；工作区中 R01 相关文档仍未提交，本次未审查。

**已通过**
- R00 提交只包含清单、扫描、报告、R02 preflight 和 ledger；R01 未提交文档未纳入判断。
- 计数一致：50 个 workspace、48 个旧名、3 个 E2E fixture、45 个 frozen 副本、11 个目录、17 个脚本（`docs/plans/zody-rename-execution/manifest.json:5631`）。
- `residual-inventory.json` 已缩为 1KB 摘要；详细汇总移至 ignored `output/`；`matches.jsonl` SHA `5c2f…9c5f`、`grouped.json` SHA `60a8…9df8` 均匹配。
- `node --check docs/plans/zody-rename-execution/scan-inventory.mjs` 退出 0。
- R01/R02/R10 的 `writeSet` 两两交集为空；目录目标无碰撞。

**任务放行判断**

| 任务 | 判断 | 条件 |
| --- | --- | --- |
| R01 | **有条件继续** | 先补外部身份清单和 bootstrap protocol 映射；否则 contract-map 不是权威清单 |
| R02 | **有条件继续** | 主控提供绝对备份目录、旧制品白名单和来源；当前 preflight 不能算 R02 完成 |
| R10 | **暂停** | 目标文件冲突仍在 `writeSet`，不得覆盖 |

**阻断项**
1. **BLOCKING R10 — 冲突目标仍在写入集合。** manifest 标了 `scripts/zcode-distribution.test.mjs -> scripts/zody-distribution.test.mjs` 为 `destination-conflict`（`manifest.json:5519`），但 R10 `writeSet` 仍包含已存在的 `scripts/zody-distribution.test.mjs`（`file-assignments.json:126`），gate 未写冲突处理（`file-assignments.json:213`）。现有目标导入旧 `./zcode-distribution/*`（`scripts/zody-distribution.test.mjs:9`），旧文件是集成测试，workflow 同时运行两者（`.github/workflows/zody-release.yml:45`）。派发前必须由主控定合并/拆分方案，并从 R10 `writeSet` 移除目标文件或加显式 conflict 元数据。
2. **BLOCKING R01 — 外部身份保留清单缺失。** manifest 没有 `externalIdentities`/保留例外条目，检索不到 `zcode-plugins-official`、`zcode-cua`、`zcode_mobile_secure_store`、`zcode-sandbox`、`persist:plugin-sandbox-v2-*`。生产源码中这些身份明确存在：`packages/services/src/plugins/officialPluginCache.ts:4`、`apps/zcode-cli/packages/adapters/src/config/schema.ts:177`、`packages/shared/src/mcp.ts:228`、`packages/desktop/src/main/pluginSandbox/contract.ts:11`、`packages/android/app/src/main/java/io/github/zclaudia/zody/mobile/bridge/SecureKeyValueStore.kt:69`。R01 不能只靠 survey 正文冻结这些保留项。
3. **BLOCKING R01/R20 — bootstrap protocol 目录未登记。** manifest 只列了 shared 的 `zcode-protocol`/`zcode-protocol-v4` 移动（`manifest.json:5382`），bootstrap 的 `src/zcode-protocol`（70 文件）和 `src/zcode-protocol-v4`（59 文件）只作为父目录 `apps/zcode-cli` 文件出现（`manifest.json:908`），没有独立旧→新路径；父目录改名为 `apps/zody-cli` 后它们仍叫 `zcode-protocol`。R01 contract-map 和 R20 都会漏掉这部分。
4. **非阻断当前三项，阻断 R20/R21 — 嵌套 lock 无人更新。** `apps/zcode-cli` 移动文件包含 `apps/zcode-cli/pnpm-lock.yaml` 和 `skills-lock.json`（`manifest.json:5097`、`:5106`），但 R21 `writeSet` 只有根 `pnpm-lock.yaml`（`file-assignments.json:256`），R20 又排除 lock；CLI 锁内有 19 处 `@zcode/` 链接。R21 前必须明确归属。
5. **非阻断 R00，阻断 R02 正式结论 — preflight 不是备份。** `R02-preflight.md` 基于主工作区 HEAD `033f917`，不是本 worktree `06ad2270`；未展开/恢复归档，未验证四 pin、签名身份、SDK/权限、旧组合运行，独立 server-cli 制品也未定位。R02 `structureScope` 仍是占位（`file-assignments.json:70` 附近）。R02 继续前必须由主控给出绝对备份目录和制品白名单。

本次仅做只读结构化核对和 `node --check`；未运行扫描生成、pnpm、测试、构建、UI 或生产动作。
