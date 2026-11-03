# R20.4 batch04: independent DeepSeek review

Reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cc4-82c8-7cc2-a81c-fee2d8b18b67`; read-only fixed3cb3a005→677771fe. Raw response follows.

**结论：PASS（限定 R20.4 batch-04 符号迁移）**
不是全仓改名、R21/R22 或发行验收通过。本次只读核验固定提交与产物，未运行 build/测试/UI；验证日志为读取 Terra/主控已有记录。

**范围与产物完整性**
- 固定范围成立：`3cb3a0050fb47771305fe084852fc6aed994eb92` → `677771fef8ea7b14498668d7b52057bdf7c1bef4`，702 文件 = 695 产品 + 7 报告/账本；产品集合与 `final-candidate-audit.json` 的 695 项完全相等，无多无少。
- 695 文件的 `beforeSha256`/`finalAfterSha256` 与 git 实际 blob 全量一致，0 偏差；3,873 个 `inputHashes` 与 base blob 全量一致，0 缺失；`unauthorized=0`、`manualConflicts=0`、`appliedByteMismatch=[]`。
- 694 文件与联合补丁逐字节一致；仅 `apps/dev-docs/src/data/protocolDocs.ts` 在补丁结果 `13a5a8…` 之上追加两处 path 修正，最终 `74755b…`，与 `intentionalPostPatchChanges` 完全对应。

**绑定与高风险符号**
- 600 条 = 565 bound + 27 manual（6 value-merged + 20 string-ref + 1 unresolved）+ 8 先前已迁移；592 条 ledger 记录全部可回溯到 `bc-bindings.json`，无孤立/缺项。
- 16 个同名多记录均为不同模块/不同符号，引用集分离：`ZodyProtocolClientRequestOptions`（bootstrap vs services）、`ZodyTaskTarget`（services interface vs shared alias）、`ZodySessionCreateParams`（services interface vs protocol schema）、`ZodyProvider`（providers 联合派生 vs core 字面量）。未发现串绑；`bc-target-name-collisions.json` 为空，checker/language-service 抽检 8 项一致。
- 三组 DI interface/const：`IZodyTaskService`、`IZodyAgentService`、`IZodySessionService` 均保留 interface + const 合并；descriptor 的 `channelName` 仍取 `ServiceChannels.ZCodeTask/ZCodeAgent/ZCodeSession`，注册、`getOptional`、`ProxyChannel.toService` 均使用新 descriptor，运行时键未变。动态 `import("../src/index.js")` 解构已改为 `IZodyAgentService`。
- `ZodyAgentSessionRuntimePreferencesRequest` 仅一处声明 `packages/services/src/zody-agent/zodyAgent.ts:370`、一处 public `export type` `packages/services/src/index.ts:161`，无重复导出。
- 两处 devdocs source 已精确指向 `packages/shared/src/zody-protocol-legacy-types.ts:259,446`（`ZodyMessageInfo`/`ZodyMessagePart`）；其余三项 `ZodyTaskMeta`、`ZodyActiveToolCall`、`ZodyWorkspaceRef` 均能解析到声明。

**保留边界**
- `packages/shared/src/channels.ts` 完全未变，旧 `ZCodeTask: "zcode-task"`、`ZCodeAgent: "zcode-agent"`、`ZCodeSession: "zcode-session"` 键值保留。
- 未见 env/wire 字面量变更；未见 schema 标识符变更；31 个 frozen-native 路径全部未进入 695 文件；`git diff --check` 通过。
- 运行日志支持：root typecheck exit 0；lint exit 0 / 303 warnings；CLI build 23/23、0 cached；CLI typecheck 34/34、0 cached；root 168/1914、target 7/99、CLI 6/45、node 2/176、devdocs 7/18 均为 exit 0（后三者与重跑记录）。

**非阻断 finding（4 项）**
- 根测试首次整体 exit 1：`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`，168/1914 断言通过但有 1 个 unhandled error；单文件 9/9、完整重跑 exit 0。根因未定位，不能称为“单次干净全绿”。后续应在干净 CI 重跑或隔离该 teardown 链，勿用延时吞错。
- Main 比较基线取自上批 `controller-basenames-final-main.log`，不是 3cb 新基线；归一化包含已登记改名与 union 排序。建议补一次 3cb 基线 `tsc -b packages/desktop/tsconfig.main.json` 留档，避免比较可复现性依赖旧基线。
- `architecture-retest.log` 显示 exit 0，但 `architecture.log` 与主控日志均为 exit 1（`pluginUiBridgeService.ts` 404 行）。报告采用 exit 1 正确；建议删除或标注该 retest 的调用条件，避免误读为架构通过。
- 旧名文本残留：`packages/services/src/zody-agent/zodyTaskServiceAdapter.ts:300` 的错误文案仍含 `IZCodeTaskService`，另有若干注释旧名。属运行时错误文案/注释，不是绑定；已由主控声明后续文字批处理，纳入后续批次即可。

**范围外/不宣称**
- Main 单独 tsc 仍为 85 诊断失败，不作为通过；architecture 仍因 404 行既有违规失败；本次不宣称全仓类型、运行时 function/binding、R21/R22 或发布通过。
- 本次未重审其他 root owner、历史批或 R01 未提交文档，也未运行根构建。
