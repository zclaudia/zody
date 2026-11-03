# Directory consumers and manifest assertion: DeepSeek review

Reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cdb-5be9-73f3-9b21-930b5c45f36a`, read-only; fixed `7c4ff9113680a38e273032b09bee32ee6ba399af` → `3cb3a0050fb47771305fe084852fc6aed994eb92`. Raw response follows.

**结论**
`PASS`（限定固定 `7c4ff911…→3cb3a005…` 的 8 文件 `directoryConsumerCorrection`）。上次 manifest 断言阻断已关闭；未发现新的产品/测试阻断。

**上次阻断关闭**
- `scripts/test/zody-manual-data-paths.test.mjs:142` 已从仅 `access(manifestPath)` 改为精确断言临时 HOME 下的 `.zody/perf-task-manifests/<sessionId>.json`。
- mutation 副本与当前实现逐行比较，只差 `manifestPath` 一行：`join(homedir(), ".zcode", ...)`。
- `manual-mutation.log` 显示该 mutation 在大测试中红了 1 项，实际 `.zcode`、期望 `.zody`；`manual-real.log` 和主控 `controller-directory-manual.log` 均为 2/2 绿。该证据来自 Terra/主控日志，不是我独立执行。

**范围与六消费者**
- 直接父提交是 `7c4ff911…`；diff 共 12 文件，其中 8 个精确授权文件匹配 `directoryConsumerCorrection.files`，另外 4 个是 scope JSON、两份报告和 ledger bookkeeping；未包含 root install 或其他产品文件。
- `v4-native-boundary.test.ts`：扫描现行 `src/zody-protocol-v4/`（固定候选下 59 个 `.ts`），regex 仅匹配 `zody-protocol/`，保留 `-v4` 反例，并增加非空扫描和正反例断言。
- `v4-native-selection-side-chat.test.ts`：本地 import 与 mock 均指向 `../src/zody-protocol-v4/commands/prompt-turn.js`。
- `conversation-topic-publisher-hydration-bound.test.ts`：import 与 `vi.mock` 均指向 `@zody/shared/zody-protocol-v4`；`zcode-artifact://` 是运行时身份保留。
- `provider-m2-legacy-boundary.test.ts`：retired 路径改为现行 `src/zody-protocol/active-session-model-limits.ts`，该文件确实不存在，ENOENT 检查有效。
- `packages/services/test/modelTrajectory.test.ts`：导入和源码读取均指向现行 `src/zody-agent/modelTrajectory`，文件存在。
- `apps/zody-cli/scripts/shadow-replay.mjs`：两个 bootstrap dist 动态导入均指向 `dist/zody-protocol-v4`；usage 改为已验证的 `node --import tsx`，其余主要是格式化等价改动。空 synthetic DB 的 tsx 日志成功初始化 0 会话；plain Node 仍因 shared TS 导出解析失败，未声称实际会话回放。

**测试证据**
- 只读证据显示 CLI 4 文件 26 测试通过、services 1 文件 7 测试通过、manual 2/2 通过；typecheck 报告退出 0，lint 303 warnings/0 errors，changed architecture 0 violations，bootstrap build 13/13 成功。
- 我实际执行了固定 SHA 的 diff/路径/hash 检查、`git diff --check`，以及 Node 24.14.0 对 `shadow-replay.mjs` 和 manual 测试的 `node --check`，均通过。
- 我未独立运行 Vitest/Node 测试、typecheck、lint、build 或 architecture；测试结果来自被审主控/Terra 日志。未 install、未加载 WDIO、未访问真实 HOME。

**非阻断残留**
- `shadow-replay` 只证明空 synthetic DB 的加载/初始化，不证明真实会话重放。
- `modelTrajectory.test.ts` 仍以 `zcode-model-trajectory-*` 命名测试临时目录；它不是本批六个生产目录消费者，未影响路径解析，若做全品牌清理可另行列项。
