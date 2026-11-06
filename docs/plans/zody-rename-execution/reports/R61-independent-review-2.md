# R61 独立验收（第 2 轮）— 原生模型审查

日期：2026-11-06。审查者：R61 独立验收第 2 轮（原生模型，与执行者不同源）。范围：`reports/R61.md`（含 §13 返修）+ `output/zody-rename-r61/**`，只读核对（未改任何既有文件、未联网；未重跑全量门禁，全部门禁结论按主控日志逐条读核；对账类数字全部用脚本从原始 JSON 复算）。工作区：`/Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename`，HEAD `d8eb82765392a09207f27852bb5743fe0c7bc87a`。

**判定：PASS（附 1 条 P3）。** 第 1 轮的 P2（R22 双基线混用）与各 P3 已全部返修并经本轮独立复算证实；八项核对全部通过；发布结论"不可发布，仅候选"与证据一致。

---

## 1. 八项核对结果

| # | 项 | 判定 | 实测依据 |
| --- | --- | --- | --- |
| ① | git status 零源码改动 | **通过** | `git status --porcelain` 仅 `?? docs/plans/zody-rename-execution/reports/R61.md` 与 `?? …/R61-independent-review-1.md`（两份报告均为未跟踪文档，非源码）；无任何 tracked 修改/删除；`git stash list` 空；`git diff --stat -- apps/zody-cli/packages/node-repl-host/dist-types` 无输出（§12 的 7 个 tracked 声明产物已恢复）；`git tag` 0 个；`d8eb8276..HEAD` 0 提交。报告 §8.2 写"只剩 ?? R61.md"是第 1 轮审查报告落盘前的快照，现多出的正是第 1 轮审查自身的报告，非源码变化 |
| ② | 复用矩阵抽查 2 单元（本轮换样，与第 1 轮不同） | **通过** | 单元 A（R54 段）：`git diff --stat 26030925..2a909694` = **43 files / 1903+/315−**，逐字等于 §3.1 R54 行；目录覆盖与 §3.1 描述一致（adapters/src/plugins、bootstrap、cli、server/src/remote、services plugin-sync/settings/skills/subagents/commands 等）。单元 B（R48.2-B 直接复用）：TRUST 三模块 `git show <SHA>:<file> \| shasum -a 256` 在 `8072db71` 与 HEAD 逐字一致且等于 R48 证据 JSON 记录（`packages/ui/src/store/workspaceHookReviewStore.ts 01755b12…`、`packages/ui/src/settings/workspaceHookReviewCommands.ts a35aabb3…`、`packages/desktop/src/host/windowRemoteConnectionRegistry.ts 695615ee…`）；`git diff --name-only 8072db71..HEAD -- apps/zody-cli/packages/telemetry` 为空（TELEMETRY 零 diff）。加验 R56 复用基座：`af24a365..HEAD` 仅 4 个 docs/inventory 文件，`471ad9c4..af24a365` = 4 文档文件 252+/9−，与 §3.1 逐字一致 |
| ③ | 残留三档 × 台账 closure 对账 | **通过（附 1 条 P3）** | `residual-allowlist.json` 26 项；按 `releaseClass` 实数 12 阻止（RES-01..08,10,11,12,25）/ 10 允许（RES-09,13..21）/ 4 后续（RES-22,23,24,26），与报告 §6 及 `countsByClass` 一致。台账 `task-ledger.md:426` R48 显式 owner 逐条有承接：state-storage→RES-03、watcher→RES-02（R48 70 条中 watcher 实数 9 ✓）、Main85/old MCP import→RES-26（本轮 grep 两份 mapping 与两份 R22 清单均 0 命中 ✓）、knip→RES-08、gen-ui contract→RES-09、Strict19→RES-07、签名→RES-10、跨平台/混布→RES-12；"plugin service size" 已由 R52 修至 394 行（`wc -l packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts` = 394）故不入清单属实。R56/R60 ledger 行的 blockers（E2E 环境、R51 双 skip、bootstrap 3 例、签名/封存）分别由 RES-11/RES-06/RES-10 承接。dist-types 漂移已登 RES-23（后续归属档、主控已 checkout 恢复、树干净） |
| ④ | 发布矩阵全列在场 blocked | **通过** | `release-matrix.json`：CLI darwin-x64/linux-x64/win32-x64 `execute: BLOCKED`（各带 runner 缺失理由）；Desktop mac-arm64/mac-x64/win-x64/linux-x64 与 Android 设备层全 `BLOCKED`（各带证据与放行条件）；`not_deleted` 明示"未从范围删除、未用 macOS 结果替代"。平台列与 `docs/plans/zody-full-divergence-rename-survey.md` §6.3 固定矩阵一致。实盘复核：`dist/zody/releases/0.1.0/` 仅 4 个 CLI/Web 归档 + SHA256SUMS，`shasum -a 256 -c` 4/4 OK，SHA 与 JSON 逐字一致 |
| ⑤ | 全量对账 + R48/R22 映射逐条可溯 | **通过（复算全中）** | G6 日志尾部实测 `Tests 78 failed / 16129 passed / 20 skipped (16227)`、`27 failed / 1773 passed / 3 skipped (1803)`、524.44s、exit 1。**R48 侧**：R61 mapping `matched` 69 条全部落在 R48 70 条内（0 缺失）；R48−R61 恰为 `stopDesktopStopVisualBuild` 1 条；13 新项 = 12 watcher + 1 stateStorage（R48 70 条中 stateStorage 0 条 ✓）；G6 日志 watcher 文件 21 FAIL = 12 新 + 9 既有 ✓。**R22 双基线（脚本复算，归一化 = 文件 + 去套件分隔/空白折叠、ad859 套件名 `[file]` 归文件级）**：resume∩ad859=33、并集=51；resume 基：R61 **39/42**、R48 **30/42**、未复现 3（三文件 G6 日志 0 FAIL 实测）；ad859 基：R61 **37/42**、R48 **31/42**（=R48 `totals.r22StillFailing=31`，且 R48 `r22.caseMatched=true` 实数 31）、未复现 5（五文件 G6 日志 0 FAIL 实测）；13 新项命中 resume **10**、ad859 **7**；`sameCaseFailedAd859` true=8/false=2；不在 resume 的 3 条 watcher 均在 ad859 且本轮失败——§4.1 与 RES-25 的每一个数字逐字复现，JSON `r22Baselines` 的 missingAtR61 清单与复算集完全相等。82 条 mapping = 82 条 G6 FAIL 行（79 条用例级 + 3 条 vitest 套件级；套件级恰为 devStartupReadyState/electronBuilderLinuxPackageTargets/tsupChunkIsolation），逐文件计数 21/13/6/5/5/3/3/2/2/2/1… 与日志全等 |
| ⑥ | 交接物在场 | **通过** | H-01..H-06 共 17 文件逐一在场：R43 runbook（10 行，首段明示"不授权连接或修改真实远端"）、R48 H/D7/L7 三 JSON（303/137/25 行）、遥测 spec 26 行 + cutover 21 行、R56 §9 + 3 份插件 spec（125/95/66 行）、R60 s0-freeze/sealed-registry/S8 两日志（S8 `"status": "pass"`；codesign `valid on disk` + `satisfies its Designated Requirement`）、R56 四份证据 JSON |
| ⑦ | 三段式结论与证据一致 | **通过** | §9② 10 项阻断逐项复核：licenses `--strict` 日志实数 **19** 项（逐行清点 1–19，首项 React Best Practices skill，含 Skia/QuickJS-NG/rust-standard-library）+ `EXIT=1`；G6 78F；bootstrap 复跑 `3 failed / 21 passed` EXIT=1；G4 arch-full `violations: 1`（gen-ui 缺 contract.test.ts）exit 1；G5 knip exit 1；"release asset set requires…" 为真实测试（`scripts/zody-distribution.test.mjs:112`）且 `dist/zody/releases/0.1.0/` 无 Desktop/Android 资产；每项均带放行条件。§9③"不可发布，仅候选"与 G6/G9 硬红一致。G1/G2/G3 转记与日志一致（`tsc -b` 无诊断 / `303 warnings and 0 errors` / violations 0-0-0）；G7 构建日志 0 条 error/failed（仅 postject `.note` 警告与 `[sea] downloading` 构建行为），报告如实标注"exit 0 为主控报告、本槽位未重跑构建"，并落地复核了四归档 SHA 与 SEA `--version` → `0.1.0` EXIT=0 |
| ⑧ | 不触发真实发布 | **通过** | `git tag` 0；`d8eb8276..HEAD` 0 提交（HEAD 仍 R60 收口）；R43 runbook 明示不授权真实远端；D7/L7 为本地 vitest（各 `7 passed / 9 skipped`）；隔离根 `/tmp/z61.fclV5s`（`logs/isolated-root.txt`）+ 合成 HOME；发行工具 18 项为 `node --test`；§8.3 为交接文稿（前置条件含 strict exit 0/豁免，未执行） |

