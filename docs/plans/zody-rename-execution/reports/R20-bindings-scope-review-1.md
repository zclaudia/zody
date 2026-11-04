# R20 bindings seed scope review

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`, DeepSeek. 26-name seed only; source hash rebind and complete handoffs remain.

**核验结论**

**条件 PASS（仅限 26 个 seed 名称）**，不是全部 bindings 闭合，也不是执行授权。代码闭包整体可靠；dispatch 前需处理下列具体遗漏/串行条件。

**已核验**

- 26 个名称、91 个写路径、266 个 occurrence 一致；mapping 共 268 个 occurrence，减去 `scripts/doctor-macos-release-app.sh` 的 2 个独立 shell 局部变量，正好 266。
- 在 `04860520` 上按 `git grep -w` 核对，26 个名称的代码路径/行集合与提案一致；仅一个非代码文档位置不在提案内（见下）。
- deep CLI 路径已覆盖：`contracts/src/index.ts` 再导出、`telemetry/src/bootstrap.ts` 从 `@zody/contracts` 导入、adapters/bootstrap/debug 等嵌套 workspace 均有 occurrence。
- 再导出、mock export key、source-assertion string 均已覆盖：
  - `packages/shared/src/index.ts:7`
  - `apps/zody-cli/packages/contracts/src/index.ts:105`
  - `packages/desktop/test/desktopRuntimeEnv.test.ts:46`
  - `apps/zody-cli/packages/adapters/tests/runner-debug-storage-rollback.test.ts:9`
- 11 个原子组覆盖全部 26 个名称且无重复；第 5 组 68 个写文件与写集一致，shell 局部变量已正确排除。
- 90/91 个写集 hash tuple 同时匹配 `04860520` 与当前工作树；唯一例外是 R45 正在写的 `create-app.ts`。
- `ZCODE_HOME_DIR` 的两处 TS 局部声明与 shell 局部变量已正确区分；`ZCODE_AGENT_MODE_OPTIONS` 的 shared/UI 两份独立声明均已覆盖。
- 值保持不变：`.zody`、`Zody Agent`、`"zody"` process prefix、source header 值均未改；只改 identifier。
- 26 个名称和 91 个路径中无 NodeREPL flag、wire/meta、错误码、native/output/reports 路径；native 8 项仅为 evidence/snapshot。

**具体遗漏/条件**

- `docs/remote/zcode-agent-remote-deployment.md:57` 是 tracked、非冻结的 `ZCODE_DATA_ROOT_DIR_NAME` 文档引用，未进 26 或 91 路径。若文档不在本批范围，应明确记录“代码闭包完整、文档由 docs owner 后续更新”；否则应补入写集。当前提案“no missing non-frozen paths”的表述需要收窄为“no missing code paths”。
- `create-app.ts` 的 hash 来源混合：`gitBlob` `d8aca0…` 匹配 R45 当前工作树，`sha256` `9e6f1e…` 匹配 `04860520` HEAD，而当前工作树 raw SHA 是 `c2c0fe…`。occurrence 行 45/406 在两个版本一致，但 dispatch 前必须在 R45 接受后重新计算 blob/SHA 并重生成 occurrence；不能把当前 tuple 当原子基线。
- R46 交集不止 `packages/shared/src/process-diagnostic.ts`。对照 `R46-frozen-proposal.json` 的实际 production 写集，R20 还与其重叠：
  - `apps/zody-cli/packages/adapters/src/logging/index.ts`
  - `apps/zody-cli/packages/bootstrap/src/app/create-app.ts`
  - `apps/zody-cli/packages/telemetry/src/bootstrap.ts`
  - `packages/services/src/zody-agent/zodyAgentProcessManager.ts`
  - `packages/services/src/zody-agent/zodyAgentService.ts`
  - `packages/services/src/zody-agent/zodyTaskServiceAdapter.ts`
  - `packages/shared/src/process-diagnostic.ts`
  应按全部 7 个路径与 R46 串行/交锁，而不是只处理 process-diagnostic。`create-app.ts` 同时受 R45、R46、R20 约束，建议顺序 R45 → R46 → R20 或按文件显式交接。
- R20 文件内仍有已登记的其他 owner 残项，例如 `ZCODE_PROCESS_DIAGNOSTIC_PREFIX`（R41）、`ZCODE_AGENT_PROVIDER`/`COMMAND_AGENT`/`ENABLED_AGENT_PROVIDERS`（provider identity owner）、`ZCODE_AGENT_LIFECYCLE_LOG_MARKER`（R46）。本批可保留旧名，但若这些 owner 写同一文件，必须串行；不能宣称这些文件里的 `ZCODE_*` 已全部切换。
- `ZCODE_MODE_OPTION_LABEL_IDS`、`ZCODE_MODE_OPTION_DESCRIPTION_IDS`、`ZCODE_TASK_MODE_*`、`ZCODE_INTERACTION_BEHAVIOR_OPTIONS` 目前没有直接单测；typecheck/lint + 既有 UI 测试是实际闭包。若要求逐名称红测，应在 dispatch 前补，否则把这一项作为已知验证边界。
- 26 只是 seed：extra audit 已记录 70 个名称、825 个 occurrence、173 个路径；其中 `ZCODE_PROTOCOL_NAME` 15 个 occurrence/7 个路径（值 `"Zody Protocol"` 不变）为确认遗漏。本结论不覆盖这些残项，不能写成“全部 bindings 已闭合”。

**Verdict**

条件 PASS：在控制器锁定 91 路径、R45 接受后重算 `create-app.ts`、与 R46 按上述 7 路径串行、并对文档行作出范围归属后，可派 26 名称的 bounded R20 实施。当前未修改文件、未运行测试/安装/构建，也不构成实现或全量闭合验收。
