# R20.4 剩余 basename 固定基线只读预检

本报告只依据 `1b042046c373fa91c5ed80b1501bcf0677f2eb39` 的 `git archive` 快照；未读取并发修改的产品工作树，未写产品、构建或运行测试。198 个原候选中 100 个已迁移，剩余 98 个旧路径均存在、目标无现存或 casefold 碰撞：62 个当前源码、36 个测试。每项旧/新路径、基线 SHA、分类和消费者原文见 `output/zody-rename-r20-basenames/remaining-plan/remaining-inventory.json`。

`consumer-plan.json` 为每一项列 R20.4 实施责任、保留原因、精确旧/新字面路径候选及所在文件/行：85 项有路径候选，12 项未发现当前字面路径但仍需动态核查，1 项有注释或动态复核。候选共 687 条，不能把它们当作自动替换指令：其中公共导出键、代码路径、runner、当前文档和可能的运行时字符串必须逐条区分；3353 条历史/保护/标识符等按原文保留，139 条上下文仍待人工判断。151 个 manualReviewPaths 继续排除，feature graph 由 R21、native 冻结材料不随此批改写；历史/现行的分类只是逐条审查线索，不构成按目录授权或豁免。`dynamic-targeted.json` 将动态/文件操作邻域收窄为涉及 13 个具体候选的 60 条证据；它包含邻近代码误报，且无法证明不存在跨文件拼接，实施者须逐条核对，不得将其当成全部需要改动的路径。

特别注意 Desktop 数据大小 worker 是原子集合：`packages/desktop/scripts/desktop-main-entrypoints.mjs:6` 的源码入口与输出键、`packages/desktop/src/main/zodyDataSizeWorkerClient.ts:14` 的 Worker URL、scanner/import 及测试必须同批核对；输出键是活动加载路径，不能只改源文件名。`packages/shared/package.json` 的 `./zcodeEndpoint` 公开子路径与 `apps/zody-cli/packages/cli/scripts/build.mjs` 对应 alias 及调用者也须作为契约一起处理；其他同名对象字段、日志、wire 和环境变量保留各自所有者。legacy reader 的文件名可按内部路径迁移，但旧数据语义和历史样本保持不变。现行 runner 包含根 `vitest.config.ts` 的明确测试路径和 CLI `package.json` 的明确 node-test 路径，见每项精确候选。

## workspace ignore E2E

`e2e-case-plan.json` 给出可实施方案：把 `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-workspace-zcodeignore.test.ts` 移为 `...workspace-zodyignore.test.ts`。固定提交中，除历史计划/台账外，没有旧或新 basename 的当前引用；上游 replay fixture 目录和 case manifest 目录中两种名字对应的四个 JSON 均不存在，所以基线没有仓内 fixture/manifest 需要改名。测试标题和 `ZCT-2096811705629528064` 是历史问题引用，不改；failure artifact caseId 基于测试标题而非 spec 文件名。

需要明确的行为是：`packages/desktop/test/e2e/helpers/upstream-replay-fixture-resolution.ts` 从 basename 去 `.test.ts` 派生 caseName，并用它匹配 case-local fixture/manifest；manual-review 默认按 WDIO glob 排除，显式运行时仍可按新路径匹配，未配置 case-local fixture 的手动 worker 走 capture；strict-case-local 在缺失该 case fixture/manifest 时失败。现有 `packages/desktop/test/upstreamReplayFixtureResolution.test.ts` 可补新 basename 的 fixture 缺失、strict 及 manual capture 场景，再用实际 runner 确认 glob 发现。显式配置的 fixture 路径保持调用者所给路径；本提交没有需要机械修改的历史 payload。若后续基线新增对应当前 fixture/manifest，应同步迁移具体条目，不因假设中的仓外 fixture 永久阻塞。

## 实施交接和限制

实施者须在 R01 的符号批完成后基于新提交重新读取 98 个当前文件、重新计算 SHA/碰撞和逐项消费者，按 `consumer-plan.json` 精确审阅生成移动/引用 patch；不能使用此快照覆盖新符号内容。移动后重建公共声明和实际产物，按目标测试 runner 收集并执行，根 typecheck/lint/changed architecture 单独记录；Desktop main/full architecture 的既有基线失败及冻结资源限制继续保留。此预检只提供逐项证据与计划，没有运行代码、生成产品 patch 或声称 98 项引用已全部语义核销。
