# R47 scope review 1

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a456-8275-7f92-ade9-5b96ca871195`, DeepSeek. Proposal review only.

**预审结论**

不直接 PASS。R47 的源码边界大体正确，但当前 frozen proposal 仍有会改变验收含义的 scope/证据缺口；修订后可作 R47 scope PASS。此次仅只读审查，未运行 tests/build/install，未修改文件。

**已通过部分**

- `proposedWriteSet` 的 21 个路径中仅 2 个待创建文件缺失；现有 test/spec 路径均存在；R43 commit 未见 hook/trust 交集。
- `packages/shared/src/workspace-hook-config.ts` 仍保留 `zcode.json`、`.zcode/config.json`、`.zody/config.json` 和 explicit 来源。
- `packages/shared/src/workspace-hook-digest.ts` 计算的是规范化执行语义，不是原始文件字节；空白/字段顺序不应直接导致失信。
- `packages/shared/src/workspace-hook-trust-store-file.ts` 对 `schemaVersion: 1`、完整 record 和 `workspaceIdentity + hookDeclarationDigest` 唯一性做严格整份拒绝，没有部分信任泄漏。
- `apps/zody-cli/packages/core/src/hooks/workspace-hook-trust-evaluation.ts` 以 identity+digest 查找，corrupt store fail closed；`remoteSessionId` 不进入 trust key。
- persistent-only 规格、旧 `.zcode` 兼容、无 soft-gate 恢复、仅可复现失败才条件锁 production 文件的策略，均与当前源码一致。

**需修订项**

1. `output/zody-rename-w5-preflight/R47-frozen-proposal.json:121` 的 rejection 断言错误。
   当前写的是“`deny` 和 `allow_trusted_only` prevent mutation and executions”，但 `docs/specs/workspace-hook-trust.md:1677` 明确：`allow_trusted_only` 允许已有 persistent Trust 运行，只禁止新建/更新；`deny` 才禁止已有信任执行。应改为分别断言：匹配记录在 `allow_trusted_only` 下可运行、无记录 blocked、无 mutation；`deny` 全部 blocked。测试范围还应加入 `apps/zody-cli/packages/core/tests/workspace-hook-trust-domain.test.ts` 和 `apps/zody-cli/packages/bootstrap/tests/workspace-hook-trust-protocol.test.ts`。

2. `output/zody-rename-w5-preflight/R47-frozen-proposal.json:55` 的 “changed bytes” 与语义摘要合同冲突。
   `packages/shared/src/workspace-hook-digest.ts` 对空白/无关字节变化应保持 digest 不变。应改为“changed command/args/timeout/shell/async 等执行语义”，并增加 whitespace-only 重写仍保留原 trust 的反向用例；移动 `.zcode` → `.zody` 则因来源路径变化而失信。

3. `output/zody-rename-w5-preflight/R47-frozen-proposal.json:126` 的 identity/remoteSessionId 证据没有对应 UI 写入范围。
   `remoteSessionId` 的实际路由在 `packages/ui/src/store/workspaceHookReviewStore.ts` 和 `packages/ui/src/settings/workspaceHookReviewCommands.ts`，但 proposal 的 readSet/writeSet/testEntrypoints 均未包含 UI 文件或 UI 测试；现有 `packages/ui/test/workspaceHookInlineTrust.test.ts` 和 `workspaceHookReviewStore.test.ts` 也没有 `remoteSessionId` 断言。应把相应 UI 测试加入候选锁，或明确只做静态边界确认，不能声称已证明 attachment 路由。另需明确：同 identity 不同 `remoteSessionId` 仍是同一信任主体，只有不同 `workspaceIdentity` 不能复用授权。

4. `output/zody-rename-w5-preflight/R47-frozen-proposal.json` 的真实 Desktop restart 计划仍不可执行。
   现有 `packages/desktop/test/e2e/conversation-session/conversation-session-hook-trust.test.ts` 是同一 Electron session 内的 HK05–07；`packages/desktop/wdio.conf.ts:1668` 的 `resetE2EHome` 会在 beforeSession 删除 E2E HOME，spec 本身没有重启步骤。proposal 的 “only where fixture lifecycle permits” 不能作为验收条件。应二选一：新增并锁定专用 restart spec/helper，证明 Electron 重启后仍读取同一隔离 HOME 下的 trust store；或明确将 Desktop restart 降为 pending，仅用 adapters/bootstrap reopen 证明 store 重载。`conversation-session-permission-hook-rewrite.test.ts` 不能计入 restart 证据。

5. 实施绑定前需更新候选元数据。
   proposal 仍写 `candidate: HEAD 71acf64f`，但当前 R43 已提交为 `04860520`；还需补充 R45/R46 的 write-set 交集，不能只保留 `r43WriteIntersection: []`。这不是当前代码缺陷，但当前 JSON 不能直接作为 R47 实施基线。

6. 测试入口应记录真实脚本。
   `output/zody-rename-w5-preflight/R47-frozen-proposal.json:141` 使用 `exec wdio`，会绕过 `packages/desktop/package.json:41` 的 `pretest:e2e:serial`（构建 `@zody/e2e-report`）。建议改用 `pnpm --dir packages/desktop test:e2e:serial -- --spec ...`，或明确记录 e2e-report 已预构建的前提。

**范围边界**

历史来源目前只说 `.zcode` 固定摘要；若“历史 trust 原样保留”也包含 `zcode.json` 或 explicit 来源，应补相应 fixture/断言，否则应把声明收窄到 `.zcode`。整体上，R47 scope 在修订上述 1–4 项并完成 R43/R45/R46 rebind 后可 PASS；未完成这些前不建议冻结。
