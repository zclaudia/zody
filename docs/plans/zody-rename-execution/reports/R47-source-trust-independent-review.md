# R47.1 DeepSeek 独立验收

Agent: broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1，route deepseek-flash。下述执行观察发生在真实 runtime 对注入 ExecutionPort 的调用层，不是 OS shell 执行；fresh app 也不是 Desktop 进程重启。清理后的核验另记。

**结论**
`R47_SOURCE_TRUST_TESTS` 为 **scoped PASS**：未发现需要修改测试或产品源码的阻断项，可进入 R47 本阶段验收。该结论不覆盖 R47 全量、Desktop 重启、R48 或发行。

**核验结果**
- `grant.json` SHA256 与 `source-hashes.json` SHA256 均匹配；manifest 为 11 行：3 write + 8 verify。11 个当前 SHA/Git blob 全部匹配，8 个 verify 文件相对 `db51e8b9` 基线未变，`productionChanges=0`。
- 工作树只有 3 个授权测试文件变化；`docs/plans/.../file-assignments.json` 是 controller 记账，不属于产品写入。
- `workspace-hook-trust-phase1.test.ts:48` 的 3 个 literal 用例先断言单一 source、`discoveryOrder: 0`、`sourceFileIndex: 0`、`resolvedTimeoutMs: 30000`、`resolvedMaxOutputBytes: 4096`，再做 digest 比较。三个 literal 我用实际 canonical payload 独立复算，均匹配。
- `workspace-hook-trust-store.test.ts:57` 使用真实文件写入未知 `schemaVersion: 999`，断言 `status: "corrupt"`、`records: []` 且 recovered 文件字节等于原始输入；没有把该结果扩大为 runtime 行为。
- `workspace-hook-runtime-admission.test.ts:23` 对三种 source 均先通过真实 file store 写入 literal v1 grant，读取 store 文件后创建 fresh app；原文件与仅格式化版本都实际执行一次。迁移用例实际发现 `.zcode/config.json`→`.zody/config.json`，digest 改变后产生 `workspace_hooks_pending_trust` 且零执行；语义变更产生 `workspace_hook_declaration_changed` 且零执行；最终 store 文件字节与 grant 后完全一致。官方插件 resolver spy 有恢复调用，并检查合成插件目录不存在。
- 最终日志计数与报告一致：`adapters-final.log` 19 passed，`shared.log` 12 passed，`admission-final.log` 和 `source-trace-final.log` 均为 3 passed / 5 skipped；重复运行不累加。13 个 command-index 日志 SHA 我逐一复核均匹配。
- 失败证据保留且归类正确：`adapters.log` 的 3 个失败是把 `sourceDiscoveryOrder` 断言在 hook 而非 source 的测试 setup 错误；`admission-strengthened.log` 的 3 个失败是语义变更错误地期待 pending、实际为 declaration-changed 的 expectation 错误；都不应算产品 red。`freshness.log` 的 SSH 认证失败也保留。
- `resolution.log` SHA 与 `source-trace-summary.json` 记录一致，10 个关键 owner 实际走 source；报告已明确其他 transitive 包仍可能走 dist，不声称完整 source-only closure。
- `controller/final-verification.json` 为 PASS：11 source、8 verify unchanged、0 production changes、13 命令/日志核验；root typecheck/lint/architecture 均 exit 0，lint 303 条既有 warnings。

**唯一剩余门禁**
`controller/cleanup-preflight-pending.json:1` 仍标记 `PENDING`，说明清理前置清单尚未按最终 verification/本 review 刷新。因此 **不要用当前 pending preflight 执行删除**；controller 刷新并确认最终 manifest 后即可清理。除此之外未发现 R47_SOURCE_TRUST_TESTS 的具体阻断。
