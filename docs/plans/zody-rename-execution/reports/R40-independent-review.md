# R40 independent interface acceptance

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a456-8275-7f92-ade9-5b96ca871195` (DeepSeek, read-only).

**复核结论**
R40 限定接口阶段可接受（PASS），未发现阻断。shared/RPC 接口可冻结并交 R41/R42/R44 消费；不宣称端到端、混布或发布通过。

**证据**
- 当前 13 个源码/spec SHA 与 `results.json` 完全一致，源码已按冻结状态核对。
- writer focused 97/97；主控独立复跑 `packages/shared/test/handshake.test.ts` + `packages/rpc/test/serialization.test.ts` 17/17，`controller-verify/runner.json` exit 0、`run.log` 通过。
- Agent protocol 67/67；lint 0 errors/303 warnings；architecture 0；typecheck exit 2 仅 `packages/server/src/entry-stdio.ts:41` 与 `packages/server/src/remote/handshake.ts:79` 两处 R41 旧 literal（ack 重复诊断不计新项）。
- 未发现越界源码、新依赖或新 worktree；临时根已清理。

**冻结交接**
- R41：接入上述两处 hello/ack；同步旧字面 fixture，含 `apps/zody-cli/packages/bootstrap/tests/zody-protocol.test.ts:3194`。不得给 Agent LF JSON 套 RemoteServer 握手。
- R42：直接消费冻结常量；`packages/desktop/src/main/remote-access/gatewayDeviceTransportHello.ts:103` 的 ack 需补 `protocolVersion`，并落实旧/缺失 ack 的 `incompatible-version` 关闭。Hono `handleProtocols` 方案确认无需 R40 增加 transport API。
- R43：更新 `packages/server/src/remote/serverBundleDeployCheck.ts:8` 的旧嵌套标记能力探测。
- R44：接主桥/IPC 两端及硬编码内部 channel fixture；不误改 `PluginSandboxChannels`、CodingPlan 官网合同。
- R48/平台：真实新旧混布、手机双链路、旧持久化 `protocol.name` 快照及三平台运行仍需后续验证。

Controller accepts the shared/RPC interface checkpoint with the explicitly retained R41 typecheck failures. R41/R42/R44 must consume these interfaces before integrated validation; no release or mixed-version success is claimed.

