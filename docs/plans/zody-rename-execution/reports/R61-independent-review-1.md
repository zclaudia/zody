# R61 独立验收（第 1 轮）— 原生模型审查

日期：2026-11-06。审查者：R61 独立验收（原生模型，与执行者不同源）。范围：`reports/R61.md` + `output/zody-rename-r61/**`，只读核对（未改源码、未联网；除 `node scripts/licenses.mjs check` 只读复跑外未重跑门禁，全部门禁结论按主控日志逐条读核）。工作区：`/Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename`，HEAD `d8eb82765392a09207f27852bb5743fe0c7bc87a`。

**判定：CHANGES_REQUIRED（仅报告级修正；发布结论与门禁事实未被推翻）。** 8 项核对中 7 项通过；⑤ 的 R22 对账段存在 P2 口径混用，需在报告内修正后才可收口。

---

## 1. 八项核对结果

| # | 项 | 判定 | 实测依据 |
| --- | --- | --- | --- |
| ① | git status 零源码改动 | **通过** | `git status --porcelain` 仅 `?? docs/plans/zody-rename-execution/reports/R61.md`；`git rev-parse HEAD` = `d8eb8276…`；`git stash list` 空；`git diff --stat -- apps/zody-cli/packages/node-repl-host/dist-types` 无输出（7 个 tracked dist-types 已由主控恢复，与 §12 一致） |
| ② | 复用矩阵抽查 2 单元 | **通过** | 单元 A：`git diff --stat 2043607a..7ed8ded8` = 13 files / 990+/23−，文件清单与 §3.1 R50 行逐项一致（shared gen-ui/mcp-apps 4+5 文件 + toolMeta + spec + 3 docs）；加验 R60 P0-1 段 `af24a365..8b98b6a3` = 仅 `third-party/inventory.json` 6+/6−。单元 B：TRUST 三模块 `git show <SHA>:<file> \| shasum -a 256` 在 `8072db71` 与 HEAD 完全一致，且与 `output/zody-rename-r48/r48.2-data-trust-telemetry/evidence/trust-remote-ab.json` 记录值一致（`workspaceHookReviewStore.ts 01755b12…`、`workspaceHookReviewCommands.ts a35aabb3…`、`windowRemoteConnectionRegistry.ts 695615ee…`） |
| ③ | 残留三档×台账 closure 对账 | **通过（附 3 条 P3）** | 25 项 RES-01..25 在场；报告口径 12 阻止/10 允许/3 后续（含 §12 补登后 RES-23 移档）；台账 426 行 R48 残留 owner（state-storage→RES-03、watcher→RES-02、knip→RES-08、gen-ui contract→RES-09、Strict19→RES-07、签名→RES-10、跨平台/混布→RES-12）逐一有承接；"plugin service size" 由 R52 修至 394 行（`wc -l packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts` = 394）故不入清单属实；R48/R56 ledger 行的 release blockers 均有 RES 承接或 §9② 条目；dist-types 漂移已登（RES-23）。P3 见 §2 |
| ④ | 发布矩阵全列在场 blocked | **通过** | `release-matrix.json`：CLI darwin-x64/linux-x64/win32-x64 execute=BLOCKED、Desktop mac-arm64/mac-x64/win-x64/linux-x64 全 BLOCKED、Android BLOCKED；`not_deleted` 明示不以 macOS 代替；与 `docs/plans/zody-full-divergence-rename-survey.md` §6.3 固定矩阵平台列一致；四归档 `shasum -a 256` 实测 = `d74a0945…`/`4d4d8322…`/`d6901cc6…`/`fff9c82b…`，与 JSON 逐字一致 |
| ⑤ | 全量对账与 R48/R22 映射可溯 | **部分** | G6 日志尾部实测 `Tests 78 failed / 16129 passed / 20 skipped`、27 files、524.44s、exit 1 ✓。R48 侧**逐条可溯**：R61 matched 69 条全部在 R48 70 条清单中逐字命中（0 缺失），R48→R61 唯一未复现条目恰为 `stopDesktopStopVisualBuild`（class 同名未证同因），cause 继承 0 错配；13 新项 = 12 watcher + 1 stateStorage ✓；隔离复跑 15F/12P/1S、1F/2P、3F/21P 与日志一致。R22 侧发现 P2（§2.1）：`39/42（R48 时的 31 条 + 本次回归的 8 条）`混用两个不同的 42 条清单 |
| ⑥ | 交接物在场 | **通过** | H-01..H-06 共 17 个文件逐一 `ls`/`wc -l` 在场：R43 runbook（10 行六步正文）、R48 H/D7/L7 三 JSON（303/137/25 行）、遥测 spec 26 行 + cutover 21 行、R56 §9（`R56.md:175` 起）+ 3 份插件 spec、R60 s0-freeze/sealed-registry/s8 两日志、R56 四份证据 JSON |
| ⑦ | 三段式结论与证据一致 | **通过** | §9② 10 项 blocking 逐一有证据+放行条件，抽查全部落实：G9 `licenses-strict.log` 实数 19 项（逐行清点 1–19）+ EXIT=1；G6 78F；bootstrap 复跑 3F/21P；G4 arch-full 日志 1 违例（gen-ui 缺 contract.test.ts）；G5 knip exit 1；"release asset set requires all desktop, CLI, Android, notes, and checksum files" 为真实测试（`scripts/zody-distribution.test.mjs:112`，rerun 18/18 EXIT=0）且 `dist/zody/releases/0.1.0/` 仅 4 个 CLI/Web 归档；G2 `303 warnings and 0 errors`；G3 violations 0/0/0。§9③ "不可发布，仅候选"与上述硬红一致 |
| ⑧ | 不触发真实发布 | **通过** | `git tag` = 0；R61 无新 commit（HEAD 仍为 R60 收口 `d8eb8276`）；R43 runbook 第 3 行明示"不授权连接或修改真实远端"；D7/L7 为 vitest 本地隔离重跑（`rerun-r48.1e-{darwin,linux}-matrix.log` 各 7 passed/9 skipped，D7 回退用例 PASS）；发行工具 18 项为 `node --test` 单测；rerun 摘要注明隔离根 `/tmp/z61.*` + 合成 HOME |

