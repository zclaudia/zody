# R20 内部成员：DeepSeek 独立审查

**结论：scoped PASS**（仅 R20.4-internal-members-01 固定候选；不代表完整 R20.4、R21/R22 或发行通过）

**固定对象**
- 基 `21c06e804020be17dc4dde62fbc0ee4d2b96beb4` → 候选 `66af64363af06f2729c3a725ebc9e06dc71964c3`
- 父提交精确匹配；候选 tree `33806a4005d08924402c96618847f99fb7a934c8`
- 152 文件：142 个 `packages/` 产品文件、1 个 spec、9 个 docs/ledger；无 lock、env、产品 JSON/YAML、dist 或 apps 产品改动。`git diff --check` 通过。

**已验证**
- `candidate.json` 的 142 文件集合与 `git diff packages` 完全一致；516 次编辑仅涉及三组精确改名：493 checker 引用、12 反射/类型/测试文本、9 测试 fake、2 active E2E mock。
- 对全部 490 行产品变更做逐行归一化：把 `zodyTaskService/zodyAgentService/zodySessionService` 还原为旧名后，与基提交变更行多重集合完全一致，`bad=0`。没有混入字段、env、wire、序列化或其他名称变化。
- 声明与消费者闭合：`packages/services/src/accessor.ts:59,62,63`、`packages/client/src/remoteServiceAccess.ts:64,67,68` 及 channel 构造、`packages/services/src/node.ts:1933,2018`、`packages/ui/src/hooks/useWorkspaceTaskLists.ts:102`、`packages/web/src/mobile-remote/homeOnlyServices.ts:66,159,167`、`packages/desktop/src/host/legacyRemoteWorkspaceRpcContract.ts:13-15,27`。
- 本地反射数组确为 `keyof IServiceAccessor` 的进程内属性查找，不是远端 channel 值；测试双 `packages/desktop/test/hostRemoteWorkspaceServices.test.ts:111-113` 仍保留 `remote: "zcode-session"` 外部值。
- 两个 active mobile fake 已同步：`mobile-remote-onboarding.mjs:40`、`mobile-settings-connection.mjs:51`。
- 旧成员标识符在受审产品 TS/TSX/MJS/JS 的非注释代码中为 0，带引号旧键为 0；剩余只出现在注释、历史 docs 和 native 冻结报告。
- `packages/shared/src/channels.ts` 前后 SHA-256 均为 `4956fb13dae81ad000bd2f1645d391956bc34cc34bdcddc3f27447a8394be0fc`，`zcode-task/zcode-agent/zcode-session` 原值未改。
- 记录证据显示：主控 14 文件 115/115、source 1/1、root typecheck/lint/architecture 0；Terra 更广运行 772 通过、1 个既有 gateway 失败；mobile onboarding 4 场景及 settings 均 exit 0；Main 85 诊断 exit 1，归一后与旧基线一致。我未重跑这些测试，以上是固定候选日志/commands 证据，不是本次静态审查替代运行验证。

**非阻断项**
- `docs/plans/zody-rename-execution/reports/R20-internal-members-implementation.md:3` 仍写“未修改 ledger、scope”，但本候选确实包含 9 个 ledger/scope 元数据修订；应改为“controller 在实施后追加 receipt/账本”，避免与 diff 矛盾。
- 旧名注释仍存在，例如 `packages/services/src/accessor.ts:91`、`packages/services/src/node.ts:1254`、`packages/desktop/src/host/index.ts:2868`；符合本批“只改标识符、文字另批”的边界，不阻断。
- `packages/services/dist/accessor.d.ts` 与 `packages/client/dist/remoteServiceAccess.d.ts` 不在候选 git tree 中；生成声明只能作为构建证据引用，不能由固定 commit 独立复核。

**边界**
Main 仍为 85 条诊断且 exit 1；既有 gateway 1 失败仍存在；R20.4 剩余 symbols/basenames、R21/R22、clean release/Docker 均未完成；没有 CLI build 结论。上述均不构成本固定的产品回归，但也不能把本批 PASS 当作完整 R20 或发行通过。

主控说明：changed architecture 的实际执行者是实施者 Terra；主控独立执行115+1测试、typecheck和lint，未重复架构检查。已生成 dist 声明仅作为构建日志/哈希证据，不是提交内文件。此前198项 basename 已另有独立验收，本次审查不重新确认那些历史批次。
