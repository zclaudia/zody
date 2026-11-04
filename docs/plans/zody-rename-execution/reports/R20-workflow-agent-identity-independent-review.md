**结论：R20_WORKFLOW_AGENT_DEFAULT 范围内 scoped PASS**
无产品阻断；17 路径、7 write + 10 verify、4 literal 变换与实际证据一致。清理可继续由主控按 manifest 执行，但本轮验收不授权删除任何 red/fail/临时证据。

**实际核验**
- `controller/grant.json` SHA256 `f5472991…`、`implementation/source-hashes.json` SHA256 `1c1c19b5…` 均匹配；17 个 current hash 全部匹配，10 个 verify-only 文件与 `56deb506` blob 一致。
- 独立重放基线 `zcode-workflow`→`zody-workflow` 替换后与当前两生产文件逐字节相等；两文件各 2 处，共 4 处，无其他改动。`zcode-expert`、显式旧值、空字符串、动态值均保留。
- `child-green`：4/4 passed（27 skipped），覆盖 default、`reviewer`、旧 `zcode-workflow`、空字符串；每个用例断言真实父 permission 请求 1 次、parent/child identity、拒绝不执行，并从真实 session store 读到 child message 的 `agent`。
- `facade-final`：2/2 passed（40 skipped）；真实非 expert `audit` definition + `app.runWorkflow`，读取真实 child SQLite message 的 `agent`，并用 call-through `AgentRuntime.prototype.createChildClientPorts` 观察到 `zody-workflow`；明确不声称 facade 产生真实 permission prompt。既有 expert 正控通过。
- `ui-final`：26/26 passed；旧历史 fixture 保留，新默认标签新增。
- 插件解析器 spy 实际被调用，隔离 `<tempRoot>/cli/plugins` 不存在；R46 generic fixture blob `a0061d53…` 未变，未冒充新 OS hook/usage roundtrip。
- controller 复核：bootstrap `tsc --noEmit` 0、root typecheck 0、root lint 0（303 既有 warnings）、changed architecture 0；`final-verification.json` 为 PASS。
- 报告 `R20-workflow-agent-identity.md` 的 counts、filtered 说明、失败日志保留和限制描述与实际文件一致；red/facade 失败日志仍在。

**限制（不构成阻断）**
- 最终定向 run 只执行 4 个 identity 用例、facade/expert 2 个用例；原 guarded 回归用例和另外 40 个 session-persistence 用例未在最终过滤 run 中重跑，新增用例已覆盖本次所需的 broker/denial/identity 断言。
- 未声称真实 OS hook、workflow usage 关闭重开、完整 E2E、GUI 或 release；R46 仅作未变 fixture 的 generic 证据。
- CLI 相关文件未由 root formatter 的 scoped 检查覆盖（报告已说明新 facade block 在副本中格式化）；root lint 0 已通过，未发现格式阻断。
- 清理尚未执行；主控清理时必须保留 `red-child*`、`facade-first/second/diagnose`、最终 green runner/log 及临时根，不得把中间失败当已通过或提前删除。

可选非阻断加固：facade 测试目前用 `calls.some(...)` 断言 ports 配置，若后续需要更强约束可加 `calls.length === 1`；本轮 scope 不要求。
