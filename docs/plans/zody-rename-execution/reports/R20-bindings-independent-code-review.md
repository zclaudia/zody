# Independent code review

**结论**

对 `aa3db87d` 基线上的 237 个已应用产品文件，本轮未发现需要 `CHANGES_REQUIRED` 的代码或边界缺陷。结论是 **scoped code acceptance，条件性进入最终验证**，不是 R20 阶段验收，也不代表全仓 94 名称最终闭合。

**已核验**

- `applied.json` 的 237 个产品路径与冻结提案的 237 个 unconditional existing paths 完全一致；2 个 conditional generated outputs 未提升。
- 237 个文件的当前 SHA 与 `applied.json.afterSha256` 全部匹配；基线 SHA 与 `beforeSha256` 全部匹配。
- 1058 次操作可对账为：1046 AST identifiers + 2 个独立 JS binding + 7 个 source assertion/comment/doc + 1 个 JSDoc + 1 个 Vite 当前注释 + 1 个历史状态段落。
- controller `source-audit-01` 实际结果：236 文件、1048 个 identifier rename、3 个授权 source assertion、0 problems。
- 没有发现 object shorthand 被改名；所有 TS/JS 改动行均属于该 identifier/reference 闭包或明确授权的字符串/注释。
- 外部值和历史值保留，包括 `ZCODE_PLUGIN_ID`、`zcode/errorPresentation`、`zcode/browserScreenshotContentIndices`、`zcode/nodeReplCuaApp`、`zcode-plugins-official`、`computer-use@zcode-plugins-official`、`ZCODE_FILE_LOCK_TIMEOUT` 等。
- CUA alias 已同步：
  - `apps/zody-cli/packages/bootstrap/src/mcp-config.ts:19` 使用 `ZODY_CUA_BROKER_SOCKET_ENV`，值为 `ZODY_CUA_PERMISSION_BROKER_SOCKET`。
  - `apps/zody-cli/packages/core/src/mcp/index.ts:21` 与 `computer-use-policy.ts:3` 使用 `ZODY_CUA_OFFICIAL_MCP_SERVER_NAME`，值为 `plugin:computer-use:computer-use`。
  - 当前源码未发现旧 CUA alias 引用；bootstrap 的该 alias 不是 package 公共导出入口。
- `packages/desktop/test/desktopRuntimeEnv.test.ts:32,46` 的两个 module mock key 已正确改为对应新 export。
- 三个 source assertion 精确命中：`runner-debug-storage-rollback.test.ts:9`、`automationTypographyTokens.test.ts:119`、`pluginSettingsSection.test.ts:270`。
- `docs/conversation-share-v1.md` 仅顶部状态段改变；`## 产品边界` 起的正文 SHA-256 为 `4d925786756a0abe7917b7f2182a9f78fc41986fdabfde752074e59a198a93cc`，与基线一致，未恢复分享功能。
- 48 个 node-repl-host tracked emit 输出与 working tree、基线一致，0 diagnostics，未 promoting `result.d.ts`/`.map`。

**必须收口的范围项**

- 当前工作树相对 `applied.json` 还多出三个路径：
  - `specs/zody-rename-internal-bindings.md`：属于 grant 的 planned path，尚未进入 applied/hash manifest。
  - `docs/plans/zody-rename-execution/file-assignments.json`：不在 241 path grant 内。
  - `docs/plans/zody-rename-execution/task-ledger.md`：不在 241 path grant 内。
  如果这两个 plan 文件属于 controller 的文档记账，请明确归属；如果计入单写者 writeSet，则当前精确 scope 尚未闭合，不能把它们当作产品实现文件。
- 计划中的 `docs/plans/zody-rename-execution/reports/R20-bindings-closure.md` 尚未出现，属于最终证据待补项。
- CLI 首轮失败来自 ignored `telemetry/dist` 仍导入旧 contracts 名称。它可以用“刷新生成输出后重跑”解释，不是已确认的产品源码回归；但在 fresh CLI export/hash/log 交付前不能宣称 CLI 通过。
- `scripts/doctor-macos-release-app.sh:6` 仍有独立的 shell 局部变量 `ZCODE_HOME_DIR`。它不是 R20 的 TS/JS binding declaration，不在本 grant 的 94 名称闭包内；应作为后续 residual owner 项登记，不构成本轮阻断。

**当前读取 Hash**

```text
8666b2cbdc9167d9e2020c60f5562a8c10de088a0edddcf8fb6520b08aa9b918  R20-bindings-final-aa3db-proposal.json
496ca49b983dee1db0e3a54da724507fe2a0c24cc1650b5734ca1ffad6fb807a  specs/zody-rename-internal-bindings.md
80767c40f9d8beff2c8c14773813884e5ef62d1527bc08db66b10086d262c725  controller/grant.json
bd8f89fe5bc2729ad61be81e311a9d5022651145367dbd22ea9834bf9a651e95  implementation/applied.json
49483ecebeb5dc8c8c71bbe29e838408d0ba7c87f5804f5ca0c493abeaa93a48  implementation/apply-bindings.cjs
213e4bcf079fd0ec1af0b355b78a27f26c75326e8ee56be7e0ed046985a06b5b  controller/source-audit.json
7d4e230ce480cdd044fbb223e36b42ff6242c5875872e41d7676393778ff3451  controller/generated-verification.json
e2e5beb38b9758e5d86786328da4d9b1a04685f4bdd5c7d64d98ec0bb73becc9  packages/shared/src/index.ts
9c04a2bcb06cb4e1e31a0cce23423b92d085bd480b06c875f8fdfa0c0165f01e  apps/zody-cli/packages/contracts/src/index.ts
88bc104933f925632887fa7450ddc71e4df9799cd957fb50d72cd1d06ca912ea  packages/services/src/index.ts
e4eaaadf0f076f4abb81457e3057d287c925644f7d9972e1f25a5417d0fdfa00  apps/zody-cli/packages/bootstrap/src/mcp-config.ts
003a4a03e22a112f7ad60c2a97fa7c77c79e807f0feb298e21587d44cdbd46c1  apps/zody-cli/packages/core/src/mcp/index.ts
d4e84583351c44962288d083f77c677cb3398cae03857835d00a01a9d6e4845d  apps/zody-cli/packages/node-repl-host/src/result.ts
1445aafcc862f861dd0b8a6db15f273b6121b12c98afe18efd2d810704b077c7  docs/conversation-share-v1.md
2699cd665a5be7c7feef77623f028090a86954230810f586355bc59a83365376  apps/dev-docs/vite.config.ts
```

本轮未运行测试、install、build 或写文件；controller 的 root typecheck/lint/architecture 结果仅按已有证据引用，未重复执行。

