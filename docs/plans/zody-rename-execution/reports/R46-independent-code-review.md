# R46 independent code and test review

Read-only DeepSeek reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`. The first review required test corrections; the second accepted those exact corrections. Neither is full E2E or release acceptance.

## Initial review

**结论**
本轮只读复核 `HEAD=4f5f9951`，98 个 `source-hashes.json` 路径重新计算的 SHA256 全部匹配，未发现产品源码漂移。产品实现中未发现新的明确改名错配，但当前测试证据仍有 2 个会实际失败的测试缺陷和 2 个关键断言缺口，因此**不能据此判定 R46 实现验收通过**。

**具体阻断**
- `packages/services/test/zodyAgentService.test.ts:335`、`:465`、`:541`、`:613`、`:1546`、`:1573` 仍使用旧协议名 `ZCode Protocol`，而严格 schema 要求 `Zody Protocol`。主控已复现 12 个失败；应只修这 6 个活跃 fixture/预期值，不放宽 schema、不删 retry。修改后需刷新 98 路径 hash/manifest。
- `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-ttft-diagnostics.test.ts:233` 仍先按 `zcode.local_ttft.` 过滤，随后才检查 `zody.local_ttft.duration`，导致 `count()` 恒为 0；E2E 实际运行时会在有 TTFT root 的用例超时或断言失败。这里应改为 `zody.local_ttft.`。这是测试缺陷，不是当前生产源码缺陷。

**需要补强的证据**
- `apps/zody-cli/packages/telemetry/tests/otlp-integration.test.ts:124-126` 已用 `requests.length === 2` 约束“单 trace 请求 + 单 metric 请求”，所以不应再把 `find()` 误判为无约束重复批次；但 `:201` 只断言 metric descriptor 数量为 1，没有断言 `zody.agent.turn.duration` 的 histogram `dataPoints` 数量和 `count`。建议明确断言 `dataPoints.length === 1` 且 `count === 1`，并保留旧 descriptor 缺失断言。`shutdown()` 后的额外 cumulative export 不是本次单次逻辑点的充分反证；spec 允许重试/多次 HTTP 批次。
- TTFT 只有在现有测试中验证了部分 metric count；`packages/desktop/test/localTtftExportDiagnostics.test.ts` 未断言 resource/scope。应补 `service.name=zody-local-ttft`、`zody.telemetry.schema_version=1`、`instrumentationScope.name=@zody/local-ttft`，并断言旧 scope 缺失。源码当前在 `packages/desktop/src/main/localTtftExporter.ts:39-42,80` 和 `packages/desktop/src/main/localTtftSpans.ts:79` 正确使用新名称，但没有测试保护。
- `apps/zody-cli/packages/adapters/tests/logging.test.ts:66-80` 直接调用 `createLogger("zody")`，属于机械自证，不能证明真实生产调用点已迁移。`createZodyApp` 的 startupKind `zody_app` 测试是真实路径，但日志 category 仍缺少一个实际 producer 断言；这不阻止产品代码推进，但不应计入完整 producer 覆盖。

**已核销**
- OTLP 集成测试是真实 loopback HTTP、gzip/protobuf 解码；trace root `agent_turn` 断言为 1，metric 请求和 trace 请求各 1 个。
- `ZodyAgentProcessManager` 真实子进程退出 → reporter `onExit` 一次 → `appARMSBootstrap.beforeReport` 实际过滤新 marker 的 console duplicate；新 marker 存在、旧 marker 缺失。
- 默认/显式/historical SQLite 路径：临时真实 SQLite 关闭重开、旧/新/custom message 与 usage 保留；新写默认 `zody-agent`，显式 agent 不变；restore 脚本新写默认 `zody-agent`。
- `packages/services/src/telemetry/telemetryCore.ts:36` 的 `["zcode:session_create:v1", userId, sessionId]` seed 未改，既有可靠性测试仍覆盖。
- 网络 interface 实际 producer 位于 `packages/services/src/zody-agent/zodyTaskServiceAdapter.ts:5649-5653`，已改为 `zody_agent.model.*`。
- `vitest.config.ts` 的 `__ZODY_TELEMETRY_REPORT_ENDPOINT__` 修复只影响测试注入；生产端仍由 `scripts/build-time-config.mjs` 定义，未改变生产 endpoint。
- R46 changed diff 未触碰 R45 artifact/media resolver；未发现对旧媒体拒绝和 R45 URI 边界的回退。

## Targeted correction review

**Review2 结论**
定点复核通过 test-scope，未发现新的具体产品阻断。相对 `source-hashes-before-review-fixes.json` 仅 5 个测试文件变化，产品源码未改；当前 98 个路径 SHA256 全部匹配。

**上轮问题核销**
- 六个 `protocol.name`/`protocolName` fixture 已改为 `Zody Protocol`；`packages/services/test/zodyAgentService.test.ts` 不再有活跃旧值。已落盘 `controller/service-protocol-02` 为 40/40，原 12 失败记录保留。
- `apps/zody-cli/packages/telemetry/tests/otlp-integration.test.ts:201-210` 现同时断言 `zody.agent.turn.duration` 只有一个 metric、一个 histogram dataPoint、count=1，并断言无旧 `zcode.` metric；结合 `requests.length === 2`，不再只是 descriptor 名称检查。
- `packages/desktop/test/localTtftExportDiagnostics.test.ts:111-126` 现验证真实 trace/metric resource 的 `service.name=zody-local-ttft`、`zody.telemetry.schema_version=1`、新 scope `@zody/local-ttft`，并检查旧 resource key 和旧 scope 缺失。
- `packages/desktop/test/e2e/.../conversation-session-ttft-diagnostics.test.ts:233` 的旧 `zcode.local_ttft.` filter 已改为 `zody.local_ttft.`。
- `apps/zody-cli/packages/bootstrap/tests/provider-registry-app-runtime.test.ts:47-71` 现通过真实 `createZodyLoggerFactory` spy 验证 `createZodyApp` 使用 `zody` category，且旧 `zcode` category 未出现。
- restore 测试变化为格式化，仍保留真实临时 SQLite、旧/新/custom 身份和真实 restore script 行为。

**证据状态**
已落盘 controller 记录：`collector-02` 2/2、`ttft-02` 2/2、`bootstrap-review-02` 9/9、`service-protocol-02` 40/40；`typecheck-02` 与 `lint-02` exit 0，lint 303 warnings。3 个正式 E2E 仍未运行，因此不能宣称完整 R46/E2E 通过；最终 runtime 验收仍以主控最终 manifest 为准。