加验（§8 变更清单）：`git rev-list --count 033f9178..HEAD` = **77**；`git diff -M --shortstat 033f9178..HEAD` = **9147 files / 131407+/43755−**，与 §8.1 逐字一致；`package.json` SHA-256 前缀 `416cc6de…` ✓。§3.3 四产物 SHA 与磁盘实测逐字一致（`zody.cjs 99d13ae3…`、`entry-http.js dd4e021c…`、`zody-server.cjs 5cbdbc84…`、`web index.html c8632295…`，对照 `evidence/rerun-artifacts.sha256` 与 `shasum` 实算）。

## 2. 第 1 轮意见返修核验（§13）

| 第 1 轮意见 | 本轮复算 |
| --- | --- |
| P2 R22 双基线混用 | **已修**。`failure-mapping.json` 增 `r22Baselines`（resume7089/ad859 两结构、路径、交集 33/并集 51、inR61/inR48、missingAtR61 清单）；§4.1/RES-25 按双基线分列；全部数字独立复算全中（见 ⑤） |
| P3 RES-23 JSON 分叉 | **已修**。JSON RES-23 = 归属后续任务/已恢复；三档 12/10/4 与报告一致；`manifest.json` 9 个证据文件哈希重算，9/9 与磁盘一致 |
| P3 RES-18 常量名 / RES-19 路径 | **已修**。`packages/shared/src/mcp.ts:16` 实为 `ZODY_PLUGIN_ID_ENV_KEY = "ZCODE_PLUGIN_ID"`；RES-19 两处 `meta.zcode` 读点实测在位（`server-operations.ts:337`、`zody-protocol-v4/conversation-telemetry-facts.ts:120`） |
| P3 Main85/old MCP 留白 | **已修**。RES-26 新增；grep 证实两份 mapping 与两份 R22 清单 0 命中、G6 无对应 FAIL |
| P3 台账 R61 行未收口 | **仍未回填**（见发现 1）；执行者已如实登记"待主控回填"，非执行者违规 |

