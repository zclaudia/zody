# R30 scope review 2

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`; read-only focused follow-up. v2 remains incomplete; this is not implementation acceptance.

**结论**

同意当前定性：v2 **不是完整可执行范围**，不能据此直接派 R30.2。你补充的 4 个活动 telemetry env、shared define 派生绑定、`scripts/build-time-config.mjs` 的 AUTO_UPDATE/下载/反馈 env 都属于 R30 硬切合同，不属于 R46 事件名变更；应作为作者已知缺口进入最终 patch，而不是用 v2 现状核销。

**原 5 项状态**

- Turbo：生产行 `turbo.json:54,119` 已补；但红测仍读 `build`/`test`，实际任务名是 `build:desktop-agent`、`@zody/cli#build`。测试目标必须修正，当前两红不能算有效证据。
- 默认 prefix：`env-config.adapter.ts:9` 及同一 provider 的输入/断言已覆盖，scope 闭合；仅源文件注释 `:1,12` 仍是旧前缀，属非阻断清理。
- APP_VERSION/BUILD_COMMIT：shared 声明、值、再导出、desktop/remote、CLI、telemetry 和测试已覆盖，scope 闭合；只保留 R30.1 的 negative case。
- BUILD_TIME：导出链和引用已覆盖，scope 闭合；R30.2 必须同步把 `packages/server/test/zodyRenameEnv.test.ts:86` 改为 `ZODY_BUILD_TIME`，否则切换后仍红。
- NSIS：仍阻断。`test-installer-preserve-files.mjs:42,60,93` 和 `test-installer-nsh-smoke.mjs:98` 仍是旧 `/DZCODE_INSTALLER_NSH`，且不在 v2 occurrence 集中；仅 fixture 和 compile test 更新会导致 producer/consumer 不一致。必须补这 4 行及当前 R30.1 compile-test delta。

**安全动作状态**

安全策略方向正确：旧、新敏感键都应从一般子进程和 tool passthrough 剔除；活动 capture 只读新键；R55 模板/parser 不动。但 v2 的唯一 writeSet 还未表达该语义：

- `packages/shared/src/runtimeEnv.ts` 的旧 denylist 行中，部分旧键被单次 rename；没有同时新增对应 `ZODY_*` 项，照 token 行执行会丢掉旧键过滤。
- `packages/desktop/src/main/desktopRuntimeEnv.ts:245-246,515-520` 尚未加入新键清除项。
- `node-repl` 的旧前缀断言 `d06-probes-fork.ts:105`、`cell-snapshot-execution.test.ts:142`、`subprocess-executor.test.ts:185` 仍被表达为旧→新 rename；应保留旧检查并新增新检查。
- 新增的 4 个活动 env `ZCODE_MODEL_TELEMETRY_ENABLED`、`ZCODE_TELEMETRY_DEVICE_MID`、`ZCODE_TELEMETRY_RUNTIME_SURFACE`、`ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION` 也必须按“旧新都拒绝、活动 capture 只读新键”纳入，而不能只做键值替换。
- Node REPL child 的 `1 pass` 是 allowlist 结果，不能证明 denylist 已修好；共享安全测试的 4 red 才是有效行为信号。

**新增已知缺口**

- `ZCODE_MODEL_TELEMETRY_ENABLED`、`ZCODE_TELEMETRY_DEVICE_MID`、`ZCODE_TELEMETRY_RUNTIME_SURFACE`、`ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION`：活动 env，需补生产读取、必要测试及安全 denylist 旧新双项。
- `ZCODE_TELEMETRY_REPORT_ENDPOINT` 及对应 `__ZCODE_TELEMETRY_REPORT_ENDPOINT__` 派生绑定：不能只改 define，还要覆盖 shared binding、再导出和实际消费者；不改 R46 事件名。
- `scripts/build-time-config.mjs` 的 AUTO_UPDATE、下载、反馈 env：属于 build-time config 生产/注入闭包，按 R30 硬切，保留外部 URL、secret ID 和事件名语义。

**R30.2 派发结论**

当前仍不可派。最小 gate 是：

- 补 NSIS 4 个 producer 行；
- 把安全动作落成旧新双项，不再用旧 denylist 单次 rename；
- 修正 Turbo 测试任务名；
- 同步 BUILD_TIME 测试绑定；
- 将上述 telemetry/env define 缺口并入最终 scope/diff；
- 由作者按 owner 做一次活跃大写 env/define 残留收口。

完成后再交 v3 patch；届时不重审 648 文件，只核销这些增量、基线/delta 和最终 active-key 残留。生产源码尚未切换，本轮不运行测试、build 或 install。

## 主控后续核对

作者已将 Turbo 测试改为实际的 `build:desktop-agent` 与 `@zody/cli#build`。新日志 `output/zody-rename-r30/implementation-v2/server-red-03.log` 及同名 `.exit` 记录 12 项测试中 10 项失败、2 项通过；本次两项 Turbo 失败来自目标任务仍使用旧环境键，是有效的切换前行为信号。此前检查不存在任务名的两项失败作废，原日志保留。此项纠正不代表完整补丁已通过审查或已经应用。

