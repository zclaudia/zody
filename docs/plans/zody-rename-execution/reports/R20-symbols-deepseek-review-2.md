# R20.4 second-group independent review

Candidate: `e79eab7d35ba576140ff57698ca0fff122629366`.
Reviewer: DeepSeek (`deepseek-flash`), read-only.

**结论**
PASS — 仅接受固定候选 `e79eab7d35ba576140ff57698ca0fff122629366`（base `6720cfe22b8e16e6abcc4abbeee0d084f17594cb`）的第二组符号/DI 变更；不代表全 R20.4、R20 或 P2 通过。未发现阻断问题。

**核查证据**
- 固定 diff 共 57 个文件：46 个产品路径 + 11 个文档/账本路径；46 个产品路径的 SHA256 与记录的 `candidate-file-list.json` 全部一致。
- 授权覆盖正确：44 个路径在 `sourceFiles`；`packages/services/src/zody-agent/zodyAgentProcessManager.ts` 由 `basenameCandidates` 的旧路径映射覆盖；`packages/desktop/src/shared/armsRumShared.js.map` 由 `generatedCompanionFiles` 明确授权。151 个 `manualReviewPaths` 均未改动。
- 23 条迁移记录逐项存在。四个旧 DI 名 `zcodeAgentCommandResolver`、`zcodeAgentNativeRuntime`、`zcodeAgentNativeRuntimeResolver`、`zcodeAgentSpawnFallbackCwd` 在活动源码中已无引用；Host 只在本地选项使用新名，真实 wire 字段仍是 `msg.agentSpawnFallbackCwd`（`packages/desktop/src/host/index.ts:2845`），validation、main 和 desktop host 进程侧未改。
- 19 个 runtime/env 绑定的旧可执行名已清除；剩余命中仅为注释、测试描述或历史/人工路径。未发现 `ZCODE_*`/`__ZCODE_*__`、telemetry、persisted key、wire 字符串值被替换。
- mock/namespace 已同步：例如 `desktopRuntimeEnv.test.ts` 的 mock 导出改为 `sanitizeZodyRuntimeEnv`，`appARMSBootstrap.test.ts` 使用并断言 `shared.mapZodyEnvToArmsRumEnv`；没有保留旧导出别名。
- `armsRumShared.ts`、`.js`、`.js.map`、`.d.ts`、`.d.ts.map` 与隔离 emit 产物逐字节一致；JS map 的 `sources=["armsRumShared.ts"]`。首次 emit 的 `TS2724` 失败日志、shared 重建成功日志和重试成功日志均存在。
- core → adapters → bootstrap → CLI 的 build 日志均为 exit 0；新 dist 扫描未发现旧绑定，仅命中解释性注释。记录的定向测试合计 376/376：根 143、bootstrap 19、CLI 176、core 38；根 typecheck 0、lint 0 且 303 warnings。
- Desktop main 仍为 85 条诊断；与基线比较为 0 新增/0 消失，三条完整文本仅 union 成员排序不同。不能将 main 记为通过。

**非阻断修复**
- `docs/plans/zody-rename-execution/r20-symbol-migrations.json:122` 的 batch 2 `candidate` 仍为 `null`，`:315` 的 `review` 仍为 `null`；本组源码可接受，但最终账本收口前应写入 `e79eab7d...` 和本次复核结论。
- `docs/plans/zody-rename-execution/reports/R20-symbols-next.md:3` 仍写“尚未提交”，而固定候选已提交；应更新状态或明确该句是历史准备段。
- 仍有非阻断的旧名注释/测试描述，例如 `packages/shared/src/env.ts:4`、`packages/shared/src/runtimeEnv.ts:74`、`packages/shared/src/runtimeEnv.ts:152`；建议交 R20.5 或随最终文档清理，不影响运行行为。

**范围限制**
- 本次只读检查固定 commit 与已记录日志/产物，未重新执行 install、build、typecheck、lint 或 376 项测试；不能把静态阅读等同于运行行为通过。
- `main` 的 85 条诊断、完整 architecture 的两项基线问题仍未解决。剩余 internal symbols、99 个 basename、R21/R22 及后续阶段不在本组 PASS 范围内。