## 3. 发现

### 3.1 P3 — `task-ledger.md:44` R61 行仍为 `planned / unassigned / not run`

R61 已执行完毕并两轮独立验收，但计划终点的台账行未收口（第 1 轮 §2.3 已提；执行者按其只写报告+output 的约束登记为"待主控回填"，至今未回填）。不影响本次判定的事实底座，但主控终裁时应回填 R61 行（含 §12 dist-types 处置与 §4.1 双基线口径），否则计划台账与事实脱节。

### 3.2 备忘（非发现）

- 报告 §8.2"git status 只剩 ?? R61.md"的快照已因第 1/2 轮审查报告落盘而变为 3 个未跟踪报告文件（R61.md、review-1、review-2）；均为 docs/plans 下报告，非源码，不构成 ① 的偏差。
- G6 的"78 failed tests"与 mapping"82 条"的关系为：82 = 78 条用例级断言（含 1 条 fork-isolated `builtin-provider-build`，vitest 计入文件级）+ 3 条 vitest 套件级 + 1 条…… 经逐文件核对 82 条 FAIL 行与 mapping 82 条 1:1 对齐（其中 79 条带用例名，3 条套件级；79−1 条 fork-isolated = 78 计数）。报告未显式展开此算术，但逐条在账、可溯，无隐藏失败。

## 4. 未执行项（如实）

- G1/G2/G3/G4/G5/G6/G7/G8 全量门禁：未重跑（本轮只读验收，结论来自对主控日志文件的逐条读核与尾部摘要核对）；G9 `licenses --strict` 未重跑（日志 19 项已逐行清点）。licenses 基础 check 本轮亦未复跑（第 1 轮已复跑 EXIT=0）。
- §4.2 的 17 项重跑：采信执行者日志与证据 JSON（逐个在场、退出码与摘要行核对），未重放进程。

## 5. 结论

R61 的事实底座经第 2 轮独立复算全部成立：基线干净、门禁红绿如实、复用矩阵口径真实、R22 双基线对账逐条可溯、平台列未被删除、残留三档与台账 closure 无漏项、交接物在场、发布与回滚步骤未触发真实发布。第 1 轮全部意见已返修到位。唯一遗留为台账 R61 行回填（P3，主控终裁动作）。**判定：PASS。** 发布结论维持：不可发布，仅可作为可审查的发布候选 + 交接包。
