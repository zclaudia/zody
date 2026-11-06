# DeepSeek：basename 修复复审与第三批符号验收

固定候选 `1b042046c373fa91c5ed80b1501bcf0677f2eb39` → `d49aecefa7d1c3571bfae69fe4817950654b9298`。只读 route `deepseek-flash`。以下保留原文；其中待回填的账本字段由后续主控检查点更新，CLI 日志后续另补实际子目录 Node 24.14.0 版本并重跑退出 0。

**总判定**
- **(1) PASS — 可关闭此前 basename 审计分类发现。**
- **(2) PASS — batch03 在固定候选范围内可接受。**
- 仍非 R20.4/P2 完成，也不构成 Desktop/发行通过。

**Part 1 复审**
- `scripts/audit-zody-agent-remnants.mjs:89` 相对 `1b042046` 只有一处 token：`zcode-agent-policy` → `zody-agent-policy`；无通配、无其他分类改动，未移动的 `zcode-agent-model-state` 保留。
- `zody-agent-policy.ts` 命中该 `compat-type` 正则；主控 JSON `controller-symbols-03-remnants.json` 实际记录 category=`compat-type`。
- `1b042046..d49aecef` 未触碰 98 个 basename 新路径；d49 上 98 个旧路径仍不存在、新路径均存在。该阻断可关闭，但 basename 账本状态仍写 `review-CHANGES_REQUIRED`，属回填事项。

**Part 2 复审**
- 账本 25 条声明与 27 个 TS/TSX 产品文件一致；每条新名均在登记的 `declarationAfter` 文件真实声明。
- 我独立做了等价归一化（按 25 条 new→old 整词还原）：27/27 文件其余字节与 base 完全相同，0 mismatch；与主控 parser 审计一致。
- 两个同名 lifecycle 为独立声明：`zodyAgentProcessManager.ts:307`（内部进程事件）与 `zcodeAgent.ts:213`（服务契约）；消费者分别绑定到本地模块或 `@zody/services`，未混用。`services/src/index.ts:152` 只导出契约类型。
- mock 导出键与真实导出同步：`packages/desktop/test/storagePreparationWorker.test.ts:7`。
- 公共导出 `index.ts`/`node.ts` 已同步；shared 的 `export *` 无需改文本。
- 未改 env/wire/序列化值：字面量、模板、注释均保持 base 字节；旧名仅剩注释/测试描述字符串。授权 scope 的 27 个路径均为精确项，无泛化。
- 文档：5 份当前文档实际修改，`docs/windows-test-compatibility.md` 与 base 字节相同；当前 `.zody` 与历史 `.zcode` 来源已分开，不存在的 `scripts/build-zcode-lite.mjs` 标为计划项，历史测试记录保留。

**非阻断残留**
- `packages/services/src/zody-agent/zodyAgentProcessManager.ts:856` 注释仍写旧名 `ZCodeAgentRuntimeRestartedEvent`；因本批约定注释不动，建议后续注释清理批次处理。
- `packages/services/test/zodyAgentProcessManager.test.ts:81,189,395` 的 describe 字符串仍为旧函数名，属已声明的刻意保留。
- 账本：batch03 `candidate:null`、basename batch 仍为 `review-CHANGES_REQUIRED`；`R20-symbols-batch-03.md` 仍写“尚未提交”。
- `R20-current-docs.md` 开头仍描述同步前 resolver 名，结尾“后续同步”段已解释，建议收尾时合并表述。

**证据限制**
- 本次为固定 SHA 的只读静态审查；我未 install/build/运行测试。
- 191 tests、typecheck 0 error、lint 303 warnings、Main 85/85 归一相同均来自主控日志（可变 output 目录）；CLI types 日志为空，符合 `tsc --noEmit` 成功无输出，但未由我执行。
- Server clean build 由 Terra 执行，我未独立复验；Desktop `out/main`、Main 85 诊断、CUA manifest 等仍按原阶段门禁处理。