加验：`node scripts/licenses.mjs check` 复跑 EXIT=0，输出 `待补齐/核验材料 19 项` + `2060 个实装包`，与 G8 转记一致。变更清单：`git rev-list --count 033f9178..HEAD` = 77；`git diff -M --shortstat` = 9147 files / 131407+/43755−，与 §8.1 逐字一致；`8b98b6a3..d8eb8276` = 3 docs 文件 485+/7−（§3.1 行属实）。`manifest.json` 哈希抽查 2/2 一致（reuse-matrix `7361fe37…`、failure-mapping `e4ec7cce…`）。

## 2. 发现

### 2.1 P2 — §4.1/RES-25 的 R22 对账混用两个不同的 42 条基线，关键数字不可在单一清单上复现

`R61.md:104-105`：`39/42 在 R61 复现（R48 时的 31 条 + 本次回归的 8 条），3 条未复现…`；`residual-allowlist.json` RES-25：`…13 新项中 11 条命中 R22 清单`。

实测（对 `output/zody-rename-r22/resume-7089/case-comparison.json` 与 `ad859-failure-triage/case-comparison.json` 两份 42 条清单，用"文件+归一化用例名"逐条匹配 R61 failure-mapping 82 条）：

- 两份清单**不是同一组 42 条**：交集 33、并集 51。resume-7089 条目带 `sameCaseFailedAd859` 字段（R61 `new[].r22` 嵌入即此结构）；ad859-failure-triage 条目带 `caseMatched/sameSignature/fullDetailEqual`（R48 entries 的 `r22` 即此结构，其 `r22StillFailing=31` 以 ad859 为基）。
- 以 **resume-7089** 为基：R61 复现 39/42、未复现恰为 e2eDesktopBuildCache / stopDesktopStopVisualBuild / mobileRemoteGatewayTerminalTransport —— §4.1 的 39/42 与"3 条未复现"只在此基下成立（G6 日志实测该 3 文件 0 FAIL 行）。
- 以 **ad859** 为基（R48 `r22StillFailing=31` 所用）：R61 复现 **37/42**、未复现 **5** 条（另两条 storagePreparationProtocol[套件级] 与 macosCuaHelperRound11Authority 均未在 G6 日志失败）；R48 时为 31/42。
- 故 "31 + 8 = 39" 的分解在任一单一清单上均不可复现（resume 基下 R48 是 30；ad859 基下 R61 是 37）。"3 条不在 R22 清单（consume delete/plugin、observes an empty root）"仅对 resume-7089 成立——三条**都在** ad859 清单内且本轮在失败。RES-25 的"11 条命中"在两个基下都不是（resume=10、ad859=7），与 §4.1 自身 8+2+3=13（命中 10）也自相矛盾。

