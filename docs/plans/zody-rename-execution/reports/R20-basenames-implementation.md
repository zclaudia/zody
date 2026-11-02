当前候选：`1b042046c373fa91c5ed80b1501bcf0677f2eb39` 已提交；DeepSeek 发现的 audit 分类遗漏已在 `d49aecef` 修复并复审 PASS，见 R20-symbols-batch-03-deepseek-review.md。下文是实施时的过程记录。

# R20.4 basename 安全子集实施

基线 `e79eab7d35ba576140ff57698ca0fff122629366`。以新基线重新扫描、计算 SHA 和生成源码 patch；与旧预检比较未发现新增产品消费者。刷新后 source/test patch 在主工作树 `git apply --check` 均退出 0，再按 source → test 顺序应用。原批准的 99 个中有 1 个 E2E 测试因 case-name 关联未闭合而退回；本批实际移动 25 个源码、73 个测试/测试 helper，共 98 个。准确旧/新路径和基线 SHA 见 `output/zody-rename-r20-basenames/candidate-files-effective.json`。

移动验证对每个新文件比较 e79 原字节及其经审定的模块路径替换，98/98 一致，旧路径均不存在、新路径均存在；详情见 `move-verification-effective.json`。新增的 54 处源码模块消费者及 helper 的 10 个导入均随同修正；未改同名标识符、wire/env 或插件身份。扫描所选 25 个源码的 import/from/require/mock 行未发现旧 basename（`remaining-import-audit.json`）。动态路径审计针对所选完整 basename 未发现动态候选命中，但不能将此解释为已穷举所有可能的分段拼接。14 个基线存在的保护文件字节均未改变；没有 install、修改锁、native 冻结输入或用户数据。

R21 feature graph 的三个精确路径映射在 `r21-graph-candidates.json`，本批未修改图。退回的 E2E 测试 `conversation-session-workspace-zcodeignore.test.ts` 不是永久保留：`resolveConversationSessionCaseName()` 按 spec basename 去 `.test.ts` 派生 caseName，`hasUpstreamCaseLocalReplayFixtureForWorker()` 和 `resolveUpstreamReplayFixturePaths()` 用该名字查找 fixture/manifest；manual-review 默认从 WDIO 运行集中排除。跟踪树中未发现新旧对应 case-local fixture/manifest，但未能证明所有配置来源一致。`remaining-owned.json` 记录了后续将新测试 basename、新 caseName 与现有 fixture/runner/当前文档一起核销的方案，或经验证使用现有稳定 caseId 机制；历史 payload/ID 不机械重写。本次没有执行原生 E2E。

## 验证

所有命令使用 Node 24.14.0；除 CLI 工作区测试外 cwd 为 `/Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename`。

- `pnpm typecheck` 最终稳定工作树重跑退出 0。首次与 E2E 文件退回并发时退出 2（TS6053 暂时缺文件），随后重跑通过。
- `pnpm lint` 退出 0，303 warnings；`pnpm architecture:check --changed` 退出 0，仅代表变更检查。此前已确认 main 单独类型检查 85 项及 full architecture 两项基线问题，不将它们写为通过。
- `pnpm exec tsc -b --force packages/shared packages/services packages/server packages/ui` 退出 0，强制重建受影响声明；生成的 shared/services 公开声明指向新路径，未用旧 dist 作为证明。
- 根 `pnpm exec vitest run` 加 `candidate-files-effective.json` 中 69 个 `packages/**/test/*.test.ts` 目标：69 文件、575 测试通过，退出 0（完整日志 `root-tests.log`）。
- cwd `apps/zody-cli` 执行 `../../node_modules/.bin/vitest run`，参数为三个已迁移的 bootstrap 测试及 10 个 fake-app helper 直接消费者（含 `zcode-protocol.test.ts`）：13 文件、211 测试通过，退出 0（参数和输出见 `cli-tests.log`，调用脚本可由实施记录复原）。
- 源码直接消费者 11 个测试文件 `pnpm exec vitest run`：11 文件、101 测试通过，退出 0；列表见 `source-consumer-tests.json`，日志 `source-consumer-tests.log`。

本批未提交；余下 97 原预检候选以及本次退回的 E2E 项继续逐项核销，不能视为 R20.4 已完成。

CLI 测试精确复跑（先 `cd apps/zody-cli`，且 Node 24.14.0 在 PATH）：

```sh
../../node_modules/.bin/vitest run packages/bootstrap/tests/zody-protocol-message-mapper.test.ts packages/bootstrap/tests/zody-protocol-telemetry-lifecycle.test.ts packages/bootstrap/tests/zody-protocol-transport.test.ts packages/bootstrap/tests/cua-startup-identity.test.ts packages/bootstrap/tests/dynamic-workflow-policy.test.ts packages/bootstrap/tests/model-io-preferences.test.ts packages/bootstrap/tests/protocol-runtime-shutdown.test.ts packages/bootstrap/tests/session-event-store-retention.protocol.test.ts packages/bootstrap/tests/session-resident-pool.test.ts packages/bootstrap/tests/session-selection-protocol.test.ts packages/bootstrap/tests/shared-context-selection-import.test.ts packages/bootstrap/tests/v4-auto-drain-race.test.ts packages/bootstrap/tests/zcode-protocol.test.ts
```

## 收集与文件清单复核

- 原 11 个源码消费者测试运行时确实先按 `candidate-files-effective.json` 映射路径；`source-consumer-actual-argv.json` 和 `actual-test-argv.json` 保存原执行 cwd 与完整 argv。后者同时列出根 69 文件、CLI 13 文件的原运行参数。
- 使用 `vitest list --json=<独立 output 绝对路径>` 后的收集结果逐文件保存在 `collection-summary.json`：根 69/69 文件、575 测试；源码消费者 11/11 文件、101 测试；CLI 13/13 文件、211 测试。三组均无缺失或额外文件。收集结果不替代主控统一复验的测试执行。
- `candidate-product-files.json` 包含 98 组移动旧/新路径、45 个消费者文件及合并去重后的 134 个当前产品文件。
- 首次尝试收集时误将 `--json` 后首个测试路径当作输出文件，短暂覆盖了 `packages/client/test/zodyProtocolV4TopicEnvelope.test.ts` 与 `packages/desktop/test/zodyDataSizeTelemetry.test.ts`。两者已从 e79 对应旧文件重建并应用本批审定路径替换，`restored-candidate-sha256.json` 记录预期和实际 SHA-256 一致；98 项复核无差异。原测试在该事故前执行，恢复后未自行重跑；按主控要求交由其统一复验。
