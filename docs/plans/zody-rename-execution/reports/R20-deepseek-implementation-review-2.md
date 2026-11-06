# R20.2/R20.3 independent review 2

Candidate: `c62caae2a32fb369a1d5b3b8679d7310b320a5a5`.
Reviewer: DeepSeek, route `deepseek-flash`, read-only.

**结论：CHANGES_REQUIRED**（仅针对 R20.2/R20.3 子步骤，不代表 P2/R20 整体通过）

**阻断项**
- `apps/zody-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:317-320` 与 `:348-351` 仍只列旧源目录 `zcode-guide-plugin` / `zcode-cua-plugin`。当前树只有 `apps/zody-cli/packages/zody-guide-plugin` 和 `zody-cua-plugin`，因此 monorepo/dev 的文件系统 seed 找不到这两个内置插件；打包侧保留旧 staged 路径的语义不应改变。最小修复：为两组 `rootCandidates` 增加新目录名变体（`packages/zody-*-plugin`、`../zody-*-plugin`、`../../zody-*-plugin`、`../../../zody-*-plugin`），同时保留旧候选供 `resources/glm/packages/zcode-*-plugin` 使用。不要改 `.zcode-plugin`、插件 `name`、marketplace 或 `prepare-agent-node-bundle.mjs` / `prepare-prebuilds.mjs` 的 `stagedPath`。
- 源目录迁移未同步这些源树测试：`apps/zody-cli/packages/bootstrap/tests/dynamic-workflow-skill.test.ts:51`、`apps/zody-cli/packages/bootstrap/tests/zody-guide-path-contract.test.ts:15`、`apps/zody-cli/packages/node-repl-host/test/computer-use-onboarding.test.ts:20`、`apps/zody-cli/packages/node-repl-host/test/mcp-server.test.ts:338`（相关提示在 `:333`）。旧目录已不存在，上述测试读取/导入会失败。最小修复：源树测试改为 `zody-guide-plugin` / `zody-cua-plugin`；`packages/server/test/remoteDeploy.test.ts` 和 `packages/zody-server-cli/test/packaging.test.ts` 中保留 `zcode-*-plugin` 的 staged 身份断言不要误改。

**非阻断项**
- `docs/plans/zody-rename-execution/reports/R20.md:34` 的 “`architecture:check --changed`” 通过容易被误读为全量架构通过；控制器报告已说明全量仍有 2 个基线问题，建议明确加 “changed-only” 限定。
- `apps/zody-cli/packages/cli/scripts/build-sea.mjs:60,190` 仍使用中间产物名 `zcode-${target}.sea.blob`。未观察到它作为发布/公共资产，但若本阶段要求内部产物命名一致，应显式指派 R20.4/后续 owner 或一并改名。
- `packages/ui/src/lib/builtinSkillI18n.ts:41` 的路径标记仍只有 `/zcode-guide-plugin/`；若 monorepo 下 `pluginName` 为空而走路径 fallback，则新版源路径不会被识别。非阻断，但建议同批补 `/zody-guide-plugin/`。

**已核对**
Provider/CLI/remote 的 `zody.cjs`、`zody-server.cjs`、`zody-builtin.json`、私有 `bin.zody` 及 SEA 资产 key 的生产者/消费者基本一致；`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、`zcode-builtin:` revision、`zcode-builtin-refresh.json`、外部 Excalidraw/marketplace/MCP 身份未被误改；CUA AST guard 与 provenance fixture 的修复也在。以上为静态路径/边界审查，未执行这些 Vitest，也未运行 codemod。
