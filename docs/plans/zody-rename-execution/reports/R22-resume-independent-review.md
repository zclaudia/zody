# R22 resumed independent review

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3ef-1ff3-73f3-85d1-ba99d9bde573`; route deepseek-flash / magpie / group/deepseek; read-only. Product candidate7089; completed resume evidence reviewed. This receipt permits only the stated scoped/conditional transition to R30, not full-suite or release acceptance.

**结论**

本轮只读审查基于既有完整结果，未重跑测试、build、install，也未修改文件。结论是：**可作“限定 scoped PASS”，仅覆盖 7089 的 P2 改名解析与真实启动链；允许 R30 实施，但 R22 不能记为 full green、verified 或发行通过。**

未发现必须先修的“改名解析/路径/构建入口”阻断。真实红项仍在，但属于已证明旧失败、冻结输入或未解释的测试可靠性问题，不是 R30 环境变量/define 的机械前置。若主控门禁要求“所有失败先完全归因”，则不应放行 R30；计划 R22 只要求“所有改名链路可解析、第三方依赖无漂移；真实结果和基线失败分开”，当前最高可落账状态是 **conditional/scoped**，不是 R22 通过。

**A. 失败分类**

原始事实已复核：7089 隔离 unit 为 `15917 pass / 42 fail / 20 skip`，21 个失败文件 = 17 个含断言失败文件 + 4 个套件级失败文件；42 条断言中 39 条在 ad859 首次全量有同名失败，3 条没有。见 `docs/plans/zody-rename-execution/reports/R22-resume-7089.md:9`、`:15`、`:23`，以及 `output/zody-rename-r22/resume-7089/unit.vitest.json`、`case-comparison.json`。

- **现有代码回归：0 条已确认。** 没有发现 `@zody/*` 模块解析、改名后路径/构建产物缺失导致的失败。4 个套件级失败是 3 个缺 `cua-narrow manifest` 和 1 个隔离 HOME 下 Round11 node probe 失败，均非模块解析错误，且都在旧 `fullDetailEqual` 集合中。
- **已证明旧失败：25 条当前断言 + 4 个套件级失败。** 旧对照的 `fullDetailEqual` 共 30 项（26 断言 + 4 套件级）；逐项匹配后，25 条断言仍出现在当前 42 条中，4 个套件级仍失败；旧集合中的 `both independent Hosts consume plugin without broadcasts` 本次已通过。证据见 `docs/plans/zody-rename-execution/reports/R22-failure-triage.md:9`、`:14`，以及 `output/zody-rename-r22/ad859-failure-triage/case-comparison.json`。代表性旧失败包括 remoteAccess/appSettings、provider 模型元数据、手机 gateway、Desktop E2E 脚本/路径、CUA visual/lease、provider-node 构建、M2 边界等。
- **同名但未证明同因：14 条断言。** 包括 `stateStorage` broadcast、`stopDesktopStopVisualBuild`、`hookCreateButtonSize`，以及 11 条 watcher（`observes project directory recreation`、`both independent Hosts consume create/update/rename/disable/enable/builtin`、`recovers after deleting`、`observes files`、`reads state`、`does not publish`）。这些不能仅凭同名归为旧失败。
- **新名未解释：3 条 watcher。** `user rename reaches both Hosts when the real directory is AGENTS`、`keeps user scans and native updates limited to direct files`、`keeps project scans and native updates limited to direct files`。但需注意：两个 direct-files case 在 7c ancestor 定向复跑中同样失败（`output/zody-rename-r22/ad859-failure-triage/ancestor-rerun.log:2087`、`:2113`）；rename case 在 7c 单例诊断中失败（`R22-watcher-single-case-diagnostics.md:17`），但在 7c ancestor 复跑中通过（`ancestor-rerun.log:1196`）。因此这是**双侧波动/时序问题，不是已确认的改名回归**，但根因仍未解释。
- **GenUI `stateStorage`：** 测试、实现、`atomicFileUtils`、RPC Emitter、shared Gen UI contract、`atomicFileLock`、Vitest config、lock 均同 blob，且 exports 指向 `src`；仍失败属真实测试可靠性/负载时序问题，归 services/Gen UI owner，不是机械改名阻断。见 `R22-resume-source-triage-7089.md:11`。
- **watcher 源码等价：** 测试、`subagentConfigScope.ts`、`subagentRuntimeConfig.ts` 同 blob；`subagentStorage.ts` 仅 `resolveZCodeStorageRoot→resolveZodyStorageRoot`，函数体未变；`subagentsService.ts` 仅同一调用及 `ZCodeProvider→ZodyProvider` 类型名；数据根仍为 `.zody`。见 `R22-resume-source-triage-7089.md:15`。
- **Main 85：** 85 条诊断仍 exit 1，但与 ad859 基线在**路径 + 连续引号 union 顺序**归一化后整份相同。报告 `R22-resume-7089.md:13` 只写了“规范化检出路径”，措辞少列了 union 顺序；建议主控落账时补正，避免夸大证据。实测仅 11 行 union 顺序差异，归一化后完全一致。
- **knip / architecture：** 2 条 architecture 违规在 ad859 已存在；knip 的 `mcpZodyAgent.test.ts:5 → ../src/mcp.js` 是旧 type-only 静态未解析，测试实际通过。两者仍是真实 gate，但不能写成当前改名运行时回归。见 `R22-resume-7089.md:3`。
- **narrow：** 33/37，4 项缺冻结 manifest/identity-pins，归 R60，不是 R30 机械改名阻断。见 `R22-resume-7089.md:11`。

**B. R30 阻断判断**

- **没有必须先解决的改名相关阻断。** 当前没有证据表明 42 条失败中有任何一条由 P2 改名解析、包名、路径或构建入口直接造成；相反，关键链路有同 blob 或纯符号/类型差异证明。
- **真正还缺、会阻止“宣称全绿”的证据：**
  - watcher 与 GenUI 的**同一 runner、同一隔离环境、同负载下的 7089/7c 事件时序对照**；当前只有跨运行证据和 blob 等价，足以排除“已确认改名回归”，不足以证明根因。
  - 6fb→7089 的**字面四目标重跑**。`unified-build-source-association.json` 已明确：7089 相对 6fb 实际 9 个变化路径（6 个文档 + 3 个 `packages/zody-server-cli` 的 test/tsup/spec），23 个工作区依赖闭包，明确排除 `@zody/server-cli`；它证明统一 CLI/server/web 功能源码未受独立桥影响，但**不声称 7089 新 commit 元数据重建字节相同**。因此 6fb 归档只能作限定关联证据，不能写成“7089 四目标已重跑”。
  - narrow 4 项冻结输入、strict19、签名、其他平台执行属于 R60/发行边界，不应笼统当作 P2 改名实现阻塞。
- **允许 R30 实施的条件：** 主控在 task-ledger 中把 R22 记为 scoped/conditional，而不是 verified；逐项登记 42 条失败、4 个套件级、2 条旧 architecture、knip、Main85、narrow 4 项及 watcher/GenUI 未解释边界的 owner、证据和限制；R30 实施后仍须执行 RENAME-ENV、目标构建/启动、G，并在 R20/R21 修复后重跑受影响检查。计划门禁见 `docs/plans/zody-full-divergence-rename-execution-plan.md:175-177`、`:181-185`、`:335`。

**C. 清理规则**

- **没有具体阻断缺口。** §1.4 已覆盖当前源码/未提交修改、可追溯提交、原始日志和失败证据、每类最新有效产物及输入/输出摘要、旧版本与 R02 冻结/回滚材料。见 `docs/plans/zody-full-divergence-rename-execution-plan.md:59-70`。
- **现有保留状态可接受：** `retention.json` 记录 4 个 6fb 归档、7089 stage、R02，以及 license-clean、固定工具链、共享 pnpm；stage 同卷搬存并记录 11191 文件哈希；最新 license-clean 为 `7089/1ead5e` 且工作区干净，仍在保留集合。被移除的 3 棵 R21 树均为 detached、`ancestor_of_task=true`、tracked/untracked 状态为空，且有提交可追溯；Docker 旧树先把独有 history 保留到 `refs/codex/evidence/zody-full-rename/docker-clean-cc648373`，再普通 remove，两改动文件与集成分支同 blob，未丢源码。见 `output/zody-rename-cleanup-20261104/retention.json`、`standalone-stage-relocation.json`、`worktree-audit/cleanup-result.md`、`worktree-audit/premoves.json`。
- **仅有非阻断的登记缺口：**
  - `retention.json.permanentEvidence` 是概述，未逐项记录 `resume-7089` 原始日志、`unit.vitest.json`、`case-comparison.json` 及两份 R22 报告的路径和 SHA；§1.4 要求逐项记录，建议下次清理前补齐。
  - `activeResources` 中 license-clean 未记录 `sourceCommit/tree` 和摘要；建议补 `7089/1ead5e`、干净状态及释放条件。
  - `retention.json.phase` 仍是 `R22 resumed, not accepted`；scoped 落账后应更新，避免后续清理误判。
  这些不影响当前 R30 实施，因为证据文件和受保护工作树都仍在。

**最终落账建议**

主控可记为：**R22 的 P2 改名解析与真实启动链 scoped/conditional PASS；允许 R30 实施；R22 仍非 full green/verified。** 明确保留 fullsuite 42 断言失败、4 个套件级失败、全量 architecture、knip、Main85、narrow 4 项及 watcher/stateStorage 未解释边界；不宣称 strict19、签名或其他平台通过，不放行发行。若主控门禁要求全部失败先归因，则本轮应暂不放行 R30。

