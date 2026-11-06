# R21 compact harness：DeepSeek 独立审查

**结论：PASS（仅 scoped compact harness 修正）**
4 文件小批只包含 2 个 E2E harness、专用报告和 ledger；未改产品行为。

**核查结果**
- `git diff a3a0d9c9..01f59a33` 仅 4 文件，两个测试文件 SHA-256 与报告一致：
  - `case-usage-anchor.mjs` → `95c1d9bb…`
  - `case-background-bash.mjs` → `841909b9…`
- `case-usage-anchor.mjs:127/157/204` 三处均已改为 `app = await createApp(...)`；`case-utils.mjs:116` 与 `create-app.ts:170` 均为 async，修复方向正确，未把 Promise 当 app。
- `case-background-bash.mjs:246-250` 完整复制了 `incoming-message.ts:10` 的安全来源前缀；`:267` 使用 `providerNotification === expectedSafetyPrefix + expectedNotification` 严格等值，未用 `includes`/`startsWith`，也未删减原有 task-id、tool-use-id、output-file、status、summary 等内容。通知内容和安全来源断言均未弱化。
- 偏移后的断言上下文仍只报告 `expectedNotification`（不含前缀），失败时诊断信息略不完整；这是非阻断的可选改进，不影响正确性。

**实际验证边界**
- Terra 日志 `output/zody-rename-r21/docker-correction/harness-local-fake.log` 显示 fake 7/7、`failedCaseCount: 0`；`harness-local-background-bash.log` 显示 1/1、`failedCaseCount: 0`。
- 主控 `output/zody-rename-validation/harness/fake.log` 同样 7/7；`background-bash.log` 1/1；`commands.json` 两条命令均 `exitCode: 0`，使用隔离临时 HOME/TMPDIR、无 API key。
- 我只读取了上述日志和固定 SHA，没有复跑；本地命令使用已有编译产物，不是新 Docker 构建。`commands.json` 未嵌入 HEAD SHA，证据绑定依赖报告和已核对的文件 SHA。
- 根 typecheck/lint/fmt 日志显示无错误；完整最终 Docker 候选、完整 R21/R22 仍未证明，不能据此宣称全量通过。

**PASS 范围**
仅确认该 harness 修正本身：await 正确、通知与安全前缀等值断言完整、无产品逻辑变化。
