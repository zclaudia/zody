# R47 scope review 2

Read-only reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a456-8275-7f92-ade9-5b96ca871195`, DeepSeek. Conditional scope conclusion; routing issue requires reachability/reproduction investigation before any product change.

**结论**

原先四个 blocker 已基本闭合，可给 **R47 scope conditional PASS**；但有一个与 `remoteSessionId` 路由相关的具体源码缺口，以及一个 restart 证据隔离/模型前置条件。此次只读，未运行 tests/build/install，未修改文件。

**已闭合**

- `allow_trusted_only` / `deny` 已分开：pre-existing exact trust 在 `allow_trusted_only` 下可运行，未信任项与 mutation 被拒绝；`deny` 全部阻止。
- 语义摘要与 whitespace 反向例已明确；三旧来源 `zcode.json`、`.zcode/config.json`、explicit 均要求独立固定 v1 摘要和 `sourcePathAtGrant`。
- `core domain`、`bootstrap protocol`、UI routing 测试已加入 writeSet/testEntrypoints。
- restart 方案已从模糊条件变为专用 Playwright 文件计划，明确真实二次 Electron 启动、同一隔离目录、完全关闭 Host/Agent、store/digest 不变及日志/截图/进程证据；HK05–07 入口已改用 `test:e2e:serial`。
- 当前基线 `04860520` 正确，R43/R45/R46 交集目前为空，并保留最终 R45/R46 完成后的 rebind 条件。

**剩余条件**

1. `remoteSessionId` 的“selected attachment”当前源码并不支持，需补锁或收窄断言。
   `packages/ui/src/store/workspaceHookReviewStore.ts:189` 的 `findWorkspaceHookCommandBinding` 只接收 path/identity，没有 `remoteSessionId`；`packages/ui/src/settings/workspaceHookReviewCommands.ts:105` 直接使用该结果。`packages/ui/src/settings/HooksSection.tsx:163-165` 虽解析了选中的 `remoteSessionId`，但只传给服务解析，没有传给 trust lookup；`useWorkspaceHookInlineTrust.ts` 也没有该输入。
   因此两个相同 identity/path、不同 `remoteSessionId` 的 binding 同时存在时，会按插入顺序取第一个，不能保证“命令发往所选 attachment”。
   处理方式二选一：把 `packages/ui/src/store/workspaceHookReviewStore.ts`、`packages/ui/src/settings/workspaceHookReviewCommands.ts`、`useWorkspaceHookInlineTrust.ts`/`HooksSection.tsx` 纳入条件 production lock，并加入相应 UI 测试；或把验收断言收窄为“唯一 binding 时携带 `remoteSessionId`”，不声称 selected-attachment 路由。当前 proposal 声称无 UI production 变更即可通过，这两点不一致。

2. restart helper 需要把隔离环境 seam 和模型/执行前置写清。
   新文件目前只是 `new` 计划，尚未存在于工作区；作为 scope 可以接受，但不能算执行证据。`output/zody-rename-r44/desktop-smoke/smoke-run5.cjs` 直接传 `process.env`，而 Desktop/Agent 数据根还依赖 `ZODY_DATA_BASE_DIR`、`ZODY_DESKTOP_HOME_DIR`、`ZODY_DESKTOP_USER_DATA_DIR`、`ZODY_DESKTOP_SESSION_DATA_DIR` 等键；仅设 HOME/USERPROFILE 不足以保证不会写真实 `~/.zody` 或用户 userData。
   同时，真实自然 SessionStart 执行需要确定性的本地 provider/model fixture；HK05–07 的 WDIO replay fixture 不能假定直接 Playwright 脚本自动继承。应在 helper 计划中固定这些环境键、Electron 二进制解析及模型/执行 fixture，否则 restart 只能证明 store 重载，不能稳定证明 Hook 执行。

3. 明确真实 Desktop restart 覆盖哪个旧来源。
   contracts/adapters/bootstrap 已覆盖三种来源，但 `requiredAcceptance.real desktop restart` 只说 “exact old-source trust”，未指定 `.zcode/config.json`、`zcode.json` 或 explicit。建议明确至少一个 Desktop 来源，其余两种保留为 store/admission 证据，避免范围含糊。

R45/R46 完成后的最终写集重绑仍是实施前置条件；本结论不覆盖 R45/R46 当前 worktree 改动，也不宣称 R47 已执行。

Controller disposition: the inherited-env comment is a requirement for the proposed R47 helper, not evidence that the accepted R44 run used real user paths. R44 used an isolated parent environment and verified actual Electron userData/sessionData; its original raw evidence and scoped acceptance remain unchanged. R47 must record the same concrete isolation checks and actual Agent configuration.