影响：不隐藏任何失败（82 条失败逐条在账；多报复现方向为保守），发布结论不变；但按本 ask "R48 66F/R22 42F 映射逐条可溯" 的口径，该段不可溯。**修正要求**：§4.1 与 RES-25 显式注明所采用的 R22 基线文件，按单一基线重述分解（resume-7089：39/42 = R48 时 30 + 回归 8+1？按实数重算；ad859：37/42 = 30 + 7），并更正"11 条命中"；若需机器可读，failure-mapping.json 补 `r22Baseline` 字段。

### 2.2 P3 — `residual-allowlist.json` RES-23 仍为补登前状态，与报告权威口径分叉

JSON `RES-23`：`release: 阻止发布`、`未提交`；报告 §6.3/§12 已改判"归属后续任务（主控已 exact checkout 恢复）"。报告 §12 已声明"JSON 未在本次补登中修改，以报告为准"——披露诚实，但终验的机器可读清单与权威三档统计（12/10/3）不一致（JSON 为 13/10/2），后续任何按 JSON 的自动化对账会把已恢复的 dist-types 误判为阻断。建议随终裁同步 JSON 并在 `manifest.json` 重算哈希。

### 2.3 P3 — 台账 `task-ledger.md` R61 行未收口

`task-ledger.md:44` 仍为 `| R61 | planned | unassigned | not run |`，而 R61 已执行完毕并产出报告与证据（这是执行者"只写报告+output"约束的自然结果，非执行者违规）；计划终点的台账状态失真，主控终裁时应回填（含 §12 dist-types 处置与 ⑤ 的基线澄清）。

### 2.4 P3 — RES-18 常量名误写

`R61.md` §6.2 与 JSON RES-25…RES-18 条：`ZCODE_PLUGIN_ID_ENV_KEY = "ZCODE_PLUGIN_ID"`。实测 `packages/shared/src/mcp.ts:16` 为 `export const ZODY_PLUGIN_ID_ENV_KEY = "ZCODE_PLUGIN_ID";`——保留旧**值**的事实正确，但常量**名**写错（仓库无 `ZCODE_PLUGIN_ID_ENV_KEY` 符号），照抄去 grep 会落空。另 RES-19 的 `conversation-telemetry-facts.ts` 实际位于 `apps/zody-cli/packages/bootstrap/src/zody-protocol-v4/`（报告仅写裸文件名，`server-operations.ts:337` 与 `:120` 两处 `meta.zcode` 读点均已实测在位）。

### 2.5 P3 — 台账 R48 closure 的 "Main85 与 old MCP test import" 在 R61 无显式对账

`task-ledger.md:426`（R48 残留 owner 段）要求 Desktop/type-system owner 保留 "Main85 and the old MCP test import"。两词在 R48/R61 failure-mapping 与两份 R22 清单中均无条目（疑似已不失败或归入 knip/RES-08），但 R61 允许清单未显式交代二者的当前处置，属于对账叙述的留白而非漏登失败。

## 3. 未执行项（如实）

- G1 typecheck / G2 lint / G3/G4 architecture / G5 knip / G6 test:unit / G7 build:zody --all：**未在本轮重跑**（本轮只读验收；上述判定均来自对主控日志文件的逐条读核：`w8-r61-g-{typecheck,lint,arch}.log`、`w8-r61-{arch-full,knip,test-unit,build-all}.log` 的实际内容与摘要行）。G7 exit 0 为主控报告口径，gate-summary 已注明"本槽位未重跑构建"；我方复核了日志（3132 行、0 条 error/failed）与产物（四归档哈希、SHA256SUMS 逐字一致）。
- R48.1-A/B/C/D/E、R48.2-A/B 的 17 项重跑：采信执行者日志与摘要 JSON（日志文件与退出码逐个在场），未重放进程。
-licenses `--strict`：未重跑（G9 日志 19 项实数已逐行清点）；基础 check 已复跑 EXIT=0。

## 4. 结论

R61 的事实底座（基线干净、门禁红绿如实、复用判定真实、平台列未被删除、交接物在场、发布结论为"不可发布仅候选"）经独立复核成立；**不通过点仅集中在 R22 对账叙述的基线混用（P2）与三处登记留白（P3）**，均为报告/台账级修正，不动产品源码。修正 §2.1（并建议连带 §2.2–2.5）后可转 PASS。
