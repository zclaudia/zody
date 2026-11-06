# R20.4 first-group independent review

Candidate: `6720cfe22b8e16e6abcc4abbeee0d084f17594cb`.
Reviewer: DeepSeek (`deepseek-flash`), read-only.

**结论**
`PASS`（仅限固定候选 `6720cfe22b8e16e6abcc4abbeee0d084f17594cb` 的 R20.4 首组；不代表 R20.4 全量或 P2 完成）

**已核查**
- 固定 diff `854ddf60..6720cfe2`：48 个文件，40 个产品当前路径加 2 个 basename 移动；旧路径已消失、新路径存在，均由 `substep4.basenameCandidates` 覆盖。151 个 manual-review 路径没有 diff；native、lock、frozen、trust 无改动。
- ProcessManager 7 个类型、class、旧模块路径与 exporter/mock 已闭合：源码、测试及 `vi.doMock`/`vi.doUnmock` 均使用 `zodyAgentProcessManager.js` 与 `ZodyAgentProcessManager`；`vitest.config.ts:8` 已指向新测试文件。
- 外部对象键、env/wire/serialization 未改：`zcodeAgentCommandResolver`、`zcodeAgentNativeRuntime`、`zcodeAgentNativeRuntimeResolver` 及 `ZCODE_*` 键保留。对核心源码做符号归一化后仅剩预期路径/测试夹具差异。
- 声明产物可信：`armsRumShared.d.ts` 与 `.d.ts.map` 的入库字节和隔离 emit 输出一致；map 为 `sources:["armsRumShared.ts"]`，报告中的 SHA256 也匹配。
- `genUiOutputEnv.test.ts:31` 的 `.zody` 断言对应真实数据根，仍是精确断言；`zodyAgentProcessManager.test.ts` 中 `"zcode-cli"`→`"zody-cli"` 是已记录的实际目录夹具修正，不是放宽断言。
- 读取的 controller 日志显示 113/113、1/1、19/19、176/176，共 309 项；root typecheck/lint 为 0/0（303 warnings）。main tsc 仍为 85 条，且与独立基线逐条相同；不视为 main 通过。本次未重跑测试、未读写源码，也未使用当前 mutable 工作树作为候选。

**非阻断剩余**
- `docs/plans/zody-rename-execution/reports/R20-symbols.md:3` 和 `:23` 仍写“尚未提交/本组未提交”，与固定 commit `6720cfe2` 不一致；建议改为已固化候选的表述。
- `ZCodeAgentNativeRuntimeResolver`/`Context`、内部分注入属性和 1602/196 余量仍在后续 R20.4 组；`packages/services/src/node.ts:114`、`packages/desktop/src/host/cuaNarrowAgentRuntime.ts:6` 是预期剩余，不是本组失败。
- 旧名称注释尚存于 `packages/services/src/node.ts:1751`、`packages/services/src/zody-agent/zodyAgentProcessManager.ts:4`、`packages/zody-server-cli/src/runtime/agentWiring.ts:26`，仅属文本收尾。

Controller clarification: the first group intentionally left LocalServices injection option names unchanged. Subsequent source tracing classifies those four option keys as internal DI interfaces, distinct from the existing Host message fields; their next-group migration must preserve the actual wire fields. This review does not authorize a wire rename or exempt internal DI names indefinitely.
