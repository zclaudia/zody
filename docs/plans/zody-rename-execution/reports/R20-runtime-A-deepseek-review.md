# R20 runtime A + CUA：DeepSeek 独立审查

**结论**
`PASS`（仅限定 `cc19c32b91bb1ea80e9a7018d3b87b48f8e3d3e6` → `a3a0d9c93bc61289fcb32f6538ccaea326e0631c` 的 A+CUA 代码范围）。未发现 A 阻断项；不代表 runtime 857/CUA 全完成、R21/R22 或发行通过。

**独立核实**
- 294 files = 291 M + 3 A；其中 288 产品/spec/graph + 6 metadata。288 集合与 `output/zody-rename-r20-runtime-next/runtime-closure/file-hashes.json` 完全一致；用 `git cat-file` 复算 288×2 个 SHA-256，0 mismatch。`2d9→cc19` 仅 2 个 Dockerfile + 6 metadata，无 TS/JS/lock/package/tsconfig 变更。
- 538 条声明：独立 TypeScript 解析 58 个声明文件，0 条旧声明残留、0 条新声明缺失；`538-record-audit.json` 的 baseline/current 行号集合逐条复核 0 mismatch。ledger 539 条 = 538 + CUA pair；491 auto + 47 manual，manual ID 与 `applied-47-bindings.json` 完全一致。
- 高风险闭合：`RunDependencies` 属性在 `apps/zody-cli/packages/cli/src/cli-types.ts:90`、`run.ts:277`、`cua-launch-session.ts:463` 同步；`NodeApiClient` 的 DI key 在 `packages/services/src/providers/api/nodeApiClient.ts:22` 及 `node.ts:1146` 同步；`TelemetryCore` 在 `telemetryCore.ts:67`、`:475` 同步。
- 外部契约：3 个短名仅在 `conversation-telemetry-facts.ts:120`、`server-operations.ts:337`、`background-task-notifications.ts:82` 改局部变量，`meta.zcode` 与 `zcode:` 键保留；5 个 `Error.name` 字符串保留；`ServiceChannels` 值 `channels.ts:112,116,118` 未改；`ZCODE_PROTOCOL_NAME = "ZCode Protocol"` 保留。
- CUA：`packages/zody-cua/broker-server.js:155`、`broker-server.d.ts:211`、`packages/services/src/node.ts:422`/`:677`、`packages/zody-cua/test/control-protocol.test.ts:1119` 闭合；旧导出红、新导出绿日志均在。graph 仅 7 个 symbol leaf 变化，372 nodes/726 edges 不变；devdocs 21 个 source anchor 精确同步。
- 验证记录：root 80 files 首跑 `1055 pass / 1 fail / 1 skip`、exit 1（旧 resolver 源码断言），修正后单项 `21/21`、exit 0；CLI `36 files/514`、Node `212+42=254`、graph `4/4`；root typecheck/lint exit 0（303 warnings）；architecture 0 violations；CLI build `23/23`、0 cached，CLI typecheck `34/34`（其中 21 cached）；Main 85 diagnostics exit 1，且与旧日志 SHA-256 完全一致。

**非阻断缺口 / 后续**
1. `root.log` 的完整 80 文件套件在测试断言修正后未再整体复跑；合并/发布前应补跑完整套件，不能只凭 21/21 宣称全绿。
2. `output/zody-rename-validation/runtime-a/main.log` 仍 exit 1、85 条诊断与既有基线字节一致；这是独立的 Main 门禁，不能记为通过。
3. bootstrap 原始两次 5000ms 超时仍保留；7c 祖先 5/5、静态 import 后候选 5/5，但模块加载接近阈值的原因未证明。发布前应做固定候选的重复干净运行，不建议仅凭单次通过收口。
4. CLI build 来自实施者日志、主控未重跑；CLI typecheck 有 21/34 cached。当前证据足够审查绑定，但不构成一次零缓存全量验证。
5. `r20-symbol-migrations.json` 的 batch `candidate`/`review` 仍为 `null`；PASS 后应写入 `a3a0d9c9…` 与本次 review receipt。B/C/D、R20.5、R21/R22 仍开放。

**边界**
本次全部结论基于固定 git 对象与已保存日志；当前工作树已被下一批 B/C/D 写入改动，未作为 A 候选。未执行 build/install/UI/发布。
